// MANUAL check with REAL operating-system mouse clicks. Unlike sendInputEvent, these go through
// Windows' native hit test, which is what decides whether a click lands on a button or is eaten as
// a title-bar drag (-webkit-app-region). It caught a bug the other suites could not: the tab's close
// X did nothing for a real user while every synthetic-click test passed.
//
// It MOVES THE MOUSE and briefly shows the window, so it is not part of the normal run. Use:
//   bash scripts/manual-os-click.sh
// (starts this script, then scripts/manual-os-click.ps1 which performs the clicks it asks for.)
const { app, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-os-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");
const CH = process.env.PBCALC_CHANNEL; // directory shared with the .ps1 helper
require("../electron/main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });

app.whenReady().then(async () => {
  await sleep(2500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const popup = require("../electron/popup");
  const win = state.mainWindow;
  win.setBounds({ x: 50, y: 50, width: 1200, height: 800 });
  // Real clicks land on whatever window is on top at that spot: keep this one above everything
  // (other programs, including the editor, otherwise cover it and swallow the clicks).
  win.setAlwaysOnTop(true, "screen-saver");
  win.focus();
  await sleep(800);
  const sh = win.webContents;

  // Ask the helper to click the centre of an element (in the shell page or in the open popup).
  let n = 0;
  async function osClick(wc, selector, opts = {}) {
    const r = await wc.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    if (!r) return false;
    const cb = win.getContentBounds();
    const pt = screen.dipToScreenPoint({ x: Math.round(cb.x + (opts.abs ? 0 : 0) + r.x), y: Math.round(cb.y + r.y) });
    n += 1;
    win.moveTop();
    fs.writeFileSync(path.join(CH, "step.json"), JSON.stringify({ n, x: pt.x, y: pt.y, hoverFirst: !!opts.hoverFirst }));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(CH, "done_" + n)); i++) await sleep(100);
    const cur = screen.getCursorScreenPoint(); // DIP
    const cb2 = win.getContentBounds();
    const hit = await wc.executeJavaScript(`(()=>{const e=document.elementFromPoint(${cur.x - cb2.x},${cur.y - cb2.y});return e?(e.id||e.className||e.tagName):null})()`).catch(() => "?");
    console.log("DBG click", selector, "target", JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y) }), "cursor-rel", JSON.stringify({ x: cur.x - cb2.x, y: cur.y - cb2.y }), "hit", hit, "focused", win.isFocused());
    await sleep(700);
    return true;
  }
  // Move the real cursor over an element without clicking (hover).
  async function osMove(wc, selector) {
    const r = await wc.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const b=e.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2}})()`);
    if (!r) return false;
    const cb = win.getContentBounds();
    const pt = screen.dipToScreenPoint({ x: Math.round(cb.x + r.x), y: Math.round(cb.y + r.y) });
    n += 1;
    fs.writeFileSync(path.join(CH, "step.json"), JSON.stringify({ n, x: pt.x, y: pt.y, mode: "move" }));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(CH, "done_" + n)); i++) await sleep(100);
    return true;
  }
  async function osClickAt(dipX, dipY) {
    const pt = screen.dipToScreenPoint({ x: Math.round(win.getContentBounds().x + dipX), y: Math.round(win.getContentBounds().y + dipY) });
    n += 1;
    fs.writeFileSync(path.join(CH, "step.json"), JSON.stringify({ n, x: pt.x, y: pt.y }));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(CH, "done_" + n)); i++) await sleep(100);
    await sleep(700);
  }
  const popupWc = () => win.getBrowserViews().pop().webContents;

  tm.createTab("https://example.com/");
  tm.createTab("https://example.org/");
  await sleep(2500);

  let before = state.tabs.length;
  await osClick(sh, ".tab.active .tab-close");
  check("OS click on the active tab's X closes the tab", state.tabs.length === before - 1);

  before = state.tabs.length;
  await osClick(sh, "#new-tab");
  check("OS click on + opens a tab", state.tabs.length === before + 1);

  const firstId = state.tabs[0].id;
  await osClick(sh, ".tab:not(.active)");
  check("OS click on an inactive tab activates it", state.activeTabId === firstId || state.activeTabId !== state.tabs[state.tabs.length - 1].id);

  await osClick(sh, "#tab-search");
  await sleep(800);
  check("OS click on the tab-search chevron opens the popup", popup.isOpen("tabsearch"));
  await osClickAt(700, 500); // empty backdrop area
  check("OS click outside closes the popup", !popup.isOpen());

  await osClick(sh, "#menu");
  await sleep(800);
  check("OS click on ⋮ opens the menu", popup.isOpen("menu"));
  before = state.tabs.length;
  await osClick(popupWc(), ".item");
  check("OS click on a menu item (New tab) runs it", state.tabs.length === before + 1 && !popup.isOpen());

  await osClick(sh, "#url-input");
  check("OS click on the omnibox focuses it", (await sh.executeJavaScript("document.activeElement.id")) === "url-input");

  // Tab hover with the REAL cursor: rounded highlight + hover card, no native tooltip
  const hovercard = require("../electron/hovercard");
  await osClickAt(700, 500); // park the cursor away from the tabs
  await sleep(700);
  check("card is closed while the cursor is away", !hovercard.isOpen());
  await osMove(sh, ".tab:not(.active)"); // (the helper itself takes ~500ms, so the 500ms delay is covered by verify-ui)
  await sleep(1200);
  check("hover card appears under the hovered tab (real cursor)", hovercard.isOpen());
  if (process.env.PBCALC_SHOTS) {
    fs.mkdirSync(process.env.PBCALC_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.PBCALC_SHOTS, "hover_shell.png"), (await win.webContents.capturePage({ x: 0, y: 0, width: 900, height: 120 })).toPNG());
    fs.writeFileSync(path.join(process.env.PBCALC_SHOTS, "hover_card.png"), (await win.getBrowserViews().pop().webContents.capturePage()).toPNG());
  }
  await osClickAt(700, 500);
  await sleep(800);
  check("card disappears when the real cursor leaves", !hovercard.isOpen());

  // window dragging from an empty part of the strip must still work (strip stays a drag region)
  const b0 = win.getBounds();
  const gap = await sh.executeJavaScript(`(()=>{const t=document.getElementById("tabs").getBoundingClientRect(),p=document.getElementById("new-tab").getBoundingClientRect();return {x:(p.right+ (window.innerWidth-140))/2, y:20}})()`);
  check("strip has an empty draggable gap right of the + button", gap.x > 0);

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log((r.pass ? "PASS " : "FAIL ") + r.name));
  fs.writeFileSync(path.join(CH, "result.txt"), results.map((r) => (r.pass ? "PASS " : "FAIL ") + r.name).join("\n") + "\nTOTAL " + results.length + " FAILED " + failed.length + "\n");
  fs.writeFileSync(path.join(CH, "done_all"), "1");
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
