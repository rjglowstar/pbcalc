const { app, BrowserWindow } = require("electron");
const { dataDir } = require("./constants");

// MUST run before anything else touches storage, and before the app is ready — Electron only
// honours app.setPath("userData", ...) if it runs before the "ready" event fires. This one line
// points the WHOLE app at one folder (%LOCALAPPDATA%\PBCalc — see dataDir): the safeStorage-encrypted
// password vault, every tab's session cookies/localStorage and the settings file all resolve
// relative to THIS path from here on, with zero changes in the modules that call
// app.getPath("userData") — they simply inherit it.
app.setPath("userData", dataDir());

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
  warnIfDataFolderUnwritable();
  require("./downloads/downloadManager").init();
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
