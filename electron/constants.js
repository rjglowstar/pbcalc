const { app } = require("electron");
const path = require("path");

// WHERE PBCALC KEEPS ITS DATA — saved passwords, bookmarks, settings (and the session data that
// is wiped on exit) all live in ONE folder inside the user's profile:
//
//     %LOCALAPPDATA%\PBCalc   i.e. C:\Users\<user>\AppData\Local\PBCalc
//
// Out of sight (AppData is hidden by default) rather than a folder sitting in the root of C:, and
// independent of where the program was installed — an install into Program Files used to put the
// data beside the exe where a standard user cannot write, so nothing could be saved at all.
//
// Why Local and not Roaming: Chrome keeps its own profile in
// %LOCALAPPDATA%\Google\Chrome\User Data, and on a domain profile everything under Roaming is
// copied to and from the server at every logon — a browser cache does not belong there. (The
// sibling ERP ends up in %APPDATA%\mfg-erp only because it never calls app.setPath at all; that is
// Electron's default, not a decision. Its one deliberate choice is D:\Exe Settings for the barcode
// settings file.)
//
// Fallback, same shape as that ERP's D:\Exe Settings -> %APPDATA% rule: when the preferred folder
// cannot be created OR written, use %APPDATA%\PBCalc (Roaming). The probe really writes and deletes
// a file — a folder that exists but refuses writes is exactly the case a plain existsSync() would
// wave through and fail on later. Resolved once per process.
//
// In dev (`npm start`) the data stays inside the project (git-ignored), so working on PBCalc never
// touches the data of an installed copy.
//
// Built with path.join from an env var, never written as a literal: a Windows path in a JS string
// is a trap — "C:\PBCalc" is NOT that path, because \P is not a valid escape and it collapses to
// the RELATIVE path "C:PBCalc", which app.setPath rejects with "Path must be absolute".
function localAppData() {
  // LOCALAPPDATA is set on every supported Windows; derive it from the profile if it is not.
  return process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
}
const PREFERRED_DATA_DIR = path.join(localAppData(), "PBCalc");

function resolveDataDir(preferred) {
  const fs = require("fs");
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, ".write-test");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return preferred;
  } catch (_) {
    return path.join(app.getPath("appData"), "PBCalc"); // %APPDATA%\PBCalc (Roaming)
  }
}

let resolvedDataDir = null;
function dataDir() {
  if (resolvedDataDir) return resolvedDataDir;
  resolvedDataDir = app.isPackaged
    ? resolveDataDir(PREFERRED_DATA_DIR)
    : path.join(__dirname, "..", ".dev-userdata");
  return resolvedDataDir;
}

// Chrome-like chrome geometry (px). The tab view starts below TAB_STRIP + TOOLBAR (+ bookmarks bar
// when shown); see chromeHeight() in tabs/tabManager.js. Must match renderer/shell/shell.css.
// Every browsing tab runs in this one named session (NOT "persist:" — an in-memory partition, so
// cookies/localStorage/HTTP cache live in RAM, speed up loads during the session, and vanish on
// exit with zero disk trace). It is a single constant because SEVERAL subsystems must target the
// SAME session as the tabs: the Chrome User-Agent / header spoofing (electron/main.js) and the
// download manager's "will-download" (electron/downloads/downloadManager.js). Wiring those to
// session.defaultSession while tabs used this partition is what silently broke UA spoofing (tabs
// leaked the "Electron" token) and downloads (the manager never saw them). Keep them aligned here.
const TAB_PARTITION = "pbcalc";
const TAB_STRIP_HEIGHT = 40;
const TOOLBAR_HEIGHT = 40;
const BOOKMARKS_BAR_HEIGHT = 32;
// Chrome has no tab limit at all — it just keeps shrinking the tabs (measured from a real window
// with ~82 tabs: 18px each). This is only a safety ceiling so a runaway page calling window.open
// cannot spawn renderer processes without end; nobody reaches it by hand.
const MAX_TABS = 150;
const HOME_URL = "https://www.google.com/";
// Local new-tab page (no history, no most-visited tiles).
const NEWTAB_URL = require("url").pathToFileURL(path.join(__dirname, "..", "renderer", "newtab", "newtab.html")).href;

// Local settings page (Chrome's chrome://settings equivalent): Appearance mode, bookmarks bar.
const SETTINGS_URL = require("url").pathToFileURL(path.join(__dirname, "..", "renderer", "settings", "settings.html")).href;

// Home page shown in Restricted Mode: tiles for the preset (bookmarked) sites only.
const RESTRICTED_HOME_URL = require("url").pathToFileURL(path.join(__dirname, "..", "renderer", "restricted", "home.html")).href;

// Bookmark manager page (chrome://bookmarks equivalent). In Restricted Mode only reachable after the
// admin PIN.
const MANAGER_URL = require("url").pathToFileURL(path.join(__dirname, "..", "renderer", "manager", "manager.html")).href;

// This session's downloads (Chrome's chrome://downloads equivalent). In memory only.
const DOWNLOADS_URL = require("url").pathToFileURL(path.join(__dirname, "..", "renderer", "downloads", "downloads.html")).href;

module.exports = {
  dataDir,
  resolveDataDir, // exported for the tests: the probe-and-fallback rule itself
  PREFERRED_DATA_DIR,
  TAB_PARTITION,
  DOWNLOADS_URL,
  MANAGER_URL,
  RESTRICTED_HOME_URL,
  SETTINGS_URL,
  TAB_STRIP_HEIGHT,
  TOOLBAR_HEIGHT,
  BOOKMARKS_BAR_HEIGHT,
  MAX_TABS,
  HOME_URL,
  NEWTAB_URL,
};
