const { BrowserWindow } = require("electron");
const path = require("path");
const state = require("../state");
const { createTab, resizeActiveView } = require("../tabs/tabManager");

function createMainWindow() {
  state.mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 768,
    minHeight: 768,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "..", "preloads", "shell-preload.js"),
    },
  });

  state.mainWindow.removeMenu();
  state.mainWindow.loadFile(
    path.join(__dirname, "..", "..", "renderer", "shell", "shell.html"),
  );

  state.mainWindow.once("ready-to-show", () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    state.mainWindow.show();
    createTab(); // the window always opens with one tab, at the home page
  });

  state.mainWindow.on("resize", resizeActiveView);
  state.mainWindow.on("resized", resizeActiveView);
  state.mainWindow.on("maximize", resizeActiveView);
  state.mainWindow.on("unmaximize", resizeActiveView);

  state.mainWindow.on("closed", () => {
    state.mainWindow = null;
    state.tabs = [];
    state.activeTabId = null;
  });
}

module.exports = { createMainWindow };
