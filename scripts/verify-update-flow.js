// The whole update chain, as the owner sees it, with the REAL modules (electron-updater download + checksum, updater.js, updateProgress.js, the
// real "Updating PBCalc" window) and stand-ins only for what cannot be run here without replacing the owner's installed PBCalc: the silent
// installer (a renamed powershell called "PBCalc Setup 0.2.0.exe" that works ~6 s) and the new PBCalc it starts (a renamed powershell called
// "pbc_e2e_new.exe" that opens a window). The "old PBCalc" is a SEPARATE Electron process that really quits.
//   Case 2: the user presses Update -> the window must be there before the old app is gone, stay through the installer, close when the new app is up.
//   Case 3: the user pressed Cancel earlier; at the next START the main window must not be created at all (no flicker) - the same window is
//           shown instead, then the same chain.
// Not covered: the real NSIS installer replacing the real files (that would replace the PBCalc installed on this PC); it is the stand-in's job here.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-update-flow.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");

const MODE = process.argv.find((a) => /^--(old|start)$/.test(a));   // child: the "old PBCalc"
const PS_EXE = "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const DIR = path.join(os.tmpdir(), "pbc-flow-e2e");
const FAKE_INSTALLER = path.join(DIR, "pbc_e2e_inst.exe"), FAKE_NEW = path.join(DIR, "pbc_e2e_new.exe");   // other names than the real ones: a PBCalc the owner has open must not matter
const NAME = "PBCalc Setup 0.2.0.exe";
const DEV_YML = path.join(__dirname, "dev-app-update.yml");

// ───────────────────────── the "old PBCalc" (child) ─────────────────────────
if (MODE) {
  const feed = process.argv.find((a) => a.startsWith("--feed=")).slice(7);
  app.whenReady().then(async () => {
    const out = (o) => console.log("CHILD " + JSON.stringify(o));
    const updater = require("../electron/updater");
    const store = { v: MODE === "--start" ? "0.2.0" : "" };
    const { autoUpdater } = require("electron-updater");
    // the only stub: instead of running the real installer, run the stand-in and quit like quitAndInstall does
    autoUpdater.quitAndInstall = () => {
      out({ event: "quitAndInstall", windows: BrowserWindow.getAllWindows().length });
      // the stand-in installer: a script that works ~6 s and then starts the stand-in new PBCalc (which opens a window)
      const instPs1 = path.join(DIR, "inst.ps1"), newPs1 = path.join(DIR, "new.ps1");
      const NL = String.fromCharCode(10);
      fs.writeFileSync(newPs1, "Add-Type -AssemblyName System.Windows.Forms" + NL + "$f = New-Object System.Windows.Forms.Form" + NL + "$f.Text = 'new pbcalc'" + NL + "[void]$f.ShowDialog()" + NL);
      fs.writeFileSync(instPs1, "Start-Sleep -Seconds 6" + NL + "Start-Process -FilePath '" + FAKE_NEW + "' -ArgumentList '-NoProfile','-File','" + newPs1 + "'" + NL);
      // (not `detached`: a detached powershell has no console and ends at once; `start` makes it independent of this process, like the real installer)
      const inst = spawn("cmd.exe", ["/d", "/s", "/c", '"start "" /b "' + FAKE_INSTALLER + '" -NoProfile -File "' + instPs1 + '""'], { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
      inst.unref();
      app.quit();
    };
    const u = updater.setup({
      feedUrl: feed, delayMs: 3600000, currentVersion: "0.1.5",
      ask: async () => true,
      declined: { get: () => store.v, set: (v) => { store.v = v; } },
      log: (m) => out({ log: m }),
      progressOptions: { newName: "pbc_e2e_new", installerLike: "pbc_e2e_inst*" },   // what the window watches for: the stand-ins
    });
    if (MODE === "--start") {
      // what main.js does at start: nothing is created before this answer
      out({ event: "start", pending: u.startupPending(), windows: BrowserWindow.getAllWindows().length });
      const handled = await u.startupInstall();
      out({ event: "startup-answer", handled, windows: BrowserWindow.getAllWindows().length });
    } else {
      await u.check();
    }
    setTimeout(() => { out({ event: "timeout" }); app.exit(3); }, 60000).unref();
  });
  return;
}

// ───────────────────────── the test (parent) ─────────────────────────
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 170000).unref();
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra !== undefined ? "  <" + extra + ">" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => { try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { timeout: 20000 }).toString().trim(); } catch (_) { return ""; } };
const updateWindows = () => ps("(Get-Process | Where-Object { $_.MainWindowTitle -eq 'PBCalc update' } | ForEach-Object { $_.Id }) -join ','").split(",").filter(Boolean).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

const exe = crypto.randomBytes(1024 * 1024);
const sha = crypto.createHash("sha512").update(exe).digest("base64");
const yml = `version: 0.2.0\nfiles:\n  - url: ${NAME}\n    sha512: ${sha}\n    size: ${exe.length}\npath: ${NAME}\nsha512: ${sha}\nreleaseDate: '2026-10-08T00:00:00.000Z'\n`;
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split("?")[0]).replace(/^\/assets\//, "");
  if (p === "pbcalc.yml") { r.setHeader("content-type", "text/yaml"); return r.end(yml); }
  if (p === NAME) { r.setHeader("content-type", "application/octet-stream"); return r.end(exe); }
  r.statusCode = 404; r.end("no");
});

async function scenario(label, flag) {
  console.log("\n-- " + label);
  const feed = "http://127.0.0.1:" + server.address().port + "/assets/";
  const t0 = Date.now(); const log = [];
  const child = spawn(process.execPath, [__filename, flag, "--feed=" + feed], { stdio: ["ignore", "pipe", "pipe"], env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })() });
  let buf = ""; const events = [];
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.startsWith("CHILD ")) { const e = JSON.parse(line.slice(6)); e.at = Date.now() - t0; events.push(e); } } });
  let exitedAt = null; child.on("exit", () => { exitedAt = Date.now() - t0; });
  // sample the screen every 300 ms: which update-window processes exist, is the old app alive, is the installer / the new app running
  const samples = [];
  const sampler = (async () => { while (exitedAt === null || Date.now() - t0 < exitedAt + 14000) { samples.push({ at: Date.now() - t0, win: updateWindows().length > 0, old: exitedAt === null }); await sleep(250); if (Date.now() - t0 > 40000) break; } })();
  await sampler;
  if (process.env.FLOW_DEBUG) console.log("   procs: " + ps("(Get-Process | Where-Object { $_.ProcessName -like 'pbc_e2e*' -or $_.MainWindowTitle -eq 'PBCalc update' } | ForEach-Object { $_.ProcessName + '#' + $_.Id + '[' + $_.MainWindowTitle + ']' }) -join '; '"));
  try { child.kill(); } catch (_) {}
  if (process.env.FLOW_DEBUG) console.log("   timeline " + label.slice(0, 8) + ": exit=" + exitedAt + " events=" + events.map((e) => (e.event || "log") + "@" + e.at).join(",") + " windowSamples=" + samples.map((x) => x.at + (x.win ? "W" : "-")).join(" "));
  const q = events.find((e) => e.event === "quitAndInstall");
  const firstWin = samples.find((s) => s.win);
  const lastWin = [...samples].reverse().find((s) => s.win);
  const gapSamples = samples.filter((s) => exitedAt !== null && s.at > exitedAt + 300 && s.at < (lastWin ? lastWin.at : 0));
  return { events, samples, q, exitedAt, firstWin, lastWin, gapSamples, stillShown: updateWindows().length };
}

(async () => {
  try {
    await app.whenReady();
    ps("Get-Process | Where-Object { $_.MainWindowTitle -eq 'PBCalc update' } | Stop-Process -Force");   // windows left by an earlier run would be counted as this run's
    fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(PS_EXE, FAKE_INSTALLER); fs.copyFileSync(PS_EXE, FAKE_NEW);
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    // electron-updater of a development run reads this file next to the script (written and removed here, like verify-updater.js)
    fs.writeFileSync(DEV_YML, ["provider: generic", "url: http://127.0.0.1:" + server.address().port + "/assets/", "channel: pbcalc", "updaterCacheDirName: pbcalc-updater", ""].join(String.fromCharCode(10)));

    // Case 2 - the user presses Update
    let r = await scenario("Case 2: the user presses UPDATE (old PBCalc quits, installer works, new PBCalc starts)", "--old");
    check("the update was offered and Update chosen: the old app reached quitAndInstall", !!r.q, JSON.stringify(r.events.map((e) => e.event || e.log)));
    check("the 'Updating PBCalc' window was on screen BEFORE the old app exited", r.firstWin && r.exitedAt && r.firstWin.at < r.exitedAt, JSON.stringify({ win: r.firstWin && r.firstWin.at, exit: r.exitedAt }));
    check("...and it appeared at least ~1 s before the old app was gone (no empty moment)", r.firstWin && r.exitedAt && r.exitedAt - r.firstWin.at >= 800, String(r.exitedAt - (r.firstWin && r.firstWin.at)));
    check("there is NO moment between the old app exiting and the new one showing in which no update window is on screen", r.gapSamples.length > 8 && r.gapSamples.every((s) => s.win), JSON.stringify({ n: r.gapSamples.length, missing: r.gapSamples.filter((s) => !s.win).map((s) => s.at) }));
    check("the window closed by itself after the new PBCalc opened (nothing left on screen)", r.stillShown === 0 && r.lastWin && r.lastWin.at > r.exitedAt + 3000, JSON.stringify({ still: r.stillShown, last: r.lastWin && r.lastWin.at, exit: r.exitedAt }));
    ps("Get-Process -Name pbc_e2e_new -ErrorAction SilentlyContinue | Stop-Process -Force"); await sleep(800);

    // Case 3 - Cancel earlier, now the next START
    r = await scenario("Case 3: Cancel was pressed earlier - the next START (no main window may appear)", "--start");
    const st = r.events.find((e) => e.event === "start"), ans = r.events.find((e) => e.event === "startup-answer"), qq = r.events.find((e) => e.event === "quitAndInstall");
    check("start-up sees the postponed update and no main window exists at that moment", st && st.pending === true && st.windows === 0, JSON.stringify(st));
    check("the answer 'installing' comes with STILL no main window (the browser never flashed up)", ans && ans.handled === true && ans.windows === 0, JSON.stringify(ans));
    check("PBCalc quits into the installer with no main window ever created", qq && qq.windows === 0, JSON.stringify(qq));
    check("the 'Updating PBCalc' window was on screen from the start and through the whole install", r.firstWin && r.firstWin.at < 7000 && r.gapSamples.length > 8 && r.gapSamples.every((s) => s.win), JSON.stringify({ first: r.firstWin && r.firstWin.at, missing: r.gapSamples.filter((s) => !s.win).length }));
    check("...and it closed by itself when the new PBCalc opened", r.stillShown === 0 && r.lastWin && r.lastWin.at > r.exitedAt + 3000, JSON.stringify({ still: r.stillShown }));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  ps("Get-Process -Name pbc_e2e_new -ErrorAction SilentlyContinue | Stop-Process -Force");
  try { server.close(); } catch (_) {}
  try { fs.unlinkSync(DEV_YML); } catch (_) {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_UPDATEFLOW total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
