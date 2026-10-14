// The bookmarks bar ALWAYS shows on a New Tab page, like Chrome, even when "Show bookmarks bar" is off (owner 2026-10-14). Everywhere else the setting decides,
// unchanged. It shows the ACTIVE list (dummy or real). Restricted Mode too: there the new-tab page is "Your sites". Checks the SHELL element #bookmark-bar
// and the page view's top edge (112 with the bar, 80 without) - the flag alone proves nothing - on: the first tab, a website, a new tab, switching tabs,
// the setting turned on and off again, the dummy/real list, the hidden 3-click switch, and Restricted Mode.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-ntp-bookmarks.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process"), http = require("http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.env.PBC_NB_MODE;

if (MODE) {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbnb-"));
  const ud = path.join(tmp, "UserData");
  require("../electron/constants").dataDir = () => ud;
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: false, restricted: { startRestricted: MODE === "restricted" } }));
  fs.writeFileSync(path.join(ud, "bookmarks.json"), JSON.stringify([{ id: "r1", title: "Real One", url: "http://real.example/", favicon: "" }]));
  (async () => {
    require("../electron/main.js");
    await app.whenReady();
    const state = require("../electron/state"), tm = require("../electron/tabs/tabManager"), store = require("../electron/bookmarks/bookmarkStore");
    for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);
    const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<title>site</title>x"); }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const site = "http://127.0.0.1:" + srv.address().port + "/";
    const look = async (label) => {
      await sleep(700);
      const t = tm.getActiveTab();
      const bar = await state.mainWindow.webContents.executeJavaScript(`(() => { const b = document.getElementById("bookmark-bar"); return { shown: !!b && !b.hidden && b.offsetHeight > 0, titles: b ? Array.from(b.querySelectorAll(".bm-title, .bookmark-title, span")).map((x) => x.textContent.trim()).filter(Boolean).slice(0, 8) : [] }; })()`);
      return { label, shown: bar.shown, titles: bar.titles, top: t ? t.view.getBounds().y : null, url: t ? t.url.replace(/.*\/renderer\//, "") : "" };
    };
    const out = [];
    const waitLoaded = async () => { const t = tm.getActiveTab(); for (let i = 0; i < 300 && (t.view.webContents.isLoading() || !t.view.webContents.getURL()); i++) await sleep(20); };
    await waitLoaded();
    out.push(await look("first tab (new-tab page)"));
    if (MODE === "normal") {
      tm.navigate ? tm.navigate(site) : state.tabs[0].view.webContents.loadURL(site);
      await waitLoaded(); out.push(await look("the same tab on a website"));
      tm.createTab(); await waitLoaded(); out.push(await look("a new tab"));
      tm.switchTab(state.tabs[0].id); out.push(await look("switched back to the website tab"));
      tm.switchTab(state.tabs[1].id); out.push(await look("switched to the new-tab tab again"));
      out.push({ label: "3-click switch on the new-tab page (setting off)", switched: tm.toggleBookmarkMode() });
      store.setMode("real"); tm.broadcastBookmarks();   // the real list made active the other way, to see the bar follow it
      out.push(await look("after the switch (real list)"));
      tm.switchTab(state.tabs[0].id); await sleep(300);
      out.push({ label: "3-click switch on a website (setting off)", switched: tm.toggleBookmarkMode() });
      tm.toggleBookmarksBar(); out.push(await look("setting turned ON, on the website"));
      tm.toggleBookmarksBar(); out.push(await look("setting OFF again, on the website"));
      out.push({ label: "setting saved", setting: JSON.parse(fs.readFileSync(path.join(ud, "settings.json"), "utf8")).showBookmarksBar, mode: store.getMode() });
    } else {
      out.push({ label: "restricted", restricted: !!state.restricted });
      tm.createTab(null, { allowRestricted: true }); await waitLoaded(); out.push(await look("a new 'Your sites' tab"));
      tm.createTab(site, { allowRestricted: true, site: "127.0.0.1" }); await waitLoaded(); out.push(await look("a site tab"));
    }
    srv.close();
    console.log("RESULT " + JSON.stringify(out));
    app.exit(0);
  })().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
} else {
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 300000).unref();
  let failed = 0, total = 0;
  const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 300) + ">" : "")); };
  const run = (mode) => new Promise((resolve) => {
    const env = { ...process.env, PBC_NB_MODE: mode }; delete env.ELECTRON_RUN_AS_NODE;
    let out = ""; const c = cp.spawn(process.execPath, [__filename], { env, windowsHide: true });
    c.stdout.on("data", (d) => { out += d; });
    c.on("exit", () => { const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { error: out.slice(-400) }); });
  });
  const bar = (x) => x && x.shown === true && x.top === 112, nobar = (x) => x && x.shown === false && x.top === 80;
  app.whenReady().then(async () => {
    console.log("-- normal mode, 'Show bookmarks bar' OFF");
    const r = await run("normal");
    check("the run completed", Array.isArray(r), r.error);
    if (Array.isArray(r)) {
      const g = (l) => r.find((x) => x.label === l) || {};
      check("first tab = new-tab page: the bar is shown (page at 112)", bar(g("first tab (new-tab page)")), JSON.stringify(g("first tab (new-tab page)")));
      check("...with the DUMMY list (the active one after a start)", (g("first tab (new-tab page)").titles || []).some((t) => /GIA|GJEPC|Surat|BDB/.test(t)), JSON.stringify(g("first tab (new-tab page)").titles));
      check("the same tab on a website: hidden again (setting off; page at 80)", nobar(g("the same tab on a website")), JSON.stringify(g("the same tab on a website")));
      check("a new tab: shown", bar(g("a new tab")), JSON.stringify(g("a new tab")));
      check("switching to the website tab hides it, back to the new-tab tab shows it", nobar(g("switched back to the website tab")) && bar(g("switched to the new-tab tab again")), JSON.stringify([g("switched back to the website tab"), g("switched to the new-tab tab again")]));
      check("the hidden 3-click switch is UNCHANGED: with the setting off it does not switch, also on the new-tab page", g("3-click switch on the new-tab page (setting off)").switched === false && g("3-click switch on a website (setting off)").switched === false, JSON.stringify([g("3-click switch on the new-tab page (setting off)"), g("3-click switch on a website (setting off)")]));
      check("the bar on the new-tab page follows the ACTIVE list: the real list once it is active", (g("after the switch (real list)").titles || []).includes("Real One") && bar(g("after the switch (real list)")), JSON.stringify(g("after the switch (real list)")));
      check("the setting itself works as before: ON shows it on the website, OFF hides it there", bar(g("setting turned ON, on the website")) && nobar(g("setting OFF again, on the website")), JSON.stringify([g("setting turned ON, on the website"), g("setting OFF again, on the website")]));
      check("the setting is saved as the user set it (off) - the New Tab rule does not change it", g("setting saved").setting === false, JSON.stringify(g("setting saved")));
    }
    console.log("-- Restricted Mode, setting OFF");
    const q = await run("restricted");
    check("the run completed", Array.isArray(q), q.error);
    if (Array.isArray(q)) {
      const g = (l) => q.find((x) => x.label === l) || {};
      check("the browser is in Restricted Mode", g("restricted").restricted === true);
      check("the 'Your sites' page (the new-tab page there) shows the bar", bar(g("first tab (new-tab page)")) && bar(g("a new 'Your sites' tab")), JSON.stringify([g("first tab (new-tab page)"), g("a new 'Your sites' tab")]));
      check("a site tab hides it (setting off)", nobar(g("a site tab")), JSON.stringify(g("a site tab")));
    }
    console.log("\nPBCALC_NTPBAR total=" + total + " failed=" + failed);
    app.exit(failed ? 1 : 0);
  });
}
