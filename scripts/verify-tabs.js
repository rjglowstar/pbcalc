// Focused test: the tab strip is patched (never rebuilt), so favicons stay put and Chrome's
// open/close animations can run; plus Duplicate carrying the back/forward history.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-tabs.js
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

// capturePage needs the window not to be treated as occluded (it is never brought to the front)
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-tabs-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); } return false; };
setTimeout(() => { console.log("WATCHDOG after " + results.length); app.exit(2); }, 120000).unref();

// A tiny site with a real <link rel=icon>, and pages that keep firing title updates so the strip
// is pushed a lot (that churn is what used to blank the favicons).
const ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    if (req.url === "/icon.png") { res.setHeader("content-type", "image/png"); return res.end(ICON); }
    if (req.url.startsWith("/app")) {
      // Like the PB ERP: the session lives in sessionStorage, not in a cookie. No token -> login.
      res.setHeader("content-type", "text/html");
      return res.end(`<!doctype html><html><head><title>App</title></head><body>
        <div id="out">?</div>
        <script>
          const t = sessionStorage.getItem("authToken");
          document.getElementById("out").textContent = t ? "DASHBOARD " + t : "LOGIN PAGE";
          document.title = t ? "Dashboard" : "Login";
        </script></body></html>`);
    }
    const n = req.url.replace(/\D/g, "") || "0";
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html><head><link rel="icon" href="/icon.png"><title>Page ${n}</title></head>
      <body>page ${n}<script>let i=0;setInterval(()=>{document.title="Page ${n} "+(++i)},120)</script></body></html>`);
  });
  srv.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + srv.address().port; resolve(); });
});

require("../electron/main.js");

app.whenReady().then(async () => {
  await ready;
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const win = state.mainWindow;
  const js = (c) => win.webContents.executeJavaScript(c);
  const tabsInfo = () => js('[...document.querySelectorAll(".tab")].map((t)=>({id:t.style.order,img:!!t.querySelector(".tab-icon img"),src:(t.querySelector(".tab-icon img")||{}).src||"",title:t.querySelector(".tab-title").textContent,closing:t.classList.contains("closing"),w:Math.round(t.getBoundingClientRect().width),active:t.classList.contains("active")}))');

  // ── favicons survive a busy page ──
  // Target the SITE's tab by its title: every tab has an icon now (our own pages ship one too),
  // so "the first tab with an <img>" is no longer the page under test.
  const siteTab = '[...document.querySelectorAll(".tab")].filter((t)=>/^Page /.test(t.querySelector(".tab-title").textContent))[0]';
  const siteIdx = async () => (await tabsInfo()).findIndex((t) => /^Page /.test(t.title));
  tm.createTab(base + "/1");
  await until(async () => js(`!!(${siteTab} && ${siteTab}.querySelector(".tab-icon img"))`));
  await js(`${siteTab}.querySelector(".tab-icon img").dataset.mark = "x"; 0`);
  const i0 = await siteIdx();
  const before = (await tabsInfo())[i0].title;
  await sleep(1500); // ~12 title pushes from the page
  const info = await tabsInfo();
  check("the title keeps updating (the strip really is being pushed)", info[i0].title !== before);
  check("the favicon is still shown after all those updates", info[i0].img && /icon\.png$/.test(info[i0].src));
  check("...and it is the SAME <img>, never re-created", (await js(`${siteTab}.querySelector(".tab-icon img").dataset.mark`)) === "x");

  // ── reloading keeps the favicon and the title (Chrome) ──
  const site1 = state.tabs[state.tabs.length - 1];
  const favBefore = site1.favicon;
  check("the page has a favicon before the reload", !!favBefore);
  site1.view.webContents.reload();
  await sleep(2000);
  check("BUG 1: the favicon survives a reload", site1.favicon === favBefore);
  check("...and the strip still draws it", (await tabsInfo()).some((t) => /icon\.png$/.test(t.src)));

  // the New Tab page: a reload must not turn its title into the file path
  tm.createTab();
  await sleep(1200);
  const nt = state.tabs[state.tabs.length - 1];
  check("the new tab is called 'New Tab'", nt.title === "New Tab");
  nt.view.webContents.reload();
  await sleep(1500);
  check("BUG 2: it is still 'New Tab' after a reload, not a file path", nt.title === "New Tab" && !/Project|\.html/.test(nt.title));
  check("...and the strip shows that too", (await tabsInfo()).some((t) => t.title === "New Tab"));
  tm.closeTab(nt.id);
  await sleep(300);

  // ── a duplicated tab shows its favicon too ──
  const tabA = state.tabs[state.tabs.length - 1];
  tm.navigate(base + "/2");
  await sleep(1200);
  tm.navigate(base + "/3");
  await sleep(1200);
  tm.duplicateTab(tabA.id);
  await sleep(2500);
  const dup = state.tabs.find((t) => t.id !== tabA.id && t.url.startsWith(base));
  check("Duplicate opens a copy", !!dup && dup.url === tabA.url);
  check("the copy sits right after the original (Chrome)", state.tabs.indexOf(dup) === state.tabs.indexOf(tabA) + 1);
  const dupInfo = (await tabsInfo()).find((t) => t.active);
  check("the duplicated tab shows its favicon", dupInfo && dupInfo.img);

  // ── Duplicate carries the back/forward history ──
  const nav = dup.view.webContents.navigationHistory;
  check("the copy can go Back, like Chrome's Duplicate", nav.canGoBack() === true);
  check("the copy has the whole history, not just one entry", nav.getAllEntries().length >= 3);
  nav.goBack();
  await sleep(1200);
  check("going Back in the copy lands on the previous page", dup.view.webContents.getURL() === base + "/2");

  // ── a duplicated tab keeps the login the site kept in sessionStorage ──
  tm.createTab(base + "/app");
  await sleep(1500);
  const appTab = state.tabs.find((t) => t.url.startsWith(base + "/app"));
  check("the app starts logged OUT", /LOGIN PAGE/.test(await appTab.view.webContents.executeJavaScript("document.body.innerText")));
  await appTab.view.webContents.executeJavaScript('sessionStorage.setItem("authToken","abc123"); location.reload(); 0');
  await sleep(1500);
  check("...and logged IN once it has its token", /DASHBOARD abc123/.test(await appTab.view.webContents.executeJavaScript("document.body.innerText")));
  await tm.duplicateTab(appTab.id);
  await sleep(2000);
  const appCopy = state.tabs.find((t) => t.id !== appTab.id && t.url.startsWith(base + "/app"));
  check("the copy exists", !!appCopy);
  const copyText = await appCopy.view.webContents.executeJavaScript("document.body.innerText");
  check("THE FIX: the duplicate is still logged in (sessionStorage came across)", /DASHBOARD abc123/.test(copyText));
  check("the original is untouched", /DASHBOARD abc123/.test(await appTab.view.webContents.executeJavaScript("document.body.innerText")));
  // a plain new tab must NOT inherit anything
  tm.createTab(base + "/app");
  await sleep(1500);
  const plain = state.tabs[state.tabs.length - 1];
  check("a NEW tab on the same site is still logged out", /LOGIN PAGE/.test(await plain.view.webContents.executeJavaScript("document.body.innerText")));
  check("the hand-over was consumed, nothing is left pending", state.pendingSessionRestore.size === 0);
  tm.closeTab(plain.id);
  tm.closeTab(appCopy.id);
  await sleep(400);

  // ── open / close animation ──
  // Sampling "the width 60ms after createTab" is a race against IPC latency, so instead the shell
  // records the last tab's width every frame and the samples are read afterwards: that captures
  // the whole animation no matter how long the message took to arrive.
  const startSampler = () => js(`(() => {
    window.__s = [];
    const tick = () => {
      const t = document.querySelectorAll(".tab");
      const last = t[t.length - 1];
      if (last) window.__s.push(Math.round(last.getBoundingClientRect().width));
      if (window.__s.length < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return 0;
  })()`);
  const samples = () => js("window.__s");

  await startSampler();
  const n0 = state.tabs.length;
  tm.createTab(base + "/4");
  await sleep(1200);
  const grow = await samples();
  const settled = (await tabsInfo())[0].w;
  check("a new tab grows from nothing instead of appearing at full size",
    grow.length > 5 && Math.min(...grow) < settled * 0.5 && new Set(grow).size > 3);
  check("...and ends at the same width as its neighbours", Math.abs(grow[grow.length - 1] - settled) <= 2);
  const tabTr = await js('(()=>{const c=getComputedStyle(document.querySelector(".tab"));return {d:c.transitionDuration,f:c.transitionTimingFunction,p:c.transitionProperty}})()');
  check("the open/close transition is the measured 200ms ease-out",
    /0\.2s/.test(tabTr.d) && /cubic-bezier\(0, 0, 0\.58, 1\)|ease-out/.test(tabTr.f) && /flex-basis/.test(tabTr.p));

  const victim = state.tabs[state.tabs.length - 1];
  tm.closeTab(victim.id);
  await sleep(80);
  const closing = (await tabsInfo()).filter((t) => t.closing);
  check("a closed tab stays in the strip while it shrinks away", closing.length === 1);
  check("the main process has already dropped it", state.tabs.length === n0);
  check("the shrinking tab is gone once the animation is over", await until(async () => (await tabsInfo()).every((t) => !t.closing), 2000));

  // ── closing a tab: what the OTHER tabs do, frame by frame (compared with Chrome) ──
  // Start/end states are not enough here: the strip used to squeeze every tab for a moment and
  // then grow back, and freezing used to jump to full width first. Record every frame.
  const recordWidths = (ms = 900) => js(`(() => {
    window.__cw = [];
    const t0 = performance.now();
    const tick = () => {
      window.__cw.push([...document.querySelectorAll(".tab:not(.closing)")].map((t) => Math.round(t.getBoundingClientRect().width)));
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return 0;
  })()`);
  const widthFrames = () => js("window.__cw");

  // (a) pointer OUTSIDE the strip: the others only ever grow, never squeeze first
  while (state.tabs.length < 5) { tm.createTab(base + "/8"); await sleep(300); }
  await sleep(900);
  const widthOf = () => js('Math.round(document.querySelectorAll(".tab")[0].getBoundingClientRect().width)');
  const wBefore = await widthOf();
  await recordWidths();
  tm.closeTab(state.tabs[2].id);
  await sleep(1100);
  const framesA = (await widthFrames()).filter((f) => f.length);
  const minSeen = Math.min(...framesA.map((f) => Math.min(...f)));
  check("closing a tab never squeezes the others first", minSeen >= wBefore - 1);
  check("...they only grow into the freed space", Math.max(...framesA[framesA.length - 1]) >= wBefore);

  // (b) pointer IN the strip, tabs compressed: Chrome keeps every width exactly as it was
  while (state.tabs.length < 10) { tm.createTab(base + "/9"); await sleep(250); }
  await sleep(900);
  check("with that many tabs the strip is compressed", await until(async () => (await widthOf()) < 238, 4000));
  const w8 = await widthOf();
  await js('document.querySelector(".strip").dispatchEvent(new MouseEvent("mouseenter")); 0'); // pointer in the strip
  await recordWidths();
  tm.closeTab(state.tabs[3].id);
  await sleep(1100);
  const framesB = (await widthFrames()).filter((f) => f.length);
  check("closing with the pointer in the strip does NOT re-widen the others", (await widthOf()) === w8);
  check("...and they never even flicker: every frame is the frozen width",
    framesB.every((f) => f.every((w) => Math.abs(w - w8) <= 1)));

  // (c) pointer leaves: ~330ms pause, then an animated expansion (not a snap)
  await recordWidths(1000);
  await js('document.querySelector(".strip").dispatchEvent(new MouseEvent("mouseleave")); 0');
  await sleep(1200);
  const framesC = (await widthFrames()).filter((f) => f.length);
  const first = framesC[0][0];
  const held = framesC.findIndex((f) => Math.abs(f[0] - first) > 1);
  check("...they still hold during Chrome's ~330ms pause", held > 12); // >12 frames at ~16ms
  check("...and then expand", (await widthOf()) > w8);
  const distinct = new Set(framesC.map((f) => f[0]));
  check("...the expansion is animated, not a snap", distinct.size >= 4);

  // ── hover fade uses the measured curves ──
  const hov = await js('(()=>{const b=document.querySelector(".tab:not(.active) .tab-body");const c=getComputedStyle(b);return {d:c.transitionDuration,f:c.transitionTimingFunction}})()');
  console.log("     hover transition = " + JSON.stringify(hov));
  check("hover fade-out is the measured 185ms ease-in",
    /0\.185s/.test(hov.d) && /cubic-bezier\(0\.42, 0, 1, 1\)|ease-in/.test(hov.f));

  // ── the app's own icon: assets, installer wiring, and the New Tab favicon ──
  {
    const { nativeImage } = require("electron");
    const A = path.join(__dirname, "..", "assets");
    const png = nativeImage.createFromPath(path.join(A, "icon.png"));
    check("assets/icon.png is a 512x512 image", !png.isEmpty() && png.getSize().width === 512 && png.getSize().height === 512);
    // the rounded corners must be transparent, or the taskbar shows a white box around the icon
    const pb = png.toBitmap(); // BGRA
    let opaque = 0;
    for (let i = 3; i < pb.length; i += 4) if (pb[i] > 200) opaque++;
    check("the icon's corners are transparent (no white box behind it)", pb[3] === 0 && opaque / (512 * 512) < 0.99);
    const ico = fs.readFileSync(path.join(A, "icon.ico"));
    const n = ico.readUInt16LE(4);
    const sizes = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 16;
      const w = ico.readUInt8(o) || 256;
      const off = ico.readUInt32LE(o + 12), len = ico.readUInt32LE(o + 8);
      sizes.push(w);
      if (nativeImage.createFromBuffer(ico.slice(off, off + len)).getSize().width !== w) ok = false;
    }
    check("assets/icon.ico carries the Windows sizes, each decodable", ok && [16, 32, 48, 256].every((x) => sizes.includes(x)));
    const big = (() => { const i = sizes.indexOf(256), o = 6 + i * 16; return nativeImage.createFromBuffer(ico.slice(ico.readUInt32LE(o + 12), ico.readUInt32LE(o + 12) + ico.readUInt32LE(o + 8))).toBitmap(); })();
    check("...and the .ico keeps that transparency too", big[3] === 0);
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    check("the installer, shortcuts and exe use it", pkg.build.win.icon === "assets/icon.ico" &&
      pkg.build.nsis.installerIcon === "assets/icon.ico" && pkg.build.nsis.uninstallerIcon === "assets/icon.ico");
    check("the main window is created with the app icon", /icon:\s*path\.join\([^)]*assets[^)]*icon\.png/.test(
      fs.readFileSync(path.join(__dirname, "..", "electron", "windows", "mainWindow.js"), "utf8")));
  }

  // ── every internal page has its own favicon, not the default globe ──
  const iconOf = async (tab) => {
    for (let i = 0; i < 40; i++) { if (tab.favicon) break; await sleep(100); }
    return tab.favicon;
  };
  const shellIconFor = (title) => js(`(() => { const t = [...document.querySelectorAll(".tab")].find((x) => x.querySelector(".tab-title").textContent === ${JSON.stringify(title)}); if (!t) return "no-tab"; const img = t.querySelector(".tab-icon img"); return img ? img.src.slice(0, 32) : "globe"; })()`);

  const pages = [
    ["New Tab", () => tm.createTab()], // this one is the app logo, checked separately below
    ["Settings", () => tm.openSettings()],
    ["Bookmark manager", () => tm.openManager()],
    ["Downloads", () => tm.openDownloadsPage()],
  ];
  for (const [title, open] of pages) {
    open();
    await sleep(1500);
    const t = state.tabs.find((x) => x.id === state.activeTabId);
    const icon = await iconOf(t);
    // New Tab carries the app logo (a PNG); the other internal pages use themed SVG glyphs
    const expected = title === "New Tab" ? /^data:image\/png/ : /^data:image\/svg\+xml/;
    check(`${title}: the page has its own favicon`, expected.test(icon));
    check(`${title}: the strip draws it instead of the globe`, (await shellIconFor(title)).startsWith("data:image/"));
  }

  // The glyph must follow the Windows app mode like the globe it replaces. (A prefers-color-scheme
  // rule inside an SVG favicon is ignored by Chromium — measured — so main rebuilds the icon.)
  tm.openSettings();
  await sleep(1500);
  const setTabTheme = state.tabs.find((x) => x.id === state.activeTabId);
  tm.applyThemeMode("light");
  await sleep(800);
  check("in light mode the icon uses the light-mode grey (#5f6368)", /%235f6368/.test(setTabTheme.favicon));
  tm.applyThemeMode("dark");
  await sleep(800);
  check("switching to dark redraws it in the dark-mode grey (#9aa0a6)", /%239aa0a6/.test(setTabTheme.favicon));
  check("the strip was told about the new icon", /%239aa0a6/.test(await js('document.querySelector(".tab.active .tab-icon img").src')));
  // and it is really painted, not a broken image
  const painted = await (async () => {
    const r = await js('(()=>{const i=document.querySelector(".tab.active .tab-icon img");const b=i.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)}})()');
    const bmp = (await win.webContents.capturePage(r)).toBitmap();
    let lo = 255, hi = 0;
    for (let i = 0; i < bmp.length; i += 4) {
      const lum = 0.2126 * bmp[i + 2] + 0.7152 * bmp[i + 1] + 0.0722 * bmp[i];
      lo = Math.min(lo, lum); hi = Math.max(hi, lum);
    }
    return hi - lo; // ink against the tab background
  })();
  check("the icon is actually drawn in the tab (ink visible against the tab)", painted > 20);
  check("...and the image loaded (no broken icon)", (await js('document.querySelector(".tab.active .tab-icon img").naturalWidth')) > 0);
  tm.applyThemeMode("system");
  await sleep(600);

  // the New Tab page carries the PBCalc logo in colour (like a real site favicon), not a glyph
  const ntTab = state.tabs.find((t) => t.title === "New Tab");
  check("the New Tab page uses the PBCalc app logo as its favicon", !!ntTab && /^data:image\/png;base64,/.test(ntTab.favicon));

  // it must survive a reload, a duplicate, and being opened by typing the address
  const setTab = state.tabs.find((x) => x.title === "Settings");
  setTab.view.webContents.reload();
  await sleep(1500);
  check("Settings: the favicon survives a reload", /^data:image\/svg\+xml/.test(setTab.favicon) && setTab.title === "Settings");
  await tm.duplicateTab(setTab.id);
  await sleep(1800);
  const setCopy = state.tabs.find((x) => x.id !== setTab.id && x.title === "Settings");
  check("Settings: a duplicate has it too", !!setCopy && /^data:image\/svg\+xml/.test(await iconOf(setCopy)));
  tm.closeTab(setCopy.id);
  await sleep(300);
  tm.navigate("pbcalc://downloads");
  await sleep(1500);
  const typed = state.tabs.find((x) => x.id === state.activeTabId);
  check("typing pbcalc://downloads gives the same favicon", /^data:image\/svg\+xml/.test(await iconOf(typed)));

  // ── right-click → Duplicate must not leave the original tab drawn as "hovered" ──
  // A native menu takes the mouse away from Chromium, so :hover stays stuck on the tab that was
  // right-clicked; after Duplicate that tab is no longer active either, so the stale hover fill is
  // plainly visible. The shell suppresses hover styling until the mouse really moves again.
  const { Menu } = require("electron");
  const realBuild = Menu.buildFromTemplate;
  Menu.buildFromTemplate = () => ({ popup() {}, closePopup() {} }); // don't pop a real menu in a test

  tm.createTab(base + "/7");
  await sleep(1500);
  const victimTab = state.tabs[state.tabs.length - 1];
  const sh = win.webContents;
  const tabRect = async (id) => js(`(()=>{const t=[...document.querySelectorAll(".tab")][${state.tabs.indexOf(victimTab)}];const r=t.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  const pt = await tabRect();
  // put the pointer on it until Chromium really reports :hover
  let hovered = false;
  for (let i = 0; i < 10 && !hovered; i++) {
    sh.sendInputEvent({ type: "mouseMove", x: pt.x - 3, y: pt.y });
    await sleep(60);
    sh.sendInputEvent({ type: "mouseMove", x: pt.x, y: pt.y });
    await sleep(120);
    hovered = await js('document.querySelectorAll(".tab:hover").length === 1');
  }
  check("the pointer is hovering the tab", hovered);
  const fillOfHovered = () => js('(()=>{const t=document.querySelector(".tab:hover");return t?getComputedStyle(t.querySelector(".tab-body")).backgroundColor:"none"})()');
  const transparent = "rgba(0, 0, 0, 0)";
  check("...and it is painted with the hover fill", (await fillOfHovered()) !== transparent);

  // right-click it (this is what the real menu path runs), then duplicate
  await js('document.querySelectorAll(".tab")[' + state.tabs.indexOf(victimTab) + '].dispatchEvent(new MouseEvent("contextmenu", {bubbles:true})); 0');
  await sleep(400);
  check("the shell stops trusting :hover while the native menu is up", (await js('document.body.classList.contains("no-hover")')) === true);
  await tm.duplicateTab(victimTab.id);
  await sleep(1800);
  const copyTab = state.tabs.find((t) => t.id !== victimTab.id && t.url === victimTab.url);
  check("the copy is the active tab (as in Chrome)", !!copyTab && state.activeTabId === copyTab.id);
  // Read the ORIGINAL tab's own fill: the strip re-flows when the copy appears, so "whatever is
  // hovered" may well be the copy (which is active, and white by design).
  const origIdx = state.tabs.indexOf(victimTab);
  const fillOfOriginal = () => js(`getComputedStyle(document.querySelectorAll(".tab")[${origIdx}].querySelector(".tab-body")).backgroundColor`);
  check("THE FIX: the original is NOT left with a hover fill", (await fillOfOriginal()) === transparent);
  // the separator between the original and the (now active) copy must be hidden, as next to any
  // active tab — suppressing the stale hover must not switch it back on
  const sepOpacity = (i) => js(`getComputedStyle(document.querySelectorAll(".tab")[${i}].querySelector(".tab-sep")).opacity`);
  check("no stray separator is left beside the new active tab", (await sepOpacity(origIdx)) === "0");
  check("...and the separators elsewhere are untouched", (await sepOpacity(0)) === "1");
  check("...and the original is drawn as an ordinary inactive tab", (await js(`(()=>{const t=[...document.querySelectorAll(".tab")].find((x)=>x.querySelector(".tab-title").textContent===${JSON.stringify(victimTab.title)});return t ? !t.classList.contains("active") : false})()`)) === true);
  // moving the mouse again makes :hover trustworthy, so the fill comes back
  sh.sendInputEvent({ type: "mouseMove", x: pt.x + 2, y: pt.y });
  await sleep(300);
  check("once the mouse moves, hovering paints again", (await js('document.body.classList.contains("no-hover")')) === false);
  sh.sendInputEvent({ type: "mouseMove", x: 600, y: 400 });
  Menu.buildFromTemplate = realBuild;
  tm.closeTab(copyTab.id);
  tm.closeTab(victimTab.id);
  await sleep(400);

  // ── many tabs: Chrome never refuses one, it just keeps shrinking (MEASURED from a real
  //    82-tab Chrome window: inactive pitch 18px, active body 32px, no scrolling) ──
  state.tabs.slice(1).forEach((t) => tm.closeTab(t.id));
  await sleep(600);
  const OLD_CAP = 30; // what PBCalc used to refuse at
  while (state.tabs.length < 50) tm.createTab();
  await sleep(2500);
  const peakTabs = state.tabs.length;
  check("tabs can be opened past the old 30 limit", peakTabs === 50);
  check("(for the record) the old build stopped at " + OLD_CAP, peakTabs > OLD_CAP);
  const many = await js(`(() => {
    const t = [...document.querySelectorAll(".tab")];
    const act = document.querySelector(".tab.active");
    const inact = t.filter((x) => !x.classList.contains("active"));
    const strip = document.getElementById("tabs");
    const off = inact.map((x) => { const i = x.querySelector(".tab-icon").getBoundingClientRect(), r = x.getBoundingClientRect(); return Math.abs((i.left + i.width / 2) - (r.left + r.width / 2)); });
    return {
      n: t.length,
      inactiveMin: Math.min(...inact.map((x) => Math.round(x.getBoundingClientRect().width))),
      activeBody: Math.round(act.querySelector(".tab-body").getBoundingClientRect().width),
      iconsVisible: inact.every((x) => x.querySelector(".tab-icon").getBoundingClientRect().width > 0),
      scrolls: strip.scrollWidth > strip.clientWidth + 1,
      iconOffMax: Math.max(...off),
      plusVisible: document.getElementById("new-tab").getBoundingClientRect().width > 0,
    };
  })()`);
  check("they compress instead of overflowing (no horizontal scrolling, like Chrome)", many.scrolls === false);
  check("compressed tabs never go below Chrome's 18px floor", many.inactiveMin >= 18);
  check("the active tab stays wider, ~32px of body like Chrome", many.activeBody >= 30 && many.activeBody <= 40);
  check("every compressed tab still shows its favicon", many.iconsVisible);
  check("...centred in the tab, as Chrome does when there is no room for a title", many.iconOffMax <= 2);
  check("the + button is still there", many.plusVisible);
  // Chrome's look at this density (measured from the user's 82-tab window): no separators at all,
  // favicon only, and the active tab keeps its favicon — the close button appears on hover.
  const narrow = await js(`(() => {
    const act = document.querySelector(".tab.active");
    const ina = document.querySelector(".tab:not(.active)");
    const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
    return {
      seps: [...document.querySelectorAll(".tab-sep")].filter((x) => getComputedStyle(x).opacity !== "0").length,
      activeIcon: vis(act.querySelector(".tab-icon")), activeX: vis(act.querySelector(".tab-close")),
      inactiveIcon: vis(ina.querySelector(".tab-icon")), inactiveX: vis(ina.querySelector(".tab-close")),
    };
  })()`);
  check("no separators between tabs at this width (as in the user's Chrome)", narrow.seps === 0);
  check("the active tab shows its favicon, not a close button", narrow.activeIcon && !narrow.activeX);
  // (hover reveals the X instead — asserted right below)
  check("inactive tabs show only their favicon", narrow.inactiveIcon && !narrow.inactiveX);
  // hovering the active tab swaps the favicon for the X (Chrome screenshots 61 vs 62)
  const aPt = await js('(()=>{const r=document.querySelector(".tab.active").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');
  let swapped = false;
  for (let i = 0; i < 10 && !swapped; i++) {
    win.webContents.sendInputEvent({ type: "mouseMove", x: aPt.x - 2, y: aPt.y });
    await sleep(50);
    win.webContents.sendInputEvent({ type: "mouseMove", x: aPt.x, y: aPt.y });
    await sleep(120);
    swapped = await js('(()=>{const a=document.querySelector(".tab.active");const x=a.querySelector(".tab-close"),i=a.querySelector(".tab-icon");return getComputedStyle(x).display!=="none" && getComputedStyle(i).display==="none"})()');
  }
  check("hovering the narrow active tab swaps its favicon for the close button", swapped);
  // ...and that button is still Chrome's 16px circle, centred — not a stretched ellipse
  const closeBox = await js(`(() => {
    const a = document.querySelector(".tab.active"), c = a.querySelector(".tab-close");
    const b = c.getBoundingClientRect(), ab = a.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), radius: getComputedStyle(c).borderRadius,
      off: Math.round((b.left + b.width / 2) - (ab.left + ab.width / 2)) };
  })()`);
  check("the close button stays a 16x16 circle on a narrow tab (Chrome's hover circle)",
    closeBox.w === 16 && closeBox.h === 16 && closeBox.radius === "50%");
  check("...and it is centred in the tab", Math.abs(closeBox.off) <= 1);
  win.webContents.sendInputEvent({ type: "mouseMove", x: 600, y: 400 });
  await sleep(200);

  // ...while at a normal width the separators and close buttons are there, as Chrome draws them
  state.tabs.slice(12).forEach((t) => tm.closeTab(t.id));
  await sleep(1500);
  const normal = await js(`(() => {
    const ina = document.querySelector(".tab:not(.active)");
    return {
      width: Math.round(ina.getBoundingClientRect().width),
      seps: [...document.querySelectorAll(".tab-sep")].filter((x) => getComputedStyle(x).opacity !== "0").length,
      x: getComputedStyle(ina.querySelector(".tab-close")).display !== "none",
    };
  })()`);
  check("at a normal width the separators come back", normal.width > 90 && normal.seps > 0);
  const wideClose = await js(`(() => {
    const a = document.querySelector(".tab.active"), c = a.querySelector(".tab-close");
    const b = c.getBoundingClientRect(), ab = a.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), fromRight: Math.round(ab.right - b.right) };
  })()`);
  check("on a wide tab the close button is the same 16px circle, 8px from the right edge (Chrome)",
    wideClose.w === 16 && wideClose.h === 16 && Math.abs(wideClose.fromRight - 11) <= 4);
  check("...and so do the inactive close buttons (Chrome: from 84px)", normal.x);
  state.tabs.slice(1).forEach((t) => tm.closeTab(t.id));
  await sleep(1500);

  // ── Restricted Mode gets Duplicate too ("both mode"), still confined to the bookmark's site ──
  const bm = require("../electron/bookmarks/bookmarkStore");
  bm.toggle({ url: base + "/app", title: "App", favicon: "" });
  tm.enableRestricted(); // this drops the open tabs itself; closing the last one would quit the app
  await sleep(1200);
  const homeTab = state.tabs.find((t) => t.isHome);
  check("the restricted 'Your sites' page has its own favicon", !!homeTab && /^data:image\/svg\+xml/.test(await iconOf(homeTab)));
  // (opening a bookmark from the tiles page loads in place, so this tab becomes the site below)
  tm.openBookmark(String(bm.list()[0].id));
  await sleep(1800);
  const rTab = state.tabs.find((t) => t.url.startsWith(base));
  check("a bookmark opens in Restricted Mode", !!rTab && !!rTab.site);
  await rTab.view.webContents.executeJavaScript('sessionStorage.setItem("authToken","r-token"); location.reload(); 0');
  await sleep(1500);
  await tm.duplicateTab(rTab.id);
  await sleep(2000);
  const rCopy = state.tabs.find((t) => t.id !== rTab.id && t.url.startsWith(base));
  check("Duplicate works in Restricted Mode", !!rCopy);
  check("the copy stays tied to the same allowed site", !!rCopy && rCopy.site === rTab.site);
  check("the copy keeps the login as well", /DASHBOARD r-token/.test(await rCopy.view.webContents.executeJavaScript("document.body.innerText")));
  const beforeCount = state.tabs.length;
  tm.createTab("https://example.org/");
  check("an ordinary new tab is still refused in Restricted Mode", state.tabs.length === beforeCount);
  tm.leaveRestricted();
  await sleep(500);

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_TABS total=" + results.length + " failed=" + failed.length);
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
