const { app } = require("electron");
const path = require("path");

// Portable storage — everything the app keeps (saved passwords, session cookies/localStorage,
// any future settings) lives in a folder NEXT TO the app itself, never the Windows-default
// %APPDATA%. That is the defining difference from a normal browser: no history is ever recorded,
// and nothing is scattered across the OS profile, so the entire install (exe + its data) can be
// copied, moved, or deleted as one self-contained unit.
//
// In a packaged build, "next to the app" means next to the installed .exe (process.execPath).
// In dev (`npm start`, i.e. running through node_modules/electron.exe), process.execPath points
// at Electron's OWN binary buried in node_modules — not a meaningful location for user data — so
// dev instead uses a folder inside the project itself (git-ignored).
function portableDataDir() {
  if (app.isPackaged) {
    return path.join(path.dirname(process.execPath), "UserData");
  }
  return path.join(__dirname, "..", ".dev-userdata");
}

const TAB_BAR_HEIGHT = 104; // tab strip + address bar + bookmarks bar, see renderer/shell/shell.css
const DOWNLOAD_SHELF_HEIGHT = 48; // bottom strip, only present while the downloads list is non-empty
const MAX_TABS = 30;
const HOME_URL = "https://www.google.com/";

module.exports = {
  portableDataDir,
  TAB_BAR_HEIGHT,
  DOWNLOAD_SHELF_HEIGHT,
  MAX_TABS,
  HOME_URL,
};
