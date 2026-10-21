const { contextBridge, ipcRenderer } = require("electron");

// Bridge for the print-preview dialog only (renderer/printpreview, a local file we ship). Main (electron/printPreview.js) accepts these
// channels only from that dialog's own view and decides everything; the page can only ask for a preview, start the job, or close.
contextBridge.exposeInMainWorld("printAPI", {
  init: () => ipcRenderer.invoke("print:init"),
  preview: (settings) => ipcRenderer.invoke("print:preview", settings),
  go: (settings, moreOpen) => ipcRenderer.invoke("print:go", settings, moreOpen),
  sticky: (settings, moreOpen) => ipcRenderer.invoke("print:sticky", settings, moreOpen),
  system: () => ipcRenderer.invoke("print:system"),
  close: () => ipcRenderer.send("print:close"),
  // the real per-printer caps, pushed in once the ~2-3s PowerShell enumeration finishes - init() itself
  // never waits for this (see the BUG comment on print:init in electron/printPreview.js)
  onCapsUpdated: (cb) => ipcRenderer.on("print:caps-updated", (_e, data) => cb(data)),
});
