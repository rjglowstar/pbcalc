const { BrowserWindow, ipcMain, dialog, app } = require("electron");
const path = require("path");
const os = require("os");
const state = require("./state");

// The "Send report" box (the support report, electron/diagnostics.js). It is the user's decision point: nothing is collected and nothing leaves the computer until
// the user presses Send in this box, where a note can be typed too. Opened by Settings > Support > "Send report...", and - by itself, at most once in 30 minutes - after
// a page crashed or stopped responding (diagnostics.js -> promptAfterProblem). It never opens by itself while the calculator screen is showing, in Restricted
// Mode, or while PBCalc is quitting.
// Where it goes: a file in the IT department's folder on the company network (diagnostics.send). A PC that is NOT on that network is not an error: the box says so
// in plain words (no technical text) and offers "Save as file", so the user can hand the file to the IT department - the same button is there from the start.
// A modal window of PBCalc's own (like the update dialog); only THIS window may ask for the send (the ipc handler checks the sender).
const AUTO_GAP_MS = 30 * 60 * 1000;
let win = null, current = null, lastAutoAt = 0, registered = false;

function register() {
  if (registered) return;
  registered = true;
  ipcMain.handle("reportdialog:send", async (e, note) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !current) return { ok: false, error: "unavailable" };
    const dg = require("./diagnostics");
    try {
      const report = await dg.collect({ note: String(note == null ? "" : note).slice(0, dg.NOTE_MAX), trigger: current.trigger });
      const r = await dg.send(report);
      if (r.ok) current.sent = true;
      return { ok: !!r.ok, offline: !!r.offline, reason: r.reason || "" };   // (no file path, no technical text: the box words it)
    } catch (_) { return { ok: false, offline: false, reason: "error" }; }
  });
  // "Save as file...": the same report, to a file the user picks (default: the Desktop) - to hand to the IT department when the network is not there
  ipcMain.handle("reportdialog:save", async (e, note) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !current) return { ok: false };
    const dg = require("./diagnostics");
    try {
      const report = await dg.collect({ note: String(note == null ? "" : note).slice(0, dg.NOTE_MAX), trigger: current.trigger });
      const d = new Date(report.createdAt), p2 = (n) => String(n).padStart(2, "0");
      const name = "PBCalc-report_" + report.computer.name.replace(/[^A-Za-z0-9._-]/g, "_") + "_" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + ".json";
      let desk = ""; try { desk = app.getPath("desktop"); } catch (_) {}
      const r = await dialog.showSaveDialog(win, { title: "Save the report file", defaultPath: desk ? path.join(desk, name) : name, filters: [{ name: "PBCalc report", extensions: ["json"] }] });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      await dg.saveToFile(report, r.filePath);
      current.saved = true;
      return { ok: true, name: path.basename(r.filePath) };
    } catch (_) { return { ok: false, reason: "error" }; }
  });
  // the content got taller / shorter (the status message under the note): the window follows, so the buttons are never cut off
  ipcMain.on("reportdialog:fit", (e, h) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !Number.isFinite(h) || h <= 0) return;
    try { win.setContentSize(540, Math.max(360, Math.min(Math.round(h), 820))); } catch (_) {}
  });
  ipcMain.on("reportdialog:close", (e) => { if (win && !win.isDestroyed() && e.sender === win.webContents) { try { win.close(); } catch (_) {} } });
}

// opts.trigger: "manual" | "crash" | "hang". Resolves { sent, saved } when the box is closed.
function ask(opts = {}) {
  register();
  if (win && !win.isDestroyed()) { try { win.focus(); } catch (_) {} return current.promise; }
  const trigger = ["crash", "hang"].includes(opts.trigger) ? opts.trigger : "manual";
  const parent = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
  current = { trigger, sent: false, saved: false, promise: null };
  current.promise = new Promise((resolve) => {
    win = new BrowserWindow({
      parent, modal: !!parent,
      width: 540, height: 560, useContentSize: true,
      show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: "PBCalc report", autoHideMenuBar: true,
      icon: path.join(__dirname, "..", "assets", "icon.png"),
      backgroundColor: require("electron").nativeTheme.shouldUseDarkColors ? "#3c3c3c" : "#ffffff",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "..", "preloads", "reportdialog-preload.js") },
    });
    const w = win, c = current;
    w.removeMenu();
    require("./lockdown").lock(w.webContents);
    w.on("closed", () => { if (win === w) { win = null; current = null; } resolve({ sent: c.sent, saved: c.saved }); });
    w.webContents.once("did-finish-load", async () => {
      try {
        const dg = require("./diagnostics");
        w.webContents.send("reportdialog:init", { trigger, computer: os.hostname(), version: require("../package.json").version, noteMax: dg.NOTE_MAX });
        const h = await w.webContents.executeJavaScript("Math.ceil(document.querySelector('.dlg').getBoundingClientRect().height)");
        if (!w.isDestroyed()) { w.setContentSize(540, Math.max(360, Math.min(h, 820))); w.center(); w.show(); w.focus(); }
      } catch (_) { if (!w.isDestroyed()) w.show(); }
    });
    w.loadFile(path.join(__dirname, "..", "renderer", "reportdialog", "reportdialog.html")).catch(() => { try { w.close(); } catch (_) {} });
  });
  return current.promise;
}

// A page crashed / stopped responding: ask - but not too often, and never where a box would be wrong.
function promptAfterProblem(kind) {
  const now = Date.now();
  if (state.calcMode || state.restricted || state.quitting) return false;
  if (!state.mainWindow || state.mainWindow.isDestroyed() || !state.mainWindow.isVisible() || state.mainWindow.isMinimized()) return false;
  if (win && !win.isDestroyed()) return false;
  if (now - lastAutoAt < AUTO_GAP_MS) return false;
  lastAutoAt = now;
  ask({ trigger: kind === "crash" ? "crash" : "hang" }).catch(() => {});
  return true;
}

module.exports = { ask, promptAfterProblem, _win: () => win, _resetGap: () => { lastAutoAt = 0; } };
