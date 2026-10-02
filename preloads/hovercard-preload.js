const { contextBridge, ipcRenderer } = require("electron");

// Receive-only bridge for the tab hover card page (renderer/hovercard): it can show what the main
// process sends and nothing else.
contextBridge.exposeInMainWorld("cardAPI", {
  onData: (cb) => { ipcRenderer.on("card:data", (_e, data) => cb(data)); },
});
