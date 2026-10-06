const { BrowserView, app } = require("electron");
const path = require("path");
const state = require("./state");

// Popups (tab search, ⋮ menu, downloads, site info, find bubble) are drawn by a transparent
// BrowserView stacked ABOVE the page's BrowserView — a plain HTML dropdown inside the shell
// window would be hidden underneath the page view. Modal popups cover the whole window with a
// transparent backdrop, so a click anywhere outside closes them (Chrome behaviour). The find
// bubble instead gets exactly its own small rectangle, so the page underneath stays clickable.
//
// One popup at a time. The view is created on open and destroyed on close, so it costs nothing
// while closed.
let view = null;
let kind = null;
let anchor = null;
let autoTimer = null;
let partial = false;  // Chrome's compact bubble: the one that pops up by itself, no title or footer
let editBubble = null; // null = the Name+URL dialog; { added } = Chrome's star bubble
let editId = null;   // bookmark being edited in the "bookmark-edit" box
let hovered = false; // the mouse entered the downloads bubble: never dismiss it from under them

const FIND_W = 380;
const FIND_H = 48;

const tabManager = () => require("./tabs/tabManager");
const downloads = () => require("./downloads/downloadManager");
const bookmarks = () => require("./bookmarks/bookmarkStore");

function alive() {
  return !!view && !view.webContents.isDestroyed();
}

function isSender(wc) {
  return alive() && wc === view.webContents;
}

function isOpen(k) {
  return alive() && (k == null || kind === k);
}

function contentSize() {
  return state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow.getContentSize() : [1200, 800];
}

function bounds() {
  const [w, h] = contentSize();
  if (kind === "find") {
    return { x: Math.max(0, w - FIND_W - 16), y: tabManager().chromeHeight() - 1, width: FIND_W, height: FIND_H };
  }
  return { x: 0, y: 0, width: w, height: h };
}

// Where a shortcut-opened popup appears when there is no button rect to anchor to.
function defaultAnchor(k) {
  const [w] = contentSize();
  if (k === "tabsearch") return { left: 8, right: 36, top: 6, bottom: 38 };
  if (k === "siteinfo") return { left: 100, right: 130, top: 44, bottom: 76 };
  if (k === "bookmark-edit") return { left: Math.round(w / 2 - 190), right: Math.round(w / 2 + 190), top: 0, bottom: tabManager().chromeHeight() };
  return { left: w - 44, right: w - 12, top: 44, bottom: 76 }; // menu / downloads
}

function siteInfo(tab) {
  if (!tab) return null;
  let host = "";
  try { host = new URL(tab.url).host; } catch (_) {}
  return { host: host || tab.url, url: tab.url, siteKind: tabManager().siteKind(tab) };
}

function zoomPercent() {
  const t = tabManager().getActiveTab();
  if (!t || t.view.webContents.isDestroyed()) return 100;
  return Math.round(Math.pow(1.2, t.view.webContents.getZoomLevel()) * 100);
}

function buildData() {
  const tm = tabManager();
  const s = tm.getTabState();
  const data = { kind, anchor };
  if (kind === "tabsearch") {
    data.tabs = s.tabs.map((t) => {
      let host = "";
      try { host = new URL(t.url).host; } catch (_) {}
      return { id: t.id, title: t.title, host: host || t.url, favicon: t.favicon, active: t.id === s.activeTabId };
    });
  } else if (kind === "menu") {
    data.restricted = !!state.restricted;
    data.zoom = zoomPercent();
    data.bookmarksBar = state.bookmarksBarVisible;
    data.fullscreen = !!(state.mainWindow && state.mainWindow.isFullScreen());
    const t = tm.getActiveTab();
    data.canBookmark = !!t && bookmarks().isBookmarkable(t.url);
  } else if (kind === "downloads") {
    data.items = downloads().publicList();
    data.partial = partial;
  } else if (kind === "siteinfo") {
    data.site = siteInfo(tm.getActiveTab());
  } else if (kind === "bookmark-edit") {
    const b = bookmarks().list().find((x) => x.id === editId);
    data.bookmark = b ? { id: b.id, title: b.title, url: b.url, favicon: b.favicon } : null;
    data.bubble = editBubble;
  }
  return data;
}

function close() {
  clearTimeout(autoTimer);
  autoTimer = null;
  hovered = false;
  partial = false;
  zoomClicks = [];
  editId = null;
  editBubble = null;
  if (!view) return;
  const v = view;
  view = null;
  kind = null;
  anchor = null;
  try {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.removeBrowserView(v);
  } catch (_) {}
  try {
    if (!v.webContents.isDestroyed()) v.webContents.destroy();
  } catch (_) {}
  // Give keyboard focus back to the page.
  const t = tabManager().getActiveTab();
  if (t && !t.view.webContents.isDestroyed()) {
    try { t.view.webContents.focus(); } catch (_) {}
  }
}

// opts.autoCloseMs: dismiss by itself unless the mouse enters it (downloads bubble).
// Popups that exist in Restricted Mode: the ⋮ menu (ordinary browser settings only), downloads,
// find, and the admin panel (which only exists there, and only the hidden shortcut opens it).
// Tab search and site info stay out: they would list addresses.
const RESTRICTED_KINDS = new Set(["menu", "downloads", "find", "unlock"]);
// Menu actions a locked-down user may use. Everything that edits bookmarks, shows the bookmark
// manager, opens developer tools or turns the bookmarks bar off is refused here, and the menu page
// does not even draw those entries.
const RESTRICTED_ACTIONS = new Set([
  "close", "hover", "dl-open", "dl-show", "dl-cancel", "dl-pause", "dl-retry", "dl-dismiss", "find-text", "find-close",
  "print", "zoom", "zoom-reset", "new-tab", "fullscreen", "settings", "downloads", "downloads-page", "find", "exit",
  "toggle-bookmarks-bar", // a view preference only: it edits no bookmark and shows no address
]);

function open(k, rect, opts = {}) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  if (state.restricted && !RESTRICTED_KINDS.has(k)) return;
  if (!state.restricted && k === "unlock") return;
  if (k === "find" && isOpen("find")) {
    // Ctrl+F again: just put the caret back in the find box.
    view.webContents.focus();
    try { view.webContents.send("popup:find-focus"); } catch (_) {}
    return;
  }
  if (isOpen(k)) return close(); // second click on the same button closes it
  if (isOpen()) close();

  require("./hovercard").hide();
  require("./omnibox").hide();
  kind = k;
  editId = k === "bookmark-edit" ? String(opts.bookmarkId || "") : null;
  editBubble = k === "bookmark-edit" && opts.bubble ? { added: !!opts.added } : null;
  partial = !!opts.partial;
  anchor = rect || defaultAnchor(k);
  view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "preloads", "popup-preload.js"),
    },
  });
  view.setBackgroundColor("#00000000");
  require("./shortcuts").attachShortcuts(view.webContents);
  state.mainWindow.addBrowserView(view); // added last = on top of the page view
  view.setBounds(bounds());
  view.webContents.loadFile(path.join(__dirname, "..", "renderer", "popup", "popup.html"));
  view.webContents.once("did-finish-load", () => {
    if (alive()) view.webContents.focus();
  });
  if (opts.autoCloseMs) autoTimer = setTimeout(close, opts.autoCloseMs);
}

// Chrome's bubble stays up while a download runs and closes a few seconds after the last one is
// done — unless the mouse went into it, in which case it waits for the user.
function autoCloseDownloads(ms) {
  // Only the bubble that opened BY ITSELF dismisses itself; one the user opened stays until they
  // click away, as in Chrome.
  if (!isOpen("downloads") || !partial || hovered) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(close, ms);
}

// Page-side data + first render request.
function getData() {
  return alive() ? buildData() : null;
}

// Push fresh data to an open popup (tabs / downloads / zoom changed).
function refresh() {
  if (!alive() || kind === "find") return;
  try { view.webContents.send("popup:data", buildData()); } catch (_) {}
}

function sendFindResult(result) {
  if (isOpen("find")) {
    try { view.webContents.send("popup:find-result", result); } catch (_) {}
  }
}

function reposition() {
  if (!alive()) return;
  if (kind === "find") { view.setBounds(bounds()); return; }
  // Modal popups close on resize, like Chrome's menus. NOT synchronously: this runs inside the
  // window's own "resize" emit, and Electron's per-view autoResize listener for THIS view is still
  // queued behind us — destroying the view now makes it throw "#autoResize called without owner
  // window" (an uncaught-exception dialog when the resize was a fullscreen toggle).
  setImmediate(() => { if (alive() && kind !== "find") close(); });
}

// Save from the "bookmark-edit" box. Main process decides: it re-checks Restricted Mode itself, so even a popup page
// that somehow existed there could not edit anything.
function saveBookmark(title, url) {
  if (state.restricted || !isOpen("bookmark-edit") || !editId) return { ok: false, error: "unavailable" };
  const fields = { title: String(title == null ? "" : title) };
  if (url != null) fields.url = String(url);   // the star bubble edits the name only
  const r = bookmarks().update(editId, fields);
  if (!r.ok) return { ok: false, error: r.error };
  tabManager().broadcastBookmarks();
  close();
  return { ok: true };
}

// "Remove" in the star bubble.
function removeBookmark() {
  if (state.restricted || !isOpen("bookmark-edit") || !editId) return { ok: false, error: "unavailable" };
  bookmarks().remove(editId);
  tabManager().broadcastBookmarks();
  close();
  return { ok: true };
}

// The hidden bookmark-list switch: three clicks on the "100%" in the menu within 2 seconds, in ONE menu session (closing
// the menu forgets the count). Counted here, in the main process; works in Restricted Mode as well. When the third click
// switches the list (either way) the menu closes at once.
const SWITCH_CLICKS = 3, SWITCH_WINDOW_MS = 2000;
let zoomClicks = [];
function countZoomClick() {
  const now = Date.now();
  zoomClicks = zoomClicks.filter((t) => now - t < SWITCH_WINDOW_MS);
  zoomClicks.push(now);
  if (zoomClicks.length < SWITCH_CLICKS) return;
  zoomClicks = [];
  if (tabManager().toggleBookmarkMode()) close();
}

function handleAction(name, arg) {
  if (state.restricted && !RESTRICTED_ACTIONS.has(name)) return;
  const tm = tabManager();
  switch (name) {
    case "close": return close();
    case "hover": hovered = true; clearTimeout(autoTimer); autoTimer = null; return;

    case "activate-tab": close(); return tm.switchTab(arg);
    case "close-tab": tm.closeTab(arg); return refresh();
    case "new-tab":
      close();
      // Restricted Mode: a new tab is the "Your sites" tiles page, and there is no address bar.
      if (state.restricted) return tm.createTab(undefined, { allowRestricted: true });
      tm.createTab();
      return tm.focusAddressBar();

    case "toggle-bookmarks-bar": tm.toggleBookmarksBar(); return refresh();
    case "bookmark-active": close(); return tm.toggleBookmarkActive();
    case "zoom": tm.zoom(arg); return refresh();
    case "zoom-reset": tm.zoom(0); countZoomClick(); return refresh();   // the "100%" button: Reset zoom (+ the hidden switch)
    case "fullscreen":
      close();
      state.mainWindow.setFullScreen(!state.mainWindow.isFullScreen());
      return;
    case "print": close(); return tm.printActive();
    case "find": close(); return tm.openFind();
    case "devtools": close(); return tm.openDevTools();
    case "downloads": close(); return tm.openDownloadsPage();
    case "downloads-page": close(); return tm.openDownloadsPage();
    case "settings": close(); return tm.openSettings();
    case "bookmark-manager": close(); return tm.openManager();
    case "exit": close(); return app.quit();

    case "dl-open": return downloads().open(arg);
    case "dl-show": return downloads().showInFolder(arg);
    case "dl-cancel": return downloads().cancel(arg);
    case "dl-pause": return downloads().togglePause(arg);
    case "dl-retry": return downloads().retry(arg);
    case "dl-dismiss": downloads().dismiss(arg); return refresh();

    case "find-text": return tm.findText(arg && arg.text, arg && arg.opts);
    case "find-close": return tm.closeFind();
  }
}

module.exports = { open, autoCloseDownloads, close, isOpen, isSender, getData, refresh, sendFindResult, reposition, handleAction, saveBookmark, removeBookmark };
