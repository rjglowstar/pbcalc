const { BrowserView } = require("electron");
const state = require("../state");
const { TAB_BAR_HEIGHT, MAX_TABS, HOME_URL } = require("../constants");

function notifyTabs() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  try {
    state.mainWindow.webContents.send("tabs:changed", getTabState());
  } catch (_) {}
}

function getTabState() {
  return {
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((t) => {
      const wc = t.view.webContents;
      const alive = !wc.isDestroyed();
      return {
        id: t.id,
        title: t.title || "New Tab",
        url: t.url || "",
        canGoBack: alive && wc.canGoBack(),
        canGoForward: alive && wc.canGoForward(),
        loading: alive && wc.isLoading(),
      };
    }),
  };
}

function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

// Called on window resize/maximize AND every time the active tab changes, so the visible
// BrowserView always exactly fills the space below the tab strip / address bar.
function resizeActiveView() {
  const tab = getActiveTab();
  if (!tab || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  const [w, h] = state.mainWindow.getContentSize();
  tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width: w, height: Math.max(0, h - TAB_BAR_HEIGHT - state.bottomInset) });
}

function createTab(url) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return getTabState();
  if (state.tabs.length >= MAX_TABS) return getTabState();

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Deliberately NO partition option here — every tab shares Electron's default persistent
      // session, so logging into a site in one tab keeps you logged in across every other tab of
      // the same site, exactly like a real browser. The ERP shell this project split off from
      // does the OPPOSITE (an isolated partition per tab) because it specifically needs several
      // independent logins open side by side; that need does not apply to a general browser.
      preload: require("path").join(__dirname, "..", "..", "preloads", "tab-preload.js"),
    },
  });

  const tab = { id: state.nextTabId++, view, title: "New Tab", url: "" };
  state.tabs.push(tab);
  wireTabEvents(tab);

  state.mainWindow.addBrowserView(view);
  switchTab(tab.id);
  view.webContents.loadURL(url || HOME_URL);

  notifyTabs();
  return getTabState();
}

function wireTabEvents(tab) {
  const wc = tab.view.webContents;
  wc.on("page-title-updated", (_e, title) => { tab.title = title; notifyTabs(); });
  wc.on("did-navigate", (_e, url) => { tab.url = url; notifyTabs(); });
  wc.on("did-navigate-in-page", (_e, url) => { tab.url = url; notifyTabs(); });
  wc.on("did-start-loading", notifyTabs);
  wc.on("did-stop-loading", notifyTabs);

  // A link opened with target="_blank" / window.open becomes a new TAB in this same window,
  // rather than a separate popup window — the behaviour a browser user actually expects.
  wc.setWindowOpenHandler(({ url }) => {
    createTab(url);
    return { action: "deny" };
  });
}

function switchTab(id) {
  const next = state.tabs.find((t) => t.id === Number(id));
  if (!next || !state.mainWindow || state.mainWindow.isDestroyed()) return getTabState();

  const current = getActiveTab();
  if (current && current.id !== next.id && !current.view.webContents.isDestroyed()) {
    try {
      state.mainWindow.removeBrowserView(current.view);
    } catch (_) {}
  }

  state.activeTabId = next.id;
  try {
    state.mainWindow.addBrowserView(next.view);
  } catch (_) {}
  resizeActiveView();
  notifyTabs();
  return getTabState();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === Number(id));
  if (idx === -1) return getTabState();

  const [removed] = state.tabs.splice(idx, 1);
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      state.mainWindow.removeBrowserView(removed.view);
    } catch (_) {}
  }
  if (!removed.view.webContents.isDestroyed()) removed.view.webContents.destroy();

  if (state.activeTabId === removed.id) {
    state.activeTabId = null;
    const nextTab = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (nextTab) switchTab(nextTab.id);
  }

  // Closing the very last tab reopens a fresh one instead of leaving an empty window — matches
  // how every mainstream browser behaves (closing the last tab closes the window on most
  // platforms; here we instead treat "the window" as always having at least one tab).
  if (state.tabs.length === 0) createTab();

  notifyTabs();
  return getTabState();
}

// A bare search term (no scheme, no dot that looks like a domain) goes to a search engine, same
// as typing into any real browser's address bar. Anything else gets https:// assumed onto it if
// it has no scheme of its own yet.
function navigate(url) {
  const tab = getActiveTab();
  if (!tab) return;
  let target = String(url || "").trim();
  if (!target) return;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  const looksLikeDomain = /^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(target);

  if (!hasScheme && !looksLikeDomain) {
    target = "https://www.google.com/search?q=" + encodeURIComponent(target);
  } else if (!hasScheme) {
    target = "https://" + target;
  }

  tab.view.webContents.loadURL(target);
}

function goBack() {
  const t = getActiveTab();
  if (t && t.view.webContents.canGoBack()) t.view.webContents.goBack();
}
function goForward() {
  const t = getActiveTab();
  if (t && t.view.webContents.canGoForward()) t.view.webContents.goForward();
}
function reload() {
  const t = getActiveTab();
  if (t && !t.view.webContents.isDestroyed()) t.view.webContents.reload();
}

module.exports = {
  getTabState,
  getActiveTab,
  resizeActiveView,
  createTab,
  switchTab,
  closeTab,
  navigate,
  goBack,
  goForward,
  reload,
};
