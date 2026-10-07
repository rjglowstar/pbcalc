const { BrowserView } = require("electron");
const path = require("path");
const state = require("./state");

// Chrome's tab hover card: hover a tab and a small card appears just below it with the page title,
// the site name and a preview thumbnail. It is a transparent BrowserView stacked above the page view
// (an HTML element inside the shell would be hidden behind it), sized exactly to the card, and
// it only ever exists for a moment: hidden (removed from the window) the instant the mouse leaves
// the tab, and destroyed after 30 idle seconds so it costs nothing while unused.
//
// The preview thumbnails are plain in-memory JPEGs kept on the tab object (see captureThumb in
// tabs/tabManager.js) — never written to disk, gone when the tab closes or the browser quits.
const CARD_W = 268; // card 256 + 6px margin each side for the shadow
const H_NO_THUMB = 66;
const H_THUMB = 214;
const TAB_STRIP_BOTTOM = 42; // the card starts just under the tab strip

let view = null;
let shown = false;
let idleTimer = null;
let token = 0; // invalidates a show() that was overtaken by a hide()
let lastData = null;

const tabManager = () => require("./tabs/tabManager");

function alive() {
  return !!view && !view.webContents.isDestroyed();
}

function ensureView() {
  if (alive()) return;
  view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "preloads", "hovercard-preload.js"),
    },
  });
  view.setBackgroundColor("#00000000");
  view.webContents.loadFile(path.join(__dirname, "..", "renderer", "hovercard", "hovercard.html"));
  view.webContents.on("did-finish-load", () => {
    if (lastData && alive()) view.webContents.send("card:data", lastData);
  });
}

function destroyView() {
  clearTimeout(idleTimer);
  if (!view) return;
  const v = view;
  view = null;
  shown = false;
  try { if (state.mainWindow && !state.mainWindow.isDestroyed()) require("./viewHost").detach(state.mainWindow, v); } catch (_) {}
  try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch (_) {}
}

function hide() {
  token += 1;
  clearTimeout(idleTimer);
  if (alive() && shown) {
    try { require("./viewHost").detach(state.mainWindow, view); } catch (_) {}
  }
  shown = false;
  if (alive()) idleTimer = setTimeout(destroyView, 30000);
}

// rect = the hovered tab's box in window coordinates.
async function show(tabId, rect) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  const my = ++token;
  const info = await tabManager().hoverInfo(tabId);
  if (my !== token || !info) return; // hidden again (or the tab vanished) while we were capturing

  clearTimeout(idleTimer);
  ensureView();
  lastData = info;
  const [w] = state.mainWindow.getContentSize();
  const x = Math.max(0, Math.min(Math.round(rect.left), w - CARD_W));
  view.setBounds({ x, y: TAB_STRIP_BOTTOM, width: CARD_W, height: info.thumb ? H_THUMB : H_NO_THUMB });
  if (!shown) {
    require("./viewHost").attach(state.mainWindow, view); // added last = on top of the page view
    shown = true;
  }
  if (!view.webContents.isLoading()) view.webContents.send("card:data", info);
}

function isOpen() {
  return alive() && shown;
}

module.exports = { show, hide, isOpen, destroyView };
