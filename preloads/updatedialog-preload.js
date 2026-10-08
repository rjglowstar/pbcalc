const { contextBridge, ipcRenderer } = require("electron");

// The update dialog (renderer/updatedialog) can receive the two version numbers and send back ONE answer: update (true) or cancel (false).
// Nothing else. (The main process accepts the answer only from this dialog's own window.)
contextBridge.exposeInMainWorld("updateDialogAPI", {
  onInit: (cb) => ipcRenderer.on("updatedialog:init", (_e, info) => cb(info)),
  answer: (yes) => ipcRenderer.send("updatedialog:answer", yes === true),
});
