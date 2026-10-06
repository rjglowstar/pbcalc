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

// Disable GPU disk cache to prevent Windows file-locking collisions and console warnings.
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");

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

app.whenReady().then(() => {
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
  createMainWindow();
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
