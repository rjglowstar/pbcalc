const { app, BrowserView, BrowserWindow } = require('electron');
const tabManager = require('./electron/tabs/tabManager');
const state = require('./electron/state');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false });
  state.mainWindow = win;
  
  const mockWebContents = () => {
    const listeners = {};
    return {
      getURL: () => 'http://example.com',
      isDestroyed: () => false,
      destroy: () => {},
      focus: () => {},
      capturePage: async () => ({ toDataURL: () => '' }),
      on: (event, cb) => { listeners[event] = cb; },
      emitBeforeInput: (e, input) => { if (listeners['before-input-event']) listeners['before-input-event'](e, input); }
    };
  };
  
  const origCloseTab = tabManager.closeTab;
  tabManager.closeTab = (id) => {
    console.log('closeTab called with id:', id);
    origCloseTab(id);
  };
  
  tabManager.createTab('http://example.com', { webContents: mockWebContents() });
  tabManager.createTab('http://example2.com', { webContents: mockWebContents() });
  
  console.log('Tabs before Ctrl+W:', state.tabs.length);
  
  const activeWc = state.tabs.find(t => t.id === state.activeTabId).view.webContents;
  activeWc.emitBeforeInput({ preventDefault: () => {} }, { type: 'keyDown', key: 'w', control: true, isAutoRepeat: false });
  
  console.log('Tabs after Ctrl+W:', state.tabs.length);
  
  const newActiveWc = state.tabs.find(t => t.id === state.activeTabId).view.webContents;
  newActiveWc.emitBeforeInput({ preventDefault: () => {} }, { type: 'keyDown', key: 't', control: true, isAutoRepeat: false });
  
  console.log('Tabs after Ctrl+T:', state.tabs.length);
  
  app.quit();
});
