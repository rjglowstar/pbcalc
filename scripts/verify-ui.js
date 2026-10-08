// End-to-end UI smoke test against the REAL app (electron/main.js + the real shell page): clicks the
// actual toolbar buttons through the DOM and checks the Chrome-style chrome. It briefly shows the
// real window. Uses a temp userData folder. Optional: PBCALC_SHOTS=<dir> also saves screenshots
// (light and dark) of the chrome and popups.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-ui.js
const { app, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-ui-"));
// main.js sets userData itself (portable folder), so redirect its source instead.
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
let uncaught = [];
process.on("uncaughtException", (e) => { uncaught.push(String(e && e.message)); });
const results = [];
// If a step ever hangs (an awaited page that vanished), say so instead of timing out silently.
setTimeout(() => { console.log("WATCHDOG: test stuck after " + results.length + " checks; uncaught=" + JSON.stringify(uncaught)); app.exit(2); }, 240000).unref();
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.PBCALC_SHOTS;

require("../electron/main.js");

app.whenReady().then(async () => {
  await sleep(4500); // startup can be slow on a busy machine
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const popup = require("../electron/popup");
  const win = state.mainWindow;
  const sh = win.webContents;
  const js = (code) => sh.executeJavaScript(code);
  // PBCalc now opens MAXIMIZED. Everything below measures geometry against the Chrome reference,
  // and sizing a maximized window is a no-op, so put it back to a known, normal window first.
  if (win.isMaximized()) win.unmaximize();
  win.setContentSize(1400, 900);
  await sleep(500);
  // Popups close when the window loses focus (by design). Other programs can steal focus while the
  // suite runs, so take it back before every click.
  const click = (id) => { win.focus(); return js(`document.getElementById("${id}").click(); 0`); };
  // Click a toolbar button until its popup really is open (an earlier popup still closing, or a
  // window blur, can make the first click a no-op or a toggle-off).
  const openVia = async (id, kind) => {
    for (let i = 0; i < 4; i++) {
      await click(id);
      await sleep(1000);
      if (popup.isOpen(kind)) return true;
      if (popup.isOpen()) { popup.close(); await sleep(300); }
    }
    return false;
  };
  const save = async (name, wc) => {
    if (shots) fs.writeFileSync(path.join(shots, name + ".png"), (await wc.capturePage()).toPNG());
  };
  if (shots) fs.mkdirSync(shots, { recursive: true });

  check("window is frameless with native buttons over the tab strip (titleBarStyle hidden)", win.getBounds().width > 0 && !win.isMenuBarVisible());
  check("starts with one New Tab", state.tabs.length === 1 && (await js('document.querySelectorAll(".tab").length')) === 1);
  check("tab title shown", (await js('document.querySelector(".tab-title").textContent')) === "New Tab");
  check("omnibox empty with Chrome placeholder on new tab", (await js('document.getElementById("url-input").value')) === "" && /Ask Google or type a URL/.test(await js('document.getElementById("url-input").placeholder')));
  check("toolbar icons are SVG (back/forward/reload/menu)", (await js('["back","forward","reload","menu","tab-search","new-tab"].every(id=>document.getElementById(id).querySelector("svg"))')) === true);
  check("page view starts below the 112px chrome", state.tabs[0].view.getBounds().y === 112);

  await click("new-tab");
  await sleep(1200);
  check("+ button opens a second tab", state.tabs.length === 2 && (await js('document.querySelectorAll(".tab").length')) === 2);
  check("exactly one tab is active", (await js('document.querySelectorAll(".tab.active").length')) === 1);
  check("new tab focuses the address bar", (await js("document.activeElement.id")) === "url-input");

  // tab search button
  await click("tab-search");
  await sleep(1200);
  // A window blur (anything else grabbing focus while the suite runs) closes popups by design;
  // if that happened, once more.
  if (!popup.isOpen("tabsearch")) { await click("tab-search"); await sleep(1200); }
  check("tab-search button opens the Open Tabs popup", popup.isOpen("tabsearch"));
  await save("light_tabsearch", win.getBrowserViews().pop().webContents);
  popup.close();

  // ⋮ menu
  await openVia("menu", "menu");
  check("⋮ button opens the menu popup", popup.isOpen("menu"));
  await save("light_menu", win.getBrowserViews().pop().webContents);
  popup.close();

  // ── the menu's full-screen button (was: "#autoResize called without owner window" crash) ──
  await openVia("menu", "menu");
  await win.getBrowserViews().pop().webContents.executeJavaScript(`[...document.querySelectorAll(".zoom-row button")].find((b) => /Full screen/.test(b.title)).click(); 0`);
  await sleep(1500);
  check("menu Full screen button enters full screen without an error", win.isFullScreen() === true && uncaught.length === 0 && !popup.isOpen());
  win.setFullScreen(false);
  await sleep(1200);
  check("leaving full screen is clean too", !win.isFullScreen() && uncaught.length === 0);
  // resizing the window with a popup open must close it quietly
  await openVia("menu", "menu");
  if (!popup.isOpen("menu")) { await click("menu"); await sleep(1200); } // a window blur may have closed it
  if (win.isMaximized()) win.unmaximize(); // setSize is a no-op on a maximized window: no resize, no close
  await sleep(200);
  const b0 = win.getBounds();
  win.setSize(b0.width - 60, b0.height - 40);
  await sleep(200);
  if (win.getBounds().width === b0.width) win.setSize(b0.width - 140, b0.height - 90); // make sure it really resized
  for (let i = 0; i < 20 && popup.isOpen(); i++) await sleep(100); // the close is deferred one tick after the resize
  await sleep(300);
  check("resizing the window while a popup is open closes it, no error" + (popup.isOpen() ? " [popup still open]" : "") + (uncaught.length ? " " + JSON.stringify(uncaught) : ""), !popup.isOpen() && uncaught.length === 0);
  win.setSize(b0.width, b0.height);
  await sleep(600);
  await openVia("menu", "menu");
  win.maximize();
  await sleep(1200);
  check("maximizing with a popup open is clean" + (uncaught.length ? " " + JSON.stringify(uncaught) : ""), uncaught.length === 0);
  win.unmaximize();
  await sleep(800);
  if (popup.isOpen()) popup.close();

  // navigate via omnibox
  await js('(()=>{const i=document.getElementById("url-input");i.focus();i.value="example.com";i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));})()');
  await sleep(4000);
  const s = tm.getTabState();
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  check("Enter in omnibox navigates (https assumed)", /^https:\/\/example\.com/.test(active.url));
  check("omnibox shows Chrome-style short address when unfocused", (await js('document.getElementById("url-input").value')) === "example.com");
  check("site info button shows secure state", active.siteKind === "secure");

  // bookmark via the star, bar entry appears, star fills
  await click("bookmark");
  await sleep(600);
  check("star bookmarks the page and the bar shows it", (await js('document.querySelectorAll(".bookmark").length')) === 1 && (await js('document.getElementById("bookmark").classList.contains("on")')) === true);

  // like Chrome, the downloads button is always there
  check("downloads button is visible even with no downloads", (await js('(()=>{const b=document.getElementById("downloads");return !b.hidden && b.getBoundingClientRect().width>0})()')) === true);

  // ── REAL mouse events on the shell (a DOM .click() hid the tab-close bug: mousedown on the
  //    tab re-rendered the strip and the button vanished before mouseup) ──
  // Element centre in the shell. Polls briefly: a tabs:changed re-render replaces the tab elements,
  // and for a moment the freshly drawn one is not ":hover" yet, so a hover-only selector can be absent.
  const center = async (sel) => {
    for (let i = 0; i < 20; i++) {
      const r = await js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
      if (r) return r;
      await sleep(100);
    }
    throw new Error("element not found: " + sel);
  };
  const realClick = async (sel, button = "left") => {
    const p = await center(sel);
    sh.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y });
    await sleep(60);
    sh.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button, clickCount: 1 });
    await sleep(40);
    sh.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button, clickCount: 1 });
    await sleep(500);
  };
  tm.createTab("https://example.com/");
  tm.createTab("https://example.org/");
  await sleep(2500);
  const before = state.tabs.length;
  await realClick(".tab.active .tab-close");
  check("real click on the active tab's X closes it", state.tabs.length === before - 1);
  // Chrome shows the X on every wide tab (no hover needed); check that first, then hover like a user
  check("wide inactive tabs show their close X without hovering (Chrome)", (await js('getComputedStyle(document.querySelector(".tab:not(.active) .tab-close")).display')) === "flex");
  const hp = await center(".tab:not(.active)");
  for (let i = 0; i < 8; i++) {
    sh.sendInputEvent({ type: "mouseMove", x: hp.x - 3, y: hp.y });
    await sleep(40);
    sh.sendInputEvent({ type: "mouseMove", x: hp.x, y: hp.y });
    await sleep(150);
    if (await js('!!document.querySelector(".tab:not(.active):hover")')) break;
  }
  await realClick(".tab:not(.active) .tab-close");
  check("real click on an inactive tab's X closes that tab", state.tabs.length === before - 2);
  tm.createTab("https://example.net/");
  await sleep(1500);
  const firstId = state.tabs[0].id;
  await realClick(".tab:not(.active)");
  check("real click on an inactive tab activates it", state.activeTabId === firstId);
  await realClick("#new-tab");
  check("real click on + opens a tab", state.tabs.length >= 3);

  // ── Chrome-style tab hover: rounded highlight + hover card (no native tooltip) ──
  const hovercard = require("../electron/hovercard");
  check("tabs have no native tooltip (title attribute)", (await js('[...document.querySelectorAll(".tab")].every((t) => !t.hasAttribute("title"))')) === true);
  // real pages only: the blank new-tab page has no site name to show
  const tabAt = (n) => js(`(()=>{const t=[...document.querySelectorAll(".tab")].filter(x=>!x.classList.contains("active") && x.querySelector(".tab-title").textContent!=="New Tab")[${n}];if(!t)return null;const r=t.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),title:t.querySelector(".tab-title").textContent}})()`);
  // start from a clean slate: mouse away from the tabs, any card from earlier steps gone
  sh.sendInputEvent({ type: "mouseMove", x: 600, y: 300 });
  await sleep(700);
  // Synthetic mouse moves are occasionally swallowed while the window is still settling, so move
  // onto the tab until Chromium really reports it as :hover.
  const hoverOn = async (pt) => {
    for (let i = 0; i < 8; i++) {
      sh.sendInputEvent({ type: "mouseMove", x: pt.x - 3, y: pt.y });
      await sleep(40);
      sh.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y });
      await sleep(120);
      if (await js(`!!document.elementFromPoint(${pt.x},${pt.y}).closest(".tab:hover")`)) return true;
    }
    return false;
  };
  const t0 = await tabAt(0);
  check("the mouse can hover a tab", await hoverOn(t0));
  await sleep(150);
  check("hovered inactive tab gets a rounded highlight", (await js(`getComputedStyle(document.elementFromPoint(${t0.x},${t0.y}).closest(".tab").querySelector(".tab-body")).backgroundColor`)) !== "rgba(0, 0, 0, 0)");
  check("no card before the 500ms delay", !hovercard.isOpen());
  await sleep(1100);
  check("hover card appears after the delay", hovercard.isOpen());
  const cardWc = win.getBrowserViews().pop().webContents;
  await sleep(400);
  const card = await cardWc.executeJavaScript('({t: document.getElementById("title").textContent, h: document.getElementById("host").textContent, th: !document.getElementById("thumb").hidden, vis: !document.getElementById("card").hidden})');
  check("card shows the tab's title", card.vis && card.t === t0.title);
  check("card shows the site name and a preview thumbnail", card.h.length > 0 && card.th === true);
  const cb = win.getBrowserViews().pop().getBounds();
  check("card sits just under the tab strip", cb.y >= 40 && cb.y <= 44 && cb.width > 200);
  const t1 = await tabAt(1);
  if (t1) {
    await hoverOn(t1);
    await sleep(450);
    const card2 = await cardWc.executeJavaScript('document.getElementById("title").textContent');
    check("moving to the next tab swaps the card at once (no 500ms wait)", hovercard.isOpen() && card2 === t1.title);
  }
  // Chrome shows no preview for the active tab — that page is already on screen.
  const ta = await js('(()=>{const t=document.querySelector(".tab.active");const r=t.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),title:t.querySelector(".tab-title").textContent}})()');
  await hoverOn(ta);
  await sleep(1100);
  const cardA = await cardWc.executeJavaScript('({t: document.getElementById("title").textContent, th: !document.getElementById("thumb").hidden})');
  check("hovering the ACTIVE tab shows its card without a thumbnail", hovercard.isOpen() && cardA.t === ta.title && cardA.th === false);
  check("the card is the short (no-preview) size for the active tab", win.getBrowserViews().pop().getBounds().height < 100);
  sh.sendInputEvent({ type: "mouseMove", x: 600, y: 300 });
  await sleep(600);
  check("card disappears when the mouse leaves the tabs", !hovercard.isOpen());
  await hoverOn(t0);
  await sleep(1100);
  sh.sendInputEvent({ type: "mouseDown", x: t0.x, y: t0.y, button: "left", clickCount: 1 });
  sh.sendInputEvent({ type: "mouseUp", x: t0.x, y: t0.y, button: "left", clickCount: 1 });
  await sleep(500);
  check("clicking a tab hides the card", !hovercard.isOpen());
  sh.sendInputEvent({ type: "mouseMove", x: 600, y: 300 });
  await sleep(400);

  // ── Tab strip geometry vs REAL Chrome 153 (numbers measured from screenshots of Chrome itself;
  //    see scripts/chrome-reference/measure.js for the probes and the reference values) ──
  const ref = require("./chrome-reference/measure");
  const setTabCount = async (n) => {
    while (state.tabs.length > n) tm.closeTab(state.tabs[state.tabs.length - 1].id);
    while (state.tabs.length < n) tm.createTab("about:blank");
    await sleep(1500);
    tm.switchTab(state.tabs[0].id);
    await sleep(700);
  };
  const strip = async () => {
    await win.webContents.capturePage({ x: 0, y: 0, width: 10, height: 10 }); // discard a possibly stale first frame
    await sleep(250);
    return ref.makeProbe(await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 44 }));
  };
  // park the mouse, fix the content width to Chrome's test window (1200) and start from 3 about:blank tabs
  sh.sendInputEvent({ type: "mouseMove", x: 700, y: 300 });
  // PBCalc opens maximized now, and sizing a maximized window does nothing — the whole Chrome
  // geometry comparison below depends on the content being exactly 1200 wide.
  if (win.isMaximized()) { win.unmaximize(); await sleep(400); }
  const oldSize = win.getContentSize();
  win.setContentSize(1200, oldSize[1]);
  await sleep(600);
  await setTabCount(3);
  // the title text is part of the measurement: every tab must be a plain about:blank page
  for (const t of state.tabs) t.view.webContents.loadURL("about:blank").catch(() => {});
  for (let i = 0; i < 60 && !tm.getTabState().tabs.every((t) => t.title === "about:blank"); i++) await sleep(150);
  for (const mode of ["light", "dark"]) {
    nativeTheme.themeSource = mode;
    await sleep(1500);
    const pal = mode === "light"
      ? { frame: "D3E3FD", toolbar: "FFFFFF", btn: "ECF3FE", sep: "A8C7FA", hover: "A8C7FA" }
      : { frame: "1F2020", toolbar: "3C3C3C", btn: "3C3C3C", sep: "3C3C3C", hover: "004A77" };
    if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, "strip_" + mode + ".png"), (await win.webContents.capturePage({ x: 0, y: 0, width: 900, height: 44 })).toPNG()); }
    const m = ref.measureStrip(await strip(), pal);
    const near = (got, want, tol) => got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= tol);
    check(`[${mode}] frame colour = Chrome's (${pal.frame})`, m.frameAt === pal.frame);
    check(`[${mode}] active tab body x 48..280 (232 wide) like Chrome`, m.activeBody.left === 48 && m.activeBody.right === 280);
    check(`[${mode}] active tab top-corner radius 10 (insets 7 5 3 2 2 1 1 0)`, near(m.cornerInsets, [7, 5, 3, 2, 2, 1, 1, 0], 0));
    check(`[${mode}] active tab bottom flares radius ~12 (Chrome 1 1 1 2 3 3 5 6 9, ±1)`, near(m.flare, [1, 1, 1, 2, 3, 3, 5, 6, 9], 1));
    check(`[${mode}] tab-search button is a 28px rounded square at x14..41 y6..33`, m.searchBtn.x0 === 14 && m.searchBtn.x1 === 41 && m.searchBtn.y0 === 6 && m.searchBtn.y1 === 33);
    check(`[${mode}] favicon ink box x57..70 y13..26`, m.favicon && m.favicon.x0 === 57 && m.favicon.x1 === 70 && m.favicon.y0 === 13 && m.favicon.y1 === 26);
    check(`[${mode}] title ink starts at x81 (±1) and sits on rows 16..24 (got ${JSON.stringify(m.title)})`, m.title && Math.abs(m.title.x0 - 81) <= 1 && m.title.y0 === 16 && m.title.y1 === 24); // ±1px: text anti-aliasing differs from Chrome's by a hair
    check(`[${mode}] close X ink box x260..267 y16..23`, m.closeX && m.closeX.x0 === 260 && m.closeX.x1 === 267 && m.closeX.y0 === 16 && m.closeX.y1 === 23);
    const rest = ref.measureRest(await strip(), pal);
    check(`[${mode}] separators 2x16 at x520..521 y12..27 (hidden next to the active tab)`, rest.sepCols[1] && rest.sepCols[2] && !rest.sepCols[0] && !rest.sepCols[3] && rest.sepRows.y0 === 12 && !rest.sepAfterActive);
    check(`[${mode}] + glyph ink box x771..780 y15..24`, rest.plus && rest.plus.x0 === 771 && rest.plus.x1 === 780 && rest.plus.y0 === 15 && rest.plus.y1 === 24);
    // hover the 2nd tab with the mouse
    // Synthetic mouse moves are sometimes swallowed or land a frame late while the window settles, so
    // hover + measure up to 4 times until Chromium really shows tab 2 hovered.
    let hv = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      sh.sendInputEvent({ type: "mouseMove", x: 700, y: 300 });
      await sleep(300);
      const t2 = await js(`(()=>{const r=document.querySelectorAll(".tab")[1].getBoundingClientRect();return {x:Math.round(r.left+r.width/2)}})()`);
      for (let i = 0; i < 6; i++) { sh.sendInputEvent({ type: "mouseMove", x: t2.x - 3, y: 20 }); await sleep(40); sh.sendInputEvent({ type: "mouseMove", x: t2.x, y: 20 }); await sleep(180); }
      await sleep(350);
      hv = ref.measureHover(await strip(), pal);
      if (hv.pillRows.y0 === 6 && hv.pillCols.l === 286) break;
    }
    check(`[${mode}] hovered inactive tab = rounded pill y6..33 (28 tall), x286..517 (got ${JSON.stringify(hv.pillRows)} ${JSON.stringify(hv.pillCols)})`, hv.pillRows.y0 === 6 && hv.pillRows.y1 === 33 && hv.pillCols.l === 286 && hv.pillCols.r === 517);
    check(`[${mode}] hover pill radius 10 on all corners (insets 7 5 3 2 2 1 1 0)`, near(hv.cornerInsets, [7, 5, 3, 2, 2, 1, 1, 0], 0));
    sh.sendInputEvent({ type: "mouseMove", x: 700, y: 300 });
    await sleep(700);

    // Address bar colours, measured from Chrome 153: rest / hover fill and the focus ring
    const omni = () => js(`(()=>{const o=document.getElementById("omnibox"),c=getComputedStyle(o);return {bg:c.backgroundColor,shadow:c.boxShadow}})()`);
    const want = mode === "light"
      ? { rest: "rgb(237, 242, 250)", hover: "rgb(225, 230, 237)", ring: "rgb(11, 87, 208)", focusBg: "rgb(255, 255, 255)" }
      : { rest: "rgb(40, 40, 40)", hover: "rgb(40, 40, 40)", ring: "rgb(168, 199, 250)", focusBg: "rgb(60, 60, 60)" };
    check(`[${mode}] address bar rest background = Chrome's ${want.rest}`, (await omni()).bg === want.rest);
    let hovered = null;
    for (let i = 0; i < 6 && !(hovered && hovered.bg === want.hover); i++) {
      sh.sendInputEvent({ type: "mouseMove", x: 597, y: 60 });
      await sleep(40);
      sh.sendInputEvent({ type: "mouseMove", x: 600, y: 60 });
      await sleep(250);
      hovered = await omni();
    }
    check(`[${mode}] address bar hover background = Chrome's ${want.hover}`, hovered.bg === want.hover);
    sh.sendInputEvent({ type: "mouseMove", x: 700, y: 300 });
    await js('document.getElementById("url-input").focus(); 0');
    await sleep(300);
    const foc = await omni();
    check(`[${mode}] focused address bar = toolbar fill + 2px ring ${want.ring}`, foc.bg === want.focusBg && foc.shadow.includes(want.ring) && /\b2px\b/.test(foc.shadow));
    await js('document.getElementById("url-input").blur(); 0');
    await sleep(200);
    if (shots) fs.writeFileSync(path.join(shots, "toolbar_" + mode + ".png"), (await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 110 })).toPNG());
  }
  nativeTheme.themeSource = "light";
  await sleep(1200);

  // how tabs shrink, compared with Chrome's behaviour at each tab count (1200px window):
  // [N, Chrome's slot pitch, active: favicon/title/X, inactive: favicon/title/X]
  const shrink = [
    [8, 116, [1, 1, 1], [1, 1, 1]],
    [10, 93, [1, 1, 1], [1, 1, 1]],
    [11, 84, [1, 1, 1], [1, 1, 0]],
    [14, 66, [1, 0, 1], [1, 1, 0]],
    [18, 52, [1, 0, 1], [1, 1, 0]],
    [20, 47, [0, 0, 1], [1, 0, 0]],
    [24, 39, [0, 0, 1], [1, 0, 0]],
  ];
  for (const [n, pitch, act, inact] of shrink) {
    await setTabCount(n);
    const got = await js(`(()=>{const t=[...document.querySelectorAll(".tab")];return {pitch:Math.round(t[1].getBoundingClientRect().left-t[0].getBoundingClientRect().left), bl0:t[0].getBoundingClientRect().left+3, bl1:t[1].getBoundingClientRect().left+3, w:t[0].getBoundingClientRect().width-6}})()`);
    const p = await strip();
    const toolbar = p.rgb("FFFFFF"), frame = p.rgb("D3E3FD");
    const has = (x0, x1, bg) => !!ref.inkBox(p, Math.round(x0), Math.round(x1) - 1, 10, 30, (col) => p.dist(col, bg) > 120);
    const w = got.w;
    const aL = got.bl0, iL = got.bl1;
    const ak = [has(aL + 8, Math.min(aL + 24, aL + w - 24), toolbar), has(aL + 32, aL + w - 32, toolbar), has(aL + w - 24, aL + w - 8, toolbar)].map(Number);
    const ik = [has(iL + 8, iL + (n <= 10 ? Math.min(24, w - 24) : 24), frame), has(iL + 32, iL + w - (n <= 10 ? 32 : 8), frame), has(iL + w - 24, iL + w - 8, frame)].map(Number);
    check(`[N=${n}] tab pitch ${got.pitch} = Chrome's ${pitch} (±1)`, Math.abs(got.pitch - pitch) <= 1);
    check(`[N=${n}] active tab shows favicon/title/X = ${act.join("/")} like Chrome (got ${ak.join("/")})`, ak.join() === act.join());
    // the inactive X region can overlap the title when there is no X, so only the favicon and X presence are compared there
    check(`[N=${n}] inactive tab shows favicon=${inact[0]} and close X=${inact[2]} like Chrome (got ${ik[0]}/${ik[2]})`, ik[0] === inact[0] && (n <= 10 ? ik[2] === 1 : true) && (n > 10 ? (await js(`getComputedStyle(document.querySelectorAll(".tab")[1].querySelector(".tab-close")).display`)) === "none" : true));
  }
  win.setContentSize(oldSize[0], oldSize[1]);
  await sleep(500);
  await setTabCount(1);

  // ── many tabs: layout must stay usable like Chrome ──
  while (state.tabs.length < 30) tm.createTab();
  await sleep(1500);
  // Creating 30 tabs in a tight loop runs the strip through its width-lock / FLIP animation; once
  // in a while the sample below landed while every tab still measured 0 and three checks failed on
  // a layout that was simply not settled yet. Wait for real widths before measuring.
  for (let i = 0; i < 30; i++) {
    const w = await js('Math.min(...[...document.querySelectorAll(".tab")].map(t=>t.getBoundingClientRect().width))');
    if (w > 0) break;
    await sleep(200);
  }
  const lay = await js(`(()=>{
    const tabs=[...document.querySelectorAll(".tab")];
    const strip=document.getElementById("tabs");
    const vis=(el)=>getComputedStyle(el).display!=="none";
    const inactive=tabs.filter(t=>!t.classList.contains("active"));
    const active=document.querySelector(".tab.active");
    const ar=active.getBoundingClientRect();
    const closeEl=active.querySelector(".tab-close");
    const cr=closeEl.getBoundingClientRect();
    const hit=document.elementFromPoint(cr.left+cr.width/2, cr.top+cr.height/2);
    return {
      n:tabs.length,
      minW:Math.min(...tabs.map(t=>t.getBoundingClientRect().width)),
      inactiveIconsVisible:inactive.every(t=>vis(t.querySelector(".tab-icon"))),
      inactiveCloseHidden:inactive.every(t=>!vis(t.querySelector(".tab-close"))),
      activeCloseVisible:vis(closeEl),
      activeCloseHittable:!!hit && !!hit.closest(".tab-close"),
      iconCentered: inactive.every(t=>{const r=t.getBoundingClientRect(),i=t.querySelector(".tab-icon").getBoundingClientRect();return Math.abs((i.left+i.width/2)-(r.left+r.width/2))<3 || r.width>60;}),
      stripFitsWindow: strip.getBoundingClientRect().right <= window.innerWidth,
      activeInView: ar.left>=strip.getBoundingClientRect().left-1 && ar.right<=strip.getBoundingClientRect().right+1
    };
  })()`);
  check("30 tabs open", lay.n === 30);
  check("no tab collapses below 24px", lay.minW >= 24);
  check("30 tabs: every inactive tab still shows its favicon", lay.inactiveIconsVisible);
  check("30 tabs: inactive tabs hide their close button", lay.inactiveCloseHidden);
  check("30 tabs: narrow inactive favicons are centred", lay.iconCentered);
  // What the active tab shows depends on how narrow it got; both bands are measured Chrome
  // (scripts/chrome-reference/README.md, "Narrow tabs"): 36-48px = X only, favicon dropped;
  // at its floor (<= 35px) = favicon at rest and the X on hover. How wide it actually lands here
  // depends on the window width, so key the expectation on the measured width rather than on an
  // assumed band — an earlier hard-coded 40px boundary disagreed with both bands at w=38.
  const activeRect = await js('(()=>{const r=document.querySelector(".tab.active").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width)}})()');
  console.log("     30 tabs: active w=" + activeRect.w + " closeVisible=" + lay.activeCloseVisible + " minW=" + Math.round(lay.minW));
  check("30 tabs: the active tab's close X at rest follows Chrome's width bands", lay.activeCloseVisible === (activeRect.w > 35));
  let xOnHover = false;
  for (let i = 0; i < 10 && !xOnHover; i++) {
    sh.sendInputEvent({ type: "mouseMove", x: activeRect.x - 2, y: activeRect.y });
    await sleep(50);
    sh.sendInputEvent({ type: "mouseMove", x: activeRect.x, y: activeRect.y });
    await sleep(120);
    xOnHover = await js('(()=>{const a=document.querySelector(".tab.active");const c=a.querySelector(".tab-close");const r=c.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return getComputedStyle(c).display!=="none" && !!hit && !!hit.closest(".tab-close")})()');
  }
  check("30 tabs: hovering the active tab reveals a clickable close X", xOnHover);
  check("30 tabs: strip does not push past the window buttons", lay.stripFitsWindow);
  check("30 tabs: active tab scrolled into view", lay.activeInView);
  await save("light_30tabs", sh);
  await realClick(".tab.active .tab-close");
  check("30 tabs: real click on the active tab's X still closes it", state.tabs.length === 29);
  while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
  await sleep(600);

  // ── menu: check mark must not indent the label (was an empty gutter before the label) ──
  await openVia("menu", "menu");
  const menuWc = win.getBrowserViews().pop().webContents;
  const lefts = await menuWc.executeJavaScript(`[...document.querySelectorAll(".item .label")].map(l=>({t:l.textContent,x:Math.round(l.getBoundingClientRect().left)}))`);
  const dl = lefts.find((l) => l.t === "Downloads");
  const bb = lefts.find((l) => l.t === "Show bookmarks bar");
  check("'Show bookmarks bar' label aligns with the other menu labels", dl && bb && dl.x === bb.x);
  check("menu has a Settings entry", lefts.some((l) => l.t === "Settings"));
  popup.close();

  // ── zoom chip ──
  tm.zoom(1);
  await sleep(500);
  check("zoom chip appears in the omnibox when zoom is not 100%", (await js('!document.getElementById("zoom").hidden && /%$/.test(document.getElementById("zoom").textContent)')) === true);
  await realClick("#zoom");
  check("clicking the zoom chip resets zoom", (await js('document.getElementById("zoom").hidden')) === true);

  // ── settings page: open from the menu, switch Mode ──
  popup.open("menu", null);
  await sleep(1000);
  popup.handleAction("settings");
  await sleep(1800);
  const sTab = state.tabs.find((t) => t.id === state.activeTabId);
  const swc = sTab.view.webContents;
  check("Settings opens in a tab titled Settings, address pbcalc://settings", swc.getTitle() === "Settings" && (await js('document.getElementById("url-input").value')) === "pbcalc://settings");
  check("settings page has the API only here", (await swc.executeJavaScript("typeof window.settingsAPI")) === "object");
  const before2 = state.tabs.length;
  popup.open("menu", null);
  await sleep(800);
  popup.handleAction("settings");
  await sleep(600);
  check("Settings reuses its existing tab", state.tabs.length === before2);
  await swc.executeJavaScript('document.querySelector("#mode [data-mode=dark]").click(); 0');
  await sleep(1000);
  check("Mode: Dark switches the whole UI to dark", nativeTheme.themeSource === "dark" && (await js('getComputedStyle(document.documentElement).getPropertyValue("--frame").trim()')) === "#1f2020");
  check("Mode choice persisted to settings.json", JSON.parse(fs.readFileSync(path.join(tmp, "UserData", "settings.json"), "utf8")).themeMode === "dark");
  await save("dark_settings", swc);
  await swc.executeJavaScript('document.querySelector("#mode [data-mode=light]").click(); 0');
  await sleep(800);
  check("Mode: Light switches back", nativeTheme.themeSource === "light" && (await js('getComputedStyle(document.documentElement).getPropertyValue("--frame").trim()')) === "#d3e3fd");
  await swc.executeJavaScript('document.querySelector("#mode [data-mode=system]").click(); 0');
  await sleep(500);
  check("Mode: Device follows the OS", nativeTheme.themeSource === "system");
  // the switch must follow changes made elsewhere while the Settings page is open
  const sw = () => swc.executeJavaScript('document.getElementById("bookmarks-bar").getAttribute("aria-checked")');
  tm.toggleBookmarksBar(); // e.g. Ctrl+Shift+B / ⋮ menu
  await sleep(500);
  check("Settings switch follows the bookmarks bar toggled elsewhere (live)", (await sw()) === (state.bookmarksBarVisible ? "true" : "false"));
  tm.toggleBookmarksBar();
  await sleep(500);
  check("...and back", (await sw()) === (state.bookmarksBarVisible ? "true" : "false"));
  await swc.executeJavaScript('document.getElementById("bookmarks-bar").click(); 0');
  await sleep(500);
  check("settings toggle hides the bookmarks bar", state.bookmarksBarVisible === false && (await js('document.getElementById("bookmark-bar").hidden')) === true);
  await swc.executeJavaScript('document.getElementById("bookmarks-bar").click(); 0');
  await sleep(500);
  await js('(()=>{const i=document.getElementById("url-input");i.focus();i.value="pbcalc://newtab";i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));})()');
  await sleep(1200);
  check("typing pbcalc://newtab opens the new tab page", (await tm.getActiveTab().view.webContents.executeJavaScript("typeof window.settingsAPI")) === "undefined");


  const sh2 = sh;
  nativeTheme.themeSource = "dark";
  await sleep(800);
  check("dark theme flips the palette", (await js('getComputedStyle(document.documentElement).getPropertyValue("--frame").trim()')) === "#1f2020");
  await save("dark_chrome", sh);
  await openVia("menu", "menu");
  await save("dark_menu", win.getBrowserViews().pop().webContents);
  popup.close();
  nativeTheme.themeSource = "light";
  await sleep(500);
  check("light theme flips back", (await js('getComputedStyle(document.documentElement).getPropertyValue("--frame").trim()')) === "#d3e3fd");

  // ── last tab closes the window (Chrome) ──
  app.removeAllListeners("window-all-closed"); // main.js would quit right away, before we print
  while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
  tm.closeTab(state.tabs[0].id);
  await sleep(800);
  check("closing the last tab closes the window like Chrome", win.isDestroyed());

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log((r.pass ? "PASS " : "FAIL ") + r.name));
  console.log("PBCALC_UI total=" + results.length + " failed=" + failed.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
