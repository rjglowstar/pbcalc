const { app, BrowserView } = require('electron');
const tabManager = require('./electron/tabs/tabManager');
const state = require('./electron/state');

app.whenReady().then(() => {
  state.mainWindow = {
    isDestroyed: () => false,
    addBrowserView: () => {},
    removeBrowserView: () => {},
    getContentSize: () => [1000, 1000],
    webContents: { send: () => {} },
    close: () => { console.log('Window closed'); },
    isFullScreen: () => false
  };
  
  tabManager.createTab('http://example.com', { webContents: null });
  const id1 = state.tabs[0].id;
  tabManager.createTab('http://example.com', { webContents: null });
  const id2 = state.tabs[1].id;
  
  console.log('Active tab before:', state.activeTabId);
  tabManager.closeTab(state.activeTabId);
  console.log('Active tab after 1 close:', state.activeTabId);
  console.log('Tabs:', state.tabs.length);
  
  tabManager.closeTab(state.activeTabId);
  console.log('Active tab after 2 closes:', state.activeTabId);
  console.log('Tabs:', state.tabs.length);
  
  app.quit();
});
