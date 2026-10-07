// End-to-end test of Restricted Mode against the REAL app (electron/main.js + the real shell and
// pages). Two local sites stand in for the preset bookmarks. It briefly shows the real window.
// Phase 2 (a child process, PBCALC_PHASE=2) proves the mode survives a restart.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-restricted.js
const { app, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawnSync } = require("child_process");

const PHASE2 = process.env.PBCALC_PHASE === "2";
const tmp = PHASE2 ? process.env.PBCALC_UD : fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-rm-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");
if (!PHASE2) fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });

process.on("unhandledRejection", (e) => console.log("UNHANDLED " + (e && e.stack)));
process.on("uncaughtException", (e) => console.log("UNCAUGHT " + (e && e.stack)));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(extra) {
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log((PHASE2 ? "  [restart] " : "") + (r.pass ? "PASS " : "FAIL ") + r.name));
  if (!PHASE2) console.log("PBCALC_RESTRICTED total=" + results.length + " failed=" + failed.length);
  else console.log("PBCALC_RESTRICTED_PHASE2 failed=" + failed.length);
  if (!PHASE2) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
}

// Seed the bookmarks BEFORE main.js starts the window (phase 1 only; phase 2 reads the files).
let siteA, siteB, servers = [];
async function startSites() {
  const B = http.createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Site B</title>site b"); });
  await new Promise((r) => B.listen(0, "127.0.0.1", r));
  // "localhost" resolves to the same machine but is a DIFFERENT site name than 127.0.0.1
  siteB = "http://localhost:" + B.address().port;
  const A = http.createServer((req, res) => {
    if (req.url.startsWith("/redir")) { res.statusCode = 302; res.setHeader("location", siteB + "/"); return res.end(); }
    res.setHeader("content-type", "text/html");
    if (req.url.startsWith("/page2")) return res.end("<title>Page Two</title>page two");
    res.end(`<title>Site A</title><body>site a
      <a id="same" href="/page2">same</a>
      <a id="cross" href="${siteB}/">cross</a>
      <a id="mail" href="mailto:x@y.test">mail</a>
      <button id="popsame" onclick="window.open('/page2')">ps</button>
      <button id="popcross" onclick="window.open('${siteB}/')">pc</button>
      <button id="jscross" onclick="location.href='${siteB}/'">jc</button>
      <img src="${siteB}/pixel.png"></body>`);
  });
  await new Promise((r) => A.listen(0, "127.0.0.1", r));
  siteA = "http://127.0.0.1:" + A.address().port;
  servers = [A, B];
}

require("../electron/main.js");

app.whenReady().then(async () => {
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const popup = require("../electron/popup");
  const bookmarks = require("../electron/bookmarks/bookmarkStore");
  bookmarks.setMode("real");   // these tests are about the owner's real list; a fresh launch starts on the dummy one
  const restricted = require("../electron/restricted");
  const cfg = () => JSON.parse(fs.readFileSync(path.join(tmp, "UserData", "settings.json"), "utf8"));
  let prompts = 0;
  dialog.showMessageBox = async () => { prompts++; return { response: 1 }; };

  // ── PHASE 2: a fresh launch on a copy of the data ─────────────────────
  // PBCALC_EXPECT = "restricted" (Default Start Restricted on, bookmarks present) or "normal"
  // (switch off, or switch on but no bookmarks to allow).
  if (PHASE2) {
    await sleep(3500);
    const win = state.mainWindow;
    const js = (c) => win.webContents.executeJavaScript(c);
    const want = process.env.PBCALC_EXPECT;
    if (want === "restricted") {
      check("starts straight into Restricted Mode", state.restricted === true);
      check("opens on the home page (one tab)", state.tabs.length === 1 && state.tabs[0].isHome);
      check("shell is locked (body.restricted, address bar hidden)", (await js('document.body.classList.contains("restricted") && getComputedStyle(document.getElementById("omnibox")).visibility')) === "hidden");
      check("new-tab with a URL still refused", (tm.createTab("http://127.0.0.1:1/"), state.tabs.length === 1));
    } else {
      check("starts in normal mode", state.restricted === false);
      check("normal chrome (address bar visible, no lock icon)", (await js('!document.body.classList.contains("restricted") && document.getElementById("unlock").hidden')) === true);
    }
    return finish();
  }

  await startSites();
  bookmarks.toggle({ url: siteA + "/", title: "Site A" });
  bookmarks.toggle({ url: siteB + "/", title: "Site B" });
  bookmarks.toggle({ url: siteA + "/redir", title: "Bounce" });

  await sleep(3000);
  const win = state.mainWindow;
  const sh = win.webContents;
  const js = (c) => sh.executeJavaScript(c);
  const twc = () => state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
  const key = (w, keyCode, modifiers = []) => { w.sendInputEvent({ type: "keyDown", keyCode, modifiers }); w.sendInputEvent({ type: "keyUp", keyCode, modifiers }); };

  // Ctrl+Shift then the letters; hold=true keeps the modifiers down while typing them.
  const secret = async (w, text = "pbsecure", hold = true) => {
    w.sendInputEvent({ type: "keyDown", keyCode: "Control", modifiers: ["control"] });
    w.sendInputEvent({ type: "keyDown", keyCode: "Shift", modifiers: ["control", "shift"] });
    if (!hold) { w.sendInputEvent({ type: "keyUp", keyCode: "Shift", modifiers: ["control"] }); w.sendInputEvent({ type: "keyUp", keyCode: "Control", modifiers: [] }); }
    for (const ch of text) {
      const mods = hold ? ["control", "shift"] : [];
      w.sendInputEvent({ type: "keyDown", keyCode: ch, modifiers: mods });
      w.sendInputEvent({ type: "keyUp", keyCode: ch, modifiers: mods });
    }
    if (hold) { w.sendInputEvent({ type: "keyUp", keyCode: "Shift", modifiers: ["control"] }); w.sendInputEvent({ type: "keyUp", keyCode: "Control", modifiers: [] }); }
    await sleep(700);
  };

  // ── normal mode is untouched ──
  check("normal mode: not restricted, unlock button hidden, + visible", !state.restricted && (await js('document.getElementById("unlock").hidden && getComputedStyle(document.getElementById("new-tab")).display !== "none"')) === true);

  // ── site-name rule ──
  check("site rule: subdomain of the same domain matches", restricted.sameSite("https://erp.pb.diamonds/x", restricted.siteOf("https://mfg.pb.diamonds/login")));
  check("site rule: other domain does not match", !restricted.sameSite("https://evil.example/", restricted.siteOf("https://mfg.pb.diamonds/login")));
  check("site rule: co.in style suffix handled", restricted.siteOf("https://a.pckpayroll.co.in") === "pckpayroll.co.in" && !restricted.sameSite("https://other.co.in", "pckpayroll.co.in"));
  check("site rule: file:/javascript: never match", !restricted.sameSite("file:///c:/x", "x") && !restricted.sameSite("javascript:alert(1)", "127.0.0.1"));

  // ── turn it on from the real Settings page ──
  tm.openSettings();
  await sleep(1800);
  const swc = twc();
  const api = (call) => swc.executeJavaScript(call);
  // (the "Saved passwords" card has password boxes of its own, hidden until Change password is pressed: none may be VISIBLE)
  check("settings page shows no PIN fields", (await swc.executeJavaScript('[...document.querySelectorAll("input[type=password]")].every((i) => i.offsetParent === null) && /Default Start Restricted/.test(document.body.innerText)')) === true);
  check("Default Start Restricted is off by default", (await swc.executeJavaScript('document.getElementById("rm-start").getAttribute("aria-checked")')) === "false");
  await swc.executeJavaScript('document.getElementById("rm-start").click(); 0');
  await sleep(700);
  check("the switch turns Default Start Restricted on (saved)", cfg().restricted.startRestricted === true && (await swc.executeJavaScript('document.getElementById("rm-start").getAttribute("aria-checked")')) === "true");
  await swc.executeJavaScript('document.getElementById("rm-start").click(); 0');
  await sleep(700);
  check("...and off again", cfg().restricted.startRestricted === false);
  check("still normal mode after only flipping the switch", !state.restricted);
  let r = await api('window.settingsAPI.restrictedEnable()');
  check("Turn on Restricted Mode now works (no PIN needed)", r.ok === true);
  await sleep(2500);
  check("mode is on for this session", state.restricted === true);
  const saved = fs.readFileSync(path.join(tmp, "UserData", "settings.json"), "utf8");
  check("the mode itself is not saved, and no PIN / hash exists anywhere", cfg().restricted.startRestricted === false && !/hash|salt|pin/i.test(saved));
  check("enabling dropped every old tab: only the home tab remains", state.tabs.length === 1 && state.tabs[0].isHome);

  // ── locked-down chrome ──
  const ui = await js(`(()=>{const vis=(id)=>getComputedStyle(document.getElementById(id));return {
    cls:document.body.classList.contains("restricted"),
    newTab:vis("new-tab").display, search:vis("tab-search").display, menu:vis("menu").display, star:vis("bookmark").display,
    omni:vis("omnibox").visibility, omniPE:vis("omnibox").pointerEvents,
    unlockShown:!document.getElementById("unlock").hidden,
    urlValue:document.getElementById("url-input").value,
    bar:!document.getElementById("bookmark-bar").hidden, marks:document.querySelectorAll(".bookmark").length,
    back:document.getElementById("back").offsetParent!==null, reload:document.getElementById("reload").offsetParent!==null }})()`);
  check("no tab-search or star; + and the ⋮ menu stay", ui.cls && ui.newTab !== "none" && ui.menu !== "none" && ui.search === "none" && ui.star === "none");
  check("address bar is invisible and unclickable", ui.omni === "hidden" && ui.omniPE === "none" && ui.urlValue === "");
  check("bookmarks bar shows the preset sites", ui.bar && ui.marks === 3);
  check("back / reload and the admin unlock button remain", ui.back && ui.reload && ui.unlockShown);

  // ── home page ──
  const hwc = twc();
  check("home page shows a tile per preset site and no URLs", (await hwc.executeJavaScript('document.querySelectorAll(".tile").length')) === 3 && !/127\.0\.0\.1|localhost|http/i.test(await hwc.executeJavaScript("document.body.innerText")));
  check("restrictedAPI exists only on the home page", (await hwc.executeJavaScript("typeof window.restrictedAPI")) === "object");

  // ── every way of making a tab or navigating is refused ──
  const before = state.tabs.length;
  tm.createTab("https://example.com/");
  await js('window.browserAPI.newTab("https://example.com/"); 0');
  tm.navigate("https://example.com/");
  key(hwc, "L", ["control"]);
  key(hwc, "D", ["control"]);
  key(hwc, "A", ["control", "shift"]);
  key(hwc, "I", ["control", "shift"]);
  key(hwc, "F12");
  await sleep(800);
  check("no tab with a URL can be created (API, IPC, navigate)", state.tabs.length === before && !/example\.com/.test(hwc.getURL()));
  check("Ctrl+L / Ctrl+D / Ctrl+Shift+A do nothing", !popup.isOpen() && bookmarks.list().length === 3);
  // Ctrl+Shift+B is ALLOWED here: it only shows/hides the bar, it cannot change what is in it.
  // The bar really has to move, not just the flag: #bookmark-bar in the shell AND the page view's
  // top edge (chrome is 40 + 40 + 32 with the bar, 80 without it).
  const barShown = () => js('!document.getElementById("bookmark-bar").hidden && document.getElementById("bookmark-bar").getBoundingClientRect().height > 0');
  const pageTop = () => { const t = state.tabs.find((x) => x.id === state.activeTabId); return t ? t.view.getBounds().y : -1; };
  key(hwc, "B", ["control", "shift"]);
  await sleep(600);
  check("Ctrl+Shift+B hides the bookmarks bar", state.bookmarksBarVisible === false && (await barShown()) === false);
  check("...and the page takes the freed space", pageTop() === 80);
  key(hwc, "B", ["control", "shift"]);
  await sleep(600);
  check("...and brings it back", state.bookmarksBarVisible === true && (await barShown()) === true && bookmarks.list().length === 3);
  check("...with the page pushed back down", pageTop() === 112);
  check("popup kinds tab-search / site-info / unlock (from IPC) are refused", (popup.open("tabsearch", null), popup.open("siteinfo", null), !popup.isOpen()));
  await js('window.browserAPI.openPopup("unlock", {left:1,right:2,top:1,bottom:2}); 0');
  await sleep(500);
  check("the admin panel cannot be opened from the toolbar (only the hidden shortcut)", !popup.isOpen());

  // ── ordinary browser settings stay available: ⋮ menu (without the restriction entries) ──
  await js('document.getElementById("menu").click(); 0');
  await sleep(1200);
  check("⋮ menu opens in Restricted Mode", popup.isOpen("menu"));
  const menuText = await win.getBrowserViews().pop().webContents.executeJavaScript("document.body.innerText");
  check("menu has the ordinary entries", ["New tab", "Downloads", "Zoom", "Print", "Find", "Settings", "Exit"].every((w) => menuText.includes(w)));
  check("menu hides bookmark editing, the bookmark manager and developer tools", !/Bookmark this|Remove this bookmark|Bookmark manager|Developer tools/i.test(menuText));
  check("...but keeps 'Show bookmarks bar' (a view preference, not an edit)", /Show bookmarks bar/.test(menuText));
  for (const act of ["devtools", "bookmark-manager", "bookmark-active"]) popup.handleAction(act);
  check("restricted menu actions are refused if forced", !twc().isDevToolsOpened() && state.tabs.length === before);
  popup.handleAction("toggle-bookmarks-bar");
  await sleep(400);
  check("the bookmarks-bar entry does work from the menu", state.bookmarksBarVisible === false);
  popup.handleAction("toggle-bookmarks-bar");
  await sleep(400);
  popup.close();

  // ── Settings is available; the Restricted section is not ──
  tm.openSettings();
  await sleep(1800);
  const stab = state.tabs.find((t) => t.id === state.activeTabId);
  check("Settings opens in Restricted Mode", state.tabs.length === before + 1 && stab.view.webContents.getTitle() === "Settings");
  const swc2 = stab.view.webContents;
  check("Settings hides the Restricted Mode card", (await swc2.executeJavaScript('document.getElementById("restricted-card").hidden')) === true);
  // the bookmarks-bar switch stays: showing/hiding the bar is allowed in Restricted Mode
  check("Settings keeps the bookmarks-bar switch", (await swc2.executeJavaScript('!document.getElementById("bar-row").hidden')) === true);
  // no address bar in Restricted Mode, so the switch about what typing sends to Google is pointless
  check("Settings hides the Google-suggestions card", (await swc2.executeJavaScript('document.getElementById("address-bar-card").hidden')) === true);
  await swc2.executeJavaScript('document.getElementById("bookmarks-bar").click(); 0');
  await sleep(700);
  check("the switch hides the bar from inside Restricted Mode", state.bookmarksBarVisible === false);
  await swc2.executeJavaScript('document.getElementById("bookmarks-bar").click(); 0');
  await sleep(700);
  check("...and shows it again", state.bookmarksBarVisible === true);
  check("Settings still shows Mode (Device / Light / Dark)", (await swc2.executeJavaScript('document.querySelectorAll("#mode button").length')) === 3);
  await swc2.executeJavaScript('document.querySelector("#mode [data-mode=dark]").click(); 0');
  await sleep(800);
  check("Mode works in Restricted Mode", require("electron").nativeTheme.themeSource === "dark");
  await swc2.executeJavaScript('document.querySelector("#mode [data-mode=system]").click(); 0');
  await sleep(500);
  const rr = await swc2.executeJavaScript('window.settingsAPI.restrictedEnable()');
  const rs = await swc2.executeJavaScript('window.settingsAPI.restrictedSetStart(true)');
  check("Restricted controls are refused from Settings while restricted", rr.ok === false && rs.ok === false);
  tm.closeTab(stab.id);
  await sleep(400);
  tm.switchTab(state.tabs[0].id);
  await sleep(300);
  check("lock icon is a plain indicator: clicking it does nothing", (await js('document.getElementById("unlock").click(); 0'), await sleep(600), !popup.isOpen()));
  check("lock icon says Restricted Mode is on", (await js('document.getElementById("unlock").title')) === "Restricted Mode is on");
  await js('window.browserAPI.toggleBookmark(); 0');
  check("bookmarks cannot be added, removed or edited", bookmarks.list().length === 3 && (bookmarks.remove ? true : true) && (await js('window.browserAPI.getBookmarks().then(l=>l.length)')) === 3);

  // ── the + button / Ctrl+T open the "Your sites" tiles page, never an address ──
  await js('document.getElementById("new-tab").click(); 0');
  await sleep(1500);
  check("+ opens a new 'Your sites' tab", state.tabs.length === before + 1 && state.tabs[before].isHome && (await twc().executeJavaScript('document.querySelectorAll(".tile").length')) === 3);
  tm.closeTab(state.activeTabId);
  await sleep(300);
  key(twc(), "T", ["control"]);
  await sleep(1500);
  check("Ctrl+T opens a 'Your sites' tab too", state.tabs.length === before + 1 && state.tabs[before].isHome);
  tm.closeTab(state.activeTabId);
  await sleep(300);
  check("back to a single home tab", state.tabs.length === before);

  // ── opening a preset site ──
  await hwc.executeJavaScript('document.querySelector(".tile").click(); 0'); // "Site A"
  await sleep(2000);
  check("tile opens the site in the same tab", state.tabs.length === 1 && twc().getURL().startsWith(siteA) && !state.tabs[0].isHome);
  check("tab is confined to that site", state.tabs[0].site === "127.0.0.1");
  check("tab strip never shows the address", (await js('document.querySelector(".tab-title").textContent')) === "Site A" && tm.getTabState().tabs[0].url === "");
  await js('document.querySelectorAll(".bookmark")[0].click(); 0'); // Site A again
  await sleep(600);
  check("clicking an open bookmark again switches, no duplicate tab", state.tabs.length === 1);
  await js('document.querySelectorAll(".bookmark")[1].click(); 0'); // Site B
  await sleep(2000);
  check("another bookmark opens its own tab", state.tabs.length === 2 && twc().getURL().startsWith(siteB));
  tm.switchTab(state.tabs[0].id);
  await sleep(500);

  // the address bar does not exist in Restricted Mode, so neither do its suggestions (or network requests)
  const omniR = require("../electron/omnibox");
  omniR.query("site", { left: 100, right: 500, bottom: 78, top: 46, width: 400 });
  await sleep(500);
  check("no address-bar suggestions in Restricted Mode", !omniR.isOpen());

  // the tab hover card never shows an address in Restricted Mode
  const hinfo = await tm.hoverInfo(state.tabs[0].id);
  check("hover card gives the title but no site name in Restricted Mode", hinfo && hinfo.title === "Site A" && hinfo.host === "");

  // ── confinement inside the site ──
  const a = () => twc();
  await a().executeJavaScript('document.getElementById("same").click(); 0');
  await sleep(1200);
  check("same-site link navigates", a().getURL() === siteA + "/page2");
  await a().loadURL(siteA + "/"); // back to the site's first page
  await sleep(800);
  await a().executeJavaScript('document.getElementById("cross").click(); 0');
  await sleep(1200);
  check("cross-site link is blocked (stays on the site)", a().getURL().startsWith(siteA));
  await a().executeJavaScript('document.getElementById("jscross").click(); 0');
  await sleep(1200);
  check("script navigation to another site is blocked", a().getURL().startsWith(siteA));
  const tabsBefore = state.tabs.length;
  await a().executeJavaScript('document.getElementById("popcross").click(); 0');
  await sleep(1000);
  check("cross-site popup is blocked", state.tabs.length === tabsBefore);
  await a().executeJavaScript('document.getElementById("popsame").click(); 0');
  await sleep(1500);
  check("same-site popup opens as a tab (e.g. an ERP report)", state.tabs.length === tabsBefore + 1);
  tm.closeTab(state.activeTabId);
  await sleep(300);
  tm.switchTab(state.tabs[0].id);
  prompts = 0;
  await a().executeJavaScript('document.getElementById("mail").click(); 0');
  await sleep(800);
  check("mailto: is ignored (no external app prompt)", prompts === 0 && a().getURL().startsWith(siteA));
  check("sub-resources from other sites still load (page is intact)", (await a().executeJavaScript("document.getElementById('same') !== null")) === true);

  // ── redirect off-site on the very first load ──
  tm.switchTab(state.tabs[0].id);
  await js('document.querySelectorAll(".bookmark")[2].click(); 0'); // Bounce -> 302 to other site
  await sleep(2500);
  const bt = state.tabs.find((t) => t.bookmarkId && bookmarks.list().find((b) => b.id === t.bookmarkId && b.title === "Bounce"));
  const btext = bt ? await bt.view.webContents.executeJavaScript("document.body.innerText") : "";
  check("off-site redirect is blocked with a 'blocked' page", !!bt && /blocked/i.test(btext));
  check("blocked page does not reveal any address", !/127\.0\.0\.1|localhost|http/i.test(btext));
  if (bt) tm.closeTab(bt.id);

  // ── devtools & context menu ──
  tm.switchTab(state.tabs[0].id);
  await sleep(300);
  a().openDevTools({ mode: "detach" });
  await sleep(1200);
  check("developer tools close themselves", a().isDevToolsOpened() === false);
  let template = null;
  const ob = Menu.buildFromTemplate;
  Menu.buildFromTemplate = (t) => { template = t; const m = ob(t); m.popup = () => {}; return m; };
  a().emit("context-menu", {}, { linkURL: siteA + "/page2", mediaType: "none", srcURL: "", selectionText: "", isEditable: false, editFlags: {}, x: 1, y: 1 });
  const labels = (template || []).map((i) => i.label).filter(Boolean);
  Menu.buildFromTemplate = ob;
  check("page right-click has no link address, new-tab or Inspect items", !labels.some((l) => /link|Inspect|new tab/i.test(l)) && labels.includes("Reload"));
  tm.tabContextMenu(state.tabs[0].id); // must not throw; only 'Close' exists
  check("shortcuts that remain: Ctrl+F opens find, Ctrl+P prints, Alt+Left is allowed", (key(a(), "F", ["control"]), await sleep(600), popup.isOpen("find")));
  tm.closeFind();

  // ── hidden shortcut: Ctrl+Shift, then "pbsecure" ──
  await secret(a(), "pbsecur"); // incomplete: must not trigger
  check("incomplete sequence does nothing", !popup.isOpen() && state.restricted);
  await secret(a(), "pbsxxxxx");
  check("wrong sequence does nothing", !popup.isOpen() && state.restricted);
  await secret(a(), "pbsecure", false); // modifiers released before typing
  check("Ctrl+Shift then pbsecure (released) opens the admin panel while restricted", popup.isOpen("unlock") && state.restricted);
  popup.close();
  await secret(a(), "pbsecure", true); // modifiers held while typing
  check("Ctrl+Shift+pbsecure (held) opens the admin panel while restricted", popup.isOpen("unlock") && state.restricted);
  popup.close();
  check("the shortcut alone never turns the lock off", state.restricted === true);
  // ── admin panel ──
  await secret(a(), "pbsecure", true);
  await sleep(800);
  check("the hidden shortcut opens the admin panel", popup.isOpen("unlock"));
  const pwc = () => win.getBrowserViews().pop().webContents;
  const panelText = await pwc().executeJavaScript("document.body.innerText");
  check("panel shows both buttons and asks for no PIN", /Manage sites/.test(panelText) && /Leave Restricted Mode/.test(panelText) && (await pwc().executeJavaScript('!document.querySelector("input")')) === true);
  // ── "Manage sites": opens the bookmark manager straight away (still restricted) ──
  const tabsBeforeMgr = state.tabs.length;
  check("no manager without going through the admin panel", (tm.openManager(), tm.openManager(false), state.tabs.length === tabsBeforeMgr));
  await pwc().executeJavaScript('document.querySelector(".unlock .secondary").click(); 0');
  for (let i = 0; i < 40 && !twc().getURL().endsWith("manager.html"); i++) await sleep(150); // wait for the page to commit
  await sleep(500);
  const mwc = twc();
  check("Manage sites opens the manager, still Restricted", state.restricted && state.tabs.length === tabsBeforeMgr + 1 && mwc.getURL().endsWith("manager.html") && state.adminTabId === state.activeTabId);
  check("manager API exists only on the manager page", (await mwc.executeJavaScript("typeof window.managerAPI")) === "object" && (await state.tabs[0].view.webContents.executeJavaScript("typeof window.managerAPI")) === "undefined");
  check("manager lists the current sites", (await mwc.executeJavaScript('document.querySelectorAll("#list .row").length')) === 3);
  let mr = await mwc.executeJavaScript('window.managerAPI.add("Manager Site", "example.net/login")');
  check("admin can add a site (bare address gets https://)", mr.ok && mr.list.length === 4 && mr.list[3].url === "https://example.net/login");
  await sleep(500);
  check("bookmarks bar updated live", (await js('document.querySelectorAll(".bookmark").length')) === 4);
  mr = await mwc.executeJavaScript('window.managerAPI.add("Bad", "javascript:alert(1)")');
  check("non-web addresses are rejected", mr.ok === false && mr.error === "bad-url");
  mr = await mwc.executeJavaScript('window.managerAPI.add("Dup", "https://example.net/login")');
  check("duplicate address is rejected", mr.ok === false && mr.error === "duplicate");
  const newId = bookmarks.list().find((b) => b.title === "Manager Site").id;
  mr = await mwc.executeJavaScript(`window.managerAPI.update(${JSON.stringify(newId)}, "Renamed", "https://example.net/other")`);
  check("admin can edit title and address", mr.ok && bookmarks.list().find((b) => b.id === newId).title === "Renamed" && bookmarks.list().find((b) => b.id === newId).url === "https://example.net/other");
  const order0 = bookmarks.list().map((b) => b.id);
  await mwc.executeJavaScript(`window.managerAPI.move(${JSON.stringify(newId)}, -1)`);
  const order1 = bookmarks.list().map((b) => b.id);
  check("admin can reorder", order1[2] === newId && order0[3] === newId);
  await mwc.executeJavaScript(`window.managerAPI.remove(${JSON.stringify(newId)})`);
  check("admin can remove a site", bookmarks.list().length === 3 && !bookmarks.list().some((b) => b.id === newId));
  check("changes are saved to bookmarks.json", JSON.parse(fs.readFileSync(path.join(tmp, "UserData", "bookmarks.json"), "utf8")).length === 3);
  // the manager UI itself
  await mwc.executeJavaScript('document.querySelector("#list .row .actions .btn:nth-child(3)").click(); 0'); // first row Edit
  await sleep(300);
  check("manager UI switches a row to edit mode", (await mwc.executeJavaScript('document.querySelectorAll("#list .row input").length')) === 2);
  tm.closeTab(state.adminTabId);
  await sleep(500);
  check("closing the manager ends the admin session", state.adminTabId === null && state.restricted);
  check("the home tab cannot use the manager API (session over)", tm.isManagerSender(state.tabs[0].view.webContents) === false);
  tm.switchTab(state.tabs[0].id);
  await sleep(300);
  await secret(twc(), "pbsecure", true);
  await sleep(1000);
  await win.getBrowserViews().pop().webContents.executeJavaScript('document.querySelector(".unlock .primary").click(); 0');
  await sleep(1000);
  check("Leave Restricted Mode leaves it immediately", state.restricted === false && !popup.isOpen());
  check("chrome is back to normal (+ button, menu, address bar)", (await js('!document.body.classList.contains("restricted") && document.getElementById("unlock").hidden && getComputedStyle(document.getElementById("new-tab")).display !== "none" && getComputedStyle(document.getElementById("omnibox")).visibility !== "hidden"')) === true);
  check("normal browsing works again (new tab, navigate)", (tm.createTab(), state.tabs.length >= 2));
  check("bookmarks survived intact", bookmarks.list().length === 3);

  // ── turn it back on with the hidden shortcut (a PIN exists and there are bookmarks) ──
  check("normal mode: Ctrl+Shift+O opens the bookmark manager freely", (key(twc(), "O", ["control", "shift"]), await sleep(1500), twc().getURL().endsWith("manager.html")));
  tm.closeTab(state.activeTabId);
  await sleep(300);
  await secret(twc(), "pbsecure", true);
  await sleep(1500);
  check("Ctrl+Shift+pbsecure turns Restricted Mode ON from normal mode", state.restricted === true && state.tabs.length === 1 && state.tabs[0].isHome);
  // Fresh launches on copies of the data:
  const launch = (label, want, prep) => {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-rm2-"));
    fs.mkdirSync(path.join(ud, "UserData"), { recursive: true });
    for (const f of ["settings.json", "bookmarks.json"]) {
      if (fs.existsSync(path.join(tmp, "UserData", f))) fs.copyFileSync(path.join(tmp, "UserData", f), path.join(ud, "UserData", f));
    }
    if (prep) prep(ud);
    const childEnv = { ...process.env, PBCALC_PHASE: "2", PBCALC_UD: ud, PBCALC_EXPECT: want };
    delete childEnv.ELECTRON_RUN_AS_NODE; // any value at all would make Electron behave as plain Node
    const child = spawnSync(process.execPath, [__filename], { env: childEnv, encoding: "utf8", timeout: 60000 });
    const out = (child.stdout || "") + (child.stderr || "");
    out.split(/\r?\n/).filter((l) => /\[restart\]/.test(l)).forEach((l) => console.log("  (" + label + ")" + l));
    check("restart: " + label, /PBCALC_RESTRICTED_PHASE2 failed=0/.test(out) && /\[restart\] PASS/.test(out));
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) {}
  };
  const setStart = (ud, on) => {
    const f = path.join(ud, "UserData", "settings.json");
    const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    c.restricted = { startRestricted: on };
    fs.writeFileSync(f, JSON.stringify(c));
  };

  // The use case of "Default Start Restricted": an admin switches Restricted Mode OFF during the
  // session, yet the next launch is restricted again because the switch is on.
  await sleep(300);
  tm.openSettings();
  await sleep(1800);
  await twc().executeJavaScript('document.getElementById("rm-start").click(); 0'); // switch ON (we are in restricted mode? no: restricted is on now)
  await sleep(300);
  // (Settings hides the restricted card while restricted, and the IPC refuses: so leave first)
  tm.closeTab(state.activeTabId);
  await sleep(300);
  check("switch cannot be changed while restricted", cfg().restricted.startRestricted === false);
  await secret(twc(), "pbsecure", true);
  await sleep(800);
  await win.getBrowserViews().pop().webContents.executeJavaScript('document.querySelector(".unlock .primary").click(); 0');
  await sleep(1000);
  check("admin left Restricted Mode for this session", state.restricted === false);
  tm.openSettings();
  await sleep(1800);
  await twc().executeJavaScript('document.getElementById("rm-start").click(); 0');
  await sleep(700);
  check("switch on (saved) while in normal mode", cfg().restricted.startRestricted === true);
  tm.closeTab(state.activeTabId);
  await sleep(300);
  launch("switch ON, mode was left last session -> starts Restricted", "restricted");
  launch("switch OFF -> starts normally", "normal", (ud) => setStart(ud, false));
  launch("switch ON but no bookmarks -> starts normally (nothing to allow)", "normal", (ud) => {
    try { fs.rmSync(path.join(ud, "UserData", "bookmarks.json")); } catch (_) {}
    fs.writeFileSync(path.join(ud, "UserData", "bookmarks-dummy.json"), "[]");   // a launch starts on the dummy list: it must be empty too
  });
  launch("upgrade: old PIN-version settings (enabled:true) stay locked", "restricted", (ud) => fs.writeFileSync(path.join(ud, "UserData", "settings.json"), JSON.stringify({ restricted: { enabled: true, salt: "00", hash: "00" } })));

  servers.forEach((s) => s.close());
  finish();
});
