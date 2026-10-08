// Site permissions like Chrome (electron/permissions.js): a page that wants location / camera / microphone / notifications / clipboard
// read / MIDI has to ASK; a bubble under the address bar answers. Before this every one of them was granted silently.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-permissions.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-perm-"));
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
    const perms = require("../electron/permissions");
    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>site " + q.url + "</title>page"); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = srv.address().port, base = "http://127.0.0.1:" + port, other = "http://localhost:" + port;
    tm.createTab(base + "/a"); await sleep(1800);
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId), wc = () => tab().view.webContents;
    const js = (code) => wc().executeJavaScript(code, true);
    const bubble = () => state.mainWindow.getBrowserViews().pop().webContents;
    const bubbleData = () => popup.getData() && popup.getData().permission;
    // start a request in the page WITHOUT waiting for it (it waits for the user), result lands in window.__r[name]
    const ask = (name, code) => js('window.__r = window.__r || {}; (' + code + ').then((v) => { window.__r["' + name + '"] = v; }, (e) => { window.__r["' + name + '"] = "ERR:" + (e.name || e.code || e); }); 0');
    const result = (name) => js('window.__r && window.__r["' + name + '"]');
    const GEO = 'new Promise((r) => navigator.geolocation.getCurrentPosition(() => r("GRANTED"), (e) => r("code" + e.code), { timeout: 8000 }))';
    const CAM = 'navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return "GRANTED"; }, (e) => e.name)';
    const CAMMIC = 'navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return "GRANTED"; }, (e) => e.name)';
    const NOTIF = 'Notification.requestPermission()';
    const CLIP = 'navigator.clipboard.readText().then(() => "GRANTED", (e) => e.name)';
    const waitBubble = async (ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (popup.isOpen("permission")) return true; await sleep(100); } return false; };

    console.log("-- the bubble");
    await ask("geo1", GEO);
    check("a page asking for the location opens the permission bubble", await waitBubble());
    const d = bubbleData();
    check("...it names the site and says what is wanted", d && d.origin === base && d.texts.join() === "Know your location", JSON.stringify(d));
    check("...and the page has NOT been given anything meanwhile", (await result("geo1")) === undefined);
    const dom = await bubble().executeJavaScript("document.body.innerText");
    check("the bubble shows 'wants to', the request and Chrome's three buttons", /wants to/.test(dom) && /Know your location/.test(dom) && /Allow while visiting the site/.test(dom) && /Allow this time/.test(dom) && /Never allow/.test(dom), dom.replace(/\s+/g, " "));
    check("the site is shown with its scheme and port, bold", /127\.0\.0\.1/.test(dom) && (await bubble().executeJavaScript('!!document.querySelector(".pm-title b")')));
    await bubble().executeJavaScript('[...document.querySelectorAll(".pm-buttons button")].find((b) => b.textContent === "Never allow").click()'); await sleep(900);
    check("'Never allow' refuses the request (PERMISSION_DENIED)", (await result("geo1")) === "code1", await result("geo1"));
    check("the bubble is gone", !popup.isOpen("permission"));
    await ask("geo2", GEO); await sleep(1200);
    check("the refusal is remembered for the site: asking again shows no bubble and is refused at once", !popup.isOpen("permission") && (await result("geo2")) === "code1");

    console.log("\n-- other sites and other things");
    await js('location.href = "' + other + '/b"; 0'); await sleep(1800);
    await ask("geo3", GEO);
    check("the SAME permission from ANOTHER site (localhost vs 127.0.0.1) asks again", await waitBubble());
    popup.answerPermission("once");
    for (let i = 0; i < 40 && (await result("geo3")) === undefined; i++) await sleep(250);   // the location service can take a few seconds to say "no fix"
    check("'Allow this time' grants it (code2 / code3 = allowed, the PC just has no location fix; code1 would be a refusal)", ["code2", "code3", "GRANTED"].includes(await result("geo3")), await result("geo3"));
    await ask("n1", NOTIF);
    check("notifications ask too", await waitBubble() && bubbleData().texts.join() === "Show notifications");
    check("Notification.permission is NOT 'granted' while the question is open", (await js("Notification.permission")) !== "granted", await js("Notification.permission"));
    popup.answerPermission("visit"); await sleep(1200);
    check("'Allow while visiting the site' grants it", (await result("n1")) === "granted" && (await js("Notification.permission")) === "granted");
    await js('location.href = "' + other + '/c"; 0'); await sleep(1800);
    await ask("geo4", GEO); await sleep(1000);
    check("'Allow this time' ended with the page: leaving it asks again", popup.isOpen("permission"));
    popup.answerPermission("never"); await sleep(800);
    await ask("n2", NOTIF); await sleep(1200);
    check("'Allow while visiting' stays for the site's other pages (no new bubble for notifications)", !popup.isOpen("permission") && (await result("n2")) === "granted");

    console.log("\n-- camera, microphone, clipboard");
    await js('location.href = "' + base + '/d"; 0'); await sleep(1800);
    // (a PC without a camera makes Chromium answer NotFoundError BEFORE it asks anything, so the handler is called the way Chromium calls it)
    let camAnswer = "pending";
    perms.request(wc(), "media", (ok) => { camAnswer = ok; }, { requestingUrl: base + "/d", mediaTypes: ["video", "audio"] });
    check("camera + microphone in one request lists BOTH", await waitBubble() && bubbleData().texts.join(" | ") === "Use your camera | Use your microphone", JSON.stringify(bubbleData()));
    check("...the page is not given them meanwhile", camAnswer === "pending");
    popup.answerPermission("visit"); await sleep(600);
    check("'Allow while visiting the site' grants both", camAnswer === true);
    let cam2 = "pending";
    perms.request(wc(), "media", (ok) => { cam2 = ok; }, { requestingUrl: base + "/d", mediaTypes: ["video"] });
    check("the allowed camera is not asked again on this site", !popup.isOpen("permission") && cam2 === true);
    let camOther = "pending";
    perms.request(wc(), "media", (ok) => { camOther = ok; }, { requestingUrl: other + "/d", mediaTypes: ["video"] });
    await sleep(300);
    check("...but ANOTHER site asks for it itself", popup.isOpen("permission") && camOther === "pending");
    popup.answerPermission("never"); await sleep(400);
    check("'Never allow' for a camera refuses it", camOther === false);
    const third = "http://[::1]:" + port;
    let c3 = "pending", m3 = "pending";
    perms.request(wc(), "media", (ok) => { c3 = ok; }, { requestingUrl: third + "/d", mediaTypes: ["video"] });
    await sleep(300); popup.answerPermission("visit"); await sleep(300);
    perms.request(wc(), "media", (ok) => { m3 = ok; }, { requestingUrl: third + "/d", mediaTypes: ["audio"] });
    await sleep(300);
    check("camera allowed does NOT mean microphone allowed (it asks separately)", c3 === true && popup.isOpen("permission") && bubbleData().texts.join() === "Use your microphone" && m3 === "pending");
    popup.answerPermission("never"); await sleep(400);
    await ask("clip", CLIP);
    check("reading the clipboard asks", await waitBubble() && /clipboard/.test(bubbleData().texts.join()));
    popup.close(); await sleep(900);
    check("closing the bubble (X / Esc / click outside) refuses this time", (await result("clip")) === "NotAllowedError", await result("clip"));
    await ask("clip2", CLIP);
    check("...and asks again next time (a dismissal is not a 'never')", await waitBubble());
    popup.close(); await sleep(600);

    console.log("\n-- one bubble at a time, background tabs, benign permissions");
    await js("window.__r = {}; 0");
    await ask("q1", NOTIF); await ask("q2", 'navigator.requestMIDIAccess().then(() => "GRANTED", (e) => e.name)');
    await waitBubble(); await sleep(400);
    console.log("   (q1=" + JSON.stringify(await result("q1")) + " q2=" + JSON.stringify(await result("q2")) + " open=" + popup.isOpen("permission") + " bubble=" + JSON.stringify(bubbleData()) + ")");
    check("two different requests queue: only one bubble is open", popup.isOpen("permission") && perms._state().queue.length === 1, "queue " + perms._state().queue.length);
    popup.answerPermission("never"); await sleep(800);
    check("...the next one follows when the first is answered", popup.isOpen("permission") && /MIDI/.test(bubbleData().texts.join()));
    popup.answerPermission("never"); await sleep(800);
    const bg = tab();
    tm.createTab(base + "/e"); await sleep(1500);
    let bgAnswer = "pending";
    perms.request(bg.view.webContents, "geolocation", (ok) => { bgAnswer = ok; }, { requestingUrl: base + "/x" });
    await sleep(300);
    check("a request from a tab you are NOT looking at is refused at once (no bubble over another page)", bgAnswer === false || bgAnswer === true && false, String(bgAnswer));
    check("benign permissions pass without a question (fullscreen, pointer lock, clipboard write)", ["fullscreen", "pointerLock", "clipboard-sanitized-write"].every((p) => { let r; perms.request(wc(), p, (ok) => { r = ok; }, { requestingUrl: base + "/" }); return r === true; }));
    let unk; perms.request(wc(), "some-future-permission", (ok) => { unk = ok; }, { requestingUrl: base + "/" });
    check("a permission nobody planned for is refused", unk === false);
    let local; perms.request(wc(), "geolocation", (ok) => { local = ok; }, { requestingUrl: "file:///C:/x.html" });
    check("a local file page cannot be granted anything", local === false);

    console.log("\n-- Restricted Mode");
    tm.createTab("about:blank"); await sleep(300);
    perms._reset();
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    const rt = tab();
    let ra = "pending";
    perms.request(rt.view.webContents, "geolocation", (ok) => { ra = ok; }, { requestingUrl: "https://example.org/x" });
    await sleep(900);
    check("the bubble also works in Restricted Mode (a site there can still ask for its camera)", popup.isOpen("permission"));
    popup.answerPermission("once"); await sleep(400);
    check("...and the answer reaches the page", ra === true, String(ra));
    tm.leaveRestricted(); await sleep(500);
    srv.close();
    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_PERMISSIONS total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
