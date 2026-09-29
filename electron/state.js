// Single mutable module-level state object, shared by every main-process module — same pattern
// as the ERP shell this project split off from. No store/reducer layer; modules require this
// directly and read/write it.
module.exports = {
  mainWindow: null,

  // { id, view (BrowserView), title, url }
  tabs: [],
  activeTabId: null,
  nextTabId: 1,

  // Height reserved at the bottom of the window for the downloads shelf (0 = hidden).
  bottomInset: 0,
};
