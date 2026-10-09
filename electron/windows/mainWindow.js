const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const state = require("../state");
const { createTab, resizeActiveView } = require("../tabs/tabManager");
const { TAB_STRIP_HEIGHT } = require("../constants");
const theme = require("../theme");
const settings = require("../settings");
const popup = require("../popup");
const calcMode = require("../calcMode");

// how long the first show waits for the calculator screen to be built (it takes well under a second; this is only the safety net)
const CALC_READY_MAX_MS = 2500;

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
  require("../lockdown").lock(state.mainWindow.webContents);   // the toolbar page never opens windows or navigates away (a dropped link used to)

  // Each ATTACHED view adds a "closed" and a "resize" listener to the window. viewHost.js removes the "closed" one (Electron never
  // does) on detach, so the count follows the number of attached views - normally 1-3. Opening many tabs at once keeps their old
  // views attached for up to 300ms (the thumbnail is taken first), which can briefly pass Node's default of 10 and print a warning
  // that is not a leak (measured: the counts return to the baseline, scripts/verify-leaks.js).
  state.mainWindow.setMaxListeners(40);
  state.mainWindow.removeMenu();
  theme.watch(state.mainWindow, TAB_STRIP_HEIGHT);
  require("../shortcuts").attachShortcuts(state.mainWindow.webContents);
  // Right-click menu for the address bar / find box (cut/copy/paste); no page items here.
  require("../contextMenu").attachContextMenu(state.mainWindow.webContents, { isShell: true });
  // Starting on the calculator: the page is told so from its very first line (?calc=1 -> body.calc-mode at once), and the window is
  // not SHOWN until the calculator has built itself (calc:ready, with a time limit). Without this the browser's tab strip, address bar and
  // bookmarks bar were visible for a few milliseconds before the calculator replaced them (seen when PBCalc is opened from the taskbar).
  // The calculator mode itself is switched on NOW, before the page loads: the page asks for it (calc:get-mode / calc:get-data) as soon as it runs.
  const startOnCalc = calcMode.enabled();
  let calcReady = Promise.resolve();
  if (startOnCalc) {
    calcMode.enter();
    const win = state.mainWindow;
    calcReady = new Promise((resolve) => {
      const timer = setTimeout(done, CALC_READY_MAX_MS);
      const onReady = (e) => { if (e.sender === win.webContents) done(); };
      function done() { clearTimeout(timer); ipcMain.removeListener("calc:ready", onReady); resolve(); }
      ipcMain.on("calc:ready", onReady);       // registered before the page exists: its "ready" can never arrive unheard
      win.once("closed", done);
    });
  }
  state.mainWindow.loadFile(
    path.join(__dirname, "..", "..", "renderer", "shell", "shell.html"),
    startOnCalc ? { query: { calc: "1" } } : undefined,
  );

  state.mainWindow.once("ready-to-show", async () => {
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
    const win = state.mainWindow;
    // Open maximized (the width/height above are what the window restores to). Maximizing BEFORE
    // show avoids the small window appearing for a frame and then jumping.
    // The calculator start does everything INVISIBLY (opacity 0) and shows the window only when it is final: the page was loaded at the
    // restore size (1400x900), so it was built for that width, and the calculator's layout follows the window width (em units) - maximizing and
    // showing at once made it appear small and then grow, and its window buttons (the title-bar overlay) went 40 -> 55 -> 63 px tall a moment later.
    // maximize() shows a hidden window, hence the opacity: maximized at once, the page re-laid out at the final size, the overlay height applied, THEN visible.
    if (startOnCalc) { try { win.setOpacity(0); } catch (_) {} }
    else await calcReady;
    if (!win || win.isDestroyed()) return;
    win.maximize();
    win.show();
    if (startOnCalc) {
      try {
        await calcReady;
        await new Promise((r) => setTimeout(r, 150));                       // the maximize reaches the page (it re-lays out at 1920 wide)
        if (!win.isDestroyed()) {
          await Promise.race([win.webContents.executeJavaScript("window.__calcSettle ? window.__calcSettle() : true", true), new Promise((r) => setTimeout(r, 1500))]);
          await new Promise((r) => setTimeout(r, 120));                      // ...and the new title-bar height has been applied (it can change the content size by a pixel or two)
        }
      } catch (_) { /* reveal anyway */ }
      if (!win.isDestroyed()) { try { win.setOpacity(1); } catch (_) {} }
    }
    // "Start on the calculator screen" (the installer's answer): the calculator first, the browser only when its "+" is pressed 5 times.
    if (!startOnCalc) createTab(undefined, { allowRestricted: true }); // opens on the new-tab page (or the Restricted home); the calculator mode was switched on above
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

  // With the calculator start on, the browser opens from the calculator and closing it quits PBCalc like any browser (the calculator is not shown again until the next start).
  calcMode.install();
  state.mainWindow.on("session-end", () => { state.quitting = true; });   // Windows is shutting down / logging off: never hold that up

  state.mainWindow.on("closed", () => {
    state.mainWindow = null;
    state.tabs = [];
    state.activeTabId = null;
  });
}

module.exports = { createMainWindow };
