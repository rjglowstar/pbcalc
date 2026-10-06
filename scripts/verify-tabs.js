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
// A hung suite must still end, but the limit has to fit the suite: it grew past 120s once the
// keyboard-focus checks (each waits out the 300ms the old view lingers) were added.
setTimeout(() => { console.log("WATCHDOG after " + results.length); app.exit(2); }, 360000).unref();

// A tiny site with a real <link rel=icon>, and pages that keep firing title updates so the strip
// is pushed a lot (that churn is what used to blank the favicons).
const ICON = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    // echoes the User-Agent the server actually received (what a WAF would see)
    if (req.url === "/ua-probe") { res.setHeader("x-seen-ua", req.headers["user-agent"] || ""); return res.end("ok"); }
    if (req.url === "/icon.png") { res.setHeader("content-type", "image/png"); return res.end(ICON); }
    // a page whose script never yields: nothing can be read from it, so closing it must still finish
    if (req.url.startsWith("/hang")) { res.setHeader("content-type", "text/html"); return res.end('<!doctype html><title>Hang</title><body>hang<script>setTimeout(function(){ for (;;) {} }, 300)</script>'); }
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

  // ── tabs present plain Chrome, in the session they really use ──
  // Tabs run in the in-memory TAB_PARTITION, not defaultSession. The UA rule used to be applied to
  // defaultSession only, so every tab sent "...Chrome/146 Electron/41.x..." — the token Akamai (Meesho)
  // answers with a 403. Checked on the HEADER the server really received, not just navigator.userAgent.
  {
    const hdr = await new Promise((resolve) => {
      const t = state.tabs.find((x) => x.url && x.url.startsWith(base));
      const wc = t ? t.view.webContents : tm.getActiveTab().view.webContents;
      const { net } = require("electron");
      // a request made BY the tab's own session, so it goes through that session's header rules
      const req = net.request({ url: base + "/ua-probe", session: wc.session });
      let ua = "";
      req.on("response", (r) => { ua = r.headers["x-seen-ua"] || ""; r.on("data", () => {}); r.on("end", () => resolve(ua)); });
      req.on("error", () => resolve("ERR"));
      req.end();
    });
    const tabWc = tm.getActiveTab().view.webContents;
    const pageUA = await tabWc.executeJavaScript("navigator.userAgent");
    check("a tab's session is the in-memory TAB_PARTITION", tabWc.session === require("electron").session.fromPartition(require("../electron/constants").TAB_PARTITION) && tabWc.session.getStoragePath() === null);
    check("the User-Agent a tab SENDS has no Electron token, and carries the real Chrome version",
      !!hdr && hdr !== "ERR" && !/Electron/i.test(hdr) && hdr.includes("Chrome/" + process.versions.chrome));
    check("...and navigator.userAgent in the page agrees with it", pageUA === hdr);
  }

  // ── Ctrl+Shift+T: each closed tab comes back in ITS OWN slot, and the keyboard keeps working ──
  // Reported: close tabs from random positions, restore, and only ONE restore worked until a tab was
  // switched by hand. The positions were fine; the cause was focus. Closing the focused tab leaves
  // NO webContents focused, and restoring (a keyboard action, nothing clicked) did not give the new
  // view focus, so the next Ctrl+Shift+T reached no before-input-event handler. A click on a tab
  // hands focus back, which is why switching tabs "fixed" it.
  {
    const { webContents } = require("electron");
    win.show(); win.focus(); await sleep(400);
    const urls = [91, 92, 93, 94].map((n) => base + "/" + n);
    const idFor = (u) => (state.tabs.find((t) => t.url === u) || {}).id;
    const order = () => state.tabs.map((t) => t.url).filter((u) => urls.includes(u)).map((u) => u.slice(-2)).join(",");
    const holder = () => {
      const f = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.isFocused());
      const t = f && state.tabs.find((x) => x.view.webContents === f);
      if (!f) { console.log("     [diag] nobody holds focus; window OS-active: " + win.isFocused() + "; focused window is " + (require("electron").BrowserWindow.getFocusedWindow() ? "one of ours" : "NOT ours")); }
      return t ? t.url : f ? "(shell or popup)" : "NOBODY";
    };
    const activeUrl = () => (state.tabs.find((t) => t.id === state.activeTabId) || {}).url;
    for (const u of urls) { tm.createTab(u); await sleep(700); }
    check("[reopen] setup: four test tabs open, in order", order() === "91,92,93,94");
    tm.getActiveTab().view.webContents.focus(); await sleep(300);
    // without this the focus checks below would prove nothing
    check("[reopen] harness: the window can hold keyboard focus on a tab", holder() === urls[3]);

    // close from the MIDDLE, then the FRONT (not the end)
    tm.closeTab(idFor(urls[2])); await sleep(400);
    tm.closeTab(idFor(urls[0])); await sleep(400);
    check("[reopen] closed 93 (middle) and 91 (front)", order() === "92,94");

    tm.reopenClosedTab(); await sleep(900);
    check("[reopen] #1 brings back 91 at the front", order() === "91,92,94");
    check("[reopen] #1 shows it and leaves keyboard focus ON it (was: nobody)", activeUrl() === urls[0] && holder() === urls[0]);
    tm.reopenClosedTab(); await sleep(900);
    check("[reopen] #2 brings back 93 between 92 and 94", order() === "91,92,93,94");
    check("[reopen] #2 keeps focus on the restored tab", activeUrl() === urls[2] && holder() === urls[2]);
    const countBefore = state.tabs.length;
    const urlsBefore = state.tabs.map((t) => t.url);
    tm.reopenClosedTab(); await sleep(500);
    // History is LIFO and spans the whole run, so a further press brings back the next-OLDER page
    // closed earlier (measured: an earlier /9) — at most one tab, and never a copy of these four.
    const extra = state.tabs.filter((t) => !urlsBefore.includes(t.url));
    check("[reopen] one more press restores at most the next-older page, no duplicates of these four",
      extra.length <= 1 && order() === "91,92,93,94" && extra.every((t) => !urls.includes(t.url)));
    for (const t of extra) tm.closeTab(t.id);
    await sleep(300);
    check("[reopen] (cleanup) back to the same tab count", state.tabs.length === countBefore);

    // a real keystroke path: Ctrl+Shift+T on the focused page goes through before-input-event
    tm.closeTab(idFor(urls[1])); await sleep(400);
    check("[reopen] closed 92", order() === "91,93,94");
    const wcNow = tm.getActiveTab().view.webContents;
    wcNow.focus(); await sleep(200);
    wcNow.sendInputEvent({ type: "keyDown", keyCode: "T", modifiers: ["control", "shift"] });
    wcNow.sendInputEvent({ type: "keyUp", keyCode: "T", modifiers: ["control", "shift"] });
    await sleep(900);
    check("[reopen] the Ctrl+Shift+T keystroke restores 92 into its slot", order() === "91,92,93,94");
    check("[reopen] ...and focus stays on a tab for the next press", holder() === activeUrl());
    for (const u of urls) { const id = idFor(u); if (id != null) tm.closeTab(id); }
    await sleep(500);
  }

  // ── Ctrl+W: keyboard focus follows to the tab that takes over, so the NEXT shortcut still works ──
  // Closing the focused tab left no webContents focused (measured: NOBODY), and the next keystroke
  // reached no handler until a tab was clicked ("only works once"). Chrome closes tab after tab on
  // repeated Ctrl+W, and the tab to the right takes over (the left one when the last tab goes).
  // Keystrokes here go ONLY to the webContents that holds focus, like the OS: nobody focused = lost.
  {
    const { webContents } = require("electron");
    win.show(); win.focus(); await sleep(400);
    const urls = [81, 82, 83, 84].map((n) => base + "/" + n);
    const mine = () => state.tabs.map((t) => t.url).filter((u) => urls.includes(u)).map((u) => u.slice(-2)).join(",");
    const focusedWc = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.isFocused());
    const holderUrl = () => { const f = focusedWc(); const t = f && state.tabs.find((x) => x.view.webContents === f); if (!f) { console.log("     [diag] nobody holds focus; window OS-active: " + win.isFocused() + "; focused window is " + (require("electron").BrowserWindow.getFocusedWindow() ? "one of ours" : "NOT ours")); } return t ? t.url : f ? "(shell or popup)" : "NOBODY"; };
    const activeUrl = () => (state.tabs.find((t) => t.id === state.activeTabId) || {}).url;
    const press = (k, mods) => {
      const f = focusedWc();
      if (!f) return false; // nobody has focus: the keystroke goes nowhere
      f.sendInputEvent({ type: "keyDown", keyCode: k, modifiers: mods });
      f.sendInputEvent({ type: "keyUp", keyCode: k, modifiers: mods });
      return true;
    };
    for (const u of urls) { tm.createTab(u); await sleep(700); }
    check("[ctrl+w] setup: four test tabs open, in order", mine() === "81,82,83,84");
    tm.getActiveTab().view.webContents.focus(); await sleep(300);
    check("[ctrl+w] harness: a tab holds keyboard focus", holderUrl() === urls[3]);

    // close the LAST tab with the keyboard: the one to its left takes over, and holds focus
    check("[ctrl+w] #1 key reached a handler", press("W", ["control"]));
    await sleep(700);
    check("[ctrl+w] #1 closed 84; 83 (left neighbour) takes over", mine() === "81,82,83" && activeUrl() === urls[2]);
    check("[ctrl+w] #1 leaves keyboard focus ON the new tab (was: nobody)", holderUrl() === urls[2]);
    // the very same shortcut again, with nothing clicked in between
    check("[ctrl+w] #2 key still reaches a handler", press("W", ["control"]));
    await sleep(700);
    check("[ctrl+w] #2 closed 83; 82 takes over", mine() === "81,82" && activeUrl() === urls[1] && holderUrl() === urls[1]);

    // a MIDDLE tab: the tab to its RIGHT takes over (Chrome), and focus goes with it
    tm.createTab(urls[2]); await sleep(700);   // order is now 81,82,83 with 83 active
    tm.switchTab((state.tabs.find((t) => t.url === urls[1]) || {}).id); await sleep(300);
    tm.getActiveTab().view.webContents.focus(); await sleep(200);
    check("[ctrl+w] middle: 82 is active between 81 and 83", activeUrl() === urls[1] && mine() === "81,82,83");
    check("[ctrl+w] middle: key reached a handler", press("W", ["control"]));
    await sleep(700);
    check("[ctrl+w] middle: the RIGHT neighbour (83) takes over and holds focus", mine() === "81,83" && activeUrl() === urls[2] && holderUrl() === urls[2]);

    // closing a tab that is NOT the active one must not move focus away from the active page
    tm.createTab(urls[3]); await sleep(700);   // 81,83,84 with 84 active
    tm.getActiveTab().view.webContents.focus(); await sleep(200);
    const bgId = (state.tabs.find((t) => t.url === urls[0]) || {}).id;
    tm.closeTab(bgId); await sleep(500);
    check("[ctrl+w] closing a BACKGROUND tab leaves the active page and its focus alone", mine() === "83,84" && activeUrl() === urls[3] && holderUrl() === urls[3]);

    // Ctrl+W then Ctrl+Shift+T then Ctrl+W: the whole keyboard round trip, nothing clicked
    check("[ctrl+w] round trip: close", press("W", ["control"]));
    await sleep(700);
    check("[ctrl+w] round trip: Ctrl+Shift+T reaches a handler", press("T", ["control", "shift"]));
    await sleep(900);
    check("[ctrl+w] round trip: 84 is restored and focused", mine() === "83,84" && activeUrl() === urls[3] && holderUrl() === urls[3]);
    for (const u of urls) { const t = state.tabs.find((x) => x.url === u); if (t) tm.closeTab(t.id); }
    await sleep(500);
  }

  // ── keyboard focus follows EVERY tab switch, so shortcuts keep working afterwards ──
  // Reported: after closing tabs and restoring them, Ctrl+Shift+O / Ctrl+Shift+J (our own pages) did nothing
  // while the same pages opened fine from the menu. Cause (measured): switchTab attached the new view
  // but never focused it, and ~300ms later the OLD view — which still held focus — was detached, so
  // focus was NOBODY and every later shortcut reached no before-input-event handler. A mouse click
  // gave focus back, which is why opening things manually "fixed" it. Brand-new tabs additionally
  // ignored a focus() made before their first load began, so createTab repeats it afterwards.
  // Keystrokes here go ONLY to the webContents that holds focus (like the OS): nobody = lost.
  {
    const { webContents } = require("electron");
    const popup = require("../electron/popup");
    const nm = (u) => { u = String(u || ""); const m = /\/(\w+)\.html$/.exec(u); return m ? m[1] : u.replace(base, "").replace(/^\//, "") || "blank"; };
    const focusedWc = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.isFocused());
    const holder = () => { const f = focusedWc(); if (!f) { console.log("     [diag] nobody holds focus; window OS-active: " + win.isFocused() + "; focused window is " + (require("electron").BrowserWindow.getFocusedWindow() ? "one of ours" : "NOT ours")); return "NOBODY"; } if (f === win.webContents) return "shell"; const t = state.tabs.find((x) => x.view.webContents === f); return t ? nm(t.url) : "popup"; };
    const press = (k, mods) => { const f = focusedWc(); if (!f) return false; f.sendInputEvent({ type: "keyDown", keyCode: k, modifiers: mods }); f.sendInputEvent({ type: "keyUp", keyCode: k, modifiers: mods }); return true; };
    const activeT = () => state.tabs.find((t) => t.id === state.activeTabId);
    const settle = () => sleep(900); // longer than the 300ms the old view lingers before it is detached
    const reset = async () => {
      popup.close(); win.show(); win.focus(); await sleep(200);
      while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
      await sleep(250);
      for (let i = 1; i <= 3; i++) { tm.createTab(base + "/7" + i); await sleep(450); }
      activeT().view.webContents.focus(); await sleep(350);
    };
    const secondShortcutWorks = async () => {
      // Ctrl+Shift+B toggles the bookmarks bar: a harmless shortcut that needs a live handler
      const had = state.bookmarksBarVisible;
      const delivered = press("B", ["control", "shift"]);
      await sleep(300);
      const worked = delivered && state.bookmarksBarVisible !== had;
      if (worked) { press("B", ["control", "shift"]); await sleep(250); } // put it back
      return worked;
    };

    await reset();
    check("[focus] harness: a page holds keyboard focus to start", holder() === "73");
    press("O", ["control", "shift"]); await settle();
    check("[focus] Ctrl+Shift+O opens the bookmark manager...", nm(activeT().url) === "manager");
    check("[focus] ...and the NEW page holds focus (was: nobody)", holder() === "manager");
    check("[focus] ...so the next shortcut still works", await secondShortcutWorks());

    await reset();
    press("J", ["control", "shift"]); await settle();
    check("[focus] Ctrl+Shift+J opens the Downloads page, which holds focus", nm(activeT().url) === "downloads" && holder() === "downloads");
    check("[focus] ...and the next shortcut still works", await secondShortcutWorks());

    await reset();
    press("Tab", ["control"]); await settle();
    check("[focus] Ctrl+Tab: the next tab holds focus and shortcuts still work", holder() !== "NOBODY" && holder() === nm(activeT().url) && await secondShortcutWorks());
    await reset();
    press("1", ["control"]); await settle();
    check("[focus] Ctrl+1: the first tab holds focus and shortcuts still work", holder() !== "NOBODY" && holder() === nm(activeT().url) && await secondShortcutWorks());

    // the ⋮ menu and tab search (popups hold focus while open) — the other way to "open it manually"
    await reset();
    popup.open("menu", null); await sleep(900);
    popup.handleAction("settings"); await settle();
    check("[focus] ⋮ menu → Settings: the Settings page holds focus", nm(activeT().url) === "settings" && holder() === "settings");
    check("[focus] ...and the next shortcut still works", await secondShortcutWorks());
    await reset();
    popup.open("tabsearch", null); await sleep(900);
    popup.handleAction("activate-tab", state.tabs[0].id); await settle();
    check("[focus] tab search → activate: that tab holds focus and shortcuts still work", holder() === nm(activeT().url) && holder() !== "NOBODY" && await secondShortcutWorks());

    // what must NOT change: the shell keeps focus when that is where the user is working
    await reset();
    win.webContents.focus(); await sleep(300);
    tm.switchTab(state.tabs[0].id); await settle();
    check("[focus] clicking the tab strip (shell focused): focus is NOT stolen from the shell", holder() === "shell");
    await reset();
    press("T", ["control"]); await settle();
    check("[focus] Ctrl+T still ends with the address bar (shell) focused", holder() === "shell");

    // YOUR exact flow: build a strip like the real one, close down to one tab with Ctrl+W, restore
    // them all with Ctrl+Shift+T, then open our own pages by shortcut
    await reset();
    for (let i = 4; i <= 8; i++) { tm.createTab(base + "/7" + i); await sleep(350); }
    tm.createTab(); await sleep(350); tm.openSettings(); await sleep(400);
    activeT().view.webContents.focus(); await sleep(300);
    const opened = state.tabs.length;
    let closes = 0; while (state.tabs.length > 1 && closes < 20 && press("W", ["control"])) { closes++; await sleep(330); }
    check("[flow] Ctrl+W closed down to one tab with every press delivered", state.tabs.length === 1 && closes === opened - 1);
    let restores = 0; for (let i = 0; i < 25 && press("T", ["control", "shift"]); i++) { const b = state.tabs.length; await sleep(450); if (state.tabs.length > b) restores++; else break; }
    check("[flow] Ctrl+Shift+T restored the closed web pages (every press delivered)", restores >= 6);
    check("[flow] after restoring, a page holds focus", holder() !== "NOBODY");
    press("O", ["control", "shift"]); await settle();
    check("[flow] then Ctrl+Shift+O opens the bookmark manager", nm(activeT().url) === "manager" && holder() === "manager");
    press("J", ["control", "shift"]); await settle();
    check("[flow] then Ctrl+Shift+J opens the Downloads page", nm(activeT().url) === "downloads" && holder() === "downloads");
    check("[flow] and shortcuts still work after both", await secondShortcutWorks());
    while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
    await sleep(300);
  }

  // ── Ctrl+Shift+T brings the tab's LOGIN back (sessionStorage), like Chrome ──
  // Reported: log in to the PB ERP, close the tab, reopen it with Ctrl+Shift+T -> the login page. The ERP
  // keeps its login in sessionStorage (the sibling ERP shell reads fxCredentials there), which belongs to
  // the TAB and died with its webContents; the closed-tab list only remembered the URL. Cookies and
  // localStorage were never lost: every tab shares one session. Chrome restores a closed tab's
  // sessionStorage; so do we now (same mechanism as Duplicate), held in memory only.
  {
    win.show(); win.focus(); await sleep(300);
    const activeT = () => state.tabs.find((t) => t.id === state.activeTabId);
    const outOf = (wc) => wc.executeJavaScript('document.getElementById("out") ? document.getElementById("out").textContent : "(no #out)"');
    const resetStrip = async () => { while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id); await sleep(500); };
    // a tab on /app<n> that is logged in: the page reads sessionStorage("authToken") on load
    const loginTab = async (n, token, extra) => {
      tm.createTab(base + "/app" + n); await sleep(800);
      const wc = activeT().view.webContents;
      await wc.executeJavaScript('sessionStorage.setItem("authToken", ' + JSON.stringify(token) + '); ' + (extra || "") + " 0");
      await wc.loadURL(base + "/app" + n); await sleep(500);
      return activeT();
    };
    const slotOf = (tab) => state.tabs.indexOf(tab);
    const tokenRe = /DASHBOARD (\S+)/;

    await resetStrip();
    const t1 = await loginTab(1, "alpha");
    const wc1 = t1.view.webContents;
    check("[restore] setup: the tab is logged in (the page sees its sessionStorage token)", /DASHBOARD alpha/.test(await outOf(wc1)));
    const slot1 = slotOf(t1);
    tm.closeTab(t1.id);
    check("[restore] the tab leaves the strip immediately (only its page lingers a few ms)", !state.tabs.includes(t1));
    await sleep(900);
    check("[restore] ...and that page is destroyed afterwards (nothing is leaked)", wc1.isDestroyed());
    await tm.reopenClosedTab(); await sleep(1200);
    const back1 = activeT();
    check("[restore] Ctrl+Shift+T reopens it in its own slot", String(back1.url).endsWith("/app1") && slotOf(back1) === slot1);
    check("[restore] ...and it is STILL LOGGED IN (was: the login page)", /DASHBOARD alpha/.test(await outOf(back1.view.webContents)));

    // sessionStorage is per TAB: another tab on the same site must not inherit the login
    tm.createTab(base + "/app9"); await sleep(900);
    check("[restore] a different tab on the same site does NOT inherit that login", /LOGIN PAGE/.test(await outOf(activeT().view.webContents)));
    // ...and restoring is once: the restored data is not served to later page loads of that tab
    await back1.view.webContents.executeJavaScript('sessionStorage.removeItem("authToken"); 0');
    await back1.view.webContents.reload(); await sleep(800);
    check("[restore] the restored login is not re-applied on every reload (logging out sticks)", /LOGIN PAGE/.test(await outOf(back1.view.webContents)));

    // two tabs closed back to back, restored back to back: LIFO order and each keeps ITS OWN login
    await resetStrip();
    const ta = await loginTab(2, "tok-A"); const tb = await loginTab(3, "tok-B");
    const slotA = slotOf(ta), slotB = slotOf(tb);
    tm.closeTab(tb.id); tm.closeTab(ta.id);            // no pause: both snapshots are in flight together
    tm.reopenClosedTab(); tm.reopenClosedTab();         // no pause: the second waits for the first
    await sleep(2500);
    const restoredA = state.tabs.find((t) => String(t.url).endsWith("/app2")), restoredB = state.tabs.find((t) => String(t.url).endsWith("/app3"));
    check("[restore] quick close,close,restore,restore brings both back", !!restoredA && !!restoredB);
    check("[restore] ...each in its own slot", !!restoredA && !!restoredB && slotOf(restoredA) === slotA && slotOf(restoredB) === slotB);
    check("[restore] ...and each with ITS OWN login (A:" + "tok-A, B:tok-B)",
      !!restoredA && !!restoredB && (tokenRe.exec(await outOf(restoredA.view.webContents)) || [])[1] === "tok-A" && (tokenRe.exec(await outOf(restoredB.view.webContents)) || [])[1] === "tok-B");

    // a page that never yields: its sessionStorage cannot be read, but closing must still finish
    await resetStrip();
    tm.createTab(base + "/hang"); await sleep(1500);   // loads, then spins forever 300ms later
    const hungTab = activeT(); const hungWc = hungTab.view.webContents;
    tm.closeTab(hungTab.id);
    check("[restore] a HUNG page leaves the strip at once", !state.tabs.includes(hungTab));
    check("[restore] ...and is still destroyed after the snapshot gives up (no leaked, spinning page)", await until(() => hungWc.isDestroyed(), 4000));
    await tm.reopenClosedTab(); await sleep(1000);
    check("[restore] ...and it can still be reopened (without a login to restore)", String(activeT().url).endsWith("/hang"));

    // memory guard: the closed-tab list lives in RAM, so an enormous sessionStorage is not kept
    await resetStrip();
    const big = await loginTab(4, "big-token", 'sessionStorage.setItem("pad", "x".repeat(600 * 1024));');
    tm.closeTab(big.id); await sleep(900);
    await tm.reopenClosedTab(); await sleep(1200);
    check("[restore] an oversized sessionStorage (>512KB) is dropped, the tab still reopens", String(activeT().url).endsWith("/app4") && /LOGIN PAGE/.test(await outOf(activeT().view.webContents)));

    // our own pages and blanks never enter the list, so there is nothing to snapshot for them
    await resetStrip();
    tm.openSettings(); await sleep(700);
    const settingsWc = activeT().view.webContents;
    tm.closeTab(activeT().id); await sleep(300);
    check("[restore] an internal page (Settings) closes and is destroyed promptly, with no snapshot wait", settingsWc.isDestroyed());
    await resetStrip();
  }

  // ── Restricted Mode gets Duplicate too ("both mode"), still confined to the bookmark's site ──
  const bm = require("../electron/bookmarks/bookmarkStore");
  bm.setMode("real");   // these tests are about the owner's real list; a fresh launch starts on the dummy one
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
