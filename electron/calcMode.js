const { app } = require("electron");
const state = require("./state");
const settings = require("./settings");

// The calculator screen (renderer/calc) is the first thing PBCalc shows when the owner chose "start on the calculator screen" at install
// (settings.json -> calculatorStart, written from the installer's answer by installChoices.js). While it shows, NO browser tab exists and
// nothing of the browser is on screen:
//   * five quick presses of the gray "+" button (counted HERE, so the page cannot fake it) open the browser (a New Tab page, 100 % zoom);
//   * when the browser is closed - the last tab closed, or the window's X - the calculator comes back instead of the app quitting: every
//     tab is closed, the session (cookies, cache, ...) is wiped like at quit, and the closed-tab list is forgotten. The calculator's own X
//     (and the menu's Exit) quit as usual.
const PLUS_NEEDED = 5;
const PLUS_GAP_MS = 1500;       // presses further apart than this start a new count
let plusCount = 0, lastPlus = 0;

const enabled = () => settings.get("calculatorStart") === true;

function toShell(channel, ...args) {
  try { if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.webContents.send(channel, ...args); } catch (_) {}
}

function quietChrome() {
  try { require("./popup").close(); } catch (_) {}
  try { require("./hovercard").hide(); } catch (_) {}
  try { require("./omnibox").hide(); } catch (_) {}
  state.findOpen = false;
}

// show the calculator (nothing else is on screen)
function enter() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.calcMode = true;
  plusCount = 0;
  quietChrome();
  require("./theme").setCalc(true, state.mainWindow);
  toShell("calc:mode", true);
  try { state.mainWindow.webContents.focus(); } catch (_) {}
}

// the browser opens (a New Tab page, or the Restricted Mode home, at 100 % zoom)
function leave() {
  if (!state.calcMode || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.calcMode = false;
  require("./theme").setCalc(false, state.mainWindow);
  toShell("calc:mode", false);
  const tm = require("./tabs/tabManager");
  tm.createTab(undefined, { allowRestricted: true, fromCalc: true });
  setImmediate(tm.resizeActiveView);
  setTimeout(tm.resizeActiveView, 150);
}

// the gray "+" was pressed
function onPlus() {
  const now = Date.now();
  if (now - lastPlus > PLUS_GAP_MS) plusCount = 0;
  lastPlus = now;
  plusCount++;
  if (plusCount >= PLUS_NEEDED) { plusCount = 0; leave(); }
}

// the browser was closed: back to the calculator, with nothing of the browsing left behind
async function returnToCalc() {
  if (state.returningToCalc || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.returningToCalc = true;
  try {
    const tm = require("./tabs/tabManager");
    for (const t of state.tabs.slice()) tm.closeTab(t.id);       // the last close asks the window to close: onWindowClose refuses while returning
    tm.forgetClosedTabs();
    try { await require("./privacy").clearSession(); } catch (_) {}
    enter();
    // an update the user postponed ("Cancel" in the update popup) goes in now: the browser is closed, there is nothing left to lose
    try { require("./updater").installIfPending(); } catch (_) {}
  } finally { state.returningToCalc = false; }
}

// 'close' of the main window (the X, Alt+F4, or the last tab closing)
function onWindowClose(e) {
  if (state.quitting) return;                                    // a real quit (menu Exit, installer, shutdown)
  if (state.returningToCalc) { e.preventDefault(); return; }
  if (enabled() && !state.calcMode) { e.preventDefault(); returnToCalc(); }
}

function install() {
  app.on("before-quit", () => { state.quitting = true; });
}

module.exports = { enabled, enter, leave, onPlus, returnToCalc, onWindowClose, install };
