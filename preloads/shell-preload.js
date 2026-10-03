const { contextBridge, ipcRenderer } = require("electron");

// Narrow bridge for the shell chrome (tab strip + toolbar + bookmarks bar) only — it can drive tab
// creation/navigation, open the popups, and read tab / bookmark / download state, nothing more.
// The vault bridge is deliberately separate (tab-preload.js) and is never exposed here.
const on = (channel, callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("browserAPI", {
  // Tabs
  getState: () => ipcRenderer.invoke("tabs:get-state"),
  newTab: (url) => ipcRenderer.invoke("tabs:new", url),
  switchTab: (id) => ipcRenderer.invoke("tabs:switch", id),
  closeTab: (id) => ipcRenderer.invoke("tabs:close", id),
  moveTab: (id, index) => ipcRenderer.send("tabs:move", id, index),
  tabContextMenu: (id) => ipcRenderer.send("tabs:context-menu", id),
  navigate: (url) => ipcRenderer.send("tabs:navigate", url),
  back: () => ipcRenderer.send("tabs:back"),
  forward: () => ipcRenderer.send("tabs:forward"),
  reload: () => ipcRenderer.send("tabs:reload"),
  stop: () => ipcRenderer.send("tabs:stop"),
  // address-bar suggestions
  omniboxQuery: (text, rect) => ipcRenderer.send("omnibox:query", text, rect),
  omniboxMove: (dir) => ipcRenderer.invoke("omnibox:move", dir),
  omniboxAccept: (text) => ipcRenderer.send("omnibox:accept", text),
  omniboxClose: () => ipcRenderer.send("omnibox:close"),
  omniboxWarm: () => ipcRenderer.send("omnibox:warm"),
  showHoverCard: (tabId, rect) => ipcRenderer.send("hovercard:show", tabId, rect),
  hideHoverCard: () => ipcRenderer.send("hovercard:hide"),
  resetZoom: () => ipcRenderer.send("tabs:reset-zoom"),
  onTabsChanged: (cb) => on("tabs:changed", cb),
  onFocusUrl: (cb) => on("shell:focus-url", () => cb()),
  onFullscreenChanged: (cb) => on("fullscreen:changed", cb),

  // Popups (tab search, menu, downloads, site info): the rect is the anchor button's box.
  openPopup: (kind, rect) => ipcRenderer.send("popup:open", kind, rect),

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke("bookmarks:list"),
  toggleBookmark: () => ipcRenderer.invoke("bookmarks:toggle-active"),
  openBookmark: (id, newTab) => ipcRenderer.send("bookmarks:open", id, newTab),
  bookmarkContextMenu: (id) => ipcRenderer.send("bookmarks:context-menu", id),
  onBookmarksChanged: (cb) => on("bookmarks:changed", cb),

  // Downloads — only the list (for the toolbar button); actions live in the popup
  getDownloads: () => ipcRenderer.invoke("downloads:get"),
  onDownloadsChanged: (cb) => on("downloads:changed", cb),
});
