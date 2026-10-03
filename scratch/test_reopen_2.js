const state = require("../electron/state");
const tabManager = require("../electron/tabs/tabManager");

// Mock
state.mainWindow = {
  isDestroyed: () => false,
  addBrowserView: () => {},
  removeBrowserView: () => {},
  getContentSize: () => [1000, 1000],
  isFullScreen: () => false,
  webContents: { send: () => {} }
};

global.BrowserView = class BrowserView {
  constructor() {
    this.webContents = {
      isDestroyed: () => false,
      destroy: () => {},
      focus: () => {},
      getURL: () => "http://test",
      capturePage: () => Promise.resolve({ toDataURL: () => "" }),
      on: () => {},
      loadURL: () => Promise.resolve(),
      executeJavaScript: () => Promise.resolve()
    };
  }
  setBounds() {}
};

tabManager.createTab("http://1");
tabManager.createTab("http://2");
tabManager.createTab("http://3");

console.log("TABS:", state.tabs.length);
tabManager.switchTab(state.tabs[0].id);
console.log("ACTIVE:", state.activeTabId);

// Close tab 2
tabManager.closeTab(state.tabs[1].id);
console.log("AFTER CLOSE 2:", state.tabs.length);

// Close tab 3
tabManager.closeTab(state.tabs[1].id);
console.log("AFTER CLOSE 3:", state.tabs.length);

tabManager.reopenClosedTab();
console.log("AFTER REOPEN 1:", state.tabs.length, "ACTIVE:", state.activeTabId);

tabManager.reopenClosedTab();
console.log("AFTER REOPEN 2:", state.tabs.length, "ACTIVE:", state.activeTabId);
