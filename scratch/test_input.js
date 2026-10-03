const { app, BrowserView, BrowserWindow } = require('electron');
const tabManager = require('./electron/tabs/tabManager');
const state = require('./electron/state');
const shortcuts = require('./electron/shortcuts');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false });
  state.mainWindow = win;
  
  tabManager.createTab('http://example.com');
  const view1 = state.tabs[0].view;
  tabManager.createTab('http://example2.com');
  const view2 = state.tabs[1].view;
  
  // Simulate Ctrl+W
  console.log('Simulating Ctrl+W...');
  const activeWc = state.tabs.find(t => t.id === state.activeTabId).view.webContents;
  activeWc.emit('before-input-event', { preventDefault: () => {} }, { key: 'w', control: true, isAutoRepeat: false });
  
  console.log('Tabs after Ctrl+W:', state.tabs.length);
  console.log('Active tab:', state.activeTabId);
  
  // Simulate Ctrl+T
  console.log('Simulating Ctrl+T...');
  const newActiveWc = state.tabs.find(t => t.id === state.activeTabId).view.webContents;
  newActiveWc.emit('before-input-event', { preventDefault: () => {} }, { key: 't', control: true, isAutoRepeat: false });
  
  console.log('Tabs after Ctrl+T:', state.tabs.length);
  
  // Simulate Ctrl+Shift+T
  console.log('Simulating Ctrl+Shift+T...');
  const newActiveWc2 = state.tabs.find(t => t.id === state.activeTabId).view.webContents;
  newActiveWc2.emit('before-input-event', { preventDefault: () => {} }, { key: 't', control: true, shift: true, isAutoRepeat: false });
  
  console.log('Tabs after Ctrl+Shift+T:', state.tabs.length);
  
  app.quit();
});
