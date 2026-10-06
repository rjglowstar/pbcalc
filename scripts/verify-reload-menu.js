// Chrome's three reloads and the right-click menu on the reload button (only while DevTools is open).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-reload-menu.js
// The reloads are measured from what the browser really sends to a local server: a normal reload revalidates the page
// (If-None-Match), a hard reload bypasses the cache (Cache-Control: no-cache, no validator) and fetches the cacheable
// script again, "empty cache" also empties the cache first. The native menu is captured (Menu.buildFromTemplate stubbed).
const { app, Menu, ipcMain } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 180000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-rm-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const win = state.mainWindow, shell = win.webContents;
    win.setAlwaysOnTop(true); win.show(); win.focus(); await sleep(500);

    // ── a server that records every request ─────────────────────────────────────────────────────
    let log = [];
    let slow = false;
    const srv = http.createServer((q, res) => {
      log.push({ url: q.url, inm: q.headers["if-none-match"] || null, cc: q.headers["cache-control"] || null, pragma: q.headers["pragma"] || null });
      if (q.url === "/old.js") { res.setHeader("content-type", "text/javascript"); res.setHeader("cache-control", "max-age=3600"); return res.end("window.old=1;"); }
      if (q.url === "/lib.js") { res.setHeader("content-type", "text/javascript"); res.setHeader("cache-control", "max-age=3600"); return res.end("window.lib=1;"); }
      if (q.url.startsWith("/page")) {
        const send = () => {
          if (q.headers["if-none-match"] === '"v1"') { res.statusCode = 304; return res.end(); }
          res.setHeader("content-type", "text/html"); res.setHeader("etag", '"v1"'); res.setHeader("cache-control", "no-cache");
          res.end('<title>reload probe</title><script src="/lib.js"></script>page');
        };
        return slow ? setTimeout(send, 2500) : send();
      }
      res.statusCode = 404; res.end();
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const active = () => state.tabs.find((t) => t.id === state.activeTabId);
    const wcOf = () => active().view.webContents;
    const pageReqs = () => log.filter((r) => r.url.startsWith("/page"));
    const libReqs = () => log.filter((r) => r.url === "/lib.js");

    tm.createTab(base + "/page"); await sleep(2000);
    check("setup: page loaded once, script fetched once", pageReqs().length === 1 && libReqs().length === 1);

    // capture the native menu instead of showing it
    let menus = [];
    const realBuild = Menu.buildFromTemplate;
    Menu.buildFromTemplate = (tpl) => { const m = { tpl, popup(o) { m.opts = o; } }; menus.push(m); return m; };
    const rect = { left: 90, bottom: 80 };
    const ask = (sender, r) => new Promise((ok) => { const e = { sender, reply() {} }; const h = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get("tabs:reload-menu"); Promise.resolve(h ? h(e, r) : false).then(ok, () => ok("threw")); });

    console.log("\n-- the menu: always available (Chrome shows it only with DevTools open; the owner wants it without)");
    menus = [];
    const shownClosed = await ask(shell, rect);
    check("DevTools CLOSED: a right-click on Reload shows the menu (no Inspect needed)", shownClosed === true && menus.length === 1);
    check("...with the three items", menus[0] && menus[0].tpl.map((x) => x.label).join("|") === "Normal Reload|Hard Reload|Empty Cache and Hard Reload");

    tm.openDevTools(); for (let i = 0; i < 40 && !wcOf().isDevToolsOpened(); i++) await sleep(250);
    check("setup: DevTools is open for the page", wcOf().isDevToolsOpened());
    win.show(); win.focus(); await sleep(400);
    menus = [];
    const shownOpen = await ask(shell, rect);
    const menu = menus[0];
    const labels = menu ? menu.tpl.map((x) => x.label) : [];
    check("DevTools open: the menu shows as well", shownOpen === true && !!menu);
    check("it has exactly Normal Reload, Hard Reload, Empty Cache and Hard Reload, in that order", labels.join("|") === "Normal Reload|Hard Reload|Empty Cache and Hard Reload");
    check("shortcut hints Ctrl+R and Ctrl+Shift+R (Chrome's wording), none for the third", menu && menu.tpl[0].accelerator === "CmdOrCtrl+R" && menu.tpl[1].accelerator === "CmdOrCtrl+Shift+R" && !menu.tpl[2].accelerator);
    check("the hints are only hints (they register no app-wide accelerator)", menu && menu.tpl.slice(0, 2).every((x) => x.registerAccelerator === false));
    check("it opens under the button, left edges aligned (x=90, y=80)", menu && menu.opts && menu.opts.x === 90 && menu.opts.y === 80);

    menus = [];
    check("only the shell can ask (a web page cannot)", (await ask(wcOf(), rect)) === false && menus.length === 0);

    console.log("\n-- each item does what its name says");
    const settle = async () => { await sleep(1800); };
    log = []; menu.tpl[0].click(); await settle();
    check("Normal Reload: the page is requested again WITH its validator (If-None-Match)", pageReqs().length === 1 && pageReqs()[0].inm === '"v1"');
    check("...and the cacheable script is served from the cache (not requested)", libReqs().length === 0);

    log = []; menu.tpl[1].click(); await settle();
    check("Hard Reload: the page is requested again WITHOUT a validator, cache bypassed", pageReqs().length === 1 && pageReqs()[0].inm === null && /no-cache/.test(pageReqs()[0].cc || "") );
    check("...and the cacheable script is fetched again", libReqs().length === 1);

    // Hard Reload re-fetches what the PAGE uses but leaves other cached files alone; Empty Cache and Hard Reload empties the
    // whole cache. Proof: cache /old.js (the page does not use it), then see which item makes it be requested again.
    const fetchOld = async () => { log = []; await wcOf().executeJavaScript('fetch("/old.js").then(r => r.text()).then(() => 0)', true); await sleep(600); return log.filter((x) => x.url === "/old.js").length; };
    check("setup: /old.js is requested the first time", (await fetchOld()) === 1);
    check("setup: ...and not again while cached", (await fetchOld()) === 0);
    menu.tpl[1].click(); await settle();
    check("Hard Reload leaves other cached files alone (/old.js still cached)", (await fetchOld()) === 0);
    log = []; menu.tpl[2].click(); await settle();
    check("Empty Cache and Hard Reload: page and script fetched again, no validator", pageReqs().length === 1 && pageReqs()[0].inm === null && libReqs().length === 1);
    check("...and it EMPTIED the cache: /old.js has to be requested again", (await fetchOld()) === 1);

    console.log("\n-- keyboard: Chrome's shortcuts");
    const key = async (k, mods) => { wcOf().focus(); log = []; wcOf().sendInputEvent({ type: "keyDown", keyCode: k, modifiers: mods }); wcOf().sendInputEvent({ type: "keyUp", keyCode: k, modifiers: mods }); await settle(); };
    const isHard = () => pageReqs().length >= 1 && pageReqs()[0].inm === null && libReqs().length === 1;
    const isNormal = () => pageReqs().length >= 1 && pageReqs()[0].inm === '"v1"' && libReqs().length === 0;
    await wcOf().executeJavaScript("location.reload(); 0"); await settle();   // warm cache
    await key("R", ["control"]);            check("Ctrl+R = normal reload", isNormal());
    await key("R", ["control", "shift"]);   check("Ctrl+Shift+R = HARD reload (was a plain reload before)", isHard());
    await key("F5", []);                    check("F5 = normal reload", isNormal());
    await key("F5", ["control"]);           check("Ctrl+F5 = HARD reload (was a plain reload before)", isHard());
    await key("F5", ["shift"]);             check("Shift+F5 = HARD reload (was a plain reload before)", isHard());

    console.log("\n-- the button");
    // right-click through the real DOM event in the shell
    menus = [];
    await shell.executeJavaScript('document.getElementById("reload").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 90, clientY: 60 })); 0');
    await sleep(500);
    check("a right-click on the real Reload button opens the menu", menus.length === 1 && menus[0].tpl.length === 3);
    check("...anchored at the button's real rectangle", menus[0] && menus[0].opts && Math.abs(menus[0].opts.x - Math.round(await shell.executeJavaScript('document.getElementById("reload").getBoundingClientRect().left'))) <= 1);
    // a plain click still reloads
    log = [];
    await shell.executeJavaScript('document.getElementById("reload").click(); 0'); await settle();
    check("a plain left click still reloads", pageReqs().length === 1);

    console.log("\n-- not while the page is loading (the button is Stop then)");
    slow = true;
    await wcOf().executeJavaScript("location.reload(); 0"); await sleep(700);
    menus = [];
    check("loading: no menu from main", (await ask(shell, rect)) === false && menus.length === 0);
    await shell.executeJavaScript('document.getElementById("reload").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); 0'); await sleep(400);
    check("loading: no menu from the button either", menus.length === 0);
    await sleep(3000); slow = false;

    console.log("\n-- Restricted Mode: no DevTools, and the reload menu is there too");
    wcOf().closeDevTools(); await sleep(500);
    const store = require("../electron/bookmarks/bookmarkStore"); store.setMode("real"); store.toggle({ url: base + "/page", title: "Probe", favicon: "" });
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    tm.openDevTools(); await sleep(700);
    check("DevTools still cannot be opened in Restricted Mode", !wcOf().isDevToolsOpened());
    menus = [];
    const shownR = await ask(shell, rect);
    check("the reload menu shows although DevTools is closed (and cannot be opened)", shownR === true && menus.length === 1);
    check("...with the same three items", menus[0] && menus[0].tpl.map((x) => x.label).join("|") === "Normal Reload|Hard Reload|Empty Cache and Hard Reload");
    menus = [];
    await shell.executeJavaScript('document.getElementById("reload").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); 0'); await sleep(500);
    check("...and the Reload button's right-click opens it there", menus.length === 1);
    const rm = menus[0];
    for (const i of [0, 1, 2]) { if (rm) rm.tpl[i].click(); await sleep(1200); }
    check("all three items work in Restricted Mode (no error, still Restricted)", errors.length === 0 && state.restricted === true);
    menus = [];
    check("only the shell can ask in Restricted Mode too", (await ask(wcOf(), rect)) === false && menus.length === 0);
    tm.leaveRestricted(); await sleep(800);
    Menu.buildFromTemplate = realBuild;
    check("no uncaught error in the main process", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_RELOADMENU total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
