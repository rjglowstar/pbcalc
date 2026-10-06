// Self-test for keyboard shortcuts, context menu, error pages, cert errors, external protocols,
// find-in-page, zoom, favicons, print/devtools wiring.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-browser.js
// Needs `openssl` on PATH (self-signed cert for the TLS test). Window is never shown.
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");

// The test window lives off-screen; without these Windows marks it occluded, the pages report
// visibilityState "hidden", and synthetic mouse input never reaches them.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-b-"));
app.setPath("userData", path.join(tmp, "UserData"));
fs.mkdirSync(app.getPath("userData"), { recursive: true });

const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); if (process.env.PBCALC_TRACE) console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

app.whenReady().then(async () => {
  const state = require("../electron/state");
  const tabManager = require("../electron/tabs/tabManager");
  require("../electron/bookmarks/bookmarkStore").setMode("real");   // starts empty here; a fresh launch is on the seeded dummy list
  const { registerIpcHandlers } = require("../electron/ipc/registerIpcHandlers");

  state.mainWindow = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { contextIsolation: true } });
  const sent = [];
  const origSend = state.mainWindow.webContents.send.bind(state.mainWindow.webContents);
  state.mainWindow.webContents.send = (ch, ...a) => { sent.push([ch, ...a]); return origSend(ch, ...a); };
  // find-in-page needs a rendered (visible) page: show the window off-screen, without focus.
  state.mainWindow.setPosition(-3000, -3000);
  state.mainWindow.showInactive();
  registerIpcHandlers();
  require("../electron/shortcuts").attachShortcuts(state.mainWindow.webContents);

  // stub OS-facing calls so nothing real opens
  const opened = [];
  shell.openExternal = async (u) => { opened.push(u); };
  dialog.showMessageBox = async () => ({ response: 0 }); // "Open"

  // ── servers ──
  const page = http.createServer((req, res) => {
    if (req.url === "/i.png") { res.setHeader("content-type", "image/png"); return res.end(PNG); }
    res.setHeader("content-type", "text/html");
    res.end('<title>Page</title><link rel="icon" href="/i.png"><body>hello needle world needle<br>' +
      '<a id="mail" href="mailto:a@b.test">mail</a> <a id="blank" target="_blank" href="/second">blank</a>' +
      '<a id="tel" href="tel:+100">tel</a></body>');
  });
  await new Promise((r) => page.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + page.address().port;

  const keyPath = path.join(tmp, "k.pem"), certPath = path.join(tmp, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  const tls = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (_q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Secure</title>secure ok"); });
  await new Promise((r) => tls.listen(0, "127.0.0.1", r));
  const tlsUrl = "https://127.0.0.1:" + tls.address().port + "/";

  tabManager.createTab(base + "/");
  await sleep(1500);
  const tab = () => tabManager.getActiveTab();
  const wc = () => tab().view.webContents;
  const st = () => tabManager.getTabState();

  // ── favicon + title ──
  check("favicon captured", /i\.png$/.test(st().tabs[0].favicon));
  check("title captured", st().tabs[0].title === "Page");

  // ── shortcuts (real key events through the tab's webContents) ──
  const key = (wcx, keyCode, modifiers = []) => {
    wcx.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    wcx.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  
  // Holding a key down: Windows repeats it ~30x/s, and Chromium marks every repeat with the
  // isAutoRepeat modifier. One action per press, as in Chrome.
  const hold = (wcx, keyCode, modifiers, repeats) => {
    wcx.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    for (let i = 0; i < repeats; i++) wcx.sendInputEvent({ type: "keyDown", keyCode, modifiers: modifiers.concat(["isAutoRepeat"]) });
    wcx.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  key(wc(), "T", ["control"]);
  await sleep(600);
  check("Ctrl+T opens a new tab", st().tabs.length === 2);
  check("Ctrl+T asks shell to focus address bar", sent.some((m) => m[0] === "shell:focus-url"));
  key(wc(), "Tab", ["control"]);
  await sleep(200);
  check("Ctrl+Tab cycles to next tab", st().activeTabId === st().tabs[0].id);
  key(wc(), "Tab", ["control", "shift"]);
  await sleep(200);
  check("Ctrl+Shift+Tab cycles back", st().activeTabId === st().tabs[1].id);
  key(wc(), "1", ["control"]);
  await sleep(200);
  check("Ctrl+1 selects first tab", st().activeTabId === st().tabs[0].id);
  key(wc(), "L", ["control"]);
  await sleep(200);
  check("Ctrl+L focuses address bar", sent.filter((m) => m[0] === "shell:focus-url").length >= 2);
  key(wc(), "W", ["control"]);
  await sleep(300);
  check("Ctrl+W closes the tab", st().tabs.length === 1);

  // back/forward: fresh history on the (remaining) tab, then Alt+Left
  await wc().loadURL(base + "/");
  await sleep(500);
  await wc().loadURL(base + "/other");
  await sleep(500);
  key(wc(), "Left", ["alt"]);
  await sleep(800);
  check("Alt+Left goes back", /\/$/.test(wc().getURL()));
  key(wc(), "Right", ["alt"]);
  await sleep(800);
  check("Alt+Right goes forward", /\/other$/.test(wc().getURL()));
  key(wc(), "F5");
  await sleep(300);
  check("F5 reloads (page still on /other)", /\/other$/.test(wc().getURL()));

  // shortcuts also reach the page as consumed (page must not see Ctrl+T)
  await wc().loadURL(base + "/");
  await sleep(600);

  // ── zoom ──
  key(wc(), "=", ["control"]);
  await sleep(100);
  const z1 = wc().getZoomLevel();
  key(wc(), "-", ["control"]);
  key(wc(), "-", ["control"]);
  await sleep(100);
  const z2 = wc().getZoomLevel();
  key(wc(), "0", ["control"]);
  await sleep(100);
  check("Ctrl+= zooms in", z1 > 0);
  check("Ctrl+- zooms out", z2 < z1);
  check("Ctrl+0 resets zoom", wc().getZoomLevel() === 0);

  // ── find in page ──
  key(wc(), "F", ["control"]);
  await sleep(300);
  const popup = require("../electron/popup");
  check("Ctrl+F opens the find bubble", state.findOpen && popup.isOpen("find"));
  const fb = state.mainWindow.getBrowserViews().pop().getBounds();
  check("find bubble sits top-right over the page (page not covered)", fb.width < 500 && fb.height < 80 && fb.y >= 100);
  check("page view unchanged by find (bubble overlays)", tab().view.getBounds().y === 112);
  const found = [];
  wc().on("found-in-page", (_e, r) => found.push(r));
  tabManager.findText("needle");
  await sleep(1500);
  check("find reports 2 matches", found.length && found[found.length - 1].matches === 2);
  tabManager.closeFind();
  check("closing find closes the bubble", !state.findOpen && !popup.isOpen());

  // ── Chrome-style layout ──
  check("page starts below tab strip + toolbar + bookmarks bar (112px)", tab().view.getBounds().y === 112);
  tabManager.toggleBookmarksBar();
  check("hiding the bookmarks bar moves the page up to 80px", tab().view.getBounds().y === 80 && !st().bookmarksBarVisible);
  tabManager.toggleBookmarksBar();
  check("Ctrl+Shift+B equivalent toggles it back", tab().view.getBounds().y === 112);
  key(wc(), "B", ["control", "shift"]);
  await sleep(200);
  check("Ctrl+Shift+B toggles the bookmarks bar", !st().bookmarksBarVisible);
  key(wc(), "B", ["control", "shift"]);
  await sleep(200);

  // ── a HELD Ctrl+T / Ctrl+W is one action, not thirty ──
  {
    const n0 = st().tabs.length;
    hold(wc(), "T", ["control"], 25); // ~0.8s of holding it down
    await sleep(900);
    check("holding Ctrl+T opens exactly ONE tab", st().tabs.length === n0 + 1);
    const n1 = st().tabs.length;
    hold(wc(), "W", ["control"], 25);
    await sleep(900);
    check("holding Ctrl+W closes exactly ONE tab", st().tabs.length === n1 - 1);
    // ...but zoom still repeats, which is what Chrome does for Ctrl +/-
    const zt = tabManager.getActiveTab();
    const z0 = zt.view.webContents.getZoomLevel();
    hold(wc(), "+", ["control"], 4);
    await sleep(500);
    check("holding Ctrl++ keeps zooming (Chrome repeats that one)", zt.view.webContents.getZoomLevel() > z0 + 1);
    key(wc(), "0", ["control"]);
    await sleep(300);
  }

  // ── new tab page ──
  tabManager.createTab();
  await sleep(1200);
  check("new tab loads the local new-tab page", wc().getURL().startsWith("file:") && wc().getURL().endsWith("newtab.html"));
  const ntab = st().tabs.find((t) => t.id === st().activeTabId);
  check("new tab shows an empty address bar and no site info", ntab.url === "" && ntab.siteKind === "internal" && ntab.title === "New Tab");
  check("new tab page has the search box", await wc().executeJavaScript('!!document.getElementById("q")'));
  const first = st().tabs[0];
  check("http page is flagged insecure, https secure", first.siteKind === "insecure");

  // ── tab search popup (Ctrl+Shift+A) ──
  key(wc(), "A", ["control", "shift"]);
  await sleep(1200);
  check("Ctrl+Shift+A opens tab search", popup.isOpen("tabsearch"));
  const pv = () => state.mainWindow.getBrowserViews().pop().webContents;
  const txt = await pv().executeJavaScript("document.body.innerText");
  check("tab search lists open tabs", /Open Tabs/.test(txt) && /New Tab/.test(txt));
  popup.handleAction("activate-tab", first.id);
  await sleep(300);
  check("picking a tab in tab search activates it and closes the popup", st().activeTabId === first.id && !popup.isOpen());

  // ── menu popup ──
  popup.open("menu", null);
  await sleep(1200);
  const mtxt = await pv().executeJavaScript("document.body.innerText");
  check("menu has New tab / Downloads / Zoom / Print / Find / Exit", ["New tab", "Downloads", "Zoom", "Print", "Find", "Developer tools", "Exit"].every((w) => mtxt.includes(w)));
  check("menu has no History entry (no-history browser)", !/History/i.test(mtxt));
  popup.close();

  // ── Ctrl+Shift+J opens the Downloads page; plain Ctrl+J belongs to the PAGE ──
  // Chrome's own key for Downloads is plain Ctrl+J, but a site run in this browser uses Ctrl+J for its
  // own modal, and before-input-event runs BEFORE the page (Chrome lets the page see it first). So the
  // browser's shortcut is Ctrl+Shift+J, and plain Ctrl+J must reach the page untouched (shortcuts.js).
  const DL_URL = require("../electron/constants").DOWNLOADS_URL;
  const pageWc = wc();
  await pageWc.executeJavaScript('window.__keys = []; window.addEventListener("keydown", (e) => window.__keys.push((e.ctrlKey ? "C" : "") + (e.shiftKey ? "S" : "") + "+" + e.key.toLowerCase())); 0');
  const tabsBeforeJ = state.tabs.length;
  key(pageWc, "J", ["control"]);
  await sleep(700);
  const keysSeen = await pageWc.executeJavaScript("window.__keys");
  check("plain Ctrl+J is NOT claimed: the page receives it, so a site's own Ctrl+J shortcut works", keysSeen.includes("C+j"));
  check("...and it opens no Downloads page and no new tab", state.tabs.length === tabsBeforeJ && !String(tabManager.getActiveTab().url).startsWith(DL_URL));
  key(pageWc, "J", ["control", "shift"]);
  await sleep(1200);
  const dlTab = tabManager.getActiveTab();
  check("Ctrl+Shift+J opens the Downloads page", dlTab.url.startsWith(DL_URL));
  check("...and that key is the browser's: the page never sees it", !(await pageWc.executeJavaScript("window.__keys")).includes("CS+j"));
  // a second press goes back to that same tab instead of piling up more of them
  key(wc(), "J", ["control", "shift"]);
  await sleep(800);
  check("Ctrl+Shift+J again reuses the Downloads tab (still exactly one)", state.tabs.filter((t) => String(t.url).startsWith(DL_URL)).length === 1);
  // it opened in a NEW tab, so put the test page back in front for everything below
  const pageTabId = state.tabs.find((t) => t.id !== dlTab.id).id;
  tabManager.closeTab(dlTab.id);
  tabManager.switchTab(pageTabId);
  await sleep(600);
  popup.close();
  // with the downloads bubble already open, the shortcut still goes to the PAGE and leaves no bubble over it
  // (an earlier version only closed the bubble on this second press and never opened the page first)
  popup.open("downloads", null);
  await sleep(800);
  check("(setup) the downloads bubble is open", popup.isOpen("downloads"));
  key(wc(), "J", ["control", "shift"]);
  await sleep(1000);
  check("Ctrl+Shift+J with the bubble open opens the page and closes the bubble",
    String(tabManager.getActiveTab().url).startsWith(DL_URL) && !popup.isOpen("downloads"));
  const dlTab2 = tabManager.getActiveTab();
  tabManager.closeTab(dlTab2.id);
  tabManager.switchTab(pageTabId);
  await sleep(600);
  popup.close();

  // ── site info popup ──
  popup.open("siteinfo", null);
  await sleep(1000);
  check("site info popup describes the connection", /not secure|Not secure|secure/.test(await pv().executeJavaScript("document.body.innerText")));
  popup.close();

  // ── tab drag-reorder + tab context actions ──
  const ids = st().tabs.map((t) => t.id);
  tabManager.moveTab(ids[0], ids.length - 1);
  check("moveTab reorders the strip", st().tabs[st().tabs.length - 1].id === ids[0]);
  const blankTab = st().tabs.find((t) => t.url === "");
  if (blankTab) tabManager.closeTab(blankTab.id);
  await sleep(200);

  // ── devtools / print wiring (stubbed: no real windows) ──
  let dt = 0, pr = 0;
  wc().openDevTools = () => { dt++; };
  wc().print = () => { pr++; };
  key(wc(), "F12");
  key(wc(), "I", ["control", "shift"]);
  key(wc(), "P", ["control"]);
  await sleep(200);
  check("F12 and Ctrl+Shift+I open devtools", dt === 2);
  check("Ctrl+P prints", pr === 1);

  // ── bookmark shortcut ──
  key(wc(), "D", ["control"]);
  await sleep(200);
  check("Ctrl+D toggles bookmark", sent.some((m) => m[0] === "bookmarks:changed" && m[1].length === 1));
  key(wc(), "D", ["control"]);
  await sleep(200);

  // ── external protocols ──
  await wc().executeJavaScript('document.getElementById("mail").click();0');
  await sleep(500);
  check("mailto: handed to OS after confirm", opened.includes("mailto:a@b.test"));
  await wc().executeJavaScript('document.getElementById("tel").click();0');
  await sleep(500);
  check("tel: handed to OS after confirm", opened.includes("tel:+100"));
  check("page stays put after external link", wc().getURL() === base + "/");
  await wc().executeJavaScript('window.open("file:///C:/Windows/win.ini");0');
  await sleep(300);
  check("file: popup blocked", st().tabs.length === 1);

  // ── target=_blank opens a tab ──
  await wc().executeJavaScript('document.getElementById("blank").click();0');
  await sleep(800);
  check("target=_blank opens a new tab", st().tabs.length === 2);
  tabManager.closeTab(st().activeTabId);
  await sleep(200);

  // ── middle-click on a link opens a BACKGROUND tab ──
  await wc().loadURL(base + "/");
  await sleep(600);
  const activeBefore = st().activeTabId;
  const rect = await wc().executeJavaScript('(()=>{const r=document.getElementById("blank").getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');
  wc().focus();
  wc().sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y });
  await sleep(200);
  for (const type of ["mouseDown", "mouseUp"]) wc().sendInputEvent({ type, x: rect.x, y: rect.y, button: "middle", clickCount: 1 });
  await sleep(1000);
  check("middle-click opens a new tab", st().tabs.length === 2);
  check("middle-click tab stays in background", st().activeTabId === activeBefore);
  const extra = st().tabs.find((t) => t.id !== activeBefore);
  if (extra) tabManager.closeTab(extra.id);
  await sleep(200);

  // ── context menu ──
  let template = null;
  const origBuild = Menu.buildFromTemplate;
  Menu.buildFromTemplate = (t) => { template = t; const m = origBuild(t); m.popup = () => {}; return m; };
  const params = { linkURL: base + "/second", mediaType: "none", srcURL: "", selectionText: "", isEditable: false, editFlags: {}, x: 5, y: 5 };
  wc().emit("context-menu", {}, params);
  const labels = (template || []).map((i) => i.label).filter(Boolean);
  check("context menu on link: open in new tab + copy link", labels.includes("Open link in new tab") && labels.includes("Copy link address"));
  check("context menu has Back/Forward/Reload/Inspect", ["Back", "Forward", "Reload", "Inspect"].every((l) => labels.includes(l)));
  wc().emit("context-menu", {}, { ...params, linkURL: "", isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false } });
  const l2 = template.map((i) => i.label).filter(Boolean);
  check("context menu in text field: cut/copy/paste", ["Cut", "Copy", "Paste"].every((l) => l2.includes(l)));
  Menu.buildFromTemplate = origBuild;

  // ── load failure -> error page -> retry once server is up ──
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const freePort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const failedUrl = "http://127.0.0.1:" + freePort + "/x";
  await wc().loadURL(failedUrl).catch(() => {});
  await sleep(1200);
  check("failed load shows error page (tab.errorPage set)", tab().errorPage && tab().errorPage.kind === "load");
  check("address bar keeps the failed URL", st().tabs.find((t) => t.id === st().activeTabId).url === failedUrl);
  const bodyText = await wc().executeJavaScript("document.body.innerText");
  check("error page explains and offers retry", /can.t be reached/i.test(bodyText) && /Try again/.test(bodyText) && /ERR_CONNECTION_REFUSED/.test(bodyText));
  const late = http.createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Back</title>recovered"); });
  await new Promise((r) => late.listen(freePort, "127.0.0.1", r));
  await wc().executeJavaScript('document.querySelector("a.btn").click();0');
  await sleep(1500);
  check("Try again recovers the tab", !tab().errorPage && (await wc().executeJavaScript("document.body.innerText")).includes("recovered"));
  late.close();

  // pbcalc:// links from a normal page do nothing
  await wc().loadURL(base + "/");
  await sleep(500);
  await wc().executeJavaScript('location.href="pbcalc://proceed";0');
  await sleep(500);
  check("pbcalc:// ignored outside an error page", wc().getURL() === base + "/");

  // ── renderer crash -> error page -> reload ──
  await wc().loadURL(base + "/");
  await sleep(500);
  wc().forcefullyCrashRenderer();
  await sleep(1500);
  check("renderer crash shows crash page", tab().errorPage && tab().errorPage.kind === "crash");
  tabManager.reload();
  await sleep(1500);
  check("reload recovers crashed tab", !tab().errorPage && wc().getURL() === base + "/");

  // ── certificate error ──
  await wc().loadURL(tlsUrl).catch(() => {});
  await sleep(1500);
  check("bad certificate shows warning page", tab().errorPage && tab().errorPage.kind === "cert");
  check("cert page offers proceed", /Proceed anyway/.test(await wc().executeJavaScript("document.body.innerText")));
  await wc().executeJavaScript('document.querySelector("a.ghost").click();0');
  await sleep(2000);
  check("Proceed anyway loads the site", (await wc().executeJavaScript("document.body.innerText")).includes("secure ok"));

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log((r.pass ? "PASS " : "FAIL ") + r.name));
  console.log("PBCALC_BROWSER total=" + results.length + " failed=" + failed.length);
  page.close(); tls.close();
  try { state.mainWindow.destroy(); } catch (_) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
