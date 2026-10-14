// Ctrl+W on a PINNED tab, like Chrome (owner 2026-10-14, from their Chrome screenshots): the FIRST Ctrl+W does not close it - a notice "Press Ctrl+W again to
// close the pinned tab" appears, centred on the line where the page starts - and a SECOND Ctrl+W while it is showing closes the tab. The menu's "Close" closes
// at once (the notice only speaks of Ctrl+W). The notice goes after SHOW_MS, when another tab is chosen, or when the tab is closed.
// Drawn in a small transparent BrowserView over the page (the shell lies UNDER the page views), made when needed and destroyed when it goes.
const { BrowserView } = require("electron");
const path = require("path");
const state = require("./state");

const SHOW_MS = 8000;        // how long the notice stays - and the second Ctrl+W counts (an estimate: Chrome's own time was not measured)
let view = null, timer = null, forTabId = null;

function hide() {
  clearTimeout(timer); timer = null; forTabId = null;
  const v = view; view = null;
  if (!v) return;
  try { if (state.mainWindow && !state.mainWindow.isDestroyed()) require("./viewHost").detach(state.mainWindow, v); } catch (_) {}
  try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch (_) {}
}

function show(tabId) {
  hide();
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  forTabId = tabId;
  const v = new BrowserView({ webPreferences: { contextIsolation: true, nodeIntegration: false } });
  view = v;
  require("./lockdown").lock(v.webContents);
  v.setBackgroundColor("#00000000");
  v.webContents.once("did-finish-load", async () => {
    if (view !== v || win.isDestroyed()) return;
    let w = 304, h = 50;
    try { const r = await v.webContents.executeJavaScript("(() => { const b = document.getElementById('t').getBoundingClientRect(); return [Math.ceil(b.width), Math.ceil(b.height)]; })()"); w = r[0] || w; h = r[1] || h; } catch (_) {}
    if (view !== v || win.isDestroyed()) return;
    const [cw] = win.getContentSize();
    const line = require("./tabs/tabManager").chromeHeight();   // where the page starts: the notice is centred on that line (measured from Chrome)
    v.setBounds({ x: Math.max(0, Math.round((cw - w) / 2)), y: Math.max(0, Math.round(line - h / 2)), width: w, height: h });
    require("./viewHost").attach(win, v);
  });
  v.webContents.loadFile(path.join(__dirname, "..", "renderer", "pintoast", "pintoast.html")).catch(() => {});
  timer = setTimeout(hide, SHOW_MS);
}

// Ctrl+W: returns true when the tab may close now, false when this press only showed the notice.
function confirmClose(tab) {
  if (!tab || !tab.pinned) return true;
  if (forTabId === tab.id && view) { hide(); return true; }   // the second Ctrl+W while the notice shows
  show(tab.id);
  return false;
}

module.exports = { confirmClose, hide, isShowing: () => !!view, SHOW_MS };
