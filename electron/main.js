const { app, BrowserWindow } = require("electron");

// Electron throws a Node warning into the terminal for every loadURL() that fails, even if we
// explicitly catch() the promise. This silences that specific noise so the terminal stays clean.
const originalEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  if (typeof warning === "string" && warning.includes("Failed to load URL:")) return;
  if (warning instanceof Error && warning.message.includes("Failed to load URL:")) return;
  return originalEmitWarning.call(this, warning, ...args);
};

const { dataDir } = require("./constants");

// MUST run before anything else touches storage, and before the app is ready — Electron only
// honours app.setPath("userData", ...) if it runs before the "ready" event fires. This one line
// points the WHOLE app at one folder (%LOCALAPPDATA%\PBCalc — see dataDir): the safeStorage-encrypted
// password vault, every tab's session cookies/localStorage and the settings file all resolve
// relative to THIS path from here on, with zero changes in the modules that call
// app.getPath("userData") — they simply inherit it.
app.setPath("userData", dataDir());

// ONE running PBCalc per data folder. A second launch (a link clicked in another program while PBCalc is the default
// browser, a double-clicked .html / .pdf) must hand its address to the window that is already open and quit - and it must
// do so BEFORE the startup sweep below, which deletes the running copy's session folder (it is meant for leftovers of a
// crash, and would wipe a live session). Without this lock two copies fought over the same folder.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
// A failed lock means "another copy is running" ONLY if the data folder is usable: the lock is a file inside it, so an
// unwritable folder fails it too - and then PBCalc must carry on and show its "cannot save your data" warning (below)
// instead of silently quitting. (dataFolderProblem is a function declaration, hoisted from further down.)
if (!gotSingleInstanceLock && !dataFolderProblem()) {
  app.quit();
  return;
}
app.on("second-instance", (_event, argv, workingDirectory) => {
  try { require("./externalOpen").openFromOutside(argv, workingDirectory); } catch (_) {}
});

// Disable GPU disk cache to prevent Windows file-locking collisions and console warnings.
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

// Video is decoded by the CPU, not the graphics card's decoder. Measured on the owner's PC (NVIDIA, Windows 10): a 2752x2064 H.264 recording
// froze after ~1 s in Electron with hardware decoding ("waiting" over and over, readyState 2, 40 of 45 frames shown then nothing) and
// played smoothly with --disable-accelerated-video-decode (6.08 s of video in 6 s) - the same file plays in Chrome, whose decoder falls back
// by itself. The cost is more CPU for large videos; the graphics card is still used for drawing the page.
app.commandLine.appendSwitch("disable-accelerated-video-decode");

// No-history policy: sweep whatever a previous run (or a crash) left behind, before Chromium
// opens any of it, and wipe the session again on quit. See electron/privacy.js.
const { wipeLeftoversOnDisk, installQuitWipe } = require("./privacy");
wipeLeftoversOnDisk();
installQuitWipe();

// dataDir() already falls back to %APPDATA%\PBCalc when %LOCALAPPDATA%\PBCalc cannot be written.
// If even the fallback fails, the browser still runs but saved passwords, bookmarks and settings
// would be lost without a word. Say so instead.
function dataFolderProblem() {
  const fs = require("fs");
  const path = require("path");
  const dir = app.getPath("userData");
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return null;
  } catch (e) {
    return { dir, reason: e.message };
  }
}

function warnIfDataFolderUnwritable() {
  const problem = dataFolderProblem();
  if (!problem) return;
  try {
    require("electron").dialog.showMessageBoxSync({
      type: "warning",
      title: "PBCalc cannot save your data",
      message: "PBCalc keeps its data in a folder inside your Windows user profile, and that folder cannot be written.",
      detail: [
        problem.dir,
        "",
        "Saved passwords, bookmarks and settings will NOT be kept while this is the case.",
        "This folder belongs to your Windows account, so something outside PBCalc is blocking it —",
        "a locked-down or roaming profile, a full disk, or security software.",
        "",
        "(" + problem.reason + ")",
      ].join("\n"),
      buttons: ["Continue anyway"],
      noLink: true,
    });
  } catch (_) {}
}

const { createMainWindow } = require("./windows/mainWindow");
const { registerIpcHandlers } = require("./ipc/registerIpcHandlers");

registerIpcHandlers();

app.whenReady().then(async () => {
  // Present as plain Chrome, with NO "Electron" token — WAFs (Akamai on Meesho) 403 the Electron UA.
  // Use the REAL Chromium version so navigator.userAgent, the Sec-Ch-Ua client hints and the sent
  // header all agree (spoofing a lower version is itself detectable). Tabs run in the TAB_PARTITION
  // session, NOT defaultSession, so the UA/header rules MUST be applied there too — otherwise tabs
  // fall back to Electron's own UA. app.userAgentFallback covers every session app-wide; we also set
  // each session explicitly so there is no ambiguity.
  const chromeVersion = process.versions.chrome || "128.0.6613.138";
  const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  try {
    const { session } = require("electron");
    const { TAB_PARTITION } = require("./constants");
    app.userAgentFallback = cleanUA;
    const sessions = [session.defaultSession, session.fromPartition(TAB_PARTITION)];
    for (const ses of sessions) {
      ses.setUserAgent(cleanUA);
      ses.setPermissionRequestHandler(require("./tabs/tabManager").permissionRequestHandler);   // see there: no silent app launches
      require("./screenShare").install(ses);   // getDisplayMedia: without a handler Electron answers "NotSupportedError"
      ses.setPermissionCheckHandler((wc, permission, origin, details) => require("./permissions").check(wc, permission, origin, details));
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.resourceType === "mainFrame") {
          details.requestHeaders["Upgrade-Insecure-Requests"] = "1";
          details.requestHeaders["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
        }
        callback({ requestHeaders: details.requestHeaders });
      });
    }
  } catch (_) {}

  warnIfDataFolderUnwritable();
  require("./downloads/downloadManager").init();
  // the installer's two answers (calculator start / default browser): read once at the first start after an install (installed copy only)
  let installAnswers = null;
  if (app.isPackaged) { try { installAnswers = require("./installChoices").apply(); } catch (_) {} }
  // In-app updates (electron/updater.js): the installed program only. Set up BEFORE the window exists, because of the next lines: when the user
  // pressed Cancel on the update popup in an earlier session the update installs now, at start - and the browser window must not appear first
  // and vanish a moment later (that flicker was the bug): an "Updating PBCalc" window (its own process) is shown instead, and PBCalc quits into the
  // installer. When there is nothing to install (server not reachable, no newer version) it is closed again and PBCalc starts as usual.
  let updatingAtStart = false;
  if (app.isPackaged && process.platform === "win32") { try { require("./updater").setup(); } catch (_) {} }
  if (app.isPackaged && process.platform === "win32") { try { const up = require("./updater"); if (up.startupPending()) updatingAtStart = await up.startupInstall(); } catch (_) {} }
  if (updatingAtStart) return;
  createMainWindow();
  // PBCalc started BY a link / file from another program (Windows "Default apps"): open it as the first tab, once the
  // window has its first tab (mainWindow creates that on "ready-to-show").
  const firstWindow = require("./state").mainWindow;
  if (firstWindow) firstWindow.once("ready-to-show", () => setTimeout(() => { try { require("./externalOpen").openFromOutside(process.argv, process.cwd(), { first: true }); } catch (_) {} }, 400));
  // The installed program lists itself in Windows' Default apps (per user, no admin). Never for a development copy: it
  // would register Electron's own exe. Off the critical path; failures are ignored (nothing depends on it).
  if (app.isPackaged && process.platform === "win32") {
    setTimeout(async () => {
      try { const db = require("./defaultBrowser"); await db.register(process.execPath); await db.repairOpenWithIcons(process.execPath); } catch (_) {}   // async: reg.exe runs beside the app, never on its thread
      // (The installer's "default browser" answer used to open Windows' Default apps page here. The owner did not want a Settings window to pop up
      // by itself, so it does not: PBCalc is only LISTED there, and can be chosen later in Settings > Default apps > Web browser.)
    }, 5000).unref();
  }
  // Build the "download started" animation view a moment after startup, off the critical path, so the
  // FIRST download's flight does not wait for a page load (play() makes it on demand if one comes sooner).
  setTimeout(() => { try { require("./dlanimation").warm(); } catch (_) {} }, 2000).unref();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
