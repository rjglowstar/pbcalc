// Chrome's "download started" animation: a circled download arrow rises from the middle of the page to
// the toolbar Downloads button, so you can SEE that the download began (a file going to the Downloads
// folder with no dialog otherwise gives no sign at all).
//
// Measured from a real Chrome (scripts/chrome-reference/capture-dlanim.ps1 + README): 64px circle, centred
// on the button's column, starting ~46.5% of the way down the page, rising for ~500ms. The motion itself
// lives in renderer/dlanim/dlanim.js; this file decides WHEN, WHERE, and keeps the view tidy.
//
// How it is drawn: the shell sits UNDER the page views, so the animation cannot live in the shell; it is
// a small transparent BrowserView (same technique as the hover card) that is attached to the window only
// while the flight lasts and then taken off again. The view is created once and kept warm, so the first
// download does not wait for a page load before anything moves. While attached it covers an 80px-wide
// column, so a click in that column during the half second goes to it, not to the page below — Chrome's
// animation is click-through, an Electron BrowserView cannot be.
const { BrowserView, nativeTheme } = require("electron");
const path = require("path");
const state = require("./state");

const VIEW_W = 80;                 // 64px circle + 8px each side
const START_FRACTION = 0.465;      // measured: the flight starts ~46.5% of the way down the page area
const FLIGHT_MS = 520;             // keep in step with DURATION in renderer/dlanim/dlanim.js
const REMOVE_AFTER_MS = FLIGHT_MS + 120;

let view = null;
let loaded = null;                 // resolves true once the animation page has loaded
let attached = false;
let timer = null;
let token = 0;                     // a newer play() (or hide()) invalidates an older one
let lastGeometry = null;           // what the last flight was aimed at (the tests compare it with the shell)

const tabManager = () => require("./tabs/tabManager");

function alive() {
  return !!view && !view.webContents.isDestroyed();
}

function ensureView() {
  if (alive()) return loaded;
  view = new BrowserView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  view.setBackgroundColor("#00000000");
  require("./lockdown").lock(view.webContents);
  attached = false;
  loaded = new Promise((resolve) => {
    view.webContents.once("did-finish-load", () => resolve(true));
    view.webContents.once("did-fail-load", () => resolve(false));
  });
  view.webContents.loadFile(path.join(__dirname, "..", "renderer", "dlanim", "dlanim.html"));
  return loaded;
}

// Create the view ahead of the first download (called once the window exists).
function warm() {
  try { ensureView(); } catch (_) {}
}

function detach() {
  clearTimeout(timer);
  if (alive() && attached) {
    try { if (state.mainWindow && !state.mainWindow.isDestroyed()) require("./viewHost").detach(state.mainWindow, view); } catch (_) {}
  }
  attached = false;
}

// Where the Downloads button really is (window coordinates), read from the shell's DOM. The shell lays
// its toolbar out with flexbox, so this is not a constant. Falls back to the popups' default anchor.
async function buttonCenter(win) {
  try {
    const r = await win.webContents.executeJavaScript(
      '(() => { const b = document.getElementById("downloads"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()',
    );
    if (r && r.w > 0) return r;
  } catch (_) {}
  const [w] = win.getContentSize();
  return { x: w - 28, y: 60 };
}

// Play the flight. Resolves true if it started (the tests wait on that), false if it was skipped.
async function play() {
  const win = state.mainWindow;
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFullScreen()) return false;
  const my = ++token;
  clearTimeout(timer);
  const ready = await ensureView();
  if (!ready || my !== token || !alive()) return false;
  const btn = await buttonCenter(win);
  if (my !== token || !alive() || win.isDestroyed()) return false;

  const [w, h] = win.getContentSize();
  const chromeH = tabManager().chromeHeight();
  const endY = btn.y;                                             // the circle ends on the button's centre
  const startY = chromeH + START_FRACTION * Math.max(0, h - chromeH);
  if (startY - endY < 60) return false;                           // a window too short to fly anywhere

  const viewX = Math.max(0, Math.min(w - VIEW_W, Math.round(btn.x - VIEW_W / 2)));
  const viewY = Math.max(0, Math.round(endY - 40));
  const viewH = Math.round(startY + 40 - viewY);
  lastGeometry = { startY, endY, contentW: w, contentH: h, chromeH, btnX: btn.x, btnY: btn.y, viewX, viewY, viewH };
  view.setBounds({ x: viewX, y: viewY, width: VIEW_W, height: viewH });
  if (!attached) {
    try { require("./viewHost").attach(win, view); attached = true; } catch (_) { return false; }
  }
  try {
    await view.webContents.executeJavaScript("window.__start(" + JSON.stringify({
      dark: nativeTheme.shouldUseDarkColors,
      fromY: startY - viewY,
      toY: endY - viewY,
    }) + ")");
  } catch (_) {
    detach();
    return false;
  }
  if (my === token) timer = setTimeout(detach, REMOVE_AFTER_MS);
  return true;
}

// Called by the download manager when a download starts in `initiator` (a webContents, or null for a
// download the app itself started, e.g. Retry — no flight for those).
function playFor(initiator) {
  if (!initiator) return Promise.resolve(false);
  const tab = state.tabs.find((t) => t.view.webContents === initiator);
  if (tab && tab.id !== state.activeTabId) {
    // started by a tab you are not looking at: Chrome shows nothing. The exception is a tab opened just
    // for the download (nothing ever shown in it), which is the one on screen a moment ago and is about
    // to close itself (tabManager.closeTabOpenedForDownload).
    let shown = "";
    try { shown = initiator.getURL(); } catch (_) {}
    if (shown && shown !== "about:blank") return Promise.resolve(false);
  }
  return play().catch(() => false);
}

function isPlaying() {
  return attached;
}

module.exports = { play, playFor, warm, detach, isPlaying, lastGeometry: () => lastGeometry };
