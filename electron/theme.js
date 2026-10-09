const { nativeTheme } = require("electron");

// Chrome's classic light/dark palette. The title-bar overlay (native min/max/close buttons drawn
// over our tab strip) has to be recoloured from the main process, so these two values are kept in
// step with --frame / --text in renderer/common/theme.css. The rest of the UI themes itself with
// CSS prefers-color-scheme, which follows the Windows app mode automatically.
const PALETTE = {
  light: { color: "#d3e3fd", symbolColor: "#1f1f1f" },
  dark: { color: "#1f2020", symbolColor: "#e3e3e3" },
};

// The calculator screen (calcMode.js): the window buttons take the colour and the HEIGHT of the calculator's header, so they look like part of it (they used to be a
// black 138 x 40 box in a white, taller header). The colours are the header's own (light glass / dark glass, sampled from the rendered header); the height and the
// calculator's light / dark setting come from the page (calc:chrome, setCalcChrome), because the header's height follows the window width (em units).
const CALC_LIGHT = { color: "#f3f9fc", symbolColor: "#1f2937" };
const CALC_DARK = { color: "#132030", symbolColor: "#e8ecf4" };
let calcChrome = { dark: false, height: 0 };
let calc = false;
const watched = [];

function current() {
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

function palette() {
  return calc ? (calcChrome.dark ? CALC_DARK : CALC_LIGHT) : PALETTE[current()];
}

function overlayOptions(height) {
  return { ...palette(), height: calc && calcChrome.height ? calcChrome.height : height };
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

// { dark, height } from the calculator page (header height in px, the calculator's own light / dark choice)
function setCalcChrome(o, win) {
  const h = Math.round(Number(o && o.height));
  calcChrome = { dark: !!(o && o.dark === true), height: h >= 30 && h <= 120 ? h : 0 };
  if (calc) watched.filter((w) => !win || w.win === win).forEach((w) => w.apply());
}

module.exports = { overlayOptions, watch, current, setCalc, setCalcChrome };
