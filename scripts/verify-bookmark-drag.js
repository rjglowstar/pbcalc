// Drag-to-reorder on the bookmarks bar (Chrome behaviour), and Restricted Mode staying read/open only.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-bookmark-drag.js
// If the PC has a second display the window is moved there first, so the owner can keep working on the main one.
const { app, screen, ipcMain } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-bmd-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const bm = require("../electron/bookmarks/bookmarkStore");
    const win = state.mainWindow;
    const shell = win.webContents;

    // second display, if any
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const other = displays.find((d) => d.id !== primary.id);
    win.unmaximize(); await sleep(300);
    if (other) win.setBounds({ x: other.workArea.x + 40, y: other.workArea.y + 40, width: 1400, height: 800 });
    console.log("displays: " + displays.length + (other ? " - test window is on the second one" : " - only one display, test window stays on it"));
    win.setAlwaysOnTop(true); win.show(); win.focus(); await sleep(500);

    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>" + q.url + "</title>page " + q.url); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const urlOf = (n) => base + "/" + n;
    for (const n of ["A", "B", "C", "D"]) bm.toggle({ url: urlOf(n), title: n, favicon: "" });
    tm.broadcastBookmarks(); await sleep(600);
    if (!state.bookmarksBarVisible) { tm.toggleBookmarksBar(); await sleep(500); }
    const file = path.join(tmp, "UserData", "bookmarks.json");
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")).map((b) => b.title).join(""); } catch (_) { return null; } };
    const order = () => bm.list().map((b) => b.title).join("");
    const bar = () => shell.executeJavaScript('[...document.querySelectorAll(".bookmark .bookmark-title")].map(e => e.textContent).join("")');
    const rectOf = (title) => shell.executeJavaScript(`(() => { const e = [...document.querySelectorAll(".bookmark")].find(x => x.textContent.trim() === ${JSON.stringify(title)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) }; })()`);
    const reset = async () => { for (const [i, n] of ["A", "B", "C", "D"].entries()) bm.moveTo(bm.list().find((b) => b.title === n).id, i); tm.broadcastBookmarks(); await sleep(500); };
    check("setup: bar shows A B C D", (await bar()) === "ABCD");

    console.log("\n-- store: moveTo");
    const id = (n) => bm.list().find((b) => b.title === n).id;
    bm.moveTo(id("A"), 3); check("A to the end -> BCDA", order() === "BCDA");
    bm.moveTo(id("D"), 0); check("D to the front -> DBCA", order() === "DBCA");
    check("saved to bookmarks.json", onDisk() === "DBCA");
    bm.moveTo(id("D"), 99); check("an index past the end is clamped (D last) -> BCAD", order() === "BCAD");
    bm.moveTo(id("D"), -5); check("a negative index is clamped (D first) -> DBCA", order() === "DBCA");
    bm.moveTo("nope", 1); bm.moveTo(id("B"), NaN); check("unknown id / bad index change nothing", order() === "DBCA");
    check("nothing is lost or duplicated", bm.list().length === 4 && new Set(bm.list().map((b) => b.id)).size === 4);
    await reset();

    console.log("\n-- the bar: real pointer drag (A dropped on the right half of C)");
    const drag = async (fromT, toT, side, hold) => {
      const a = await rectOf(fromT), t = await rectOf(toT);
      const x1 = a.cx, y = a.y, x2 = side === "after" ? t.x + t.w - 4 : t.x + 4;
      shell.sendInputEvent({ type: "mouseMove", x: x1, y });
      await sleep(80);
      shell.sendInputEvent({ type: "mouseDown", x: x1, y, button: "left", clickCount: 1 });
      for (let i = 1; i <= 12; i++) { shell.sendInputEvent({ type: "mouseMove", x: Math.round(x1 + ((x2 - x1) * i) / 12), y, button: "left" }); await sleep(30); }
      await sleep(250);
      const mid = hold ? await hold() : null;
      shell.sendInputEvent({ type: "mouseUp", x: x2, y, button: "left", clickCount: 1 });
      await sleep(900);
      return mid;
    };
    const line = () => shell.executeJavaScript('(() => { const e = document.querySelector(".bookmark.drop-before, .bookmark.drop-after"); return e ? { t: e.textContent.trim(), c: e.classList.contains("drop-after") ? "after" : "before" } : null; })()');
    const dragging = () => shell.executeJavaScript('!!document.querySelector(".bookmark.dragging")');
    let mid = await drag("A", "C", "after", async () => ({ line: await line(), dragging: await dragging() }));
    const realWorked = order() === "BCAD";
    if (realWorked) {
      check("A moved after C -> BCAD", true);
      check("a line showed where it would land (after C) while dragging", mid && mid.line && mid.line.t === "C" && mid.line.c === "after");
      check("the dragged bookmark was dimmed while dragging", mid && mid.dragging === true);
      check("the line and dimming are gone afterwards", !(await line()) && !(await dragging()));
      check("the bar shows the new order", (await bar()) === "BCAD");
      check("and it is saved", onDisk() === "BCAD");
      await reset();
      await drag("D", "B", "before");
      check("D dropped on the left half of B -> ADBC", order() === "ADBC");
      await reset();
      await drag("A", "D", "after");
      check("A dropped after the LAST one -> BCDA", order() === "BCDA");
      await reset();
      await drag("B", "B", "after");
      check("dropping on itself changes nothing", order() === "ABCD");
      // a plain click must still open the bookmark
      const r = await rectOf("B");
      shell.sendInputEvent({ type: "mouseMove", x: r.cx, y: r.y }); await sleep(60);
      shell.sendInputEvent({ type: "mouseDown", x: r.cx, y: r.y, button: "left", clickCount: 1 });
      shell.sendInputEvent({ type: "mouseUp", x: r.cx, y: r.y, button: "left", clickCount: 1 });
      await sleep(1500);
      const t = state.tabs.find((x) => x.id === state.activeTabId);
      check("a plain click on a bookmark still opens it", t && t.url === urlOf("B"));
    } else {
      console.log("   (synthetic pointer input did not start a drag here - Chromium's drag loop needs real OS input; falling back to dispatched drag events)");
    }

    console.log("\n-- the bar: drag events dispatched on the elements (what Chromium fires for a real drag)");
    await reset();
    const fire = (fromT, toT, clientXFrac) => shell.executeJavaScript(`(() => {
      const els = [...document.querySelectorAll(".bookmark")];
      const from = els.find(x => x.textContent.trim() === ${JSON.stringify(fromT)});
      const to = els.find(x => x.textContent.trim() === ${JSON.stringify(toT)});
      const dt = new DataTransfer();
      const r = to.getBoundingClientRect();
      const x = r.left + r.width * ${clientXFrac};
      const mk = (type, el, cx) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: r.top + 5 }));
      mk("dragstart", from, from.getBoundingClientRect().left + 5);
      mk("dragover", to, x);
      const mid = { cls: to.className, dragging: from.classList.contains("dragging") };
      mk("drop", to, x);
      mk("dragend", from, x);
      return mid;
    })()`);
    let m = await fire("A", "C", 0.9); await sleep(800);
    check("[events] dragover shows the line after C and dims A", /drop-after/.test(m.cls) && m.dragging === true);
    check("[events] A dropped after C -> BCAD", order() === "BCAD" && (await bar()) === "BCAD");
    await reset(); await fire("D", "B", 0.1); await sleep(800);
    check("[events] D dropped before B -> ADBC", order() === "ADBC");
    await reset(); await fire("A", "D", 0.9); await sleep(800);
    check("[events] A dropped after the last -> BCDA", order() === "BCDA");
    await reset(); await fire("B", "B", 0.9); await sleep(500);
    check("[events] dropping on itself changes nothing", order() === "ABCD");
    // drop on the empty part of the bar = last
    await shell.executeJavaScript(`(() => { const bar = document.getElementById("bookmark-bar"); const from = [...document.querySelectorAll(".bookmark")].find(x => x.textContent.trim() === "A"); const dt = new DataTransfer(); from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt })); bar.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt })); bar.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt })); from.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt })); return 0; })()`);
    await sleep(800);
    check("[events] dropping on the empty bar puts it last -> BCDA", order() === "BCDA");
    await reset();

    console.log("\n-- IPC");
    const before = order();
    ipcMain.emit("bookmarks:move", { sender: state.tabs.find((x) => x.id === state.activeTabId).view.webContents }, id("A"), 3); await sleep(300);
    check("a web page cannot reorder over IPC", order() === before);
    ipcMain.emit("bookmarks:move", { sender: shell }, id("A"), 3); await sleep(500);
    check("the shell can", order() === "BCDA");
    await reset();

    console.log("\n-- Restricted Mode: read and open only");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    check("bookmarks on the bar are not draggable", await shell.executeJavaScript('[...document.querySelectorAll(".bookmark")].length === 4 && [...document.querySelectorAll(".bookmark")].every(e => e.draggable === false)'));
    const b4 = order();
    ipcMain.emit("bookmarks:move", { sender: shell }, id("A"), 3); await sleep(500);
    check("main refuses the move even if asked", order() === b4);
    await fire("A", "C", 0.9); await sleep(800);
    check("dispatching drag events there changes nothing either", order() === b4 && onDisk() === b4);
    check("the bar still lists all four (read)", (await bar()) === b4);
    tm.leaveRestricted(); await sleep(800);
    check("back in normal mode they are draggable again", await shell.executeJavaScript('[...document.querySelectorAll(".bookmark")].every(e => e.draggable === true)'));
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_BOOKMARKDRAG total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
