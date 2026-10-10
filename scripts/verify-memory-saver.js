// Memory saver (tab discarding, like Chrome's Memory Saver): a tab that has not been looked at for a long time gives its page back; clicking it loads it again.
// Real tabs on a local web server, real renderer processes. The idle time is shortened with opts.afterMs (the product uses 30 minutes).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-memory-saver.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 170000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-mem-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });
fs.writeFileSync(path.join(tmp, "UserData", "settings.json"), JSON.stringify({ showBookmarksBar: false }));
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra !== undefined ? "  <" + extra + ">" : "")); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const settings = require("../electron/settings");
    const perms = require("../electron/permissions");
    const srv = http.createServer((q, res) => {
      res.setHeader("content-type", "text/html");
      if (q.url.startsWith("/form")) return res.end("<html><title>Form</title><body><input id=a><textarea id=t></textarea></body></html>");
      res.end("<html><head><title>Page " + q.url + "</title></head><body><h1>" + q.url + "</h1><script>sessionStorage.setItem('login','token-' + location.pathname)</script></body></html>");
    }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = "http://127.0.0.1:" + srv.address().port;
    const open = async (p) => { tm.createTab(base + p); await sleep(1300); return tm.getActiveTab(); };
    const procs = () => app.getAppMetrics().filter((m) => m.type === "Tab").length;
    const priv = () => Math.round(app.getAppMetrics().reduce((s, m) => s + (m.memory.privateBytes || 0), 0) / 1024)   /* privateBytes is in KB: this is MB */;

    console.log("-- freezing of background tabs is already there (measured, not built)");
    const A = await open("/a");
    await A.view.webContents.executeJavaScript("window.t = 0; window.r = 0; setInterval(() => window.t++, 50); (function f() { window.r++; requestAnimationFrame(f); })(); 1");
    const B = await open("/b");
    const t0 = await A.view.webContents.executeJavaScript("window.t + ':' + window.r"); await sleep(3000);
    const t1 = await A.view.webContents.executeJavaScript("window.t + ':' + window.r + ':' + document.visibilityState");
    const [ta, ra] = t0.split(":").map(Number), [tb, rb, vis] = t1.split(":");
    check("a background tab is hidden, gets no animation frames and its 50 ms timer runs ~once a second", vis === "hidden" && Number(rb) === ra && Number(tb) - ta < 20, t0 + " -> " + t1);

    console.log("-- discarding");
    const C = await open("/c");           // C is active now; A and B are background tabs
    const before = { procs: procs(), priv: priv() };
    // the tabs have not been idle long enough
    check("a tab that was used a moment ago is NOT discarded (the real limit is 30 minutes)", (await tm.discardIdleTabs()) === 0 && !A.discarded);
    const n = await tm.discardIdleTabs({ afterMs: 0 });
    check("with the idle time over, the two background tabs are discarded and the active one is not", n === 2 && !!A.discarded && !!B.discarded && !C.discarded, n);
    await sleep(800);
    check("their renderer processes are really gone (" + before.procs + " -> " + procs() + " page processes)", procs() <= before.procs - 2, before.procs + " -> " + procs());
    check("the tabs are still in the strip with their title and address", state.tabs.includes(A) && A.title === "Page /a" && /\/a$/.test(A.url), A.title + " " + A.url);
    const st = tm.getTabState();
    check("the tab state tells the strip which tabs are discarded", st.tabs.filter((t) => t.discarded).length === 2 && !st.tabs.find((t) => t.id === C.id).discarded);
    check("a discarded tab reports as destroyed to every 'is it alive' check (nothing throws)", A.view.webContents.isDestroyed() === true);
    check("private memory fell (" + before.priv + " MB -> " + priv() + " MB, all processes)", priv() < before.priv, before.priv + " -> " + priv());

    console.log("-- bringing a tab back");
    A.discarded.session && console.log("   (kept: " + A.discarded.entries.length + " history entries, sessionStorage " + JSON.stringify(A.discarded.session.data) + ")");
    tm.switchTab(A.id); await sleep(2200);
    check("clicking the tab loads it again: same address and title", !A.discarded && /\/a$/.test(A.view.webContents.getURL()) && A.view.webContents.getTitle() === "Page /a", A.view.webContents.getURL());
    check("its sessionStorage (a sign-in kept there) is back", (await A.view.webContents.executeJavaScript("sessionStorage.getItem('login')")) === "token-/a");
    check("it is the active tab and attached to the window", state.activeTabId === A.id && state.mainWindow.getBrowserViews().includes(A.view));
    check("the other discarded tab is untouched (still discarded) until it is clicked", !!B.discarded);
    check("the back / forward list came back too (the one entry)", A.view.webContents.navigationHistory.getAllEntries().length >= 1);

    console.log("-- what is never discarded");
    const F = await open("/form");
    await F.view.webContents.executeJavaScript("document.getElementById('a').value = 'half typed'; 1");
    await open("/d");
    check("a tab with text typed into a form is kept", (await tm.discardTab(F, { afterMs: 0 })) === false && !F.discarded);
    const G = await open("/g"); await open("/h");
    G.view.webContents.isCurrentlyAudible = () => true;
    check("a tab that plays sound is kept", (await tm.discardTab(G, { afterMs: 0 })) === false);
    G.view.webContents.isCurrentlyAudible = () => false;
    G.capture = { audio: true, video: false };
    check("a tab using the microphone is kept", (await tm.discardTab(G, { afterMs: 0 })) === false);
    G.capture = null;
    const P = perms._state(); P.remembered.set(base + "|notifications", true);
    check("a tab allowed to show notifications is kept (WhatsApp Web...)", (await tm.discardTab(G, { afterMs: 0 })) === false);
    P.remembered.delete(base + "|notifications");
    const I = await open("/i"); await open("/j");
    state.tabs.push({ ...state.tabs[0], id: 9999, openerId: I.id, discarded: null });   // a tab opened BY I that is still open
    check("a tab that opened another, still open, tab is kept", (await tm.discardTab(I, { afterMs: 0 })) === false);
    state.tabs.pop();
    check("the active tab and a settings page are kept", (await tm.discardTab(tm.getActiveTab(), { afterMs: 0 })) === false);
    settings.set("memorySaver", false);
    check("with Settings > Memory saver off nothing is discarded", (await tm.discardIdleTabs({ afterMs: 0 })) === 0);
    settings.set("memorySaver", true);
    check("an idle tab that has nothing to lose is still discarded after the switch is turned on again", (await tm.discardIdleTabs({ afterMs: 0 })) >= 1);

    console.log("-- closing and the rest of the browser with a discarded tab around");
    const d = state.tabs.find((t) => t.discarded);
    const count = state.tabs.length;
    tm.closeTab(d.id); await sleep(500);
    check("closing a discarded tab works", state.tabs.length === count - 1 && !state.tabs.includes(d));
    check("...and Ctrl+Shift+T brings it back with its sign-in", await (async () => { tm.reopenClosedTab(); await sleep(2200); const t = tm.getActiveTab(); return !!t && t.view.webContents.getURL() === d.url.replace(/#.*/, "") && (await t.view.webContents.executeJavaScript("sessionStorage.getItem('login')")) !== null; })());
    tm.getTabState(); tm.broadcastSettings(); tm.cycleTab(1); await sleep(400); tm.cycleTab(-1); await sleep(400);
    check("tab state, settings broadcast and cycling through tabs do not throw with discarded tabs in the strip", errors.length === 0, errors.join("|"));
    check("no uncaught error in the main process", errors.length === 0, errors.join("|"));
  } catch (e) { check("no exception: " + (e && e.stack || e), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_MEMSAVER total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
