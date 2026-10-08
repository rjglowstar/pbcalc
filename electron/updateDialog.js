const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const state = require("./state");

// The update dialog (electron/updater.js asks it): a small window of PBCalc's own - update icon, the two version numbers, what an update does
// (restart, tabs closed and not restored, opens again by itself) and Cancel / Update buttons - instead of Windows' plain message box.
// MODAL to the main window (the browser behind it cannot be used until it is answered) and never answers itself:
//   Update -> true;   Cancel, Esc, the window's X, or the main window closing -> false (nothing is ever started by anything but the Update button).
// Keyboard focus is NOT put on a button, so a stray Enter while the user types in a page decides nothing.
// `last` is only for the tests.
let last = null;

// info: { version, current } -> Promise<boolean>
function ask(info) {
  return new Promise((resolve) => {
    const parent = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow : undefined;
    const win = new BrowserWindow({
      parent, modal: !!parent,
      width: 500, height: 560, useContentSize: true,
      show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      title: "PBCalc update", autoHideMenuBar: true,
      icon: path.join(__dirname, "..", "assets", "icon.png"),
      backgroundColor: require("electron").nativeTheme.shouldUseDarkColors ? "#3c3c3c" : "#ffffff",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "..", "preloads", "updatedialog-preload.js") },
    });
    last = win;
    win.removeMenu();
    require("./lockdown").lock(win.webContents);
    const wc = win.webContents;
    let done = false;
    const onAnswer = (e, yes) => { if (e.sender === wc) finish(yes === true); };      // only THIS window may answer
    ipcMain.on("updatedialog:answer", onAnswer);
    function finish(yes) {
      if (done) return;
      done = true;
      ipcMain.removeListener("updatedialog:answer", onAnswer);
      try { if (!win.isDestroyed()) win.close(); } catch (_) {}   // close(), not destroy(): the window and its page shut down in order (destroy() left native state behind - a later theme change crashed the process)
      resolve(!!yes);
    }
    win.on("closed", () => finish(false));                 // the X, Alt+F4, or the main window closing under it

    wc.once("did-finish-load", async () => {
      try {
        wc.send("updatedialog:init", { version: String(info.version || "").slice(0, 30), current: String(info.current || "").slice(0, 30) });
        const h = await wc.executeJavaScript("Math.ceil(document.querySelector('.dlg').getBoundingClientRect().height)");   // fit the window to its content
        if (!win.isDestroyed()) { win.setContentSize(500, Math.max(300, Math.min(h, 800))); win.center(); win.show(); win.focus(); }
      } catch (_) { if (!win.isDestroyed()) win.show(); }
    });
    win.loadFile(path.join(__dirname, "..", "renderer", "updatedialog", "updatedialog.html")).catch(() => finish(false));
  });
}

module.exports = { ask, _last: () => last };
