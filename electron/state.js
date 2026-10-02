// Single mutable module-level state object, shared by every main-process module — same pattern
// as the ERP shell this project split off from. No store/reducer layer; modules require this
// directly and read/write it.
module.exports = {
  mainWindow: null,

  // { id, view (BrowserView), title, url }
  tabs: [],
  activeTabId: null,
  nextTabId: 1,

  // Duplicate tab: the source tab's sessionStorage, waiting for the copy's preload to pick it up.
  // Keyed by the NEW view's webContents.id, served exactly once, and only to that webContents on
  // the matching origin (see "tabs:session-restore"). sessionStorage is per tab, so without this a
  // duplicated tab loses a login the site kept there — Chrome's Duplicate clones it.
  pendingSessionRestore: new Map(),

  // Find-in-page bubble open? (the bubble itself is a popup overlay, see electron/popup.js)
  findOpen: false,
  // Bookmarks bar visible (Ctrl+Shift+B); loaded from settings.json at startup.
  bookmarksBarVisible: true,
  // Restricted Mode on? (see electron/restricted.js) Loaded from settings.json at startup.
  restricted: false,
  // Restricted Mode admin session: id of the bookmark-manager tab opened after a PIN check (null =
  // none). Only that tab may edit the preset list; closing it ends the session.
  adminTabId: null,
};
