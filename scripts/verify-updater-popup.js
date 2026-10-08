// The updater with its REAL dialog (electron/updateDialog.js, not a stub): it appears when a download is done, stays until somebody answers, and ONLY a click on
// "Update" starts an install. Real mouse events are sent to the dialog's buttons. Run:
// env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-updater-popup.js
const { app, BrowserWindow } = require("electron");
const http = require("http"), crypto = require("crypto");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-pop-"));
process.env.LOCALAPPDATA = tmp;
app.setPath("userData", path.join(tmp, "UserData"));
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 150000).unref();
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAME = "PBCalc Setup 0.2.0.exe";
const exe = crypto.randomBytes(1024 * 1024);
const sha = crypto.createHash("sha512").update(exe).digest("base64");
const yml = `version: 0.2.0\nfiles:\n  - url: ${NAME}\n    sha512: ${sha}\n    size: ${exe.length}\npath: ${NAME}\nsha512: ${sha}\nreleaseDate: '2026-10-08T00:00:00.000Z'\n`;
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split("?")[0]).replace(/^\/assets\//, "");
  if (p === "pbcalc.yml") { r.setHeader("content-type", "text/yaml"); return r.end(yml); }
  if (p === NAME) return r.end(exe);
  r.statusCode = 404; r.end("no");
});

(async () => {
  try {
    await app.whenReady();
    new BrowserWindow({ show: false });                                            // keeps Electron alive while the dialog windows come and go
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const feedUrl = "http://127.0.0.1:" + server.address().port + "/assets/";
    const DEV_YML = path.join(__dirname, "dev-app-update.yml");
    process.on("exit", () => { try { fs.unlinkSync(DEV_YML); } catch (_) {} });
    fs.writeFileSync(DEV_YML, ["provider: generic", "url: " + feedUrl, "channel: pbcalc", "updaterCacheDirName: pbcalc-updater", ""].join("\n"));
    const updater = require("../electron/updater");
    const state = require("../electron/state");
    const dlg = require("../electron/updateDialog");
    const real = require("electron-updater").autoUpdater;
    const main = new BrowserWindow({ show: true, width: 900, height: 600, title: "main" });
    state.mainWindow = main; await main.loadURL("data:text/html,<title>main</title>main");

    const center = (wc, sel) => wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`, true);
    const click = async (wc, sel) => { const c = await center(wc, sel); wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y }); await sleep(80); wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 }); };
    const waitDialog = async (not) => { for (let i = 0; i < 100; i++) { const w = dlg._last(); if (w && w !== not && !w.isDestroyed() && w.isVisible()) return w; await sleep(100); } return null; };

    // one scenario: check -> download -> the real dialog -> (wait) -> click `button` -> read the outcome
    async function scenario(button, waitMs, declinedBefore = "") {
      state.quitting = false;
      let qargs = null; const orig = real.quitAndInstall; real.quitAndInstall = (a, b) => { qargs = [a, b]; };
      const store = { v: declinedBefore };
      const u = updater.setup({ feedUrl, delayMs: 3600000, currentVersion: "0.1.5", log: () => {}, declined: { get: () => store.v, set: (v) => { store.v = v; } }, showProgress: () => ({ close() {} }) });
      const first = dlg._last();
      await u.check();
      const win = button ? await waitDialog(first) : null;
      if (!button) await sleep(2500);                                              // (no dialog expected: give the download time to finish)
      const out = { u, store, win };
      if (win) {
        await sleep(waitMs);
        out.openAfterWait = win.isVisible() && !win.isDestroyed();
        out.qargsWhileOpen = qargs; out.quittingWhileOpen = state.quitting;
        out.text = await win.webContents.executeJavaScript("document.body.innerText");
        await click(win.webContents, button === "Update" ? "#ud-update" : "#ud-cancel");
      }
      for (let i = 0; i < 60 && !store.v && qargs === null && win; i++) await sleep(100);
      await sleep(300);
      out.dialogShown = !!(dlg._last() && dlg._last() !== first);
      out.before = { qargs, quitting: state.quitting, declined: store.v };
      // the installer starts 2 s after the "Updating PBCalc" window (updater.js PROGRESS_LEAD_MS), so qargs is read later
      out.closeHook = () => { out.afterClose = { result: u.installIfPending() }; out.readQargs = () => { out.afterClose.qargs = qargs; }; };
      out.restore = () => { real.removeAllListeners(); real.quitAndInstall = orig; };
      return out;
    }

    console.log("-- download done: the dialog appears, nobody answers for 6 s, then the user clicks Cancel");
    let r = await scenario("Cancel", 6000);
    check("the dialog appeared by itself once the update was downloaded", !!r.win);
    check("it shows version v0.2.0, the warning (tabs closed and not restored) and what Cancel does", r.text && /v0\.2\.0/.test(r.text) && /not restored/.test(r.text) && /next time you close or open PBCalc/.test(r.text), r.text);
    check("it is STILL open after 6 s with nobody touching it (it never answers itself)", r.openAfterWait === true);
    check("...and until then nothing was installed and the app was not quitting", r.qargsWhileOpen === null && r.quittingWhileOpen === false);
    check("Cancel (real click): the installer is NOT started and the program is not quitting", r.before.qargs === null && r.before.quitting === false, JSON.stringify(r.before));
    check("Cancel: the postponed version is remembered for the next start", r.before.declined === "0.2.0", r.before.declined);
    r.closeHook();
    await sleep(2600); r.readQargs();
    check("...and when the browser is closed afterwards, the postponed update installs: quitAndInstall(true, true)", r.afterClose.result === true && r.afterClose.qargs && r.afterClose.qargs[0] === true && r.afterClose.qargs[1] === true, JSON.stringify(r.afterClose));
    r.restore();

    console.log("\n-- the user clicks Update");
    r = await scenario("Update", 1000);
    check("Update (real click): the installer starts, SILENT, PBCalc is started again afterwards: quitAndInstall(true, true)", r.before.qargs && r.before.qargs[0] === true && r.before.qargs[1] === true, JSON.stringify(r.before));
    check("...the program knows it is really quitting, and nothing stays 'declined'", r.before.quitting === true && r.before.declined === "");
    r.restore();

    console.log("\n-- the next start after a Cancel");
    r = await scenario(null, 0, "0.2.0");
    check("the version declined earlier installs at once, with NO dialog", !r.dialogShown && r.before.qargs && r.before.qargs[0] === true && r.before.qargs[1] === true, JSON.stringify({ shown: r.dialogShown, b: r.before }));
    r.restore();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  try { require("electron-updater").autoUpdater.autoInstallOnAppQuit = false; } catch (_) {}   // the downloaded file is a fake: never let the quit hook run it
  server.close();
  const failed = results.filter((x) => !x.pass).length;
  console.log("PBCALC_UPDATERPOPUP total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
