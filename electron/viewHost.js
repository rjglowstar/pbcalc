// Every window.addBrowserView(view) call makes Electron add a "closed" listener to the WINDOW that is never taken off again by
// removeBrowserView - and its closure keeps the view (and what hangs on it) alive. PBCalc adds and removes views all the time (a tab
// switch, every popup, every hover card, the omnibox list, the download-started animation), so the window collected one listener
// per call: measured +1 per tab switch, +1 per popup (46 listeners after ~40 operations, and Node's "possible EventEmitter memory
// leak" warning, which mainWindow.js used to silence with setMaxListeners(100) instead of fixing it). attach/detach take the
// listener(s) a call added off again when the view is detached, so the count stays at the number of views that are attached.
const added = new WeakMap();   // view -> the "closed" listeners its addBrowserView added

function attach(win, view) {
  const before = new Set(win.listeners("closed"));
  win.addBrowserView(view);
  const mine = win.listeners("closed").filter((l) => !before.has(l));
  if (mine.length) added.set(view, (added.get(view) || []).concat(mine));
}

function detach(win, view) {
  try { win.removeBrowserView(view); }
  finally {
    for (const l of added.get(view) || []) win.removeListener("closed", l);
    added.delete(view);
  }
}

module.exports = { attach, detach };
