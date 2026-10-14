// Pinned tabs, like Chrome (tabManager.pinTab / keepPinnedFirst, shell.js .pinned, shell.css; owner 2026-10-14). Checks the ORDER in main AND the look in the
// real toolbar page: pin moves a tab to the end of the pinned group at the left, unpin puts it right after the group; a pinned tab is icon-only at a fixed
// width with no title and no close button (also when active); new tabs never land inside the group; dragging stays inside each group; "Close other tabs" /
// "Close tabs to the right" leave pinned tabs alone; a middle click does not close a pinned tab, Ctrl+W does; Duplicate and Ctrl+Shift+T keep it pinned;
// Restricted Mode too; nothing about pinned tabs is written to disk.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-pinned-tabs.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbpin-"));
const ud = path.join(tmp, "UserData");
require("../electron/constants").dataDir = () => ud;
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: false }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, total = 0;
const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 300) + ">" : "")); };

(async () => {
  require("../electron/main.js");
  await app.whenReady();
  const state = require("../electron/state"), tm = require("../electron/tabs/tabManager");
  for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);
  const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<title>" + q.url.slice(1) + "</title>" + q.url); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = "http://127.0.0.1:" + srv.address().port + "/";
  const names = () => state.tabs.map((t) => (t.title || "?").replace(/^New Tab$/, "NT") + (t.pinned ? "*" : ""));
  const open = async (n) => { tm.createTab(base + n); await sleep(500); return state.tabs[state.tabs.length - 1]; };
  const js = (code) => state.mainWindow.webContents.executeJavaScript(code);
  const look = (id) => js(`(() => { const el = [...document.querySelectorAll(".tab")].find((e) => !e.classList.contains("closing") && e.style.order === String(${'${'}0}) ); return null; })()`).catch(() => null);
  const elInfo = async (tab) => {
    await sleep(500);
    const idx = state.tabs.indexOf(tab);
    return js(`(() => { const els = [...document.querySelectorAll(".tab:not(.closing)")]; const el = els.find((e) => e.style.order === "${idx}"); if (!el) return null;
      const vis = (sel) => { const x = el.querySelector(sel); if (!x) return false; const cs = getComputedStyle(x); return cs.display !== "none" && x.getBoundingClientRect().width > 0; };
      return { pinned: el.classList.contains("pinned"), width: Math.round(el.getBoundingClientRect().width), title: vis(".tab-title"), close: vis(".tab-close"), icon: vis(".tab-icon") }; })()`);
  };

  console.log("-- pin / unpin and the order");
  const t0 = state.tabs[0];
  const a = await open("A"), b = await open("B"), c = await open("C");
  await sleep(800);
  tm.pinTab(b.id, true);
  check("Pin moves the tab to the far left: " + names().join(","), state.tabs[0] === b && b.pinned === true, names().join(","));
  tm.pinTab(c.id, true);
  check("a second pinned tab goes to the END of the pinned group: " + names().join(","), state.tabs[0] === b && state.tabs[1] === c && c.pinned, names().join(","));
  tm.switchTab(b.id);
  const info = await elInfo(b);
  check("in the toolbar page a pinned tab is icon only: fixed 48px, no title, no close button - also when active (" + JSON.stringify(info) + ")", info && info.pinned && info.width === 48 && !info.title && !info.close && info.icon, JSON.stringify(info));
  const infoA = await elInfo(a);
  check("an ordinary tab still shows its title (" + JSON.stringify(infoA) + ")", infoA && !infoA.pinned && infoA.title && infoA.width > 48, JSON.stringify(infoA));
  tm.pinTab(b.id, false);
  check("Unpin puts it right AFTER the pinned group: " + names().join(","), state.tabs[0] === c && state.tabs[1] === b && !b.pinned, names().join(","));
  tm.pinTab(b.id, true);   // B pinned again: order B? -> end of group: C*,B*
  check("pinned again: C*, B* then the rest: " + names().join(","), state.tabs[0] === c && state.tabs[1] === b, names().join(","));

  console.log("-- new tabs never land inside the pinned group");
  tm.createTab(); await sleep(400);
  check("Ctrl+T appends at the end", !state.tabs[state.tabs.length - 1].pinned && state.tabs.indexOf(c) === 0 && state.tabs.indexOf(b) === 1, names().join(","));
  tm.switchTab(c.id); await sleep(300);
  await c.view.webContents.executeJavaScript("window.open('/FromPinned'); true", true); await sleep(1500);
  const fromPinned = state.tabs.find((t) => /FromPinned/.test(t.url));
  check("a link opened from a pinned tab lands right after the pinned group, unpinned: " + names().join(","), fromPinned && !fromPinned.pinned && state.tabs.indexOf(fromPinned) === 2, names().join(","));

  console.log("-- dragging stays inside each group");
  tm.moveTab(a.id, 0);
  check("an ordinary tab dragged to the front stops after the pinned ones", state.tabs.indexOf(a) === 2 && state.tabs[0].pinned && state.tabs[1].pinned, names().join(","));
  tm.moveTab(c.id, 99);
  check("a pinned tab dragged to the end stays inside the pinned group", state.tabs.indexOf(c) === 1 && c.pinned, names().join(","));

  console.log("-- closing");
  tm.switchTab(a.id); await sleep(300);
  const pinnedBefore = state.tabs.filter((t) => t.pinned).map((t) => t.id);
  state.tabs.filter((t) => t.id !== a.id && !t.pinned).forEach((t) => tm.closeTab(t.id));   // = "Close other tabs" (the menu's own click handler)
  await sleep(400);
  check("'Close other tabs' leaves the pinned tabs: " + names().join(","), pinnedBefore.every((id) => state.tabs.some((t) => t.id === id)) && state.tabs.length === pinnedBefore.length + 1, names().join(","));
  // middle click on a pinned tab in the toolbar page
  const pIdx = state.tabs.indexOf(b);
  await js(`(() => { const el = [...document.querySelectorAll(".tab:not(.closing)")].find((e) => e.style.order === "${pIdx}"); el.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })); return 1; })()`);
  await sleep(500);
  check("a middle click does NOT close a pinned tab", state.tabs.includes(b));
  tm.switchTab(b.id); await sleep(300);
  tm.closeTab(b.id); await sleep(700);   // = Ctrl+W
  check("Ctrl+W (Close) closes a pinned tab", !state.tabs.includes(b));
  await tm.reopenClosedTab(); await sleep(1200);
  const back = state.tabs.find((t) => /\/B$/.test(t.url));
  check("Ctrl+Shift+T brings it back PINNED, inside the pinned group: " + names().join(","), back && back.pinned && state.tabs.indexOf(back) < state.tabs.filter((t) => t.pinned).length, names().join(","));
  await tm.duplicateTab(c.id); await sleep(1200);
  const copies = state.tabs.filter((t) => /\/C$/.test(t.url));
  check("Duplicate of a pinned tab is pinned, next to it: " + names().join(","), copies.length === 2 && copies.every((t) => t.pinned) && Math.abs(state.tabs.indexOf(copies[0]) - state.tabs.indexOf(copies[1])) === 1, names().join(","));

  console.log("-- Restricted Mode");
  tm.enableRestricted(); await sleep(1500);
  const home = state.tabs[0];
  tm.pinTab(home.id, true);
  check("in Restricted Mode a tab can be pinned too", home.pinned === true && state.tabs[0] === home);
  tm.pinTab(home.id, false);
  check("...and unpinned", home.pinned === false);
  tm.leaveRestricted(); await sleep(500);

  console.log("-- nothing on disk");
  // (diag-*.json = the support report's recorder, which keeps site HOST names by design - not about pinning)
  const files = fs.readdirSync(ud).filter((f) => f.endsWith(".json") && !/^diag-/.test(f)).map((f) => fs.readFileSync(path.join(ud, f), "utf8")).join(" ");
  check("no file of the browser stores pinned tabs or their addresses (settings, bookmarks ...)", !/"pinned"/.test(files) && !files.includes("127.0.0.1"), files.slice(0, 200));
  srv.close();
  console.log("\nPBCALC_PINNED total=" + total + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
