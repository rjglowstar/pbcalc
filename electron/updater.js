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
//            (autoInstallOnAppQuit for a real quit; calcMode.returnToCalc for the calculator's "browser closed"), and if PBCalc is OPENED
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
  let manual = false;                           // the user pressed "Check for update" in Settings: this answer is asked for, never skipped
  let pending = null;                           // a downloaded update the user postponed with Cancel

  function install(info) {
    state.quitting = true;                      // a real quit: closing the window must not return to the calculator (calcMode)
    try { declined.set(""); } catch (_) {}
    if (opts.install) return opts.install(info);
    // SILENT, see the header: keeps the install where it is and PBCalc starts again by itself (isForceRunAfter)
    autoUpdater.quitAndInstall(true, true);
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
  autoUpdater.on("update-available", (info) => log("update available, downloading quietly: " + info.version));
  autoUpdater.on("update-not-available", (info) => log("up to date (" + info.version + ")"));
  autoUpdater.on("download-progress", ({ percent }) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.setProgressBar(percent / 100);
  });
  autoUpdater.on("update-downloaded", async (info) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.setProgressBar(-1);
    if (announced) return;
    announced = true;
    log("downloaded " + info.version);
    // said Cancel to THIS version in an earlier session: PBCalc was opened again, so now it just updates
    const wasManual = manual; manual = false;
    let before = ""; try { before = declined.get(); } catch (_) {}
    if (!wasManual && before && before === info.version) { log("declined earlier, installing now"); return install(info); }
    let yes = false;
    try { yes = await ask(info); } catch (_) { yes = false; }
    if (yes) return install(info);
    pending = info;
    try { declined.set(info.version); } catch (_) {}
    log("postponed by the user: installs when PBCalc is closed");
  });
  autoUpdater.on("error", (err) => log("error (ignored): " + (err && err.message ? err.message.split("\n")[0] : err)));

  // With autoDownload electron-updater starts the download itself and hands back its promise; a damaged / interrupted download rejects it
  // in addition to the "error" event above, and a rejection nobody handles can end as an error dialog in the main process (measured with a
  // wrong checksum) - so that promise is handled here too.
  const quiet = (err) => log("failed (ignored): " + (err && err.message ? err.message.split("\n")[0] : err));
  const check = () => autoUpdater.checkForUpdates().then((res) => { if (res && res.downloadPromise) res.downloadPromise.catch(quiet); }).catch(quiet);
  const timer = setTimeout(check, opts.delayMs == null ? CHECK_DELAY_MS : opts.delayMs);
  if (timer.unref && !opts.keepAlive) timer.unref();
  // the browser was closed (the calculator came back, nothing is open to lose): a postponed update goes in now
  const installIfPending = () => { if (!pending) return false; const i = pending; pending = null; install(i); return true; };
  // Settings > Version > "Check for update": the same check, now. A newer version is downloaded and the usual popup comes when it is ready
  // (asked again even if it was declined before); no newer version = nothing at all is shown. Resolves when the CHECK is over, not the download.
  const checkNow = () => { manual = true; announced = false; return check(); };
  current = { autoUpdater, check, checkNow, installIfPending };
  return current;
}

// calcMode.returnToCalc: the browser is closed -> a postponed update installs now
function installIfPending() { return current ? current.installIfPending() : false; }

// Settings button; false when updates are not running (a development copy)
async function checkNow() { if (!current) return false; await current.checkNow(); return true; }

module.exports = { setup, installIfPending, checkNow, CHANNEL, TITLE, detailFor };
