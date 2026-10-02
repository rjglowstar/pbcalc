// Measures PBCalc's tab strip with the SAME pixel probes that were used on real Chrome 153, so the
// two can be compared number for number. Used by verify-ui.js; can also be run on its own to print
// the numbers:  env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/chrome-reference/measure.js
//
// Reference (Chrome 153, light, 1200px wide window, 3 tabs about:blank, first active), window px:
//   frame D3E3FD · active/toolbar FFFFFF · hover pill A8C7FA · separators A8C7FA · search button ECF3FE
//   active body x 48..280 (232 wide), y 6..40 ; hover pill x 286..518, y 6..34 (28 tall), radius 10
//   top corner insets (rows 6..13): 7 5 3 2 2 1 1 0 ; flare expansion (rows 31..39): 1 1 1 2 3 3 5 6 9
//   separators x 520..521, y 12..28 ; search button x 14..42, y 6..34 ; plus glyph centre x 775.5
//   favicon ink x 57..70 y 13..26 ; title ink x 81..141 y 16..24 ; X ink x 260..267 y 16..23
const path = require("path");

function makeProbe(image) {
  const { width, height } = image.getSize();
  const buf = image.toBitmap(); // BGRA
  const px = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return [0, 0, 0];
    const i = (y * width + x) * 4;
    return [buf[i + 2], buf[i + 1], buf[i]]; // R G B
  };
  const hex = (x, y) => px(x, y).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const rgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return { width, height, px, hex, dist, rgb };
}

// coverage 0..1 of colour `on` over colour `off` at a pixel (for sub-pixel edge positions)
function coverage(p, x, y, off, on) {
  const c = p.px(x, y);
  const t = Math.sqrt((on[0] - off[0]) ** 2 + (on[1] - off[1]) ** 2 + (on[2] - off[2]) ** 2) || 1;
  const d = Math.sqrt((c[0] - off[0]) ** 2 + (c[1] - off[1]) ** 2 + (c[2] - off[2]) ** 2);
  return Math.max(0, Math.min(1, d / t));
}

function inkBox(p, x0, x1, y0, y1, isInk) {
  let minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    if (isInk(p.px(x, y))) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y); }
  }
  return maxx < 0 ? null : { x0: minx, x1: maxx, y0: miny, y1: maxy };
}

// Everything measurable from a capture of the tab strip with the first tab active.
// `c` = the palette of the mode being measured (hex strings).
function measureStrip(p, c) {
  const frame = p.rgb(c.frame), toolbar = p.rgb(c.toolbar);
  const out = {};
  out.frameAt = p.hex(600, 3);
  out.toolbarAt = p.hex(600, 44);

  // active body edges at y=20 (first toolbar-coloured run starting after the search button)
  let left = null, right = null;
  for (let x = 44; x < 400; x++) {
    const isT = p.dist(p.px(x, 20), toolbar) < 8;
    if (isT && left === null) left = x;
    if (left !== null && !isT && p.dist(p.px(x, 20), frame) < 6 && p.dist(p.px(x + 1, 20), frame) < 6) { right = x; break; }
  }
  out.activeBody = { left, right, width: right - left };

  // top-right corner insets, rows 6..13, relative to the body's right edge
  out.cornerInsets = [];
  for (let y = 6; y <= 13; y++) {
    let s = 0;
    for (let x = right - 14; x <= right + 2; x++) s += coverage(p, x, y, frame, toolbar);
    out.cornerInsets.push(Math.round(right - (right - 14 + s)));
  }
  // flare expansion on the right, rows 31..39
  out.flare = [];
  for (let y = 31; y <= 39; y++) {
    let s = 0;
    for (let x = right - 2; x <= right + 18; x++) s += coverage(p, x, y, frame, toolbar);
    out.flare.push(Math.round(right - 2 + s - right));
  }
  // search button box (at rest)
  const btn = p.rgb(c.btn);
  let bx0 = null, bx1 = null, by0 = null, by1 = null;
  for (let x = 4; x < 46; x++) if (p.dist(p.px(x, 20), btn) < 6) { if (bx0 === null) bx0 = x; bx1 = x; }
  for (let y = 0; y < 40; y++) if (p.dist(p.px(27, y), btn) < 6) { if (by0 === null) by0 = y; by1 = y; }
  out.searchBtn = { x0: bx0, x1: bx1, y0: by0, y1: by1 };
  // glyph ink inside the active tab
  const activeInk = (col) => p.dist(col, toolbar) > 200;
  out.favicon = inkBox(p, left + 2, left + 28, 8, 34, (col) => p.dist(col, toolbar) > 150);
  out.title = inkBox(p, left + 29, left + 120, 8, 34, (col) => p.dist(col, toolbar) > 250);
  out.closeX = inkBox(p, right - 26, right - 4, 10, 30, (col) => p.dist(col, toolbar) > 250);
  return out;
}

// States that need the mouse / rest: separators, the + glyph, and the hover pill of the SECOND tab.
function measureRest(p, c) {
  const sep = p.rgb(c.sep), frame = p.rgb(c.frame);
  const out = {};
  // separator after tab 2 (expected x 520..521, y 12..27) and its neighbours
  out.sepCols = [519, 520, 521, 522].map((x) => p.dist(p.px(x, 20), sep) < 6);
  let y0 = null, y1 = null;
  for (let y = 0; y < 44; y++) if (p.dist(p.px(520, y), sep) < 6) { if (y0 === null) y0 = y; y1 = y; }
  out.sepRows = { y0, y1 };
  out.sepAfterActive = p.dist(p.px(282, 20), sep) < 6 || p.dist(p.px(283, 20), sep) < 6; // must be hidden next to the active tab
  out.plus = inkBox(p, 762, 800, 8, 34, (col) => p.dist(col, frame) > 200);
  return out;
}

function measureHover(p, c) {
  const pill = p.rgb(c.hover), frame = p.rgb(c.frame);
  const out = {};
  const isPill = (x, y) => p.dist(p.px(x, y), pill) < 6;
  // vertical extent at the tab's left part (x=300 is left of the favicon)
  let y0 = null, y1 = null;
  for (let y = 0; y < 44; y++) if (isPill(300, y) || isPill(290, y) && false) { if (y0 === null) y0 = y; y1 = y; }
  out.pillRows = { y0, y1 };
  let l = null, r = null;
  for (let x = 270; x < 560; x++) if (isPill(x, 20)) { if (l === null) l = x; r = x; }
  out.pillCols = { l, r };
  // corner insets on the right edge, rows 6..13 (expected 7 5 3 2 2 1 1 0 relative to right edge+1)
  out.cornerInsets = [];
  for (let y = 6; y <= 13; y++) {
    let s = 0;
    for (let x = 500; x <= 530; x++) s += coverage(p, x, y, frame, pill);
    out.cornerInsets.push(Math.round((r + 1) - (500 + s)));
  }
  return out;
}

module.exports = { makeProbe, measureStrip, measureRest, measureHover, inkBox, coverage };

// ── stand-alone run: print the numbers for the current light/dark mode ─────────────────────────
// (require.main is not reliable under Electron, so check the script path)
if (process.argv.some((a) => /chrome-reference[\/]measure\.js$/.test(a))) {
  const { app, nativeTheme } = require("electron");
  const fs = require("fs");
  const os = require("os");
  const constants = require("../../electron/constants");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-measure-"));
  constants.dataDir = () => path.join(tmp, "UserData");
  require("../../electron/main.js");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  app.whenReady().then(async () => {
    await sleep(3500);
    const state = require("../../electron/state");
    const tm = require("../../electron/tabs/tabManager");
    const win = state.mainWindow;
    console.log("step: window ready");
    win.setContentSize(1200, 700);
    await sleep(500);
    state.tabs[0].view.webContents.loadURL("about:blank").catch(() => {});
    tm.createTab("about:blank");
    tm.createTab("about:blank");
    await sleep(2500);
    tm.switchTab(state.tabs[0].id);
    await sleep(1200);
    for (const mode of ["light", "dark"]) {
      nativeTheme.themeSource = mode;
      await sleep(1800);
      console.log("step: capturing", mode);
      await win.webContents.capturePage({ x: 0, y: 0, width: 10, height: 10 }); // the first capture after a theme flip can be a stale frame
      await sleep(300);
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 44 });
      const p = makeProbe(img);
      const pal = mode === "light"
        ? { frame: "D3E3FD", toolbar: "FFFFFF", btn: "ECF3FE", sep: "A8C7FA", hover: "A8C7FA" }
        : { frame: "1F2020", toolbar: "3C3C3C", btn: "3C3C3C", sep: "3C3C3C", hover: "004A77" };
      console.log(mode, JSON.stringify(measureStrip(p, pal)));
      console.log(mode, "rest", JSON.stringify(measureRest(p, pal)));
      // hover the 2nd tab (slot centre)
      const sh = win.webContents;
      const t2 = await sh.executeJavaScript(`(()=>{const r=document.querySelectorAll(".tab")[1].getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:20}})()`);
      for (let i = 0; i < 6; i++) { sh.sendInputEvent({ type: "mouseMove", x: t2.x - 3, y: 20 }); await sleep(40); sh.sendInputEvent({ type: "mouseMove", x: t2.x, y: 20 }); await sleep(200); }
      await sleep(300);
      const img2 = await win.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 44 });
      console.log(mode, "hover", JSON.stringify(measureHover(makeProbe(img2), pal)));
      sh.sendInputEvent({ type: "mouseMove", x: 700, y: 300 });
      await sleep(600);
    }
    app.exit(0);
  });
}
