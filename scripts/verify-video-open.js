// Video files open and PLAY in a PBCalc tab, like Chrome: dropped on the window, handed over by Windows, or clicked in the
// Downloads list (fileTypes.VIDEO). Before this a dropped .mp4 was ignored and a downloaded one went to another program.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-video-open.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-vid-"));
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
    const { openDropped } = require("../electron/dropFiles");
    const { targetFromArgv } = require("../electron/externalOpen");
    const { IN_TAB, FROM_USER, kindOf } = require("../electron/fileTypes");
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId);
    const downloads = [];
    require("electron").session.fromPartition(require("../electron/constants").TAB_PARTITION).on("will-download", (_e, item) => downloads.push(item.getFilename()));

    // a real, playable video: recorded from a canvas inside a tab
    tm.createTab("about:blank"); await sleep(800);
    const src = tab().view.webContents;
    const b64 = await src.executeJavaScript(`new Promise((ok, bad) => { const c = document.createElement("canvas"); c.width = 160; c.height = 120; const g = c.getContext("2d"); let n = 0; const iv = setInterval(() => { g.fillStyle = n++ % 2 ? "#cc2200" : "#0033cc"; g.fillRect(0, 0, 160, 120); }, 40); const rec = new MediaRecorder(c.captureStream(25), { mimeType: "video/webm" }); const parts = []; rec.ondataavailable = (e) => parts.push(e.data); rec.onstop = async () => { clearInterval(iv); const buf = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192)); ok(btoa(s)); }; rec.start(); setTimeout(() => rec.stop(), 1500); setTimeout(() => bad("timeout"), 8000); })`, true);
    const webm = path.join(tmp, "clip.webm");
    fs.writeFileSync(webm, Buffer.from(b64, "base64"));
    check("a playable test video was made (" + fs.statSync(webm).size + " bytes)", fs.statSync(webm).size > 200);

    const probe = (wc) => wc.executeJavaScript(`(async () => { const v = document.querySelector("video"); if (!v) return JSON.stringify({ video: false, body: document.body ? document.body.innerText.slice(0, 40) : "" }); v.muted = true; try { await v.play(); } catch (e) {} await new Promise((r) => setTimeout(r, 700)); return JSON.stringify({ video: true, w: v.videoWidth, h: v.videoHeight, ready: v.readyState, t: v.currentTime, err: v.error ? v.error.code : 0 }); })()`, true).then(JSON.parse);

    console.log("-- types");
    check("mp4, webm, m4v, ogv, mov are openable from a drop / Windows / the Downloads list", [".mp4", ".webm", ".m4v", ".ogv", ".mov"].every((e) => IN_TAB.has(e) && FROM_USER.has(e)));
    check("other media / programs are still not (mkv, avi, exe, bat)", [".mkv", ".avi", ".exe", ".bat"].every((e) => !FROM_USER.has(e)));
    check("video does not claim a file icon / registry kind of its own (nothing changes in Windows)", kindOf(".mp4") === null);

    console.log("\n-- dropped on the window");
    const before = state.tabs.length;
    check("one video file dropped opens one tab", openDropped([webm]) === 1 && state.tabs.length === before + 1);
    await sleep(2000);
    const info = await probe(tab().view.webContents);
    check("the tab is a video player page that PLAYS (frame size, time advancing, no error)", info.video && info.w === 160 && info.h === 120 && info.err === 0 && info.t > 0, JSON.stringify(info));
    check("it was shown, not downloaded", downloads.length === 0, downloads.join(","));
    check("the tab is named after the file", /clip\.webm/.test(tab().title || ""), tab().title);
    check("the address is the file's", /^file:\/\/\/.*clip\.webm$/.test(tab().url), tab().url);

    console.log("\n-- handed over by Windows (PBCalc.exe <file>)");
    check("a video path in the command line is accepted", !!targetFromArgv(["PBCalc.exe", "--", webm], process.cwd()));
    check("a made-up .mkv is refused", !targetFromArgv(["PBCalc.exe", "--", path.join(tmp, "x.mkv")], process.cwd()));

    console.log("\n-- the Downloads list");
    const dm = require("../electron/downloads/downloadManager");
    const n = state.tabs.length;
    dm._items.push({ id: 987654, state: "completed", savePath: webm, url: "http://x/clip.webm" });
    dm.open(987654); await sleep(1500);
    dm._items.pop();
    check("clicking a finished video download opens a PBCalc tab (not another program)", state.tabs.length === n + 1);

    console.log("\n-- Restricted Mode");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    check("a dropped video opens there too, like images and PDFs", openDropped([webm]) === 1);
    await sleep(2000);
    const r = await probe(tab().view.webContents);
    check("...and plays", r.video && r.err === 0 && r.t > 0, JSON.stringify(r));
    tm.leaveRestricted(); await sleep(500);

    const dl = "C:/Users/ABC/Downloads";
    const realName = fs.existsSync(dl) ? fs.readdirSync(dl).find((f) => /^Screen Recording iPad Pro.*\.mp4$/.test(f)) : null;
    const real = realName && dl + "/" + realName;
    if (real) {
      console.log("\n-- the owner's real recording (H.264 mp4)");
      check("it opens", openDropped([real]) === 1); await sleep(2500);
      const q = await probe(tab().view.webContents);
      check("and PLAYS (has a picture, time advances, no decode error)", q.video && q.w > 0 && q.err === 0 && q.t > 0, JSON.stringify(q));
    }
    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_VIDEO total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
