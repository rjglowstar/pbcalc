const { Menu, clipboard } = require("electron");
const state = require("./state");

function isInspectable(wc) {
  try {
    const p = new URL(wc.getURL()).protocol;
    return p === "http:" || p === "https:";
  } catch (_) {
    return false;
  }
}

// Electron gives no right-click menu by default, so build one from the context-menu event's
// params. `openInNewTab` is passed in (rather than required) so this module stays free of a
// circular dependency on tabManager.
function attachContextMenu(wc, { openInNewTab, isShell = false } = {}) {
  wc.on("context-menu", (_event, p) => {
    const t = [];
    const sep = () => { if (t.length && t[t.length - 1].type !== "separator") t.push({ type: "separator" }); };

    const locked = state.restricted; // Restricted Mode: no link addresses, no image saving, no Inspect
    if (p.linkURL && !isShell && !locked) {
      t.push({ label: "Open link in new tab", click: () => openInNewTab(p.linkURL) });
      t.push({ label: "Copy link address", click: () => clipboard.writeText(p.linkURL) });
      sep();
    }

    if (p.mediaType === "image" && p.srcURL && !isShell && !locked) {
      t.push({ label: "Open image in new tab", click: () => openInNewTab(p.srcURL) });
      t.push({ label: "Save image as…", click: () => wc.downloadURL(p.srcURL) });
      t.push({ label: "Copy image", click: () => wc.copyImageAt(p.x, p.y) });
      t.push({ label: "Copy image address", click: () => clipboard.writeText(p.srcURL) });
      sep();
    }

    if (p.isEditable) {
      const f = p.editFlags;
      t.push({ label: "Undo", role: "undo", enabled: f.canUndo });
      t.push({ label: "Redo", role: "redo", enabled: f.canRedo });
      sep();
      t.push({ label: "Cut", role: "cut", enabled: f.canCut });
      t.push({ label: "Copy", role: "copy", enabled: f.canCopy });
      t.push({ label: "Paste", role: "paste", enabled: f.canPaste });
      t.push({ label: "Select all", role: "selectAll", enabled: f.canSelectAll });
    } else if (p.selectionText) {
      t.push({ label: "Copy", role: "copy" });
    }

    if (!isShell && !p.isEditable) {
      sep();
      t.push({ label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      t.push({ label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      t.push({ label: "Reload", click: () => wc.reload() });
      sep();
      t.push({ label: "Print…", click: () => wc.print({ printBackground: true }) });
    }

    if (!isShell && !locked && isInspectable(wc)) {
      sep();
      t.push({ label: "Inspect", click: () => {
        if (!wc.isDevToolsOpened()) {
          wc.openDevTools({ mode: "detach" });
        }
        wc.inspectElement(p.x, p.y);
      } });
    }

    while (t.length && t[t.length - 1].type === "separator") t.pop();
    if (t.length) Menu.buildFromTemplate(t).popup();
  });
}

module.exports = { attachContextMenu };
