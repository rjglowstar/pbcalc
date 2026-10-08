const { nativeTheme } = require("electron");

// Chrome's classic light/dark palette. The title-bar overlay (native min/max/close buttons drawn
// over our tab strip) has to be recoloured from the main process, so these two values are kept in
// step with --frame / --text in renderer/common/theme.css. The rest of the UI themes itself with
// CSS prefers-color-scheme, which follows the Windows app mode automatically.
const PALETTE = {
  light: { color: "#d3e3fd", symbolColor: "#1f1f1f" },
  dark: { color: "#1f2020", symbolColor: "#e3e3e3" },
};

// The calculator screen (calcMode.js) is black around its iPad-shaped stage, so the window buttons are white on black while it shows.
const CALC = { color: "#000000", symbolColor: "#ffffff" };
let calc = false;
const watched = [];

function current() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function palette() {
  return calc ? CALC : PALETTE[current()];
}

function overlayOptions(height) {
  return { ...palette(), height };
}

function watch(win, height) {
  const apply = () => {
    if (win.isDestroyed()) return;
    try { win.setTitleBarOverlay(overlayOptions(height)); } catch (_) {}
    try { win.setBackgroundColor(palette().color); } catch (_) {}
  };
  nativeTheme.on("updated", apply);
  watched.push({ win, apply });
  win.on("closed", () => { nativeTheme.removeListener("updated", apply); const i = watched.findIndex((w) => w.win === win); if (i >= 0) watched.splice(i, 1); });
}

function setCalc(on, win) {
  calc = !!on;
  watched.filter((w) => !win || w.win === win).forEach((w) => w.apply());
}

module.exports = { overlayOptions, watch, current, setCalc };
