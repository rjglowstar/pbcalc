// Files dragged in from Explorer and dropped on the PBCalc window open in a new tab - in normal AND Restricted Mode, wherever the
// drop lands (a page, the toolbar, the tab strip) - and a page that handles drops itself (an upload box) keeps them.
// The drags are REAL, trusted OS-style events made with the DevTools protocol (Input.dispatchDragEvent with real file paths),
// not a synthetic DOM event (the preload ignores untrusted ones on purpose). A genuine mouse drag from Explorer is not driven
// here; the owner checks that by hand.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-drop-files.js
const { app, ipcMain } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 200000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-drop-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const win = state.mainWindow, shell = win.webContents;
    const dir = path.join(tmp, "files"); fs.mkdirSync(dir);
    const file = (n, c = "x") => { const p = path.join(dir, n); fs.writeFileSync(p, c); return p; };
    const pdf = file("doc.pdf", "%PDF-1.1\n"), png = file("pic.png", "PNG"), txt = file("note.txt", "note"), html = file("page.html", "<title>dropped page</title>hi");
    const zip = file("a.zip", "PK"), exe = file("run.exe", "MZ"), folder = path.join(dir, "sub.pdf"); fs.mkdirSync(folder);   // a FOLDER named like a pdf

    // a site with a page that takes drops itself (like smallpdf's upload box) and one that does not
    let pageGot = null;
    const srv = http.createServer((q, res) => {
      res.setHeader("content-type", "text/html");
      if (q.url.startsWith("/uploader")) return res.end('<title>uploader</title><div id=z style="width:600px;height:400px;background:#eef">drop here</div><script>window.got=null; document.getElementById("z").addEventListener("dragover", e => e.preventDefault()); document.getElementById("z").addEventListener("drop", e => { e.preventDefault(); window.got = Array.from(e.dataTransfer.files).map(f => f.name); });</script>');
      res.end("<title>plain page</title><div style='width:900px;height:600px'>plain</div>");
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const active = () => state.tabs.find((t) => t.id === state.activeTabId);
    const urls = () => state.tabs.map((t) => t.view.webContents.getURL());
    const fileTabs = () => urls().filter((u) => u.startsWith("file:///") && !/newtab\.html$|restricted|renderer/.test(u));

    // a real, trusted file drag at (x, y) of a webContents
    const drag = async (wc, x, y, files) => {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
      const data = { items: [], files, dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"]) await wc.debugger.sendCommand("Input.dispatchDragEvent", { type, x, y, data });
      await sleep(1500);
    };

    console.log("-- dropped on a page");
    tm.createTab(base + "/plain"); await sleep(1500);
    const pageTab = active(), pageUrl = pageTab.view.webContents.getURL(), n0 = state.tabs.length;
    await drag(pageTab.view.webContents, 300, 300, [pdf]);
    check("a dropped PDF opens in a NEW tab", state.tabs.length === n0 + 1 && /doc\.pdf$/.test(urls()[urls().length - 1]));
    check("...and the page it was dropped on is left alone (Chromium did not navigate it)", pageTab.view.webContents.getURL() === pageUrl && state.tabs.includes(pageTab));
    check("...the new tab is the one in front", /doc\.pdf$/.test(active().view.webContents.getURL()));

    console.log("\n-- several files, and files that must not open");
    tm.switchTab(pageTab.id); await sleep(400);
    const n1 = state.tabs.length;
    await drag(pageTab.view.webContents, 300, 300, [png, txt, html, zip, exe, folder, "relative/doc.pdf", path.join(dir, "missing.pdf")]);
    const added = urls().slice(n1);
    check("png, txt and html each get their own tab (3 tabs)", added.length === 3 && /pic\.png$/.test(added[0]) && /note\.txt$/.test(added[1]) && /page\.html$/.test(added[2]));
    check("a .zip, an .exe, a folder, a relative path and a missing file open NOTHING", state.tabs.length === n1 + 3);
    const tooMany = []; for (let i = 0; i < 14; i++) tooMany.push(file("m" + i + ".txt", "m" + i));
    tm.switchTab(pageTab.id); await sleep(300);
    const n2 = state.tabs.length;
    await drag(pageTab.view.webContents, 300, 300, tooMany);
    check("a drop of 14 files opens at most 10 tabs", state.tabs.length - n2 === 10);

    console.log("\n-- a page that takes the drop itself keeps it");
    tm.createTab(base + "/uploader"); await sleep(1500);
    const up = active(), n3 = state.tabs.length;
    await drag(up.view.webContents, 200, 200, [pdf]);
    check("the upload box received the file", JSON.stringify(await up.view.webContents.executeJavaScript("window.got")) === '["doc.pdf"]');
    check("...and PBCalc did NOT also open it in a tab", state.tabs.length === n3);

    console.log("\n-- dropped on the browser's own chrome (toolbar, tab strip)");
    const nShell = state.tabs.length;
    await drag(shell, 700, 60, [txt]);
    check("a file dropped on the toolbar opens in a new tab", state.tabs.length === nShell + 1 && /note\.txt$/.test(active().view.webContents.getURL()));
    const shellBefore = shell.getURL();
    const strip = await shell.executeJavaScript('(() => { const t = [...document.querySelectorAll(".tab")][0].getBoundingClientRect(); return { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) }; })()');
    await drag(shell, strip.x, strip.y, [png]);
    check("a file dropped on a tab in the tab strip opens in a new tab", state.tabs.length === nShell + 2 && /pic\.png$/.test(active().view.webContents.getURL()));
    check("the browser window itself was never navigated to the file", shell.getURL() === shellBefore);

    console.log("\n-- who may send dropped paths");
    const before = state.tabs.length;
    ipcMain.emit("files:dropped", { sender: require("electron").webContents.getAllWebContents().find((w) => w !== shell && !state.tabs.some((t) => t.view.webContents === w)) }, [pdf]); await sleep(500);
    check("a webContents that is neither the shell nor a tab is ignored", state.tabs.length === before);
    ipcMain.emit("files:dropped", { sender: shell }, "not-an-array"); ipcMain.emit("files:dropped", { sender: shell }, [42, null, {}]); await sleep(300);
    check("garbage in place of a list of paths is ignored, no crash", state.tabs.length === before && errors.length === 0);

    console.log("\n-- Restricted Mode: the same");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    const r0 = state.tabs.length, home = active();
    await drag(home.view.webContents, 300, 300, [pdf]);
    check("a PDF dropped in Restricted Mode opens in a new tab", state.tabs.length === r0 + 1 && /doc\.pdf$/.test(active().view.webContents.getURL()));
    await drag(shell, 700, 60, [png, zip]);
    check("...also on the toolbar; an unsupported file still opens nothing", state.tabs.length === r0 + 2 && /pic\.png$/.test(active().view.webContents.getURL()));
    check("Restricted Mode itself is unchanged (still locked)", state.restricted === true && (await shell.executeJavaScript('document.body.classList.contains("restricted")')));
    const fileTab = active();
    fileTab.view.webContents.executeJavaScript("location.href = 'https://example.org/'").catch(() => {}); await sleep(1500);
    check("a file tab in Restricted Mode cannot navigate away to a website", /pic\.png$/.test(fileTab.view.webContents.getURL()));
    tm.leaveRestricted(); await sleep(800);
    check("no uncaught error", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_DROPFILES total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
