// (1) What a page SEES for Notification.permission / permissions.query: "default"/"prompt" until the user answers, then granted /
//     denied - like Chrome. (Electron's check handler can only say yes/no, so the page saw "denied" before ever being asked, and Google
//     Meet answered with a "how to unblock notifications" help page instead of asking.)
// (2) Chrome's "Microphone in use" / "Camera in use" pill in the address bar while the page holds a live getUserMedia stream.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-capture-indicator.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");   // a fake microphone and camera: no hardware needed
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-cap-"));
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
    const permissions = require("../electron/permissions");
    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>cap</title><body>page</body>"); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    tm.createTab(base + "/a"); await sleep(1500);
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId);
    const wc = () => tab().view.webContents;
    const js = (code) => wc().executeJavaScript(code, true);
    const shell = (code) => state.mainWindow.webContents.executeJavaScript(code);
    const chip = async () => JSON.parse(await shell('(() => { const c = document.getElementById("capture-chip"); const r = c.getBoundingClientRect(); const s = document.getElementById("site-info").getBoundingClientRect(); return JSON.stringify({ hidden: c.hidden || r.width === 0, text: c.textContent, left: r.left, siteLeft: s.left, right: r.right }); })()'));
    const seen = () => js(`(async () => { const o = { N: Notification.permission }; for (const n of ["notifications", "geolocation", "camera", "microphone", "midi", "clipboard-read"]) o[n] = (await navigator.permissions.query({ name: n })).state; return JSON.stringify(o); })()`).then(JSON.parse);
    const waitBubble = async () => { for (let i = 0; i < 40; i++) { if (popup.isOpen("permission")) return true; await sleep(100); } return false; };

    console.log("-- what the page sees before it is asked");
    let s = await seen();
    check("Notification.permission is 'default' (not 'denied')", s.N === "default", JSON.stringify(s));
    check("permissions.query says 'prompt' for notifications, location, camera, microphone, MIDI, clipboard", ["notifications", "geolocation", "camera", "microphone", "midi", "clipboard-read"].every((n) => s[n] === "prompt"), JSON.stringify(s));
    check("nothing was asked just by looking", !popup.isOpen("permission"));

    console.log("\n-- after the answers");
    js('window.__n = "pending"; Notification.requestPermission().then((r) => { window.__n = r; }); 0');
    check("requestPermission() opens the bubble", await waitBubble());
    popup.answerPermission("visit"); await sleep(700);
    s = await seen();
    check("Allow: Notification.permission 'granted', requestPermission() resolves 'granted'", s.N === "granted" && (await js("window.__n")) === "granted" && s.notifications === "granted", JSON.stringify(s));
    check("...and the other permissions stay 'prompt'", s.geolocation === "prompt" && s.microphone === "prompt");
    wc().reload(); await sleep(1500);
    s = await seen();
    check("a reload keeps it 'granted' (the answer is the site's, for this session)", s.N === "granted" && s.notifications === "granted", JSON.stringify(s));
    js("navigator.geolocation.getCurrentPosition(() => {}, () => {}); 0");
    await waitBubble(); popup.answerPermission("never"); await sleep(700);
    s = await seen();
    check("Never allow: permissions.query says 'denied' for that one", s.geolocation === "denied" && s.notifications === "granted", JSON.stringify(s));
    check("the page cannot tell the real native answer apart: Notification.permission stays an accessor on the constructor", (await js("typeof Object.getOwnPropertyDescriptor(Notification, 'permission').get")) === "function");
    check("permissions.query still returns a PermissionStatus", (await js('(async () => (await navigator.permissions.query({ name: "notifications" })) instanceof PermissionStatus)()')) === true);
    check("an unknown name still rejects like before", (await js('navigator.permissions.query({ name: "nonsense" }).then(() => "ok", (e) => e.name)')) === "TypeError");
    permissions._reset();

    console.log("\n-- 'Microphone in use' / 'Camera in use'");
    let c = await chip();
    check("no pill when nothing is captured", c.hidden === true, JSON.stringify(c));
    js('window.__s = null; navigator.mediaDevices.getUserMedia({ audio: true }).then((x) => { window.__s = x; window.__g = "ok"; }, (e) => { window.__g = e.name; }); 0');
    check("asking for the microphone opens the permission bubble", await waitBubble());
    check("...and the pill is not shown while it is only a question", (await chip()).hidden === true);
    popup.answerPermission("visit"); await sleep(1200);
    const devs = JSON.parse(await js('navigator.mediaDevices.enumerateDevices().then((d) => JSON.stringify(d.map((x) => [x.kind, x.label])))'));
    check("after Allow the page sees the devices WITH their names (Meet showed 'Mic not found' without them)", devs.some((d) => d[0] === "audioinput" && d[1]) && devs.some((d) => d[0] === "audiooutput" && d[1]), JSON.stringify(devs));
    check("the page got the microphone",(await js("window.__g")) === "ok", await js("window.__g"));
    c = await chip();
    check("pill 'Microphone in use' appears", !c.hidden && c.text === "Microphone in use", JSON.stringify(c));
    check("...left of the site-info icon (Chrome's place)", c.right <= c.siteLeft + 1, JSON.stringify(c));
    check("the tab state says 'mic'", tm.getTabState().tabs.find((t) => t.id === tab().id).capture === "mic");
    js('navigator.mediaDevices.getUserMedia({ video: true }).then((x) => { window.__v = x; }, () => {}); 0');
    await waitBubble(); popup.answerPermission("visit"); await sleep(1200);
    c = await chip();
    check("camera + microphone: 'Camera and microphone in use'", c.text === "Camera and microphone in use", JSON.stringify(c));
    await js("window.__v.getTracks().forEach((t) => t.stop()); 0"); await sleep(400);
    c = await chip();
    check("stopping the camera leaves 'Microphone in use'", c.text === "Microphone in use", JSON.stringify(c));
    await js("window.__s.getTracks().forEach((t) => t.stop()); 0"); await sleep(400);
    check("stopping the last track removes the pill", (await chip()).hidden === true);
    js('navigator.mediaDevices.getUserMedia({ audio: true }).then((x) => { window.__s = x; }); 0'); await sleep(900);
    check("the pill comes back for a new stream (permission remembered, no second bubble)", !popup.isOpen("permission") && (await chip()).text === "Microphone in use");

    console.log("\n-- other tabs and navigation");
    const first = tab();
    tm.createTab(base + "/b"); await sleep(1500);
    check("another tab shows no pill", (await chip()).hidden === true);
    tm.switchTab(first.id); await sleep(500);
    check("switching back shows it again", (await chip()).text === "Microphone in use");
    wc().loadURL(base + "/c"); await sleep(1500);
    check("leaving the page (the stream dies with it) removes the pill", (await chip()).hidden === true && tm.getTabState().tabs.find((t) => t.id === first.id).capture === null);

    console.log("\n-- the report channel cannot be abused");
    const before = JSON.stringify(tm.getTabState().tabs.map((t) => t.capture));
    check("a page cannot ask for a different tab's pill (the sender decides which tab)", (() => { tm.setCapture({}, true, true); return JSON.stringify(tm.getTabState().tabs.map((t) => t.capture)) === before; })());
    check("junk values are read as 'not capturing'", (() => { tm.setCapture(wc(), "yes", {}); return tm.captureKind(tab()) === null; })());

    srv.close();
    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_CAPTURE total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
