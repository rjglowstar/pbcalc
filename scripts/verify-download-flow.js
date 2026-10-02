// Focused test of the Chrome-style download PROCESS: no Save As dialog, unique names, the bubble
// that opens by itself, live progress, pause/resume, cancel + retry, and the toolbar ring.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-download-flow.js
const { app, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-dlflow-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await fn()) return true; await sleep(100); } return false; };
setTimeout(() => { console.log("WATCHDOG after " + results.length); app.exit(2); }, 120000).unref();

// A server that dribbles out a 400 KB file so progress, pause and cancel are observable.
let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    if (req.url.startsWith("/small")) {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="report.pdf"');
      return res.end(Buffer.alloc(2048, 7));
    }
    if (req.url.startsWith("/long")) {
      // ~40s of steady progress: long enough to click through a whole row menu
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="long.bin"');
      res.setHeader("content-length", String(600 * 10240));
      let n = 0;
      const t = setInterval(() => {
        if (n++ >= 600 || res.writableEnded) { clearInterval(t); return res.end(); }
        res.write(Buffer.alloc(10240, 2));
      }, 65);
      req.on("close", () => clearInterval(t));
      return;
    }
    if (req.url.startsWith("/stall")) {
      // sends a little, then goes quiet for ever: a stalled transfer
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="stuck.bin"');
      res.setHeader("content-length", String(1024 * 1024));
      res.write(Buffer.alloc(20480, 3));
      return; // never ends, never sends more
    }
    // /slow: 40 chunks of 10 KB, 120ms apart
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", 'attachment; filename="big.bin"');
    res.setHeader("content-length", String(40 * 10240));
    let n = 0;
    const t = setInterval(() => {
      if (n++ >= 40 || res.writableEnded) { clearInterval(t); return res.end(); }
      res.write(Buffer.alloc(10240, 1));
    }, 120);
    req.on("close", () => clearInterval(t));
  });
  srv.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + srv.address().port; resolve(); });
});

require("../electron/main.js");

app.whenReady().then(async () => {
  await ready;
  await sleep(3500);
  const state = require("../electron/state");
  const popup = require("../electron/popup");
  const dm = require("../electron/downloads/downloadManager");
  const settings = require("../electron/settings");
  const win = state.mainWindow;
  const dir = path.join(tmp, "dl");
  fs.mkdirSync(dir, { recursive: true });
  settings.set("downloads", { dir, ask: false });

  // The shell closes popups when the window loses focus. In a test the window is not the one the
  // OS considers focused, so that rule fires at random moments and hides the bubble we are
  // watching. It is asserted on its own below; take it out of the way for the lifecycle checks.
  const blurHandlers = win.listeners("blur");
  win.removeAllListeners("blur");
  // ...and park the window where a real cursor cannot sit on the bubble: hovering it (correctly)
  // stops it from dismissing itself, which would make the lifecycle checks depend on the mouse.
  // PBCalc now starts MAXIMIZED, and setPosition is a no-op on a maximized window — restore first.
  if (win.isMaximized()) win.unmaximize();
  await sleep(300);
  win.setSize(1200, 800);
  win.setPosition(-2200, 60);
  await sleep(300);

  // ── a plain download: no dialog, straight to the folder, bubble opens by itself ──
  win.focus();
  const pv = () => win.getBrowserViews().pop().webContents;
  const bubbleText = async () => { try { return await pv().executeJavaScript("document.body.innerText"); } catch (_) { return ""; } };
  session.defaultSession.downloadURL(base + "/small");
  check("the download appears in the list", await until(() => dm.publicList().length === 1));
  check("the bubble opened by itself when the download started", popup.isOpen("downloads"));
  let txt = await bubbleText();
  check("the self-opened bubble is Chrome's compact view (no title, no footer)",
    !/Recent download history/.test(txt) && !/Full download history/.test(txt));
  check("it finishes without any Save As dialog", await until(() => dm.publicList()[0].state === "completed"));
  check("the file really is in the download folder", fs.existsSync(path.join(dir, "report.pdf")));
  await sleep(500);
  check("the bubble is (still) up when it finishes, as Chrome does", popup.isOpen("downloads"));
  txt = await bubbleText();
  check("the bubble names the file and says Done", /report\.pdf/.test(txt) && /Done/.test(txt));
  const closedBySelf = await until(() => !popup.isOpen("downloads"), 9000);
  if (!closedBySelf) { popup.close(); console.log("     [dbg] bubble did not self-close"); }
  check("...and it closes by itself a few seconds later", closedBySelf);

  // ── the full bubble, the one the user asks for ──
  popup.open("downloads", { left: 900, right: 930, top: 40, bottom: 80, width: 30 });
  await sleep(800);
  txt = await bubbleText();
  check("clicking the button gives the full bubble (title + footer)",
    /Recent download history/.test(txt) && /Full download history/.test(txt));
  // A bubble the user opened is never dismissed from under them.
  popup.autoCloseDownloads(200);
  await sleep(700);
  check("a bubble the USER opened is never auto-dismissed", popup.isOpen("downloads"));
  popup.close();

  // ── a second copy is uniquified, never overwritten (Chrome's "(1)") ──
  session.defaultSession.downloadURL(base + "/small");
  check("a second copy becomes 'report (1).pdf'", await until(() => fs.existsSync(path.join(dir, "report (1).pdf"))));
  check("the original was not overwritten", fs.readFileSync(path.join(dir, "report.pdf")).length === 2048);

  // ── the toolbar button ──
  const sh = win.webContents;
  const js = (c) => sh.executeJavaScript(c);
  check("the toolbar button is accented after a download finishes", await until(async () => js('document.getElementById("downloads").classList.contains("fresh")')));

  // ── a slow download: progress, pause/resume, cancel ──
  dm.clearAll();
  popup.close();
  session.defaultSession.downloadURL(base + "/slow");
  check("a running download reports progress", await until(() => { const d = dm.publicList()[0]; return d && d.state === "progressing" && d.received > 0; }));
  check("the toolbar button shows the progress ring while it runs", await until(async () => js('document.getElementById("downloads").classList.contains("busy")')));
  // the shell is pushed at most a few times a second, so wait for the ring rather than sampling it
  check("the ring is filled to the download's progress",
    await until(async () => Number(await js('getComputedStyle(document.getElementById("downloads")).getPropertyValue("--p")')) > 0));
  const id = dm.publicList()[0].id;
  dm.togglePause(id);
  await sleep(400);
  check("Pause pauses it", dm.publicList()[0].paused === true);
  const atPause = dm.publicList()[0].received;
  await sleep(700);
  check("a paused download stops receiving", dm.publicList()[0].received === atPause);
  await sleep(300);
  txt = await bubbleText();
  check("the bubble says Paused", /Paused/.test(txt));
  dm.togglePause(id);
  await sleep(600);
  check("Resume starts it again", dm.publicList()[0].paused === false && dm.publicList()[0].received > atPause);
  dm.cancel(id);
  check("Cancel marks it cancelled (the row stays, like Chrome)", await until(() => dm.publicList()[0] && dm.publicList()[0].state === "cancelled"));
  check("the ring goes away when nothing is running", await until(async () => !(await js('document.getElementById("downloads").classList.contains("busy")'))));

  // ── retry ──
  dm.retry(dm.publicList()[0].id);
  check("Retry starts the download over", await until(() => dm.publicList().length === 1 && dm.publicList()[0].state === "progressing"));
  dm.cancel(dm.publicList()[0].id);
  await sleep(300);

  // ── a NEW download while an old one is paused (the two must not get mixed up) ──
  dm.clearAll();
  popup.close();
  session.defaultSession.downloadURL(base + "/slow");
  await until(() => dm.publicList()[0] && dm.publicList()[0].received > 20000);
  const firstId = dm.publicList()[0].id;
  dm.togglePause(firstId);
  await sleep(400);
  session.defaultSession.downloadURL(base + "/slow");
  check("the new download is its own row", await until(() => dm.publicList().length === 2));
  await sleep(1500);
  let [a, b] = dm.publicList();
  check("the paused one stays paused and untouched", a.id === firstId && a.paused === true);
  check("the new one actually downloads", b.paused === false && b.received > 20000);
  const paths = dm._items.map((x) => path.basename(x.savePath || ""));
  check("the two never write to the same file", paths[0] !== paths[1] && /\(1\)/.test(paths[1]));
  check("a fresh download never says 'Resuming...'", !b.resuming && !b.stalled);
  dm.cancel(a.id);
  dm.cancel(b.id);
  await sleep(300);

  // ── a transfer that dies mid-way is reported as stalled, not as progress ──
  dm.clearAll();
  session.defaultSession.downloadURL(base + "/stall");
  check("the stalled download starts normally", await until(() => dm.publicList()[0] && dm.publicList()[0].received > 0));
  check("it is not called stalled while bytes are flowing", dm.publicList()[0].stalled === false);
  check("after the transfer dies it is reported as stalled", await until(() => dm.publicList()[0].stalled === true, 25000));
  check("a stalled download shows no speed", dm.publicList()[0].speed === 0);
  dm.retry(dm.publicList()[0].id);
  check("Retry on a stalled download starts it over", await until(() => dm.publicList().length === 1 && dm.publicList()[0].received === 0 || dm.publicList().length === 1, 8000));
  dm.clearAll();

  // ── clicks must land while a download is ticking (the UI must not rebuild under the pointer) ──
  dm.clearAll();
  popup.close();
  session.defaultSession.downloadURL(base + "/long");
  await until(() => dm.publicList()[0] && dm.publicList()[0].received > 20000);
  const tm = require("../electron/tabs/tabManager");
  tm.openDownloadsPage();
  await sleep(1800);
  const page = state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
  const pj = (c) => page.executeJavaScript(c);
  check("the page shows the running download", (await pj('document.querySelectorAll(".item").length')) === 1);
  check("the running row still offers the ⋮ menu", (await pj('!!document.querySelector(".more")')) === true);
  await pj('document.querySelector(".item").dataset.mark = "x"; document.querySelector(".more").dataset.mark = "x"; 0');
  const before = await pj('document.querySelector(".status").textContent');
  await sleep(1600); // several progress ticks
  check("progress keeps updating", (await pj('document.querySelector(".status").textContent')) !== before);
  check("...but the row is NOT rebuilt (the click target survives)",
    (await pj('document.querySelector(".item").dataset.mark')) === "x" &&
    (await pj('document.querySelector(".more").dataset.mark')) === "x");
  // one click on ⋮, one click on Pause — each must act the first time
  await pj('document.querySelector(".more").click(); 0');
  await sleep(300);
  check("ONE click opens the row menu", (await pj('!!document.querySelector(".rowmenu")')) === true);
  await pj('[...document.querySelectorAll(".rowmenu .mi")].find((m) => m.textContent === "Pause").click(); 0');
  await sleep(500);
  check("ONE click on Pause pauses the download", dm.publicList()[0].paused === true);
  await pj('document.querySelector(".more").click(); 0');
  await sleep(300);
  await pj('[...document.querySelectorAll(".rowmenu .mi")].find((m) => m.textContent === "Resume").click(); 0');
  await sleep(600);
  check("ONE click on Resume starts it again", dm.publicList()[0].paused === false);
  await pj('document.querySelector(".more").click(); 0');
  await sleep(300);
  await pj('[...document.querySelectorAll(".rowmenu .mi")].find((m) => m.textContent === "Cancel").click(); 0');
  check("ONE click on Cancel cancels it", await until(() => dm.publicList()[0].state === "cancelled"));
  await sleep(400);
  await pj('document.querySelector(".acts button[title^=Remove]").click(); 0');
  check("ONE click on ✕ removes the finished row", await until(() => dm.publicList().length === 0));
  tm.closeTab(state.activeTabId);
  await sleep(400);

  // ── the same, in the bubble: one click per button while progress ticks ──
  dm.clearAll();
  session.defaultSession.downloadURL(base + "/long");
  await until(() => dm.publicList()[0] && dm.publicList()[0].received > 20000);
  if (!popup.isOpen("downloads")) popup.open("downloads", { left: 900, right: 930, top: 40, bottom: 80, width: 30 });
  await sleep(900);
  const bj = (c) => pv().executeJavaScript(c);
  await bj('document.querySelector(".dl-row").dataset.mark = "x"; 0');
  const sub0 = await bj('document.querySelector(".dl-row .sub").textContent');
  await sleep(1400);
  check("the bubble keeps updating without rebuilding its rows",
    (await bj('document.querySelector(".dl-row").dataset.mark')) === "x" &&
    (await bj('document.querySelector(".dl-row .sub").textContent')) !== sub0);
  await bj('document.querySelector(".dl-btn[title=Pause]").click(); 0');
  check("ONE click on the bubble's Pause pauses it", await until(() => dm.publicList()[0].paused === true, 3000));
  await bj('document.querySelector(".dl-btn[title=Resume]").click(); 0');
  check("ONE click on the bubble's Resume continues it", await until(() => dm.publicList()[0].paused === false, 3000));
  await bj('document.querySelector(".dl-btn[title=Cancel]").click(); 0');
  check("ONE click on the bubble's Cancel cancels it", await until(() => dm.publicList()[0].state === "cancelled", 3000));
  popup.close();
  dm.clearAll();

  // ── the blur rule itself (put back, then provoked) ──
  blurHandlers.forEach((h) => win.on("blur", h));
  popup.open("downloads", { left: 900, right: 930, top: 40, bottom: 80, width: 30 });
  await sleep(600);
  win.emit("blur");
  await sleep(300);
  check("clicking away (window blur) closes the bubble", !popup.isOpen("downloads"));

  // ── "Ask where to save each file" is off by default ──
  check("the Ask switch is off by default (Chrome's default)", dm.config().ask === false);
  check("Settings reports the download folder", dm.config().dir === dir);

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_DLFLOW total=" + results.length + " failed=" + failed.length);
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
