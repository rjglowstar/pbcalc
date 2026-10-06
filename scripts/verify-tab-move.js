// Dragging a tab to a new position - in normal AND in Restricted Mode (it was blocked in Restricted Mode: both the strip
// (draggable=false) and the main process (moveTab) refused).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-tab-move.js
const { app, ipcMain } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 150000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-tabmove-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const win = state.mainWindow, shell = win.webContents;
    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>" + q.url.slice(1) + "</title>x"); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const ids = () => state.tabs.map((t) => t.id);
    // the strip's elements in strip order (each tab element carries its position in style.order)
    const dragTab = (from, to, side) => shell.executeJavaScript(`(() => {
      const els = [...document.querySelectorAll(".tab")].sort((a, b) => Number(a.style.order) - Number(b.style.order));
      const f = els[${from}], t = els[${to}];
      const dt = new DataTransfer();
      const r = t.getBoundingClientRect();
      const x = ${JSON.stringify(side)} === "after" ? r.right - 3 : r.left + 3;
      const mk = (type, el, cx) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: r.top + 10 }));
      mk("dragstart", f, f.getBoundingClientRect().left + 5);
      mk("dragover", t, x);
      mk("drop", t, x);
      mk("dragend", f, x);
      return els.length;
    })()`);
    const allDraggable = () => shell.executeJavaScript('[...document.querySelectorAll(".tab")].filter(e => !e.classList.contains("closing")).every(e => e.draggable === true)');

    for (const mode of ["normal", "restricted"]) {
      console.log("\n-- " + mode + " mode");
      if (mode === "restricted") {
        tm.secretToggle(); await sleep(2800);
        check("Restricted Mode is on", state.restricted === true);
        tm.createTab(undefined, { allowRestricted: true }); await sleep(700);
        tm.createTab(undefined, { allowRestricted: true }); await sleep(700);
      } else {
        for (const n of ["A", "B", "C"]) { tm.createTab(base + "/" + n); await sleep(800); }
      }
      const n = state.tabs.length;
      check("setup: at least 3 tabs", n >= 3);
      check("every tab in the strip is draggable", await allDraggable());
      const before = ids();
      const lastId = before[before.length - 1], firstId = before[0];
      // drag the LAST tab onto the left half of the FIRST one -> it becomes first
      await dragTab(n - 1, 0, "before"); await sleep(600);
      let now = ids();
      check("dragging the last tab to the front moves it there", now[0] === lastId && now.length === n && now.slice(1).join() === before.slice(0, n - 1).join());
      // drag the (new) first tab onto the right half of the last one -> it becomes last
      await dragTab(0, n - 1, "after"); await sleep(600);
      now = ids();
      check("dragging it back to the end moves it there", now[n - 1] === lastId && now.join() === before.join());
      // the moved tabs are still the same tabs
      check("no tab was lost, duplicated or recreated", new Set(now).size === n && now.every((id) => before.includes(id)));
      // the direct IPC (the strip uses it): shell only
      const target = ids()[1];
      tm.moveTab(target, 0); await sleep(300);
      check("tabManager.moveTab works", ids()[0] === target);
      tm.moveTab(target, 1); await sleep(300);
    }
    check("Restricted Mode is still locked after the moves", state.restricted === true);
    tm.leaveRestricted(); await sleep(800);
    check("no uncaught error", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_TABMOVE total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
