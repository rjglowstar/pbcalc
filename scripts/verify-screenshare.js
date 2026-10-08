// Screen sharing (Google Meet "Present now", Teams ...): navigator.mediaDevices.getDisplayMedia() used to fail in PBCalc with
// "NotSupportedError: Not supported" because Electron needs the app to answer it (electron/screenShare.js). Now Chrome's own
// "Choose what to share with <site>" dialog is the consent - three tabs (Chrome Tab / Window / Entire Screen), laid out from Chrome 154.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-screenshare.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-share-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const popup = require("../electron/popup");
    const srv = http.createServer((q, res) => {
      res.setHeader("content-type", "text/html");
      if (q.url.startsWith("/red")) return res.end('<title>Red page</title><body style="margin:0;background:#cc2200;height:100vh">red</body>');
      res.end("<title>share " + q.url + "</title><body>page</body>");
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const host = "127.0.0.1:" + srv.address().port;
    tm.createTab(base + "/red"); await sleep(1500);            // a tab to share
    const redTab = state.tabs.find((t) => t.id === state.activeTabId);
    tm.createTab(base + "/meet"); await sleep(1500);           // the page that asks (the tab in front)
    const asking = state.tabs.find((t) => t.id === state.activeTabId);          // the page that asks stays the same even when sharing a tab switches the view
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId), wc = () => asking.view.webContents;
    const dlg = () => state.mainWindow.getBrowserViews().pop().webContents;
    const dom = (js) => dlg().executeJavaScript(js);
    const start = (opts, w) => (w || wc()).executeJavaScript('window.__dm = "pending"; window.__stream = null; navigator.mediaDevices.getDisplayMedia(' + opts + ').then((s) => { window.__stream = s; window.__dm = "GRANTED:" + s.getVideoTracks().length + ":" + s.getAudioTracks().length; }, (e) => { window.__dm = e.name; }); 0', true);
    const outcome = (w) => (w || wc()).executeJavaScript("window.__dm");
    const stop = () => wc().executeJavaScript("window.__stream && window.__stream.getTracks().forEach((t) => t.stop()); 0");
    const waitDlg = async () => { for (let i = 0; i < 50; i++) { if (popup.isOpen("screenshare")) return true; await sleep(150); } return false; };
    const clickText = (sel, text) => dom('[...document.querySelectorAll("' + sel + '")].find((b) => b.textContent === ' + JSON.stringify(text) + ').click(); 0');
    const shareBtnProp = (prop) => dom('[...document.querySelectorAll(".sh-foot button")].find((b) => /^Share/.test(b.textContent)).' + prop);
    const pressShare = () => dom('[...document.querySelectorAll(".sh-foot button")].find((b) => /^Share/.test(b.textContent)).click(); 0');

    console.log("-- Chrome's dialog, tab 1: Chrome Tab");
    await start("{ video: true, audio: true }");
    check("a page asking to share the screen opens the dialog", await waitDlg());
    check("...and gets nothing until the user chooses", (await outcome()) === "pending");
    check("no second 'wants to...' permission bubble in front of it", !popup.isOpen("permission"));
    const txt = await dom("document.body.innerText");
    check("title 'Choose what to share with <site>' and Chrome's subtitle", txt.includes("Choose what to share with " + host) && txt.includes("The site will be able to see the contents of your screen"), txt.slice(0, 120));
    check("three tabs in Chrome's order: Chrome Tab, Window, Entire Screen", JSON.stringify(await dom('[...document.querySelectorAll(".sh-tab")].map((b) => b.textContent)')) === '["Chrome Tab","Window","Entire Screen"]');
    check("it starts on Chrome Tab", (await dom('document.querySelector(".sh-tab.on").textContent')) === "Chrome Tab");
    const rows = await dom('[...document.querySelectorAll(".sh-row-title")].map((e) => e.textContent)');
    const redTitle = rows.find((r) => /Red page/.test(r));
    check("the list shows this browser's OTHER tabs (not the page that is asking)", !!redTitle && !rows.some((r) => /share \/meet/.test(r)), JSON.stringify(rows));
    check("'Select a tab to share' sits where the preview will be", /Select a tab to share/.test(txt));
    check("'Share with tab audio' with its switch, ON by default", /Share with tab audio/.test(txt) && (await dom('document.querySelector(".sh-switch").getAttribute("aria-checked")')) === "true");
    check("Share stays disabled until something is picked", (await shareBtnProp("disabled")) === true);

    console.log("\n-- sharing a TAB (with its audio)");
    await clickText(".sh-row-title", redTitle); await sleep(300);
    check("picking a tab selects its row and the button now says 'Share with Audio'", (await dom('document.querySelector(".sh-row.on .sh-row-title").textContent')) === redTitle && (await shareBtnProp("textContent")) === "Share with Audio");
    check("...with the tab's title under its preview", (await dom('document.querySelector(".sh-cap") && document.querySelector(".sh-cap").textContent')) === redTitle);
    await pressShare(); await sleep(2500);
    check("like Chrome, pressing Share switches to the shared tab", tab().id === redTab.id);
    check("the page gets a video track AND an audio track", (await outcome()) === "GRANTED:1:1", await outcome());
    const px = await wc().executeJavaScript(`(async () => { const v = document.createElement("video"); v.muted = true; v.srcObject = window.__stream; document.body.appendChild(v); await v.play(); await new Promise((r) => setTimeout(r, 1200)); const c = document.createElement("canvas"); c.width = 40; c.height = 40; const g = c.getContext("2d"); g.drawImage(v, 0, 0, 40, 40); const d = g.getImageData(20, 20, 1, 1).data; return d[0] + "," + d[1] + "," + d[2]; })()`);
    const [r, g, b] = px.split(",").map(Number);
    check("what arrives is the REAL picture of the other tab (its red background), although that tab is in the background", r > 150 && g < 90 && b < 60, px);
    await stop(); tm.switchTab(asking.id); await sleep(600);

    console.log("\n-- the switch off = no audio");
    await start("{ video: true, audio: true }"); await waitDlg();
    await clickText(".sh-row-title", redTitle); await sleep(200);
    await dom('document.querySelector(".sh-switch").click(); 0'); await sleep(200);
    check("switching 'Share with tab audio' off turns the button into plain 'Share'", (await shareBtnProp("textContent")) === "Share");
    await pressShare(); await sleep(1800);
    check("...and the page gets video only", (await outcome()) === "GRANTED:1:0", await outcome());
    await stop(); tm.switchTab(asking.id); await sleep(600);

    console.log("\n-- tabs 2 and 3: Window, Entire Screen");
    await start("{ video: true, audio: true }"); await waitDlg();
    await clickText(".sh-tab", "Window"); await sleep(300);
    const wtxt = await dom("document.body.innerText");
    check("Window: a grid of windows with their names, and Chrome's hint 'To share audio, share a tab instead'", (await dom('document.querySelectorAll(".sh-grid.window .sh-card").length')) >= 1 && /To share audio, share a tab instead/.test(wtxt));
    check("Window: no audio switch, and Share is disabled until a window is picked", (await dom('!document.querySelector(".sh-switch")')) === true && (await shareBtnProp("disabled")) === true);
    await clickText(".sh-tab", "Entire Screen"); await sleep(300);
    check("Entire Screen: the screens are named 'Screen 1', 'Screen 2' ...", /Screen 1/.test(await dom("document.body.innerText")) && (await dom('document.querySelectorAll(".sh-grid.screen .sh-card").length')) >= 1);
    await dom('document.querySelector(".sh-card").click(); 0'); await sleep(250);
    check("picking a screen enables a plain 'Share'", (await shareBtnProp("textContent")) === "Share" && (await shareBtnProp("disabled")) === false);
    await pressShare(); await sleep(1800);
    check("a screen gives the page video only (no system audio, as in Chrome's dialog)", (await outcome()) === "GRANTED:1:0", await outcome());
    await stop();

    console.log("\n-- cancelling, made-up choices, a tab you are not looking at");
    await start("{ video: true }"); await waitDlg();
    popup.close(); await sleep(1200);
    check("closing the dialog (Cancel / Esc / click outside) refuses: NotAllowedError, nothing shared", (await outcome()) === "NotAllowedError", await outcome());
    await start("{ video: true }"); await waitDlg();
    check("a tab id / screen id / kind that was never offered is not accepted", popup.answerScreenShare("tab", 99999, false).ok === false && popup.answerScreenShare("source", "screen:999:0", false).ok === false && popup.answerScreenShare("evil", "x", false).ok === false && popup.isOpen("screenshare"));
    popup.close(); await sleep(800);
    tm.switchTab(redTab.id); await sleep(700);
    await start("{ video: true }", asking.view.webContents); await sleep(1500);
    check("a tab in the background cannot open the dialog (it is refused)", !popup.isOpen("screenshare") && !/^GRANTED|pending/.test(await outcome(asking.view.webContents)), await outcome(asking.view.webContents));
    tm.switchTab(asking.id); await sleep(500);

    console.log("\n-- Restricted Mode");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    tm.createTab(base + "/restricted-site", { allowRestricted: true }); await sleep(1500);
    await start("{ video: true }", tab().view.webContents);   // (every old tab was dropped when Restricted Mode started)
    check("the dialog also works there", await waitDlg());
    check("...without the 'Chrome Tab' list (no other tab's title is shown) - it starts on Window", JSON.stringify(await dom('[...document.querySelectorAll(".sh-tab")].map((b) => b.textContent)')) === '["Window","Entire Screen"]');
    popup.close(); await sleep(500);
    tm.leaveRestricted(); await sleep(500);
    srv.close();
    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_SCREENSHARE total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
