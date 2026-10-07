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
  reloadMenu: (rect) => ipcRenderer.invoke("tabs:reload-menu", rect),
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
  moveBookmark: (id, index) => ipcRenderer.send("bookmarks:move", id, index),
  bookmarkContextMenu: (id) => ipcRenderer.send("bookmarks:context-menu", id),
  onBookmarksChanged: (cb) => on("bookmarks:changed", cb),

  // Downloads — only the list (for the toolbar button); actions live in the popup
  getDownloads: () => ipcRenderer.invoke("downloads:get"),
  onDownloadsChanged: (cb) => on("downloads:changed", cb),
  // A file drag from Explorer is over a PAGE (the tab preload tells main, main tells us): the tab strip must stop being an OS
  // drag region meanwhile, or the drop is refused there.
  onFileDrag: (cb) => on("files:drag-state", cb),
});

// ── Files dragged in from Explorer ──────────────────────────────────────────────────────────────────────────────────────
// Without this a dropped file either bounced off ("not allowed" sign over the tab strip and toolbar) or made Chromium navigate THIS page to
// the file. A page that handles the drop itself (an upload box calls preventDefault) keeps it; otherwise the file's real path
// (webUtils: only a genuine drag from the OS has one, a file a page makes up gets "") goes to the main process, which opens it
// in a new tab (electron/dropFiles.js). Only trusted events count.
(() => {
  const { webUtils } = require("electron");
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  window.addEventListener("dragover", (e) => {
    if (!e.isTrusted || e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("drop", (e) => {
    if (!e.isTrusted || e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();   // never let Chromium navigate this page to the file
    const paths = [];
    for (const f of Array.from(e.dataTransfer.files || [])) {
      try { const p = webUtils.getPathForFile(f); if (p) paths.push(p); } catch (_) {}
    }
    // where in the tab strip it was dropped (renderer/shell/shell.js writes the slot at the moment of the drop), if it was
    const at = parseInt(document.documentElement.dataset.dropIndex, 10);
    if (paths.length) ipcRenderer.send("files:dropped", paths.slice(0, 10), Number.isInteger(at) && at >= 0 ? at : null);
  });
})();

