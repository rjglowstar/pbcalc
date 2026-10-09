const { app, dialog } = require("electron");
const state = require("./state");
const settings = require("./settings");

// In-app updates, built like the owner's ERP shell (PBERP-EXE - Barcode/electron/updater/autoUpdater.js): electron-updater against a plain web
// folder ("generic" provider, address in package.json -> build.publish). The admin only puts the THREE files electron-builder wrote into
// release/ on that server: pbcalc.yml, "PBCalc Setup <version>.exe" and its ".blockmap". At each START (5 s after the window is up) the program
// asks the server; a higher version is downloaded quietly.
//
// NOTHING IS FORCED (the owner's rule): when the download is done a modal popup says so and warns that updating restarts PBCalc (every tab is
// closed and NOT restored; PBCalc opens again when the update is finished). Two buttons:
//   Update - the installer runs silently and PBCalc starts again by itself;
//   Cancel - the popup closes and PBCalc keeps running untouched. The update then installs by itself the next time the browser is CLOSED
//            (autoInstallOnAppQuit: closing the browser quits PBCalc, which installs it), and if PBCalc is OPENED
//            again before that, it installs at once, without asking again (the declined version is remembered in settings.json).
//
// Differences from the ERP that matter, each found by measuring or by reading what the installer does:
//  * CHANNEL "pbcalc": the metadata file is pbcalc.yml, NOT latest.yml. The ERP keeps a latest.yml in the same kind of folder
//    (https://mfg.pb.diamonds/assets/); PBCalc reading THAT file would "update" itself to the ERP's installer.
//  * An update never asks for the installation password and never asks the two setup questions: the installer sees --updated (installer.nsh),
//    so what the user chose (calculator start in settings.json, the Default apps entries) simply stays.
//  * The installer is run SILENT (quitAndInstall(true, true)): the ERP's visible wizard has a "who should this be installed for" page whose first
//    choice (all users) moved an "only me" install into C:\Program Files and asked for administrator rights (measured).
//  * Never a downgrade, never a pre-release. A server that answers with something that is not a version file (a web page for a missing
//    file - measured on the test server) is an error that is logged and ignored: nothing is shown, the program just starts as usual.
const CHANNEL = "pbcalc";
const CHECK_DELAY_MS = 5000;
// The silent installer shows nothing, and PBCalc is gone while it works: electron/updateProgress.js puts an "Updating PBCalc" window on screen
// (a separate process, so it survives the quit). It is started PROGRESS_LEAD_MS before PBCalc quits, so there is never a moment with nothing.
const PROGRESS_LEAD_MS = 2000;
// At START with an update the user postponed (Cancel): the main window is NOT created until we know (no flicker: the browser used to appear,
// then vanish 5 s later when the update installed). Up to STARTUP_WAIT_MS for the server to answer; once a download is running up to
// STARTUP_DOWNLOAD_MAX_MS; if there is nothing to install (server not reachable, no newer version) PBCalc simply starts as usual.
const STARTUP_WAIT_MS = 6000;
const STARTUP_DOWNLOAD_MAX_MS = 10 * 60 * 1000;

// "0.1.10" > "0.1.9": numeric comparison of x.y.z (a missing or odd part counts as 0)
function versionCmp(a, b) {
  const n = (v) => String(v || "").split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  const x = n(a), y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

const TITLE = "PBCalc update";
const detailFor = () =>
  "If you update now, PBCalc restarts: all your open tabs are closed and are NOT restored. When the update is finished, PBCalc opens again.\n\n" +
  "If your work cannot be closed right now, press Cancel. The update will then install automatically the next time you close or open PBCalc.";

let current = null;   // the running updater (see setup)

// opts (tests only): feedUrl, delayMs, currentVersion, ask(info) -> Promise<boolean>, install(info), log(msg), declined { get, set }
function setup(opts = {}) {
  const { autoUpdater } = require("electron-updater");
  const log = opts.log || ((m) => console.log("[updater] " + m));
  const declined = opts.declined || { get: () => settings.get("updateDeclined") || "", set: (v) => settings.set("updateDeclined", v) };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;      // "Cancel" / no answer: the downloaded update installs when PBCalc is really quit
  autoUpdater.channel = CHANNEL;
  // ORDER MATTERS (found by the test: an older version on the server was downloaded and installed): electron-updater's `channel` setter
  // switches allowDowngrade ON again, so the channel has to be set FIRST and the downgrade switched off AFTER it.
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  if (opts.feedUrl) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.setFeedURL({ provider: "generic", url: opts.feedUrl, channel: CHANNEL }); }
  if (opts.currentVersion) autoUpdater.currentVersion = opts.currentVersion;

  let announced = false;
  let progress = null;                          // the "Updating PBCalc" window (updateProgress.js), once an update is really starting
  let startup = null;                           // { finish(handled) } while the main window is held back at start (startupInstall)
  let manual = false;                           // the user pressed "Check for update" in Settings: this answer is asked for, never skipped
  let pending = null;                           // a downloaded update the user postponed with Cancel
  let asking = false;                           // the update popup is open: a second "Check for update" must not open another one

  function startProgress(info) {
    if (!progress) progress = (opts.showProgress || require("./updateProgress").show)({ from: opts.currentVersion || app.getVersion(), to: info && info.version, ...(opts.progressOptions || {}) });   // progressOptions: tests only (other process names)
    try { if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.setProgressBar(1, { mode: "indeterminate" }); } catch (_) {}   // taskbar button: busy
  }

  function install(info) {
    state.quitting = true;                      // a real quit: closing the window must not return to the calculator (calcMode)
    try { declined.set(""); } catch (_) {}
    if (!opts.install || opts.showProgress) startProgress(info);   // (tests that stub the installer see no window unless they stub it too)
    if (opts.install) return opts.install(info);
    // SILENT, see the header: keeps the install where it is and PBCalc starts again by itself (isForceRunAfter). The window above is already up.
    setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch (_) {} }, progress ? PROGRESS_LEAD_MS : 0);
  }

  // the modal popup; true = Update, false = Cancel / Esc / anything else (never forces).
  // PBCalc's own dialog (electron/updateDialog.js); Windows' plain message box is only the fallback if that window cannot be made.
  const ask = opts.ask || (async (info) => {
    try { return await require("./updateDialog").ask({ version: info.version, current: app.getVersion() }); } catch (_) { /* fall back */ }
    const win = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
    const box = {
      type: "warning", title: TITLE, message: "Version " + info.version + " is ready to install.", detail: detailFor(),
      buttons: ["Update", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
    };
    const r = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
    return r.response === 0;
  });

  autoUpdater.on("checking-for-update", () => log("checking"));
  autoUpdater.on("update-available", (info) => {
    log("update available, downloading quietly: " + info.version);
    if (startup) startup.longer();
  });
  autoUpdater.on("update-not-available", (info) => { log("up to date (" + info.version + ")"); if (startup) startup.finish(false); });
  autoUpdater.on("download-progress", ({ percent }) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.setProgressBar(percent / 100);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.setProgressBar(-1);
    if (startup) {
      // PBCalc is being started and the main window is held back (startupInstall): only the version the user postponed is installed now, with
      // no question (the rule: Cancel = it installs by itself the next time PBCalc is opened). A NEWER version than that is not asked here
      // (there is no window to ask from): PBCalc starts normally and the 5 s check asks as it always does (the download is cached).
      let was = ""; try { was = declined.get(); } catch (_) {}
      const s = startup;
      if (was && was === info.version) { log("declined earlier, installing at start"); announced = true; install(info); return s.finish(true); }
      return s.finish(false);
    }
    if (announced || asking) return;
    announced = true;
    log("downloaded " + info.version);
    // said Cancel to THIS version in an earlier session: PBCalc was opened again, so now it just updates
    const wasManual = manual; manual = false;
    let before = ""; try { before = declined.get(); } catch (_) {}
    if (!wasManual && before && before === info.version) { log("declined earlier, installing now"); return install(info); }
    let yes = false;
    asking = true;
    try { yes = await ask(info); } catch (_) { yes = false; }
    asking = false;
    if (yes) return install(info);
    pending = info;
    try { declined.set(info.version); } catch (_) {}
    log("postponed by the user: installs when PBCalc is closed");
  });
  autoUpdater.on("error", (err) => { try { if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.setProgressBar(-1); } catch (_) {} log("error (ignored): " + (err && err.message ? err.message.split("\n")[0] : err)); if (startup) startup.finish(false); });

  // With autoDownload electron-updater starts the download itself and hands back its promise; a damaged / interrupted download rejects it
  // in addition to the "error" event above, and a rejection nobody handles can end as an error dialog in the main process (measured with a
  // wrong checksum) - so that promise is handled here too.
  const quiet = (err) => log("failed (ignored): " + (err && err.message ? err.message.split("\n")[0] : err));
  const check = () => autoUpdater.checkForUpdates().then((res) => { if (res && res.downloadPromise) res.downloadPromise.catch(quiet); }).catch(quiet);
  const timer = setTimeout(check, opts.delayMs == null ? CHECK_DELAY_MS : opts.delayMs);
  if (timer.unref && !opts.keepAlive) timer.unref();
  // (kept for the tests and for a caller that wants "install now"; nothing in the app calls it since the browser closing quits PBCalc)
  const installIfPending = () => { if (!pending) return false; const i = pending; pending = null; install(i); return true; };
  // Settings > Version > "Check for update": the same check, now. A newer version is downloaded and the usual popup comes when it is ready
  // (asked again even if it was declined before); no newer version = nothing at all is shown. Resolves when the CHECK is over, not the download.
  const checkNow = () => { manual = true; announced = false; return check(); };
  // An update the user postponed (Cancel) is waiting: its version is saved, and it is newer than the running one.
  const startupPending = () => {
    let was = ""; try { was = declined.get(); } catch (_) {}
    if (!was) return false;
    if (versionCmp(was, opts.currentVersion || app.getVersion()) > 0) return true;
    try { declined.set(""); } catch (_) {}      // already installed (by the quit-time install) or no longer relevant
    return false;
  };
  // main.js calls this BEFORE it creates the main window when startupPending(). Resolves true = the update is being installed (PBCalc is about
  // to quit, the progress window stays up; do NOT create the window), false = nothing to install now (the progress window is closed; start as usual).
  const startupInstall = () => new Promise((resolve) => {
    let timer = null, over = false;
    const finish = (handled) => {
      if (over) return;
      over = true; clearTimeout(timer); startup = null;
      if (!handled && progress) { try { progress.close(); } catch (_) {} progress = null; }
      resolve(handled);
    };
    startup = { finish, longer: () => { clearTimeout(timer); timer = setTimeout(() => finish(false), STARTUP_DOWNLOAD_MAX_MS); } };
    let was = ""; try { was = declined.get(); } catch (_) {}
    startProgress({ version: was });                // the postponed version is known already: the window shows it
    timer = setTimeout(() => finish(false), opts.startupWaitMs || STARTUP_WAIT_MS);
    check();                                     // the events above decide; a failure there (check swallows it) is the "error" event
  });
  current = { autoUpdater, check, checkNow, installIfPending, startupPending, startupInstall };
  return current;
}

// installIfPending: a postponed update installs now (not called by the app itself any more)
function installIfPending() { return current ? current.installIfPending() : false; }

// at start: has the user postponed an update (Cancel) that is still waiting? / hold the main window and install it (see updater setup)
function startupPending() { return current ? current.startupPending() : false; }
function startupInstall() { return current ? current.startupInstall() : Promise.resolve(false); }

// Settings button; false when updates are not running (a development copy)
async function checkNow() { if (!current) return false; await current.checkNow(); return true; }

module.exports = { setup, installIfPending, checkNow, startupPending, startupInstall, versionCmp, CHANNEL, TITLE, detailFor };
