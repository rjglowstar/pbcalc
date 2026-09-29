const { app, BrowserWindow } = require("electron");
const { portableDataDir } = require("./constants");

// MUST run before anything else touches storage, and before the app is ready — Electron only
// honours app.setPath("userData", ...) if it runs before the "ready" event fires. This one line
// is what makes the whole app portable: the safeStorage-encrypted password vault, every tab's
// session cookies/localStorage, and any future settings file all resolve relative to THIS path
// from here on, with zero changes needed in the modules that call app.getPath("userData") — they
// simply inherit it.
app.setPath("userData", portableDataDir());

// No-history policy: sweep whatever a previous run (or a crash) left behind, before Chromium
// opens any of it, and wipe the session again on quit. See electron/privacy.js.
const { wipeLeftoversOnDisk, installQuitWipe } = require("./privacy");
wipeLeftoversOnDisk();
installQuitWipe();

const { createMainWindow } = require("./windows/mainWindow");
const { registerIpcHandlers } = require("./ipc/registerIpcHandlers");

registerIpcHandlers();

app.whenReady().then(() => {
  require("./downloads/downloadManager").init();
  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
