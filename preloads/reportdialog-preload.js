const { contextBridge, ipcRenderer } = require("electron");

// The report box (renderer/reportdialog): receives what to show, can ask for the send (with the note the user typed) and ask to be closed. Nothing else.
// (The main process accepts the send only from this box's own window.)
contextBridge.exposeInMainWorld("reportDialogAPI", {
  onInit: (cb) => ipcRenderer.on("reportdialog:init", (_e, info) => cb(info)),
  send: (note) => ipcRenderer.invoke("reportdialog:send", String(note == null ? "" : note)),
  saveFile: (note) => ipcRenderer.invoke("reportdialog:save", String(note == null ? "" : note)),
  fit: (height) => ipcRenderer.send("reportdialog:fit", Number(height) || 0),   // the box grew (a message appeared): the window follows its content
  close: () => ipcRenderer.send("reportdialog:close"),
});
