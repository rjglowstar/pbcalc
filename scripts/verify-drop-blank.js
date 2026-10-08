// A file dropped while the current tab is an empty New Tab page takes that tab's place (no blank tab left behind, like Chrome).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-drop-blank.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 90000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-db-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };
(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const { openDropped } = require("../electron/dropFiles");
    const f1 = path.join(tmp, "a.txt"), f2 = path.join(tmp, "b.txt"), f3 = path.join(tmp, "c.txt");
    [f1, f2, f3].forEach((f, i) => fs.writeFileSync(f, "file " + i));
    const urls = () => state.tabs.map((t) => t.view.webContents.getURL());
    const isNtp = (u) => /newtab\.html$/i.test(u);

    console.log("-- the only tab is an empty New Tab page");
    check("start: one New Tab page", state.tabs.length === 1 && isNtp(urls()[0]), JSON.stringify(urls()));
    check("a dropped file opens", openDropped([f1]) === 1); await sleep(1500);
    check("...and the blank New Tab is gone: exactly one tab, showing the file", state.tabs.length === 1 && /a\.txt$/.test(urls()[0]), JSON.stringify(urls()));
    check("...and it is the active tab", state.tabs[0].id === state.activeTabId);

    console.log("\n-- a New Tab page among other tabs, in the middle of the strip");
    tm.createTab("about:blank"); await sleep(600);
    tm.createTab(); await sleep(1200);            // a New Tab page, now active
    check("setup: tabs = file, blank, New Tab (active)", state.tabs.length === 3 && isNtp(urls()[2]), JSON.stringify(urls()));
    openDropped([f2]); await sleep(1500);
    check("the New Tab page is replaced by the file, at its position", state.tabs.length === 3 && /b\.txt$/.test(urls()[2]) && !urls().some(isNtp), JSON.stringify(urls()));

    console.log("\n-- several files at once");
    tm.createTab(); await sleep(1200);
    const n = state.tabs.length;
    openDropped([f1, f2, f3]); await sleep(2000);
    const u = urls();
    check("three files: the blank tab is replaced, so the strip grows by 2 (not 3)", state.tabs.length === n + 2 && !u.some(isNtp), JSON.stringify(u));
    check("in the order dropped, at the blank tab's place", /a\.txt$/.test(u[n - 1]) && /b\.txt$/.test(u[n]) && /c\.txt$/.test(u[n + 1]), JSON.stringify(u));

    console.log("\n-- when the current tab is a real page, nothing is replaced");
    const before = state.tabs.length, cur = urls()[state.tabs.findIndex((t) => t.id === state.activeTabId)];
    tm.createTab("about:blank"); await sleep(800);
    const b2 = state.tabs.length;
    openDropped([f1]); await sleep(1500);
    check("a normal tab is kept: strip grows by 1", state.tabs.length === b2 + 1, JSON.stringify(urls()));
    check("a dropped file that is not openable (.exe) does nothing, the blank tab stays", (() => { tm.createTab(); return true; })() && (await sleep(1200), true) && (() => { const c = state.tabs.length; const r = openDropped([path.join(tmp, "x.exe")]); return r === 0 && state.tabs.length === c && isNtp(urls()[state.tabs.length - 1]); })());

    console.log("\n-- Restricted Mode keeps its own page");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode on", state.restricted === true);
    tm.createTab(undefined, { allowRestricted: true }); await sleep(1200);
    const rc = state.tabs.length;
    openDropped([f1]); await sleep(1500);
    check("the 'Your sites' page is not replaced: the strip grows by 1", state.tabs.length === rc + 1, JSON.stringify(urls()));
    tm.leaveRestricted(); await sleep(500);
    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_DROPBLANK total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
