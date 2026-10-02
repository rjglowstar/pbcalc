// Dark mode is for PBCalc's own UI, never for the web page.
// Chrome, measured with --force-dark-mode (scripts/chrome-reference/capture-darkmode.ps1):
//   a page reports prefers-color-scheme: dark, but its canvas is still painted WHITE (255,255,255).
// PBCalc used to paint it #3C3C3C, which made ordinary light sites look dark-themed.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-theme.js
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-theme-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("WATCHDOG after " + results.length); app.exit(2); }, 120000).unref();

// a page that styles nothing: its canvas colour is entirely the browser's decision
let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><title>Plain</title><body>plain page</body>');
  });
  srv.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + srv.address().port + "/"; resolve(); });
});

require("../electron/main.js");

app.whenReady().then(async () => {
  await ready;
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const win = state.mainWindow;

  // average colour of a small patch, as painted (alpha included: a transparent patch is not white)
  const patch = async (wc, x, y) => {
    await wc.capturePage({ x, y, width: 6, height: 6 });
    const b = (await wc.capturePage({ x, y, width: 6, height: 6 })).toBitmap();
    let r = 0, g = 0, bl = 0, a = 0, n = 0;
    for (let i = 0; i < b.length; i += 4) { bl += b[i]; g += b[i + 1]; r += b[i + 2]; a += b[i + 3]; n++; }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(bl / n), a: Math.round(a / n) };
  };
  const isWhite = (p) => p.a > 200 && p.r > 240 && p.g > 240 && p.b > 240;
  const isDark = (p) => p.a > 200 && p.r < 90 && p.g < 90 && p.b < 90;

  tm.createTab(base);
  await sleep(2500);
  const site = () => state.tabs.find((t) => String(t.url).startsWith(base)).view.webContents;

  for (const mode of ["light", "dark"]) {
    tm.applyThemeMode(mode);
    await sleep(900);
    site().reload();
    await sleep(1800);
    const p = await patch(site(), 40, 80);
    const pcs = await site().executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches');
    console.log("     " + mode + ": page patch=" + JSON.stringify(p) + " prefers-color-scheme-dark=" + pcs);
    check(`[${mode}] an unstyled web page is painted white, as in Chrome`, isWhite(p));
    check(`[${mode}] ...and the page is told the real colour scheme (Chrome does the same)`, pcs === (mode === "dark"));
  }

  // ...while PBCalc's own surfaces DO follow the setting
  tm.applyThemeMode("dark");
  await sleep(900);
  const strip = await patch(win.webContents, 600, 8);
  check("in dark mode the tab strip is dark", isDark(strip));
  const nt = state.tabs.find((t) => t.title === "New Tab");
  // capturePage never resolves for a view that is not attached to the window: show the tab first
  tm.switchTab(nt.id);
  await sleep(900);
  const ntPatch = await patch(nt.view.webContents, 300, 300);
  check("...and so is our own New Tab page", isDark(ntPatch));
  tm.openSettings();
  await sleep(1800);
  const st = state.tabs.find((t) => t.title === "Settings");
  check("...and the Settings page", isDark(await patch(st.view.webContents, 60, 300)));

  tm.applyThemeMode("light");
  await sleep(900);
  check("in light mode the tab strip is light again", !isDark(await patch(win.webContents, 600, 8)));
  console.log("     strip(dark)=" + JSON.stringify(strip));

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_THEME total=" + results.length + " failed=" + failed.length);
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
