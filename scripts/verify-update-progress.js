// The "Updating PBCalc" window (electron/updateProgress.js): it must be on screen while PBCalc is NOT running (so it lives in its own process),
// show what is happening, close by itself when the NEW PBCalc is up, and say so when the update did not finish.
// The new PBCalc is played by a renamed copy of powershell.exe that opens a window (process name "pbc_test_new"), the installer by one named
// "pbc_test_inst" - the window only looks at process names and window handles, so this is the same thing it sees in a real update.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-update-progress.js
const { app } = require("electron");
const fs = require("fs"), os = require("os"), path = require("path");
const { spawn, execFileSync } = require("child_process");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 150000).unref();
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra !== undefined ? "  <" + extra + ">" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
const ps = (cmd) => { try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", cmd], { timeout: 20000 }).toString().trim(); } catch (_) { return ""; } };
const pidOf = async (x) => { await waitFor(() => x.pid(), 10000); return x.pid(); };
const titleOf = (pid) => ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`);

(async () => {
  const kids = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbc-prog-"));
  try {
    await app.whenReady();
    const up = require("../electron/updateProgress");
    const stand = (name) => { const f = path.join(tmp, name + ".exe"); fs.copyFileSync("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", f); return f; };
    const newExe = stand("pbc_test_new"), instExe = stand("pbc_test_inst");
    const FORM = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = 'stand-in'; [void]$f.ShowDialog()";
    const NAMES = { newName: "pbc_test_new", installerLike: "pbc_test_inst*" };
    const uiFiles = () => fs.readdirSync(os.tmpdir()).filter((f) => /^pbcalc-update-ui-.*\.ps1$/.test(f));
    const before = uiFiles().length;

    console.log("-- the window appears and stays");
    check("the script is valid PowerShell (parses), light and dark", ["light", "dark"].every((m) => { const f = path.join(tmp, m + ".ps1"); fs.writeFileSync(f, "\ufeff" + up.buildScript({ ...up.DEFAULTS, ...NAMES, exe: process.execPath, oldPid: 1, dark: m === "dark", from: "v0.1.2", to: "v0.1.3", sub: "x" })); return ps(`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); $e.Count`) === "0"; }));
    const h = up.show({ ...NAMES, oldPid: 99999999, from: "0.1.2", to: "0.1.3", dark: false });
    h.hp = await pidOf(h);
    check("it starts a separate process (it reports its own process id)", h && h.hp && alive(h.hp), String(h.hp));
    check("a window titled 'PBCalc update' is on screen within 6 s (no console, no flash)", await waitFor(() => titleOf(h.hp) === "PBCalc update", 6000));
    await sleep(2500);
    check("it stays up while nothing has come back (does not close by itself)", alive(h.hp) && titleOf(h.hp) === "PBCalc update");
    check("it is a window of its OWN process: it does not depend on this (the quitting) process", h.hp !== process.pid);

    console.log("\n-- it closes when the NEW PBCalc is up");
    const inst = spawn(instExe, ["-NoProfile", "-Command", "Start-Sleep 30"], { stdio: "ignore", windowsHide: true }); kids.push(inst);
    await sleep(1500);
    check("while the installer runs it keeps showing", alive(h.hp));
    const nw = spawn(newExe, ["-NoProfile", "-Command", FORM], { stdio: "ignore" }); kids.push(nw);
    await sleep(300);
    const t0 = Date.now();
    check("as soon as a NEW 'PBCalc' process with a window exists, the update window closes by itself (within ~3 s)", await waitFor(() => !alive(h.hp), 8000), String(Date.now() - t0));
    check("...and it removed its own script file from the temp folder", await waitFor(() => uiFiles().length <= before, 4000), String(uiFiles().length));
    try { nw.kill(); inst.kill(); } catch (_) {}

    console.log("\n-- the OLD process's own window is not mistaken for the new one");
    const oldp = spawn(newExe, ["-NoProfile", "-Command", FORM], { stdio: "ignore" }); kids.push(oldp);
    await sleep(2500);
    const h2 = up.show({ ...NAMES, oldPid: oldp.pid, dark: true });
    h2.hp = await pidOf(h2);
    await sleep(5000);
    check("a window of the process whose id was passed in (the old PBCalc) does not close it", alive(h2.hp));
    oldp.kill(); await sleep(500);
    const nw2 = spawn(newExe, ["-NoProfile", "-Command", FORM], { stdio: "ignore" }); kids.push(nw2);
    check("...a different process with that name and a window does", await waitFor(() => !alive(h2.hp), 9000));
    try { nw2.kill(); } catch (_) {}

    console.log("\n-- the update did not finish");
    const h3 = up.show({ ...NAMES, oldPid: 99999999, failAfter: 3, dark: false });
    h3.hp = await pidOf(h3);
    check("nobody comes back: after the allowed time it says so and STAYS (a Close button, not a silent vanish)", await (async () => { await sleep(9000); return alive(h3.hp) && titleOf(h3.hp) === "PBCalc update"; })());
    h3.close();
    check("close() makes the window go away by itself (used when the update turned out not to be needed)", await waitFor(() => !alive(h3.hp), 4000));
    check("...and its script, id and stop files are removed", await waitFor(() => uiFiles().length <= before && !fs.readdirSync(os.tmpdir()).some((f) => /^pbcalc-update-ui-.*\.(pid|stop)$/.test(f)), 7000), String(uiFiles().length));
    await sleep(500);

    console.log("\n-- the drawn Close button on the failure screen (a mouse click, Enter and Esc)");
    const post = (pid, msg, wp, lp) => ps(`Add-Type 'using System; using System.Runtime.InteropServices; public class PM { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l); }'; $p = Get-Process -Id ${pid}; [void][PM]::PostMessage($p.MainWindowHandle, ${msg}, [IntPtr]${wp}, [IntPtr]${lp})`);
    const failing = async () => { const w = up.show({ ...NAMES, oldPid: 99999999, failAfter: 2, dark: false }); w.hp = await pidOf(w); await sleep(7000); return w; };
    const BX = 396, BY = 427;   // the button's centre in client pixels (480x470 client, button 104x38 at the bottom right)
    const xy = (x, y) => (y * 65536 + x);
    let w5 = await failing();
    post(w5.hp, 0x200, 0, xy(10, 10)); await sleep(300);
    post(w5.hp, 0x201, 1, xy(10, 10)); post(w5.hp, 0x202, 0, xy(10, 10)); await sleep(1000);
    check("a click on the empty part of the window does nothing", alive(w5.hp));
    post(w5.hp, 0x200, 0, xy(BX, BY)); await sleep(300); post(w5.hp, 0x201, 1, xy(BX, BY)); await sleep(200); post(w5.hp, 0x202, 0, xy(BX, BY));
    check("a click on the Close button closes the window", await waitFor(() => !alive(w5.hp), 6000));
    w5 = await failing(); post(w5.hp, 0x100, 13, 0);
    check("Enter closes the failure screen", await waitFor(() => !alive(w5.hp), 6000));
    w5 = await failing(); post(w5.hp, 0x100, 27, 0);
    check("Esc closes the failure screen", await waitFor(() => !alive(w5.hp), 6000));
    const prog = up.show({ ...NAMES, oldPid: 99999999, dark: false }); prog.hp = await pidOf(prog); await sleep(1500);
    post(prog.hp, 0x100, 13, 0); await sleep(1500);
    check("Enter does NOT close the progress screen (only the failure screen is dismissable that way)", alive(prog.hp));
    prog.close(); await waitFor(() => !alive(prog.hp), 4000);
    check("the window's icon is PBCalc's own file in a development run (assets/icon.ico), not Electron's", /assets[\\/]icon\.ico$/.test(up.iconFile()) && fs.existsSync(up.iconFile()), up.iconFile());

    console.log("\n-- wiring");
    const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const main = src("electron/main.js");
    const iStartup = main.indexOf("startupInstall"), iCreate = main.indexOf("createMainWindow();");
    check("main.js asks the updater (startupInstall) BEFORE it creates the main window, and returns without a window when an update is installing", iStartup > 0 && iCreate > iStartup && /if \(updatingAtStart\) return;/.test(main));
    check("the window is started 2 s before PBCalc quits (PROGRESS_LEAD_MS) and its process is not detached", /PROGRESS_LEAD_MS = 2000/.test(src("electron/updater.js")) && !/detached:\s*true/.test(src("electron/updateProgress.js").replace(/\/\/.*$/gm, "")));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  for (const k of kids) { try { k.kill(); } catch (_) {} }
  ps("Get-Process | Where-Object { $_.MainWindowTitle -eq 'PBCalc update' } | Stop-Process -Force");   // never leave a window of this test on the screen
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_UPDATEPROGRESS total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
