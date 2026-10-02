const { nativeTheme } = require("electron");

// Chrome's classic light/dark palette. The title-bar overlay (native min/max/close buttons drawn
// over our tab strip) has to be recoloured from the main process, so these two values are kept in
// step with --frame / --text in renderer/common/theme.css. The rest of the UI themes itself with
// CSS prefers-color-scheme, which follows the Windows app mode automatically.
const PALETTE = {
  light: { color: "#d3e3fd", symbolColor: "#1f1f1f" },
  dark: { color: "#1f2020", symbolColor: "#e3e3e3" },
};

function current() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function overlayOptions(height) {
  return { ...PALETTE[current()], height };
}

function watch(win, height) {
  const apply = () => {
    if (win.isDestroyed()) return;
    try { win.setTitleBarOverlay(overlayOptions(height)); } catch (_) {}
    try { win.setBackgroundColor(PALETTE[current()].color); } catch (_) {}
  };
  nativeTheme.on("updated", apply);
  win.on("closed", () => nativeTheme.removeListener("updated", apply));
}

module.exports = { overlayOptions, watch, current };
