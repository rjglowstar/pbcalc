// Two things about LINKS that open something else:
//  1. Links for other applications (whatsapp://, steam://, ms-settings: ...). Chromium asks the "openExternal" permission
//     before handing them to Windows; with no handler Electron GRANTS it, so any page could launch any registered app, and an
//     unregistered one (api.whatsapp.com's "open the app" redirect) made Windows show "You'll need a new app to open this
//     whatsapp link - Look for an app in the Microsoft Store". The product must route it through its own policy and deny.
//  2. A tab opened from a page (target=_blank, window.open, Ctrl+click, "open link in new tab") goes RIGHT AFTER its opener
//     (behind earlier tabs from the same opener), like Chrome - not at the end of the strip.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-link-handling.js
const { app, dialog, shell } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 200000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-links-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");
// remember the handler the PRODUCT registers on each session (so the test exercises the real one)
const registered = new Map();
app.on("session-created", (ses) => {
  const orig = ses.setPermissionRequestHandler.bind(ses);
  ses.setPermissionRequestHandler = (h) => { registered.set(ses, h); return orig(h); };
});
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const { session } = require("electron");
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const prompts = [], opened = [];
    dialog.showMessageBox = async (...a) => { prompts.push(a[a.length - 1]); return { response: 1 }; };   // always "Cancel": nothing is ever launched
    shell.openExternal = async (u) => { opened.push(u); };
    const srv = http.createServer((q, res) => {
      res.setHeader("content-type", "text/html");
      const u = q.url;
      if (u.startsWith("/auto")) return res.end('<title>auto</title><script>location.href="whatsapp://send/?phone=33678284238&text&type=phone_number&app_absent=0"</script>');
      if (u.startsWith("/btn")) return res.end("<title>btn</title><button id=b style='width:300px;height:100px' onclick=\"location.href='" + decodeURIComponent((u.split("?go=")[1]) || "whatsapp://send/?phone=1") + "'\">open</button>");
      if (u.startsWith("/frame")) return res.end('<title>frame</title><iframe src="' + decodeURIComponent((u.split("?go=")[1]) || "whatsapp://send/?phone=2") + '"></iframe>');
      if (u.startsWith("/links")) return res.end('<title>links</title><a id=a href="/bg" style="display:block;width:300px;height:300px">bg</a>');
      res.end("<title>" + u + "</title>x");
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const tabSes = session.fromPartition(constants.TAB_PARTITION);
    const active = () => state.tabs.find((t) => t.id === state.activeTabId);
    const wcOf = (t) => t.view.webContents;

    console.log("-- the product registers a handler for tabs");
    const productHandler = registered.get(tabSes);
    check("a permission request handler is registered on the tab session", typeof productHandler === "function");
    check("...and on the default session", registered.has(session.defaultSession));
    // spy: record each request and what the product decided, then pass it on unchanged
    const decisions = [];
    tabSes.setPermissionRequestHandler((wc, permission, cb, details) => {
      const d = { permission, url: details && details.externalURL };
      decisions.push(d);
      productHandler(wc, permission, (v) => { d.result = v; cb(v); }, details);
    });
    const run = async (label, urlPath, click) => {
      decisions.length = 0; prompts.length = 0; opened.length = 0;
      tm.createTab(base + urlPath); await sleep(1800);
      const wc = wcOf(active());
      if (click) { wc.focus(); wc.sendInputEvent({ type: "mouseMove", x: 30, y: 30 }); wc.sendInputEvent({ type: "mouseDown", x: 30, y: 30, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: 30, y: 30, button: "left", clickCount: 1 }); }
      await sleep(1200);
      return { reqs: decisions.filter((d) => d.permission === "openExternal"), prompts: prompts.length, opened: opened.length };
    };

    console.log("\n-- links for other applications are never handed to Windows");
    for (const [label, p, click] of [["the page navigates to whatsapp:// by itself (api.whatsapp.com does)", "/auto", false], ["a button opens whatsapp:// (user gesture)", "/btn", true], ["an iframe loads whatsapp://", "/frame", false],
      ["steam://", "/frame?go=" + encodeURIComponent("steam://open/main"), false], ["ms-settings:", "/frame?go=" + encodeURIComponent("ms-settings:display"), false]]) {
      const r = await run(label, p, click);
      check(label + ": Chromium asked, and the answer was NO", r.reqs.length >= 1 && r.reqs.every((d) => d.result === false));
      check("   no prompt, nothing opened", r.prompts === 0 && r.opened === 0);
    }

    console.log("\n-- mailto:/tel:/sms: keep PBCalc's own confirm (and are still not launched silently)");
    let r = await run("mailto in an iframe", "/frame?go=" + encodeURIComponent("mailto:a@b.example"), false);
    check("mailto via an iframe: the confirm dialog appears once", r.prompts === 1);
    check("...Chromium's own launch was denied and, answering Cancel, nothing opened", r.reqs.every((d) => d.result === false) && r.opened === 0);
    r = await run("mailto by a button", "/btn?go=" + encodeURIComponent("mailto:a@b.example"), true);
    check("mailto by a button: exactly ONE confirm (no double prompt)", r.prompts === 1 && r.opened === 0);
    r = await run("tel by a button", "/btn?go=" + encodeURIComponent("tel:+123456"), true);
    check("tel: the same", r.prompts === 1 && r.opened === 0);

    console.log("\n-- every other permission is exactly as before (granted)");
    for (const p of ["notifications", "geolocation", "media", "clipboard-read", "fullscreen", "pointerLock", "midi"]) {
      let got = null; productHandler(null, p, (v) => { got = v; }, {});
      check("permission '" + p + "' is still granted", got === true);
    }
    let weird = null; productHandler(null, "openExternal", (v) => { weird = v; }, {});
    check("an openExternal request with no address is denied, no crash", weird === false);

    console.log("\n-- Restricted Mode: no external applications, as before");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    prompts.length = 0; opened.length = 0;
    let rr = null; productHandler(null, "openExternal", (v) => { rr = v; }, { externalURL: "mailto:x@y.example" });
    check("mailto in Restricted Mode: no prompt, no launch, denied", prompts.length === 0 && opened.length === 0 && rr === false);
    tm.leaveRestricted(); await sleep(800);

    console.log("\n-- where a tab opened FROM a page goes");
    const last = (t) => (t.url || "").split("/").pop();
    const order = () => state.tabs.map((t) => last(t)).join(" ");
    // strip: [new tab] ... then three plain tabs A B C
    while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
    await sleep(400);
    tm.createTab(base + "/A"); await sleep(900); const A = active();
    tm.createTab(base + "/B"); await sleep(900); const B = active();
    tm.createTab(base + "/C"); await sleep(900);
    check("setup: new tab, A, B, C", /A B C$/.test(order()));
    const open = async (from, p) => { tm.switchTab(from.id); await sleep(300); await wcOf(from).executeJavaScript('window.open(' + JSON.stringify(base + p) + '); 0', true); await sleep(1200); };
    await open(A, "/A1");
    check("a link opened from A goes right after A, not at the end", /A A1 B C$/.test(order()));
    await open(A, "/A2");
    check("a second one goes behind the first (A A1 A2)", /A A1 A2 B C$/.test(order()));
    await open(B, "/B1");
    check("from B: right after B", /A A1 A2 B B1 C$/.test(order()));
    await open(A, "/A3");
    check("a third one from A: still A's group (A A1 A2 A3)", /A A1 A2 A3 B B1 C$/.test(order()));
    check("the opened tab is the one in front (foreground link)", last(active()) === "A3");
    // Ctrl+click (background tab)
    tm.createTab(base + "/links"); await sleep(1200);
    const L = active();
    const before = order();
    const wcL = wcOf(L); wcL.focus();
    wcL.sendInputEvent({ type: "mouseMove", x: 50, y: 50 });
    wcL.sendInputEvent({ type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1, modifiers: ["control"] });
    wcL.sendInputEvent({ type: "mouseUp", x: 50, y: 50, button: "left", clickCount: 1, modifiers: ["control"] });
    await sleep(1500);
    check("Ctrl+click: opens a BACKGROUND tab right after the page it came from", /links bg$/.test(order()) && active() === L);
    // Ctrl+T / + still append
    tm.createTab(); await sleep(600);
    check("a plain new tab (Ctrl+T / +) still goes to the END", state.tabs[state.tabs.length - 1] === active() && /newtab\.html$/.test(last(active())));
    check("no uncaught error", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_LINKS total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
