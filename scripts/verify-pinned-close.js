// Ctrl+W on a PINNED tab, like Chrome (electron/pinToast.js; owner 2026-10-14, from their Chrome screenshots): the first Ctrl+W does NOT close it and shows
// "Press Ctrl+W again to close the pinned tab" (304x50 pill, #062E6F / #F2F2F2 light, #ECF3FE / #1F1F1F dark, centred on the line where the page starts);
// the second Ctrl+W while it shows closes the tab. Real key events (sendInputEvent to the page that holds focus). Also: an ordinary tab closes at once, the
// menu's Close closes a pinned tab at once, choosing another tab or waiting ends the notice (the next Ctrl+W asks again), dark mode, Restricted Mode.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-pinned-close.js
const { app, nativeTheme } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbpc-"));
const ud = path.join(tmp, "UserData");
require("../electron/constants").dataDir = () => ud;
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: false, themeMode: "light" }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, total = 0;
const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 300) + ">" : "")); };

(async () => {
  require("../electron/main.js");
  await app.whenReady();
  const state = require("../electron/state"), tm = require("../electron/tabs/tabManager"), toast = require("../electron/pinToast");
  for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);
  const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<title>" + q.url.slice(1) + "</title>x"); }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = "http://127.0.0.1:" + srv.address().port + "/";
  const open = async (n) => { tm.createTab(base + n); await sleep(700); return state.tabs[state.tabs.length - 1]; };
  // Ctrl+W as the OS sends it: to the page that has the keyboard (the active tab)
  const ctrlW = async () => { const wc = tm.getActiveTab().view.webContents; wc.focus(); await sleep(80); wc.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers: ["control"] }); wc.sendInputEvent({ type: "keyUp", keyCode: "W", modifiers: ["control"] }); await sleep(900); };
  const toastView = () => state.mainWindow.getBrowserViews().find((v) => !v.webContents.isDestroyed() && /pintoast/.test(v.webContents.getURL()));
  const toastLook = async () => {
    const v = toastView(); if (!v) return null;
    const b = v.getBounds(); const [cw] = state.mainWindow.getContentSize();
    const css = await v.webContents.executeJavaScript("(() => { const t = document.getElementById('t'); const s = getComputedStyle(t); return { text: t.innerText.trim(), bg: s.backgroundColor, fg: s.color, radius: s.borderTopLeftRadius }; })()");
    return { ...css, b, centredX: Math.abs(b.x + b.width / 2 - cw / 2) <= 1, centreY: b.y + b.height / 2, line: tm.chromeHeight() };
  };

  console.log("-- a pinned tab and Ctrl+W");
  const a = await open("A"), p = await open("P");
  tm.pinTab(p.id, true); tm.switchTab(p.id); await sleep(500);
  await ctrlW();
  check("the FIRST Ctrl+W does not close the pinned tab", state.tabs.includes(p));
  const L = await toastLook();
  check("...and shows the notice 'Press Ctrl+W again to close the pinned tab'", L && L.text === "Press Ctrl+W again to close the pinned tab", JSON.stringify(L));
  check("...a 50px pill about 304px wide, centred across the window (" + (L && L.b.width) + "x" + (L && L.b.height) + ")", L && L.b.height === 50 && Math.abs(L.b.width - 304) <= 24 && L.radius === "25px" && L.centredX, JSON.stringify(L && { b: L.b, radius: L.radius }));
  check("...centred on the line where the page starts (Chrome: across the toolbar's lower edge)", L && Math.abs(L.centreY - L.line) <= 1, JSON.stringify(L && { centreY: L.centreY, line: L.line }));
  check("...in Chrome's light colours #062E6F / #F2F2F2", L && L.bg === "rgb(6, 46, 111)" && L.fg === "rgb(242, 242, 242)", JSON.stringify(L && [L.bg, L.fg]));
  await ctrlW();
  check("the SECOND Ctrl+W closes it, and the notice goes", !state.tabs.includes(p) && !toastView());

  console.log("-- what ends the notice");
  const p2 = await open("P2"); tm.pinTab(p2.id, true); tm.switchTab(p2.id); await sleep(500);
  await ctrlW();
  check("(notice up for the next pinned tab)", !!toastView() && state.tabs.includes(p2));
  tm.switchTab(a.id); await sleep(400);
  check("choosing another tab removes the notice", !toastView());
  tm.switchTab(p2.id); await sleep(400);
  await ctrlW();
  check("...and then the next Ctrl+W on the pinned tab asks again (does not close)", state.tabs.includes(p2) && !!toastView());
  await sleep(toast.SHOW_MS + 600);
  check("the notice goes by itself after " + toast.SHOW_MS / 1000 + " s", !toastView());
  await ctrlW();
  check("...and after that a Ctrl+W asks again", state.tabs.includes(p2) && !!toastView());
  tm.closeTab(p2.id); await sleep(400);   // = the right-click menu's "Close"
  check("the menu's Close closes a pinned tab at once (and removes the notice)", !state.tabs.includes(p2) && !toastView());

  console.log("-- an ordinary tab");
  const o = await open("O"); tm.switchTab(o.id); await sleep(400);
  await ctrlW();
  check("Ctrl+W on an ordinary tab closes it at once, no notice", !state.tabs.includes(o) && !toastView());

  console.log("-- dark mode");
  nativeTheme.themeSource = "dark"; await sleep(300);
  const d = await open("D"); tm.pinTab(d.id, true); tm.switchTab(d.id); await sleep(400);
  await ctrlW();
  const LD = await toastLook();
  check("in dark mode: #ECF3FE / #1F1F1F", LD && LD.bg === "rgb(236, 243, 254)" && LD.fg === "rgb(31, 31, 31)", JSON.stringify(LD && [LD.bg, LD.fg]));
  await ctrlW();
  check("...and the second Ctrl+W closes it", !state.tabs.includes(d));
  nativeTheme.themeSource = "light";

  console.log("-- Restricted Mode");
  tm.enableRestricted(); await sleep(1500);
  tm.createTab(null, { allowRestricted: true }); await sleep(800);
  const r = state.tabs[state.tabs.length - 1];
  tm.pinTab(r.id, true); tm.switchTab(r.id); await sleep(400);
  const nBefore = state.tabs.length;
  await ctrlW();
  check("in Restricted Mode too: the first Ctrl+W on a pinned tab shows the notice and keeps it", state.tabs.includes(r) && !!toastView() && state.tabs.length === nBefore);
  await ctrlW();
  check("...the second closes it", !state.tabs.includes(r));
  srv.close();
  console.log("\nPBCALC_PINCLOSE total=" + total + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
