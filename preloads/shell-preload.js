const { contextBridge, ipcRenderer } = require("electron");

// Narrow bridge for the shell chrome (tab strip + address bar) only — it can drive tab
// creation/navigation and read tab state, nothing more. The vault bridge is deliberately
// separate (tab-preload.js) and is never exposed here.
contextBridge.exposeInMainWorld("browserAPI", {
  getState: () => ipcRenderer.invoke("tabs:get-state"),
  newTab: (url) => ipcRenderer.invoke("tabs:new", url),
  switchTab: (id) => ipcRenderer.invoke("tabs:switch", id),
  closeTab: (id) => ipcRenderer.invoke("tabs:close", id),
  navigate: (url) => ipcRenderer.send("tabs:navigate", url),
  back: () => ipcRenderer.send("tabs:back"),
  forward: () => ipcRenderer.send("tabs:forward"),
  reload: () => ipcRenderer.send("tabs:reload"),
  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke("bookmarks:list"),
  toggleBookmark: () => ipcRenderer.invoke("bookmarks:toggle-active"),
  removeBookmark: (id) => ipcRenderer.invoke("bookmarks:remove", id),
  onBookmarksChanged: (callback) => {
    const listener = (_event, list) => callback(list);
    ipcRenderer.on("bookmarks:changed", listener);
    return () => ipcRenderer.removeListener("bookmarks:changed", listener);
  },
  // Downloads — referred to by id only, never by path
  getDownloads: () => ipcRenderer.invoke("downloads:get"),
  cancelDownload: (id) => ipcRenderer.send("downloads:cancel", id),
  openDownload: (id) => ipcRenderer.send("downloads:open", id),
  showDownload: (id) => ipcRenderer.send("downloads:show", id),
  dismissDownload: (id) => ipcRenderer.send("downloads:dismiss", id),
  onDownloadsChanged: (callback) => {
    const listener = (_event, list) => callback(list);
    ipcRenderer.on("downloads:changed", listener);
    return () => ipcRenderer.removeListener("downloads:changed", listener);
  },
  onTabsChanged: (callback) => {
    const listener = (_event, tabState) => callback(tabState);
    ipcRenderer.on("tabs:changed", listener);
    return () => ipcRenderer.removeListener("tabs:changed", listener);
  },
});
