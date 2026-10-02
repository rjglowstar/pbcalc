const { contextBridge, ipcRenderer } = require("electron");

// Bridge for the address-bar suggestion dropdown page (renderer/omnibox): it can receive the rows
// the main process computed and report which row was clicked — nothing else.
contextBridge.exposeInMainWorld("omniboxAPI", {
  onData: (cb) => { ipcRenderer.on("omnibox:data", (_e, d) => cb(d)); },
  pick: (index) => ipcRenderer.send("omnibox:pick", index),
});
