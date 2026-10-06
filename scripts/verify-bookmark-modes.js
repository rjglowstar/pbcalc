// The two bookmark lists: a DUMMY list everybody sees by default and the owner's REAL list, revealed by three quick clicks
// on the "100%" in the menu. Checks that the real list never shows while dummy is active (bar, IPC, manager, star), that
// each list is edited independently, that the switch is hidden/guarded (not in Restricted Mode), and - in a second
// process - that a restart always comes back on the dummy list with the dummy edits kept and the real list untouched.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-bookmark-modes.js
const { app } = require("electron");
const { spawnSync } = require("child_process");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
const PH = process.env.PBCALC_PHASE || "";
const PHASE2 = ["2", "3", "4", "5"].includes(PH);   // any child process (2 = restart check, 3/4/5 = dummy-list upgrade checks)
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const root = PHASE2 ? process.env.PBCALC_UD : fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-modes-"));
const ud = path.join(root, "UserData");
const constants = require("../electron/constants");
constants.dataDir = () => ud;
const REAL_SEED = [{ id: "r1", title: "Secret A", url: "https://secret-a.example/", favicon: "" }, { id: "r2", title: "Secret B", url: "https://secret-b.example/", favicon: "" }];
if (!PHASE2) { fs.mkdirSync(ud, { recursive: true }); fs.writeFileSync(path.join(ud, "bookmarks.json"), JSON.stringify(REAL_SEED)); }   // the owner's existing bookmarks
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log((PHASE2 ? "  [restart] " : "  .. ") + (cond ? "ok " : "FAIL ") + name); };
const finish = () => { const failed = results.filter((r) => !r.pass).length; console.log("PBCALC_BOOKMARKMODES" + (PHASE2 ? "_PHASE2" : "") + " total=" + results.length + " failed=" + failed); app.exit(failed ? 1 : 0); };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ud, f), "utf8")); } catch (_) { return null; } };
const itemsOf = (j) => (Array.isArray(j) ? j : j && j.items);   // the dummy file is { version, items }; the real one a plain array
const titles = (arr) => (arr || []).map((b) => b.title).join(",");
const DEFAULT_TITLES = "GIA,GJEPC,Surat Diamond Bourse,BDB India,Surat Diamond Trade";
const DEFAULT_URLS = ["https://www.gia.edu/", "https://www.gjepc.org/index.php", "https://www.suratdiamondbourse.in/", "https://bdbindia.org/", "https://suratdiamondtrade.com/"];
const V1_ITEMS = (extra = []) => [["Google", "https://www.google.com/"], ["Gmail", "https://mail.google.com/"], ["Maps", "https://maps.google.com/"], ["YouTube", "https://www.youtube.com/"], ["Drive", "https://drive.google.com/"], ["Calendar", "https://calendar.google.com/"], ...extra].map(([title, url], i) => ({ id: "v" + i, title, url, favicon: "" }));

app.whenReady().then(async () => {
  try {
    await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const popup = require("../electron/popup");
    const bm = require("../electron/bookmarks/bookmarkStore");
    const win = state.mainWindow, shell = win.webContents;

    if (PH === "3" || PH === "4" || PH === "5") {
      const want = JSON.parse(process.env.PBCALC_EXPECT);
      const onDisk = readJson("bookmarks-dummy.json");
      check("starts on the dummy list", bm.getMode() === "dummy");
      check("the dummy list is: " + want.titles, titles(bm.list()) === want.titles);
      check("the file is saved in the current format (version 2)", !!onDisk && !Array.isArray(onDisk) && onDisk.version === 2 && titles(itemsOf(onDisk)) === want.titles);
      if (want.defaultsWithIcons) check("every default site has its icon (a data: image)", bm.list().filter((b) => `${JSON.stringify(DEFAULT_URLS)}`.includes(b.url)).every((b) => b.favicon.startsWith("data:image/png")));
      if (want.noGoogle) check("none of the old Google defaults is left", !bm.list().some((b) => /google\.com|youtube\.com/.test(b.url)));
      return finish();
    }
    if (PHASE2) {
      const want = JSON.parse(process.env.PBCALC_EXPECT);
      check("a fresh launch starts on the DUMMY list", bm.getMode() === "dummy");
      check("the dummy edits made before the restart are still there", titles(bm.list()) === want.dummyTitles);
      check("the real list is untouched on disk", titles(readJson("bookmarks.json")) === want.realTitles);
      check("the bar shows only the dummy list", (await shell.executeJavaScript('[...document.querySelectorAll(".bookmark .bookmark-title")].map(e => e.textContent).join(",")')) === want.dummyTitles);
      check("the real list never shows on the bar after a restart", !(await shell.executeJavaScript('document.body.innerText')).includes("Secret"));
      return finish();
    }

    win.setAlwaysOnTop(true); win.show(); win.focus(); await sleep(500);
    const barTitles = () => shell.executeJavaScript('[...document.querySelectorAll(".bookmark .bookmark-title")].map(e => e.textContent).join(",")');
    const barText = () => shell.executeJavaScript("document.getElementById('bookmark-bar').innerText");
    if (!state.bookmarksBarVisible) { tm.toggleBookmarksBar(); await sleep(500); }
    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>site " + q.url + "</title>x"); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const dummyOnDisk = () => itemsOf(readJson("bookmarks-dummy.json"));

    console.log("-- first start: the dummy list");
    check("the browser starts on the DUMMY list", bm.getMode() === "dummy");
    check("fresh install: the dummy list is the 5 diamond-trade sites you chose", titles(bm.list()) === DEFAULT_TITLES);
    check("they are exactly your addresses", bm.list().map((b) => b.url).join(" ") === DEFAULT_URLS.join(" "));
    check("every one has its own icon (a small embedded image, not a globe)", bm.list().every((b) => b.favicon.startsWith("data:image/png")));
    check("the dummy file is versioned ({version:2, items})", readJson("bookmarks-dummy.json").version === 2);
    check("the dummy list is saved in its own file", titles(dummyOnDisk()) === DEFAULT_TITLES);
    await sleep(600);
    check("the bar shows the dummy bookmarks", (await barTitles()) === DEFAULT_TITLES);
    check("the owner's real bookmarks are NOT on the bar", !(await barText()).includes("Secret"));
    check("...nor in what the shell asks for (bookmarks:list)", titles(await shell.executeJavaScript("window.browserAPI.getBookmarks()")) === DEFAULT_TITLES);
    const realBytes = fs.readFileSync(path.join(ud, "bookmarks.json"), "utf8");
    check("the real file is untouched by the seeding", realBytes === JSON.stringify(REAL_SEED));

    console.log("\n-- the bookmark manager shows only the active list");
    tm.openManager(); await sleep(2200);
    const mgrText = () => state.tabs.find((t) => /manager\.html/.test(t.url)).view.webContents.executeJavaScript("document.body.innerText");
    check("dummy mode: the manager lists the dummy bookmarks only", /GJEPC/.test(await mgrText()) && !/Secret/.test(await mgrText()));
    tm.closeTab(state.activeTabId); await sleep(300);

    console.log("\n-- editing the dummy list (add, edit, delete, reorder) never touches the real one");
    tm.createTab(base + "/dummy-page"); await sleep(1500);
    const dummyBefore = bm.list().length;
    tm.toggleBookmarkActive(); await sleep(1200); popup.close(); await sleep(300);
    check("add (star): the page is added to the DUMMY list", bm.list().length === dummyBefore + 1 && titles(dummyOnDisk()).includes("site /dummy-page"));
    const gjepc = bm.list().find((b) => b.title === "GJEPC");
    bm.update(gjepc.id, { title: "Gems" });
    check("edit: renamed in the dummy list", titles(dummyOnDisk()).includes("Gems") && !titles(dummyOnDisk()).includes("GJEPC"));
    bm.remove(bm.list().find((b) => b.title === "BDB India").id);
    check("delete: removed from the dummy list", !titles(dummyOnDisk()).includes("BDB India"));
    bm.moveTo(bm.list().find((b) => b.title === "Surat Diamond Trade").id, 0);
    check("reorder: Surat Diamond Trade first", titles(dummyOnDisk()).startsWith("Surat Diamond Trade"));
    tm.broadcastBookmarks(); await sleep(500);
    const dummyFinal = titles(bm.list());
    check("the REAL file is byte-for-byte unchanged by all of that", fs.readFileSync(path.join(ud, "bookmarks.json"), "utf8") === realBytes);
    check("the star shows the page as bookmarked (dummy list)", await shell.executeJavaScript('document.getElementById("bookmark").classList.contains("on")'));
    tm.closeTab(state.activeTabId); await sleep(300);

    console.log("\n-- the hidden switch: three quick clicks on the 100% in the menu");
    const zclick = (n, gap) => (async () => { for (let i = 0; i < n; i++) { await win.getBrowserViews().pop().webContents.executeJavaScript('document.querySelector(".zval").click(); 0'); await sleep(gap); } })();
    // three quick clicks in ONE menu session; if the menu is closed under us (the window lost focus) start again
    const triple = async () => { for (let a = 0; a < 3; a++) { await openMenu(); try { await zclick(3, 120); return true; } catch (_) {} } return false; };
    const openMenu = async () => { popup.close(); await sleep(250); win.show(); win.focus(); popup.open("menu", null); for (let i = 0; i < 30; i++) { await sleep(100); try { if (await win.getBrowserViews().pop().webContents.executeJavaScript('!!document.querySelector(".zval")')) return; } catch (_) {} } };
    tm.zoom(+1); await sleep(300);
    const zoomLevel = () => state.tabs.find((t) => t.id === state.activeTabId).view.webContents.getZoomLevel();
    check("setup: the page is zoomed (not 100%)", zoomLevel() !== 0);
    // A menu closes when the window loses focus (the PC is in use). Every click step therefore starts from a freshly
    // opened menu and is repeated if the menu was closed under it.
    const attempt = async (fn) => { for (let k = 0; k < 4; k++) { try { await fn(); return true; } catch (_) {} } return false; };
    let tip = null;
    await attempt(async () => { await openMenu(); tip = await win.getBrowserViews().pop().webContents.executeJavaScript('document.querySelector(".zval").title'); });
    check("the 100% is still there with its normal tooltip 'Reset zoom'", tip === "Reset zoom");
    await attempt(async () => { await openMenu(); await zclick(1, 100); }); await sleep(400);
    check("a click on the 100% still does its normal job: it resets the zoom", zoomLevel() === 0);
    await attempt(async () => { await openMenu(); await zclick(2, 150); }); await sleep(500);
    check("two clicks do nothing", bm.getMode() === "dummy" && (await barTitles()) === dummyFinal);
    const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;   // pretend 2.3 s went by (the window is 2 s)
    await attempt(async () => { skew = 0; await openMenu(); await zclick(1, 100); skew += 2300; await zclick(2, 100); }); await sleep(500);
    Date.now = realNow;
    check("clicks spread over more than 2 seconds do not add up", bm.getMode() === "dummy");
    await attempt(async () => { await openMenu(); await zclick(2, 100); await openMenu(); await zclick(1, 100); }); await sleep(500);
    check("clicks in different menu sessions do not add up", bm.getMode() === "dummy");
    await triple(); await sleep(900);
    check("THREE quick clicks switch to the REAL list", bm.getMode() === "real");
    check("the bar now shows the owner's real bookmarks", (await barTitles()) === "Secret A,Secret B");
    check("...and none of the dummy ones", !(await barText()).includes("GIA") && !(await barText()).includes("Gems"));
    check("the menu closes at the moment the list switches", !popup.isOpen("menu"));

    console.log("\n-- editing the REAL list never touches the dummy one");
    const dummyBytes = fs.readFileSync(path.join(ud, "bookmarks-dummy.json"), "utf8");
    popup.close(); await sleep(300);
    tm.createTab(base + "/real-page"); await sleep(1500);
    tm.toggleBookmarkActive(); await sleep(1200); popup.close(); await sleep(300);
    check("add (star): goes into the REAL list", titles(readJson("bookmarks.json")).includes("site /real-page"));
    bm.update("r1", { title: "Secret A2" });
    check("edit: renamed in the real list", titles(readJson("bookmarks.json")).includes("Secret A2"));
    bm.remove("r2");
    check("delete: removed from the real list", !titles(readJson("bookmarks.json")).includes("Secret B"));
    bm.moveTo(bm.list().find((b) => b.title === "site /real-page").id, 0);
    check("reorder works in the real list", titles(readJson("bookmarks.json")).startsWith("site /real-page"));
    check("the DUMMY file is byte-for-byte unchanged by all of that", fs.readFileSync(path.join(ud, "bookmarks-dummy.json"), "utf8") === dummyBytes);
    tm.closeTab(state.activeTabId); await sleep(300);
    tm.openManager(); await sleep(2200);
    check("real mode: the manager lists the real bookmarks", /Secret A2/.test(await mgrText()) && !/Surat Diamond Trade/.test(await mgrText()));
    check("an open edit box is closed when the list changes under it", (() => { popup.open("bookmark-edit", null, { bookmarkId: bm.list()[0].id }); return popup.isOpen("bookmark-edit"); })());
    await sleep(800);
    await triple(); await sleep(1200);
    check("THREE more clicks switch back to the DUMMY list", bm.getMode() === "dummy" && (await barTitles()) === dummyFinal);
    check("...and the menu closes then too", !popup.isOpen("menu"));
    check("the open edit box was closed by the switch", !popup.isOpen("bookmark-edit"));
    check("the open manager tab was reloaded: it no longer shows the real list", !/Secret/.test(await mgrText()) && /Surat Diamond Trade/.test(await mgrText()));
    tm.closeTab(state.activeTabId); await sleep(300);
    const realFinal = titles(readJson("bookmarks.json"));

    console.log("\n-- the switch works only while the bookmarks bar is shown (normal mode)");
    tm.toggleBookmarksBar(); await sleep(600);
    check("setup: bookmarks bar hidden", !state.bookmarksBarVisible);
    await triple(); await sleep(900);
    check("bar hidden: three clicks do NOT switch the list", bm.getMode() === "dummy");
    check("...the menu is left as it was (nothing happened)", popup.isOpen("menu"));
    popup.close(); await sleep(300);
    tm.toggleBookmarksBar(); await sleep(600);
    check("bar shown again", state.bookmarksBarVisible && (await barTitles()) === dummyFinal);

    console.log("\n-- Restricted Mode follows the current list; the switch works there too and leaves the open tabs alone");
    const homeTab = () => state.tabs.find((t) => t.isHome);
    const homeTiles = () => homeTab().view.webContents.executeJavaScript('[...document.querySelectorAll(".tile .name")].map(e => e.textContent.trim()).join(",")');
    check("setup: dummy mode, restricted off", bm.getMode() === "dummy" && !state.restricted);
    bm.add({ title: "dropme", url: base + "/dropme" }); tm.broadcastBookmarks();
    const dropId = bm.list().find((b) => b.title === "dropme").id;
    const dummyNow = titles(bm.list());
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode on (dummy list active)", state.restricted === true);
    check("Restricted Mode shows the DUMMY sites on the bar", (await barTitles()) === dummyNow);
    check("...and on the 'Your sites' page", (await homeTiles()) === dummyNow);
    tm.openBookmark(dropId); await sleep(1800);   // a real site tab (opening a site reuses the home tab)
    tm.createTab(undefined, { allowRestricted: true }); await sleep(900);   // and a "Your sites" tab next to it
    const siteTab = () => state.tabs.find((t) => /\/dropme$/.test(t.url || ""));
    check("setup: a site tab AND a 'Your sites' tab are open", !!siteTab() && !!homeTab() && state.tabs.length === 2);
    const siteId = siteTab().id;

    await triple(); await sleep(1800);
    check("three clicks in Restricted Mode switch to the REAL list", bm.getMode() === "real" && state.restricted === true);
    check("the bar shows the real sites", (await barTitles()) === realFinal);
    check("the open site tab is STILL OPEN (nothing is closed)", state.tabs.length === 2 && !!siteTab() && siteTab().id === siteId);
    check("the 'Your sites' page was refreshed: it shows the real sites", (await homeTiles()) === realFinal);
    check("the menu closed at the switch", !popup.isOpen("menu"));
    await triple(); await sleep(1800);
    check("three more clicks switch back to the DUMMY list, still Restricted", bm.getMode() === "dummy" && state.restricted === true && (await barTitles()) === dummyNow);
    check("...both tabs still open, 'Your sites' shows the dummy sites again", state.tabs.length === 2 && !!siteTab() && siteTab().id === siteId && (await homeTiles()) === dummyNow);
    check("Restricted Mode itself is unchanged (still locked, no address bar)", state.restricted === true && (await shell.executeJavaScript('document.body.classList.contains("restricted")')));

    tm.toggleBookmarksBar(); await sleep(600);
    await triple(); await sleep(900);
    check("Restricted Mode, bar hidden: three clicks do NOT switch", bm.getMode() === "dummy" && state.tabs.length === 2);
    popup.close(); await sleep(300);
    tm.toggleBookmarksBar(); await sleep(600);
    check("(bar shown again)", state.bookmarksBarVisible);

    tm.leaveRestricted(); await sleep(1000);
    check("leaving Restricted Mode keeps the active list (dummy)", bm.getMode() === "dummy" && (await barTitles()) === dummyNow);
    await triple(); await sleep(900); popup.close(); await sleep(300);
    check("unlocked again outside Restricted Mode", bm.getMode() === "real");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode started with the real list active shows the REAL sites", state.restricted === true && (await barTitles()) === realFinal && (await homeTiles()) === realFinal);
    tm.leaveRestricted(); await sleep(1000);
    // go back to dummy for the restart check
    await triple(); await sleep(900); popup.close(); await sleep(300);
    check("(back on the dummy list before the restart check)", bm.getMode() === "dummy");

    check("no uncaught error in the main process", errors.length === 0);
    srv.close();

    console.log("\n-- restart: a new process on a copy of the data");
    const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-modes2-"));
    fs.mkdirSync(path.join(ud2, "UserData"), { recursive: true });
    for (const f of ["bookmarks.json", "bookmarks-dummy.json", "settings.json"]) if (fs.existsSync(path.join(ud, f))) fs.copyFileSync(path.join(ud, f), path.join(ud2, "UserData", f));
    const childEnv = { ...process.env, PBCALC_PHASE: "2", PBCALC_UD: ud2, PBCALC_EXPECT: JSON.stringify({ dummyTitles: titles(dummyOnDisk()), realTitles: realFinal }) };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(process.execPath, [__filename], { env: childEnv, encoding: "utf8", timeout: 90000 });
    const out = (child.stdout || "") + (child.stderr || "");
    out.split(/\r?\n/).filter((l) => /\[restart\]/.test(l)).forEach((l) => console.log(l));
    check("restart: every check in the new process passed", /PBCALC_BOOKMARKMODES_PHASE2 total=\d+ failed=0/.test(out));
    try { fs.rmSync(ud2, { recursive: true, force: true }); } catch (_) {}

    console.log("\n-- upgrading a dummy list saved BEFORE these sites were chosen (the old six Google sites)");
    const upgrade = (label, phase, dummyContent, expect) => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-modes-up-"));
      fs.mkdirSync(path.join(d, "UserData"), { recursive: true });
      fs.writeFileSync(path.join(d, "UserData", "bookmarks.json"), JSON.stringify(REAL_SEED));
      fs.writeFileSync(path.join(d, "UserData", "bookmarks-dummy.json"), JSON.stringify(dummyContent));
      const env = { ...process.env, PBCALC_PHASE: phase, PBCALC_UD: d, PBCALC_EXPECT: JSON.stringify(expect) };
      delete env.ELECTRON_RUN_AS_NODE;
      const c = spawnSync(process.execPath, [__filename], { env, encoding: "utf8", timeout: 90000 });
      const o = (c.stdout || "") + (c.stderr || "");
      o.split(/\r?\n/).filter((l) => /\[restart\]/.test(l)).forEach((l) => console.log("   (" + label + ")" + l));
      check(label, /PBCALC_BOOKMARKMODES_PHASE2 total=\d+ failed=0/.test(o));
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    };
    upgrade("an old list of six Google sites (reordered, plus one the user added) becomes the five new sites + the user's own", "3", V1_ITEMS([["Mine", "https://example.org/"]]),
      { titles: DEFAULT_TITLES + ",Mine", defaultsWithIcons: true, noGoogle: true });
    upgrade("an old list the user EMPTIED stays empty (nothing is re-added)", "4", [], { titles: "" });
    upgrade("a current list from which the user removed GIA does not get it back", "5", { version: 2, items: V1_ITEMS().slice(0, 0).concat([{ id: "k1", title: "GJEPC", url: "https://www.gjepc.org/index.php", favicon: "" }]) }, { titles: "GJEPC" });
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  finish();
});
