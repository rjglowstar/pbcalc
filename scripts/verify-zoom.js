// Page / image zoom like Chrome: Chrome's preset steps 25..500%, Ctrl+wheel, Ctrl+plus/minus/0 and the menu's + / - all
// share them. Measured on a real image tab (the owner's screenshots show Chrome at 25% and 500% on a .jpg).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-zoom.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 150000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-zoom-"));
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
    const shell = state.mainWindow.webContents;
    // a real image file (a capture of the window)
    const img = await shell.capturePage({ x: 0, y: 0, width: 900, height: 500 });
    const file = path.join(tmp, "pic.png"); fs.writeFileSync(file, img.toPNG());
    tm.openLocalFile(file); await sleep(2000);
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId), wc = () => tab().view.webContents;
    const pct = () => Math.round(wc().getZoomFactor() * 100);
    // dy = what the PAGE's wheel event reports (negative = wheel forward/up = zoom in). Electron's sendInputEvent has the opposite
    // sign (measured: input -100 arrives as deltaY +100), hence the minus.
    const wheel = async (dy) => { wc().sendInputEvent({ type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: -dy, modifiers: ["control"], ctrlKey: true }); await sleep(250); };
    const STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

    console.log("-- an image tab");
    check("the image tab is showing an image", await wc().executeJavaScript("document.contentType") === "image/png" && pct() === 100);
    const up = []; for (let i = 0; i < 20; i++) { tm.zoom(+1); up.push(pct()); }
    check("zoom in steps through Chrome's list 110,125,150,175,200,250,300,400,500 and stops at 500%", JSON.stringify(up.slice(0, 9)) === "[110,125,150,175,200,250,300,400,500]" && up.slice(9).every((v) => v === 500));
    const down = []; for (let i = 0; i < 20; i++) { tm.zoom(-1); down.push(pct()); }
    check("zoom out goes back down through the list to 25% and stops there", JSON.stringify(down.slice(0, 7)) === "[400,300,250,200,175,150,125]" && down.includes(25) && down[down.length - 1] === 25 && down.indexOf(25) === 15);
    tm.zoom(0);
    check("Ctrl+0 / reset returns to 100%", pct() === 100);
    check("the image itself really grows with the zoom (500% = 5x the layout width)", await (async () => { const w1 = await wc().executeJavaScript("document.images[0].getBoundingClientRect().width * devicePixelRatio"); for (let i = 0; i < 9; i++) tm.zoom(+1); await sleep(300); const w5 = await wc().executeJavaScript("document.images[0].getBoundingClientRect().width * devicePixelRatio"); tm.zoom(0); await sleep(200); return Math.abs(w5 / w1 - 5) < 0.2; })());

    // the ⋮ menu shows the same percentage (it was computed from the zoom LEVEL, which no longer matches the preset steps)
    const popup = require("../electron/popup");
    tm.zoom(+1); tm.zoom(+1); await sleep(200);
    popup.open("menu", null, {}); await sleep(600);
    check("the menu's Zoom row shows the real percentage (125%)", pct() === 125 && popup.getData() && popup.getData().zoom === 125);
    popup.close(); tm.zoom(0); await sleep(200);

    console.log("\n-- Ctrl + mouse wheel");
    await wheel(-100); check("one notch up (wheel forward) zooms in one step: 110%", pct() === 110);
    await wheel(-100); await wheel(-100); check("two more notches: 150%", pct() === 150);
    await wheel(100); check("one notch down: 125%", pct() === 125);
    for (let i = 0; i < 30; i++) await wheel(-100);
    check("many notches up stop at 500% (Chrome's limit)", pct() === 500);
    for (let i = 0; i < 40; i++) await wheel(100);
    check("many notches down stop at 25% (Chrome's limit)", pct() === 25);
    tm.zoom(0);
    await wheel(-10); await wheel(-10); await wheel(-10); await wheel(-10); await wheel(-10); await wheel(-10);
    check("small touchpad deltas add up to a step instead of each making one (6 x 10 = one step)", pct() === 110);
    tm.zoom(0);
    wc().sendInputEvent({ type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 100 }); await sleep(300);
    check("a wheel notch WITHOUT Ctrl does not zoom", pct() === 100);

    console.log("\n-- zoom from a value between two steps (e.g. left by an older version)");
    wc().setZoomFactor(1.3); await sleep(100); tm.zoom(+1); check("130% + 1 step = 150%", pct() === 150);
    wc().setZoomFactor(1.3); await sleep(100); tm.zoom(-1); check("130% - 1 step = 125%", pct() === 125);
    tm.zoom(0);

    console.log("\n-- a page that uses the wheel itself keeps it");
    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end('<title>w</title><body style="height:3000px"><script>window.n=0;addEventListener("wheel",e=>{if(e.ctrlKey){e.preventDefault();window.n++}},{passive:false})</script>x'); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    tm.createTab("http://127.0.0.1:" + srv.address().port + "/"); await sleep(1800);
    await wheel(-100);
    check("the page that handles Ctrl+wheel gets it", (await wc().executeJavaScript("window.n")) === 1);
    check("...and the browser did NOT also zoom it", pct() === 100);
    tm.createTab("data:text/html,<title>plain</title>plain page"); await sleep(1500);
    await wheel(-100);
    check("an ordinary web page zooms by Ctrl+wheel too (110%)", pct() === 110);

    console.log("\n-- zoom is per tab");
    const plainTab = tab(), imgTab = state.tabs.find((t) => /pic\.png$/.test(t.view.webContents.getURL()));
    check("the image tab was not changed by the other tab's zoom", Math.round(imgTab.view.webContents.getZoomFactor() * 100) === 100 && Math.round(plainTab.view.webContents.getZoomFactor() * 100) === 110);
    check("the tab state sent to the shell reports the percentage (the omnibox chip)", (await shell.executeJavaScript("1")) === 1 && state.tabs.length >= 3);

    console.log("\n-- Restricted Mode: zoom works there too");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    tm.openLocalFile(file); await sleep(1800);
    await wheel(-100);
    check("Ctrl+wheel zooms a page in Restricted Mode", pct() === 110);
    srv.close();
    tm.leaveRestricted(); await sleep(500);
    check("no uncaught error", errors.length === 0);
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_ZOOM total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
