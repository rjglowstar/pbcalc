// Settings > Downloads > "Change" (the download folder) works in Restricted Mode exactly as in normal mode (owner 2026-10-13: it was hidden there, and refused
// in TWO more places - the settings:choose-download-dir IPC and downloadManager.chooseDir). Per mode: the button is visible, clicking it asks for a folder (the
// native dialog is answered by a stand-in), the folder is saved and shown, and a real download lands in it. Also: the IPC still answers our Settings page only.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-download-dir.js
const { app, dialog, session } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process"), http = require("http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.env.PBC_DD_MODE;

if (MODE) {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbdd-"));
  const ud = path.join(tmp, "UserData");
  require("../electron/constants").dataDir = () => ud;
  fs.mkdirSync(ud, { recursive: true });
  const firstDir = path.join(tmp, "first"), picked = path.join(tmp, "Picked folder (" + MODE + ")");
  fs.mkdirSync(firstDir); fs.mkdirSync(picked);
  fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: true, downloads: { dir: firstDir, ask: false }, restricted: { startRestricted: MODE === "restricted" } }));
  let asked = 0;
  dialog.showOpenDialog = async () => { asked++; return { canceled: false, filePaths: [picked] }; };   // stands in for the user choosing a folder
  (async () => {
    require("../electron/main.js");
    await app.whenReady();
    const state = require("../electron/state"), tm = require("../electron/tabs/tabManager");
    for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);
    await sleep(2500);
    tm.openSettings();
    const tab = state.tabs.find((t) => /settings/.test(t.url)) || state.tabs[state.tabs.length - 1], wc = tab.view.webContents;
    for (let i = 0; i < 3000 && !(!wc.isLoading() && /settings/.test(wc.getURL())); i++) await sleep(5);
    await sleep(800);
    const r = { restricted: !!state.restricted };
    r.visible = await wc.executeJavaScript('(() => { const b = document.getElementById("dl-change"); return !!b && !b.hidden && b.offsetParent !== null; })()');
    r.shownBefore = await wc.executeJavaScript('document.getElementById("dl-dir").textContent');
    await wc.executeJavaScript('document.getElementById("dl-change").click(); true');
    await sleep(1200);
    r.asked = asked;
    r.shownAfter = await wc.executeJavaScript('document.getElementById("dl-dir").textContent');
    r.saved = JSON.parse(fs.readFileSync(path.join(ud, "settings.json"), "utf8")).downloads.dir;
    r.picked = picked;
    // a real download goes to the new folder
    const srv = http.createServer((q, s) => { s.setHeader("content-type", "application/octet-stream"); s.setHeader("content-disposition", "attachment; filename=\"report-" + MODE + ".bin\""); s.end("x".repeat(2048)); }).listen(0, "127.0.0.1");
    await new Promise((res) => srv.once("listening", res));
    wc.downloadURL("http://127.0.0.1:" + srv.address().port + "/file");
    const target = path.join(picked, "report-" + MODE + ".bin");
    for (let i = 0; i < 100 && !fs.existsSync(target); i++) await sleep(100);
    r.downloadedThere = fs.existsSync(target) && fs.statSync(target).size === 2048;
    r.notInOld = !fs.existsSync(path.join(firstDir, "report-" + MODE + ".bin"));
    srv.close();
    // the IPC answers our Settings page only: a web page's call is refused (it asks nothing and changes nothing)
    const before = asked;
    const hostile = await new Promise((resolve) => {
      const hs = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<title>evil</title>x"); }).listen(0, "127.0.0.1", async () => {
        let w2;
        tm.createTab("http://127.0.0.1:" + hs.address().port + "/", { allowRestricted: true });
        w2 = state.tabs[state.tabs.length - 1].view.webContents;
        for (let i = 0; i < 300 && (w2.isLoading() || !/127\.0\.0\.1/.test(w2.getURL())); i++) await sleep(20);
        const res = await w2.executeJavaScript("typeof window.settingsAPI === 'undefined' ? 'no settingsAPI on a web page' : 'EXPOSED'").catch((e) => "err " + e.message);
        hs.close();
        resolve(res);
      });
    });
    r.hostile = hostile;
    r.askedByHostile = asked - before;
    console.log("RESULT " + JSON.stringify(r));
    app.exit(0);
  })().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
} else {
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 300000).unref();
  let failed = 0, total = 0;
  const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 300) + ">" : "")); };
  const run = (mode) => new Promise((resolve) => {
    const env = { ...process.env, PBC_DD_MODE: mode }; delete env.ELECTRON_RUN_AS_NODE;
    let out = "";
    const c = cp.spawn(process.execPath, [__filename], { env, windowsHide: true });
    c.stdout.on("data", (d) => { out += d; });
    c.on("exit", () => { const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { error: out.slice(-400) }); });
  });
  app.whenReady().then(async () => {
    for (const mode of ["normal", "restricted"]) {
      console.log("-- " + mode + " mode");
      const r = await run(mode);
      check("the run completed", !r.error, r.error);
      if (r.error) continue;
      check("the browser really is in " + mode + " mode", r.restricted === (mode === "restricted"));
      check("Settings > Downloads shows the 'Change' button", r.visible === true);
      check("clicking it asks for a folder (the native dialog was opened once)", r.asked === 1, r.asked);
      check("the chosen folder is saved in settings.json", r.saved === r.picked, r.saved);
      check("...and shown on the page at once", r.shownAfter === r.picked && r.shownBefore !== r.picked, r.shownBefore + " -> " + r.shownAfter);
      check("a download then lands in the NEW folder, not the old one", r.downloadedThere && r.notInOld);
      check("a web page has no settings bridge and cannot open the folder dialog", r.hostile === "no settingsAPI on a web page" && r.askedByHostile === 0, r.hostile);
    }
    console.log("\nPBCALC_DOWNLOADDIR total=" + total + " failed=" + failed);
    app.exit(failed ? 1 : 0);
  });
}
