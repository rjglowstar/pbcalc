const { app } = require("electron");
const tm = require("./electron/tabs/tabManager");
const state = require("./electron/state");

app.on("ready", () => {
  // Mock mainWindow
  state.mainWindow = {
    isDestroyed: () => false,
    removeBrowserView: () => {},
    close: () => {},
    getContentSize: () => [1000, 1000]
  };

  // Open 1,2,3,4,5,6
  tm.createTab("http://1.com");
  tm.createTab("http://2.com");
  tm.createTab("http://3.com");
  tm.createTab("http://4.com");
  tm.createTab("http://5.com");
  tm.createTab("http://6.com");

  console.log("Initial tabs:", state.tabs.map(t => t.url));
  
  // They are index 0, 1, 2, 3, 4, 5
  // Close 2 and 3 (index 1 and 2, which are "http://2.com" and "http://3.com")
  const id2 = state.tabs.find(t => t.url.includes("2.com")).id;
  const id3 = state.tabs.find(t => t.url.includes("3.com")).id;

  tm.closeTab(id3);
  tm.closeTab(id2);
  
  console.log("History after closing 3, 2:", tm.getClosedTabsHistory ? tm.getClosedTabsHistory() : "no exported function");
  
  // Wait, I didn't export closedTabsHistory...
  // Reopen
  tm.reopenClosedTab();
  console.log("Tabs after 1st restore:", state.tabs.map(t => t.url));
  
  tm.reopenClosedTab();
  console.log("Tabs after 2nd restore:", state.tabs.map(t => t.url));

  app.quit();
});
