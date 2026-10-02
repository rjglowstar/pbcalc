const { contextBridge, ipcRenderer } = require("electron");

// Bridge for the popup overlay page only (renderer/popup). It loads a local file we ship, never a
// website, so it may act on tabs — but the surface is still one narrow action channel: the main
// process (electron/popup.js handleAction) decides what each named action does.
contextBridge.exposeInMainWorld("popupAPI", {
  getData: () => ipcRenderer.invoke("popup:get-data"),
  action: (name, arg) => ipcRenderer.send("popup:action", name, arg),
  admin: (mode) => ipcRenderer.invoke("popup:admin", mode),
  onData: (cb) => { ipcRenderer.on("popup:data", (_e, d) => cb(d)); },
  onFindResult: (cb) => { ipcRenderer.on("popup:find-result", (_e, r) => cb(r)); },
  onFindFocus: (cb) => { ipcRenderer.on("popup:find-focus", () => cb()); },
});
