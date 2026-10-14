// "PBCalc closed unexpectedly last time" (reportDialog.askAfterUncleanEnd, owner 2026-10-14): a PBCalc that was KILLED (the user PC's security product ended it
// while an Excel file was downloading) could not ask for a report itself; the NEXT start now offers the report box by itself. Real processes: a PBCalc is
// started and killed hard (taskkill /F, like the antivirus did), then started again. Checks: the box comes by itself with the "closed unexpectedly" text, nothing
// is sent without the user, it is asked ONCE per abnormal end, never after a normal close, in Restricted Mode too, on the calculator screen only once the browser
// opens, never in a development run without PBCALC_TEST_UNCLEAN=1, and a PBCalc killed within its first 30 s is noticed too.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-unclean-report.js
const { app, BrowserWindow } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.env.PBC_UC_MODE;

if (MODE) {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 90000).unref();
  const ud = process.env.PBC_UC_UD;
  require("../electron/constants").dataDir = () => ud;
  (async () => {
    require("../electron/main.js");
    await app.whenReady();
    const state = require("../electron/state");
    for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible()); i++) await sleep(10);
    if (MODE === "victim") {
      // wait for the first copy of the session (written ~5 s after the start), then tell the parent to kill us
      for (let i = 0; i < 300 && !fs.existsSync(path.join(ud, "diag-session.json")); i++) await sleep(50);
      console.log("READY " + process.pid + " session=" + fs.existsSync(path.join(ud, "diag-session.json")));
      await sleep(60000);
      return;
    }
    const box = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === "PBCalc report" && w.isVisible());
    const r = { restricted: !!state.restricted };
    if (MODE === "calc") {
      await sleep(7000);
      r.boxOnCalc = !!box();
      r.calcMode = !!state.calcMode;
      require("../electron/calcMode").leave();   // = the five presses of the grey "+"
    }
    let w = null;
    for (let i = 0; i < 120 && !(w = box()); i++) await sleep(100);
    r.box = !!w;
    if (w) {
      await sleep(600);
      r.text = (await w.webContents.executeJavaScript("document.body.innerText").catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      r.shareFilesWhileOpen = fs.existsSync(path.join(ud, "share")) ? fs.readdirSync(path.join(ud, "share")).length : 0;
      try { r.askedFlag = JSON.parse(fs.readFileSync(path.join(ud, "diag-previous.json"), "utf8")).askedAtStart === true; } catch (_) { r.askedFlag = "no previous file"; }
      w.close();   // = Cancel
      await sleep(500);
    }
    r.previousKept = fs.existsSync(path.join(ud, "diag-previous.json"));
    console.log("RESULT " + JSON.stringify(r));
    app.quit();   // a NORMAL close
  })().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
} else {
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 600000).unref();
  let failed = 0, total = 0;
  const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 300) + ">" : "")); };
  const newUD = (extra = {}) => { const ud = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pbuc-")), "UserData"); fs.mkdirSync(path.join(ud, "share"), { recursive: true }); fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: true, reportShare: path.join(ud, "share"), ...extra })); return ud; };
  const env = (mode, ud, test = true) => { const e = { ...process.env, PBC_UC_MODE: mode, PBC_UC_UD: ud }; delete e.ELECTRON_RUN_AS_NODE; if (test) e.PBCALC_TEST_UNCLEAN = "1"; else delete e.PBCALC_TEST_UNCLEAN; return e; };
  // a PBCalc killed hard, like the security product did
  const victim = (ud) => new Promise((resolve) => {
    const c = cp.spawn(process.execPath, [__filename], { env: env("victim", ud), windowsHide: true });
    let out = "", done = false;
    c.stdout.on("data", (d) => {
      out += d;
      const m = /READY (\d+) session=(\w+)/.exec(out);
      if (m && !done) { done = true; cp.execFile("taskkill", ["/F", "/T", "/PID", String(c.pid)], () => {}); resolve({ session: m[2] === "true" }); }
    });
    c.on("exit", () => { if (!done) resolve({ error: out.slice(-300) }); });
  });
  const run = (mode, ud, test = true) => new Promise((resolve) => {
    let out = "";
    const c = cp.spawn(process.execPath, [__filename], { env: env(mode, ud, test), windowsHide: true });
    c.stdout.on("data", (d) => { out += d; });
    c.on("exit", () => { const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { error: out.slice(-300) }); });
  });
  app.whenReady().then(async () => {
    console.log("-- PBCalc killed, then started again");
    let ud = newUD();
    const v = await victim(ud);
    check("the killed PBCalc had left its session copy (written ~5 s after the start, so a kill in the first 30 s is noticed too)", v.session === true, JSON.stringify(v));
    await sleep(2000);
    const a = await run("check", ud);
    check("the next start completed", !a.error, a.error);
    check("the report box opened BY ITSELF", a.box === true, JSON.stringify(a));
    check("...saying PBCalc closed unexpectedly last time", /PBCalc had a problem/.test(a.text || "") && /closed unexpectedly the last time/.test(a.text || ""), a.text);
    check("...and nothing was sent without the user (the IT folder stays empty while the box is open)", a.shareFilesWhileOpen === 0, a.shareFilesWhileOpen);
    check("it is marked as asked, and the crash data stays for the next report the user sends", a.askedFlag === true && a.previousKept === true, JSON.stringify(a));
    const b = await run("check", ud);
    check("after Cancel it is NOT asked again for the same crash", b.box === false, JSON.stringify(b));

    console.log("-- a NORMAL close");
    ud = newUD();
    const n1 = await run("check", ud);
    const n2 = await run("check", ud);
    check("no box after a normal close (two normal starts)", !n1.error && !n2.error && n1.box === false && n2.box === false, JSON.stringify([n1, n2]));

    console.log("-- Restricted Mode");
    ud = newUD({ restricted: { startRestricted: true } });
    await victim(ud); await sleep(2000);
    const rr = await run("check", ud);
    check("in Restricted Mode the box comes too", rr.restricted === true && rr.box === true && /closed unexpectedly/.test(rr.text || ""), JSON.stringify(rr));

    console.log("-- calculator screen");
    ud = newUD({ calculatorStart: true });
    await victim(ud); await sleep(2000);
    const cc = await run("calc", ud);
    check("NOT while the calculator screen shows (the disguise is kept)", cc.calcMode === true && cc.boxOnCalc === false, JSON.stringify(cc));
    check("...but as soon as the browser is opened", cc.box === true && /closed unexpectedly/.test(cc.text || ""), JSON.stringify(cc));

    console.log("-- a development run");
    ud = newUD();
    await victim(ud); await sleep(2000);
    const dv = await run("check", ud, false);
    check("a development copy (not installed) does not ask unless PBCALC_TEST_UNCLEAN=1", dv.box === false, JSON.stringify(dv));

    console.log("\nPBCALC_UNCLEAN total=" + total + " failed=" + failed);
    app.exit(failed ? 1 : 0);
  });
}
