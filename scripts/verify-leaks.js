// Memory / leak check. The same workload runs several rounds (many tabs of every kind, switching, hover cards, every popup, find,
// duplicate + close + reopen, window.open popups, a download, password stash / fill grants, settings, file tabs) and after each
// round everything is closed again. A leak shows up as something that does NOT come back to the baseline:
//   * live webContents and BrowserViews (a view or page that was closed but not destroyed),
//   * the module-level Maps (state.pendingSessionRestore, fillGrants, pending credentials),
//   * the main process JS heap after a forced GC, and the total working set of all processes.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-leaks.js
const { app, webContents, ipcMain } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
const v8 = require("v8"), vm = require("vm");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 420000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-leak-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const MB = (n) => (n / 1048576).toFixed(1) + "MB";

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const popup = require("../electron/popup");
    const hover = require("../electron/hovercard");
    const grants = require("../electron/vault/fillGrants");
    const creds = require("../electron/vault/pendingCredentials");
    const downloads = require("../electron/downloads/downloadManager");
    const vault = require("../electron/vault/passwordVault");
    const win = state.mainWindow;
    const dir = path.join(tmp, "files"); fs.mkdirSync(dir);
    const imgPath = path.join(dir, "pic.png"); fs.writeFileSync(imgPath, (await win.webContents.capturePage({ x: 0, y: 0, width: 400, height: 300 })).toPNG());
    const bigText = "x".repeat(200000);
    const srv = http.createServer((q, res) => {
      if (q.url.startsWith("/file.bin")) { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="leak.bin"' }); return res.end(Buffer.alloc(200000, 1)); }
      res.setHeader("content-type", "text/html");
      if (q.url.startsWith("/login")) return res.end('<title>login</title><form><input name=username><input type=password></form>');
      if (q.url.startsWith("/popup")) return res.end('<title>p</title><a id=a href="/child" target="_blank">x</a><script>window.open("/child")</script>');
      res.end("<title>page " + q.url + '</title><body><div id=d></div><script>document.getElementById("d").textContent = "' + bigText.slice(0, 50000) + '"</script>');
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    vault.saveCredential({ origin: base, username: "u1", password: "p1" });
    const snapshot = async (label) => {
      for (let i = 0; i < 3; i++) { gc(); await sleep(300); }
      const m = app.getAppMetrics();
      const ws = m.reduce((a, p) => a + (p.memory.workingSetSize || 0), 0) * 1024;
      return {
        label,
        wcs: webContents.getAllWebContents().length,
        views: win.getBrowserViews().length,
        tabs: state.tabs.length,
        restore: state.pendingSessionRestore.size,
        grants: grants._size(),
        creds: creds.size(),
        closedL: win.listenerCount("closed"),
        resizeL: win.listenerCount("resize"),
        heap: process.memoryUsage().heapUsed,
        ws,
        procs: m.length,
      };
    };

    const round = async (n) => {
      // 1. many tabs of every kind
      for (let i = 0; i < 6; i++) tm.createTab(base + "/page" + i + "?r=" + n);
      tm.createTab(base + "/login"); tm.createTab(base + "/popup");
      tm.openSettings(); tm.openDownloadsPage(); tm.openManager();
      tm.openLocalFile(imgPath);
      tm.createTab("data:text/html,<title>d</title>data page");
      await sleep(3500);
      // 2. switch through them all (thumbnails are captured on switch)
      for (const t of state.tabs.slice()) { tm.switchTab(t.id); await sleep(120); }
      // 3. hover cards
      for (const t of state.tabs.slice(0, 6)) { await hover.show(t.id, { left: 100, right: 300, top: 6, bottom: 34 }); await sleep(60); hover.hide(); }
      // 4. popups of every kind (they are created on open and destroyed on close)
      for (const k of ["menu", "tabsearch", "downloads", "siteinfo"]) { popup.open(k, null, {}); await sleep(250); popup.close(); await sleep(100); }
      tm.openFind(); await sleep(250); tm.closeFind(); await sleep(150);
      // 5. duplicate / close / reopen (session snapshots), a tab restored with sessionStorage
      const dup = state.tabs.find((t) => /\/page1/.test(t.view.webContents.getURL()));
      if (dup) { await tm.duplicateTab(dup.id); await sleep(800); }
      // 6. password stash + fill grants (taken, expired and abandoned)
      const login = state.tabs.find((t) => /\/login/.test(t.view.webContents.getURL()));
      if (login) {
        const wcid = login.view.webContents.id;
        ipcMain.emit("vault:stash-pending", { sender: login.view.webContents }, { username: "u" + n, password: "secret" + n });
        grants.grant(wcid, base, "u1");
      }
      // 7. a download, then drop it from the list
      downloads.startDownload ? downloads.startDownload(base + "/file.bin") : state.tabs[0].view.webContents.downloadURL(base + "/file.bin");
      await sleep(1500);
      for (const d of downloads.publicList ? downloads.publicList() : []) { try { downloads.dismiss(d.id); } catch (_) {} }
      // 8. close everything except the first tab, then reopen two closed ones and close those too
      for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
      await sleep(1200);
      tm.reopenClosedTab && tm.reopenClosedTab(); tm.reopenClosedTab && tm.reopenClosedTab();
      await sleep(1500);
      for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
      popup.close(); hover.hide();
      await sleep(2500);   // closed pages linger a moment (session snapshot) and the hover card idles
    };

    const snaps = [await snapshot("baseline")];
    for (let n = 1; n <= 5; n++) { await round(n); snaps.push(await snapshot("after round " + n)); }
    console.log("\n   round        wcs views tabs restore grants creds closedL   mainHeap   allProcessesRAM procs");
    for (const s of snaps) console.log("   " + s.label.padEnd(14) + String(s.wcs).padStart(3) + String(s.views).padStart(6) + String(s.tabs).padStart(5) + String(s.restore).padStart(8) + String(s.grants).padStart(7) + String(s.creds).padStart(6) + String(s.closedL).padStart(8) + MB(s.heap).padStart(11) + MB(s.ws).padStart(16) + String(s.procs).padStart(6));
    const base0 = snaps[0], last = snaps[snaps.length - 1], r2 = snaps[2];
    console.log("");
    check("every closed page is gone: live webContents are back to the baseline", last.wcs <= base0.wcs + 1);
    check("every popup / card view is gone: BrowserViews are back to the baseline", last.views <= base0.views + 1);
    check("only the first tab is left", last.tabs === 1);
    check("no session-restore snapshot stays behind (state.pendingSessionRestore)", last.restore === 0);
    check("no fill grant stays behind (fillGrants)", last.grants === 0);
    check("no typed-login stash stays behind (pendingCredentials)", last.creds === 0);
    check("the window's 'closed' listeners do not pile up (addBrowserView used to add one per call, never removed)", last.closedL <= base0.closedL + 2);
    check("the window's 'resize' listeners (one per attached view) are back to the baseline too", last.resizeL <= base0.resizeL + 2);
    check("the main process heap does not keep growing round after round (round 2 -> 5: under 6 MB)", last.heap - r2.heap < 6 * 1048576);
    check("the memory of ALL processes does not keep growing (round 2 -> 5: under 150 MB)", last.ws - r2.ws < 150 * 1048576);
    check("no uncaught error", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_LEAKS total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
