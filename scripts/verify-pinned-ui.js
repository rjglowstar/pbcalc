// Pinned tabs in the strip: the hover card and the tab widths (owner 2026-10-14: "after closing / restoring a pinned tab the hover card stays", "sometimes a tab
// stays at the pinned size"). Causes found: (1) the strip FREEZES tab widths as an inline style while the pointer is over it (Chrome-like), and an inline width
// beats .pinned - a tab pinned or unpinned during a freeze kept its old size (after a native menu the freeze often never ends); (2) after the browser hid the
// card on a close, the strip still believed a card was showing and showed one at once for whatever tab slid under the pointer; a delayed show could fire for a
// tab that had just gone. The pointer is simulated with the strip's own mouse events (the real mouse is never moved).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-pinned-ui.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 300000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbpu-"));
const ud = path.join(tmp, "UserData");
require("../electron/constants").dataDir = () => ud;
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: false }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, total = 0;
const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 400) + ">" : "")); };

(async () => {
  require("../electron/main.js");
  await app.whenReady();
  const state = require("../electron/state"), tm = require("../electron/tabs/tabManager"), card = require("../electron/hovercard");
  for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);
  const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<title>" + q.url.slice(1) + "</title>x"); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = "http://127.0.0.1:" + srv.address().port + "/";
  const js = (c) => state.mainWindow.webContents.executeJavaScript(c);
  const open = async (n) => { tm.createTab(base + n); await sleep(500); return state.tabs[state.tabs.length - 1]; };
  // the shell element of a tab = the one whose CSS order is the tab's index
  const elExpr = (tab) => `[...document.querySelectorAll(".tab:not(.closing)")].find((e) => e.style.order === "${state.tabs.indexOf(tab)}")`;
  const hover = (tab) => js(`(() => { const el = ${elExpr(tab)}; el.dispatchEvent(new MouseEvent("mouseenter")); return 1; })()`);
  const pointerInStrip = () => js(`document.querySelector(".strip").dispatchEvent(new MouseEvent("mouseenter")); 1`);
  const widths = async () => { await sleep(450); return js(`[...document.querySelectorAll(".tab:not(.closing)")].sort((a, b) => a.style.order - b.style.order).map((e) => ({ p: e.classList.contains("pinned"), w: Math.round(e.getBoundingClientRect().width), fb: e.style.flexBasis }))`); };
  const allRight = (ws) => ws.every((x) => (x.p ? x.w === 48 : x.w > 48));

  for (const n of ["A", "B", "C", "D", "E"]) await open(n);
  await sleep(800);

  console.log("-- the hover card");
  const [a, b, c, d, e] = state.tabs.slice(1);
  tm.pinTab(a.id, true); tm.pinTab(b.id, true); await sleep(500);
  await hover(b); await sleep(1300);
  check("hovering a pinned tab shows its card (setup)", card.isOpen());
  tm.switchTab(b.id); await sleep(200);
  tm.closeTab(b.id); await sleep(1200);
  check("closing that pinned tab hides the card, and it does NOT come back by itself", !card.isOpen());
  await tm.reopenClosedTab(); await sleep(1500);
  const b2 = state.tabs.find((t) => /\/B$/.test(t.url));
  check("restoring it (Ctrl+Shift+T) does not bring a card up by itself", !card.isOpen() && b2 && b2.pinned);
  await hover(c); await sleep(150);
  tm.closeTab(c.id); await sleep(1200);   // closed while the 500 ms delay was still running
  check("a card that was about to show (500 ms delay) for a tab that is then closed never appears", !card.isOpen());
  await hover(d); await sleep(1300);
  check("(card up again for D)", card.isOpen());
  tm.pinTab(d.id, true); await sleep(900);
  check("pinning the hovered tab (it moves) hides the card", !card.isOpen());

  console.log("-- widths while the strip is frozen (pointer over it)");
  await pointerInStrip();
  const victim = await open("V"); await sleep(300);
  await pointerInStrip();
  tm.closeTab(victim.id); await sleep(500);   // a close with the pointer in the strip = the widths are frozen now
  const frozen = await js(`[...document.querySelectorAll(".tab:not(.closing)")].some((e) => e.style.flexBasis !== "")`);
  check("(setup: the strip has frozen the widths)", frozen);
  tm.pinTab(e.id, true);
  let ws = await widths();
  check("a tab pinned while the widths are frozen gets the pinned size at once (48px), no frozen width left on it", ws.filter((x) => x.p).every((x) => x.w === 48 && x.fb === ""), JSON.stringify(ws));
  tm.pinTab(e.id, false);
  ws = await widths();
  check("...and unpinned while the pointer is still there: back to a full width, not stuck at 48px", allRight(ws), JSON.stringify(ws));

  console.log("-- many pinned tabs, closed and restored");
  const more = [];
  for (const n of ["F", "G", "H", "I"]) more.push(await open(n));
  more.forEach((t) => tm.pinTab(t.id, true)); await sleep(400);
  const pinnedOrder = () => state.tabs.filter((t) => t.pinned).map((t) => t.url.split("/").pop()).join(",");
  const before = pinnedOrder();
  tm.closeTab(more[1].id); tm.closeTab(more[2].id); await sleep(800);
  await tm.reopenClosedTab(); await tm.reopenClosedTab(); await sleep(1500);
  ws = await widths();
  check("two pinned tabs closed and restored: both pinned again, in their places (" + before + " -> " + pinnedOrder() + ")", pinnedOrder() === before, pinnedOrder());
  check("...every pinned tab exactly 48px and every other tab wider", allRight(ws), JSON.stringify(ws));
  for (let i = 0; i < 10; i++) tm.pinTab(more[0].id, i % 2 === 0 ? false : true);
  ws = await widths();
  check("ten quick pin / unpin in a row: the widths end right", allRight(ws) && more[0].pinned === true, JSON.stringify(ws));
  check("no tab keeps a frozen width after it all", ws.every((x) => !x.p || x.fb === ""), JSON.stringify(ws));
  check("no hover card left on screen", !card.isOpen());
  srv.close();
  console.log("\nPBCALC_PINUI total=" + total + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
