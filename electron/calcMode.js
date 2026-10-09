const { app } = require("electron");
const state = require("./state");
const settings = require("./settings");

// The calculator screen (renderer/calc) is the first thing PBCalc shows when the owner chose "start on the calculator screen" at install
// (settings.json -> calculatorStart, written from the installer's answer by installChoices.js). While it shows, NO browser tab exists and
// nothing of the browser is on screen:
//   * five quick presses of the gray "+" button (counted HERE, so the page cannot fake it) open the browser (a New Tab page, 100 % zoom);
//   * the calculator is then GONE for good (its page is emptied and its data released): closing the browser - the last tab, or the window's X - simply
//     quits PBCalc, like any browser, and the session is wiped by the quit (privacy.js). The calculator comes up again only at the NEXT start
//     of PBCalc. (An earlier version returned to a fresh calculator instead of quitting; the owner did not want that.)
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

function install() {
  app.on("before-quit", () => { state.quitting = true; });
}

module.exports = { enabled, enter, leave, onPlus, install };
