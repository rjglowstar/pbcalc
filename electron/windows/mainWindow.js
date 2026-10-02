const { BrowserWindow } = require("electron");
const path = require("path");
const state = require("../state");
const { createTab, resizeActiveView } = require("../tabs/tabManager");
const { TAB_STRIP_HEIGHT } = require("../constants");
const theme = require("../theme");
const settings = require("../settings");
const popup = require("../popup");

function createMainWindow() {
  state.bookmarksBarVisible = settings.get("showBookmarksBar");
  // "Default Start Restricted": begin locked. Never with an empty list (nothing could be opened).
  state.restricted = !!(require("../restricted").getStartRestricted() && require("../bookmarks/bookmarkStore").list().length);
  require("electron").nativeTheme.themeSource = settings.get("themeMode");
  state.mainWindow = new BrowserWindow({
    // PBCalc's own icon (assets/icon.svg -> scripts/make-icons.js). Without this the window and
    // the taskbar show Electron's default atom.
    icon: path.join(__dirname, "..", "..", "assets", "icon.png"),
    // Chrome-style: no OS title bar; our tab strip is the drag area and the native min / max /
    // close buttons are drawn over its right end (titleBarOverlay, recoloured by theme.js).
    titleBarStyle: "hidden",
    titleBarOverlay: theme.overlayOptions(TAB_STRIP_HEIGHT),
    backgroundColor: theme.overlayOptions(TAB_STRIP_HEIGHT).color,
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

  // Every tab view added to the window registers a "closed" listener on it; with more than 10 tabs
  // Node warns about a "leak" that is not one.
  state.mainWindow.setMaxListeners(100);
  state.mainWindow.removeMenu();
  theme.watch(state.mainWindow, TAB_STRIP_HEIGHT);
  require("../shortcuts").attachShortcuts(state.mainWindow.webContents);
  // Right-click menu for the address bar / find box (cut/copy/paste); no page items here.
  require("../contextMenu").attachContextMenu(state.mainWindow.webContents, { isShell: true });
  state.mainWindow.loadFile(
    path.join(__dirname, "..", "..", "renderer", "shell", "shell.html"),
  );

  state.mainWindow.once("ready-to-show", () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    // Open maximized (the width/height above are what the window restores to). Maximizing BEFORE
    // show avoids the small window appearing for a frame and then jumping.
    state.mainWindow.maximize();
    state.mainWindow.show();
    createTab(undefined, { allowRestricted: true }); // opens on the new-tab page (or the Restricted home)
    // The "maximize" event fires before this first tab exists, and the content size is still
    // settling while the tab view is first positioned — without this the page sat 2px short of the
    // bottom of a maximized window. Re-apply once the window has settled.
    setImmediate(resizeActiveView);
    setTimeout(resizeActiveView, 150);
  });

  // The hover card is hidden a tick later, not inside the resize emit (see popup.reposition()).
  state.mainWindow.on("resize", () => { resizeActiveView(); popup.reposition(); setImmediate(() => { require("../hovercard").hide(); require("../omnibox").hide(); }); });
  state.mainWindow.on("blur", () => { if (popup.isOpen() && !popup.isOpen("find")) popup.close(); });
  state.mainWindow.on("resized", resizeActiveView);
  state.mainWindow.on("maximize", resizeActiveView);
  state.mainWindow.on("unmaximize", resizeActiveView);

  state.mainWindow.on("enter-full-screen", () => {
    try {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send("fullscreen:changed", true);
      }
    } catch (_) {}
    resizeActiveView();
  });

  state.mainWindow.on("leave-full-screen", () => {
    try {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send("fullscreen:changed", false);
      }
    } catch (_) {}
    resizeActiveView();
  });

  state.mainWindow.on("closed", () => {
    state.mainWindow = null;
    state.tabs = [];
    state.activeTabId = null;
  });
}

module.exports = { createMainWindow };
