const fs = require("fs");
const path = require("path");
const { pathToFileURL, fileURLToPath } = require("url");
const state = require("./state");

// Links and files handed to PBCalc by ANOTHER program: PBCalc is a candidate in Windows' "Default apps", so Windows starts
// `PBCalc.exe <address-or-file>` for a clicked link / a double-clicked .html or .pdf. Chrome does the same: a new tab in the
// window that is already running (the single-instance lock in main.js forwards the second launch here), or - when PBCalc
// was not running - the first tab.

// Local files an outside program may ask for: what the user may hand PBCalc themselves (fileTypes.FROM_USER).
const LOCAL_OK = require("./fileTypes").FROM_USER;

// The first argument that is something we may open: an http(s) address, or a file that exists and is of an allowed type.
// Everything else (flags, the app folder Electron is started with, javascript:, ftp:, an .exe ...) is ignored.
function targetFromArgv(argv, cwd) {
  for (const a of (argv || []).slice(1)) {
    if (typeof a !== "string" || !a || a.startsWith("-")) continue;
    if (/^https?:\/\//i.test(a)) {
      try { return new URL(a).href; } catch (_) { continue; }
    }
    let file = null;
    if (/^file:\/\//i.test(a)) {
      try { file = fileURLToPath(a); } catch (_) { continue; }
    } else if (!/^[a-z][a-z0-9+.-]+:/i.test(a) || /^[a-z]:[\\/]/i.test(a)) {
      file = path.resolve(cwd || process.cwd(), a);   // a path (a Windows drive path also looks like "scheme:")
    }
    if (!file) continue;
    try {
      if (LOCAL_OK.has(path.extname(file).toLowerCase()) && fs.statSync(file).isFile()) return pathToFileURL(file).href;
    } catch (_) {}
  }
  return null;
}

function focusWindow() {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// first: PBCalc was just started with this address (the lone, untouched New Tab page makes room for it).
// Restricted Mode never opens anything from outside - the window is only brought forward.
function openFromOutside(argv, cwd, { first = false } = {}) {
  focusWindow();
  if (state.restricted) return false;
  const url = targetFromArgv(argv, cwd);
  if (!url) return false;
  const tm = require("./tabs/tabManager");
  const before = state.tabs.slice();
  tm.createTab(url);
  if (first && before.length === 1 && before[0].view && !before[0].view.webContents.isDestroyed() && /newtab\.html$/i.test(before[0].view.webContents.getURL())) {
    tm.closeTab(before[0].id);
  }
  return true;
}

module.exports = { targetFromArgv, openFromOutside, LOCAL_OK };
