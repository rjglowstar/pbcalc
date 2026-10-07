const fs = require("fs");
const path = require("path");
const state = require("./state");

// Files dragged in from Explorer and dropped on the PBCalc window (the tab strip, the toolbar, the bookmarks bar or a page).
// Chrome opens them; so does PBCalc, in a NEW TAB each, in normal AND Restricted Mode (the owner's decision).
// The preloads (shell-preload.js / tab-preload.js) catch the drop, ask Electron's webUtils for each file's real path - only a
// genuine drag from the OS has one; a file a web page invents gets "" - and send the paths here. A page that handles the drop
// itself (an upload box) keeps it: the preload ignores a drop the page already took.
const MAX_FILES = 10;

// Who may send us dropped paths: the shell window or one of the tab pages. (Popups and anything else: no.)
function isOurPage(wc) {
  try {
    if (state.mainWindow && !state.mainWindow.isDestroyed() && wc === state.mainWindow.webContents) return true;
    return state.tabs.some((t) => t.view && t.view.webContents === wc);
  } catch (_) { return false; }
}

// Opens every path that is an existing file of a type PBCalc can show (fileTypes.FROM_USER). Returns how many tabs opened.
// `at` = the tab-strip slot it was dropped on (0..number of tabs); without it the tabs go to the end.
function openDropped(paths, at) {
  if (!Array.isArray(paths)) return 0;
  const { FROM_USER } = require("./fileTypes");
  const tm = require("./tabs/tabManager");
  let opened = 0;
  const slot = Number.isInteger(at) && at >= 0 && at <= state.tabs.length ? at : null;
  for (const p of paths.slice(0, MAX_FILES)) {
    if (typeof p !== "string" || !path.isAbsolute(p)) continue;
    try {
      if (!FROM_USER.has(path.extname(p).toLowerCase()) || !fs.statSync(p).isFile()) continue;
      tm.openLocalFile(p, slot === null ? {} : { index: slot + opened });
      opened++;
    } catch (_) {}
  }
  return opened;
}

module.exports = { isOurPage, openDropped };
