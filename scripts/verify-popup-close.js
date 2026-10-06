// A page that ends itself (an OAuth / sign-in popup calling window.close()) must take its tab with it.
// Before the fix the tab stayed as the ACTIVE tab with no page behind it and reload threw
// "Cannot read properties of undefined (reading 'isDestroyed')" (an error dialog in the real app).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-popup-close.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-pc-"));
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
    const srv = http.createServer((q, res) => {
      res.setHeader("content-type", "text/html");
      if (q.url.startsWith("/popup")) return res.end("<title>popup</title>popup<script>setTimeout(() => window.close(), 700)</script>");
      if (q.url.startsWith("/stay")) return res.end("<title>stay</title>stays open");
      res.end("<title>main " + q.url + "</title>main");
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const wcOf = (t) => t.view.webContents;
    const alive = (t) => !!wcOf(t) && !wcOf(t).isDestroyed();
    const active = () => state.tabs.find((t) => t.id === state.activeTabId);

    tm.createTab(base + "/main-A"); await sleep(1500);
    const A = active();
    console.log("-- the shown popup closes itself");
    const n0 = state.tabs.length;
    await wcOf(A).executeJavaScript('window.open("/popup"); 0', true); await sleep(500);
    check("the popup opened as a tab and is the active one", state.tabs.length === n0 + 1 && active().url.endsWith("/popup"));
    await sleep(2500);
    check("after it closes itself the tab is GONE from the strip", state.tabs.length === n0 && state.tabs.every(alive));
    check("...and you are back on the page that opened it", active() === A);
    let threw = null;
    try { tm.reload(); } catch (e) { threw = e; }
    check("reload (F5 / Ctrl+R) works instead of throwing", !threw);
    check("no uncaught error reached the main process", errors.length === 0);
    check("the self-closed popup is NOT offered by Ctrl+Shift+T", !(await (async () => { const before = state.tabs.length; tm.reopenClosedTab(); await sleep(1200); const added = state.tabs.length > before && /\/popup/.test(active().url); if (state.tabs.length > before) tm.closeTab(active().id); return added; })()));

    console.log("\n-- a popup that closes itself while ANOTHER tab is shown");
    await wcOf(A).executeJavaScript('window.open("/popup"); 0', true); await sleep(400);
    tm.createTab(base + "/stay"); await sleep(1200);   // the user moves on to a third tab meanwhile
    const C = active();
    await sleep(2000);
    check("the popup tab is gone", state.tabs.every(alive) && !state.tabs.some((t) => /\/popup/.test(t.url)));
    check("the user is NOT pulled away from the tab they are on", active() === C);

    console.log("\n-- ordinary closing is unchanged");
    const nb = state.tabs.length;
    tm.createTab(base + "/main-B"); await sleep(1200);
    const B = active();
    tm.closeTab(B.id); await sleep(800);
    check("closing a normal tab still removes it and picks a neighbour", state.tabs.length === nb && !state.tabs.includes(B) && !!active() && alive(active()));
    tm.createTab(base + "/main-D"); await sleep(1200);
    const D = active();
    tm.closeTab(D.id); await sleep(1200);
    tm.reopenClosedTab(); await sleep(1800);
    check("Ctrl+Shift+T still reopens a normally closed tab", /main-D/.test(active().url));
    check("still no uncaught error", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_POPUPCLOSE total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
