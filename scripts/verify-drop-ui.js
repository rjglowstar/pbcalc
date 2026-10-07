// The UI side of dragging a file in from Explorer, as Chrome does it (measured from the owner's Chrome screenshots):
//  - Windows refuses a drop on a window's caption (OS drag) region, and PBCalc's empty tab strip IS one -> it showed the "not
//    allowed" sign. While a file drag is over the window (or over a page, relayed by main) the strip must be an ordinary area.
//  - Over the strip a drop arrow shows the slot of the new tab: between two tabs, or after the last one (Chrome's arrow).
//  - The file opens in a NEW tab AT that slot (the owner chose "always a new tab" over Chrome's replace-the-tab).
// Hit-testing is asked of Windows itself (WM_NCHITTEST: 2 = caption = refuses drops, 1 = client) - not inferred from CSS.
// Drags are trusted protocol events (Input.dispatchDragEvent). Run:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-drop-ui.js
const { app } = require("electron");
const { exec } = require("child_process");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 200000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-dropui-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const SIG = 'Add-Type -Namespace W -Name N -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);\';';

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const win = state.mainWindow, shell = win.webContents;
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const dir = path.join(tmp, "f"); fs.mkdirSync(dir);
    const file = (n) => { const p = path.join(dir, n); fs.writeFileSync(p, "x"); return p; };
    const a = file("a.txt"), b = file("b.txt"), c = file("c.png");
    const urls = () => state.tabs.map((t) => t.view.webContents.getURL());
    const active = () => state.tabs.find((t) => t.id === state.activeTabId);
    // Windows' own answer for a point of the window (client coordinates of the content area)
    const hit = (x, y) => new Promise((res) => {
      const cb = win.getContentBounds(), sx = Math.round(cb.x + x), sy = Math.round(cb.y + y);
      exec('powershell -NoProfile -Command "' + (SIG + "[W.N]::SendMessage([IntPtr]" + hwnd + ", 0x84, [IntPtr]0, [IntPtr]" + (((sy & 0xffff) << 16) | (sx & 0xffff)) + ")").replace(/"/g, '\\"') + '"', (e, so) => res(Number((so || "").trim())));
    });
    const dbg = (wc) => { if (!wc.debugger.isAttached()) wc.debugger.attach("1.3"); return wc.debugger; };
    // a real drag repeats dragover every ~50ms even while the pointer rests; one protocol event per position is not always delivered, so rest a moment and repeat
    const dragTo = async (wc, type, x, y, files) => {
      const send = () => dbg(wc).sendCommand("Input.dispatchDragEvent", { type, x, y, data: { items: [], files, dragOperationsMask: 1 } });
      await send(); await sleep(120);
      if (type === "dragOver") { await send(); await sleep(120); }
    };
    const dom = (js) => shell.executeJavaScript(js);
    // the region the OS sees is updated on the shell's next frame: ask until it settles (and say how long it took)
    const settle = async (x, y, want) => { const t0 = Date.now(); let h; do { h = await hit(x, y); if (h === want) break; await sleep(100); } while (Date.now() - t0 < 3000); settle.last = Date.now() - t0; return h; };

    const base = "data:text/html,<title>t</title>hello";
    tm.createTab(base + "1"); tm.createTab(base + "2"); tm.createTab(base + "3"); await sleep(2500);
    const rects = await dom('Array.from(document.querySelectorAll(".tab:not(.closing)")).map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; }).sort((x, y) => x.l - y.l)');
    const n = rects.length;
    const gapX = rects[n - 1].r + 150;       // empty part of the strip, right of the + button
    // an empty part of the strip RIGHT NOW (the tabs move as more open)
    const gapNow = async () => { const r = await dom('Array.from(document.querySelectorAll(".tab:not(.closing)")).map((e) => e.getBoundingClientRect().right).reduce((m, v) => Math.max(m, v), 0)'); return r + 150; };
    const arrow = () => dom('(() => { const a = document.getElementById("drop-arrow"); return { hidden: !a.classList.contains("show"), left: parseFloat(a.style.left), drag: document.body.classList.contains("file-drag") }; })()');

    console.log("-- the empty strip is refused by Windows - until a file drag is on");
    check("idle: the empty strip is the OS drag region (WM_NCHITTEST = caption), so window dragging still works", (await settle(gapX, 20, 2)) === 2);
    await dragTo(shell, "dragEnter", 600, 70, [a]);
    check("file drag over the toolbar: the strip is now an ordinary area (WM_NCHITTEST = client)", (await settle(gapX, 20, 1)) === 1 && (await arrow()).drag === true);
    check("...no arrow over the toolbar", (await arrow()).hidden === true);
    await dragTo(shell, "dragCancel", 600, 70, [a]);
    await dragTo(shell, "dragEnter", 5, 70, [a]); await dragTo(shell, "dragCancel", 5, 70, [a]);

    console.log("\n-- the drop arrow marks the slot");
    await dragTo(shell, "dragEnter", gapX, 20, [a]);
    await dragTo(shell, "dragOver", gapX, 20, [a]);
    let st = await arrow();
    check("over the empty strip: arrow shown after the last tab", !st.hidden && Math.abs(st.left - rects[n - 1].r) < 1.5);
    await dragTo(shell, "dragOver", rects[1].l + 10, 20, [a]);
    st = await arrow();
    check("left half of tab 2: arrow on the edge before tab 2", !st.hidden && Math.abs(st.left - rects[1].l) < 1.5);
    await dragTo(shell, "dragOver", rects[1].l + rects[1].w - 10, 20, [a]);
    st = await arrow();
    check("right half of tab 2: arrow on the edge before tab 3", !st.hidden && Math.abs(st.left - rects[2].l) < 1.5);
    await dragTo(shell, "dragOver", rects[0].l + 5, 20, [a]);
    st = await arrow();
    check("left half of tab 1: arrow at the very start", !st.hidden && Math.abs(st.left - rects[0].l) < 1.5);
    await dragTo(shell, "dragOver", 600, 70, [a]);
    check("moving down to the toolbar hides the arrow", (await arrow()).hidden === true);
    await dragTo(shell, "dragCancel", 600, 70, [a]);
    await sleep(1200);
    check("a cancelled drag puts everything back by itself (strip is the drag region again, no arrow)", (await arrow()).drag === false && (await settle(gapX, 20, 2)) === 2);

    console.log("\n-- the file opens at the slot");
    let before = urls();
    await dragTo(shell, "dragEnter", rects[1].l + rects[1].w - 10, 20, [a]);
    await dragTo(shell, "dragOver", rects[1].l + rects[1].w - 10, 20, [a]);
    await dragTo(shell, "drop", rects[1].l + rects[1].w - 10, 20, [a]); await sleep(1500);
    let after = urls();
    check("dropped before tab 3: one new tab, and it sits at position 2", after.length === before.length + 1 && /a\.txt$/.test(after[2]) && after[0] === before[0] && after[1] === before[1] && after[3] === before[2]);
    check("...it is the tab in front", /a\.txt$/.test(active().view.webContents.getURL()));
    check("...the drop put the strip and arrow back to idle", (await arrow()).drag === false && (await arrow()).hidden === true);
    before = urls();
    await dragTo(shell, "dragEnter", gapX, 20, [b, c]);
    await dragTo(shell, "drop", gapX, 20, [b, c]); await sleep(1500);
    after = urls();
    check("dropped on the empty strip: both files open at the END, in order", after.length === before.length + 2 && /b\.txt$/.test(after[after.length - 2]) && /c\.png$/.test(after[after.length - 1]));
    before = urls();
    const r2 = await dom('(() => { const r = document.getElementById("new-tab").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    await dragTo(shell, "dragEnter", r2.x, r2.y, [a]);
    await dragTo(shell, "drop", r2.x, r2.y, [a]); await sleep(1500);
    after = urls();
    check("dropped on the + button: a new tab at the end", after.length === before.length + 1 && /a\.txt$/.test(after[after.length - 1]));
    before = urls();
    await dragTo(shell, "dragEnter", 600, 70, [b]);
    await dragTo(shell, "drop", 600, 70, [b]); await sleep(1500);
    after = urls();
    check("dropped on the toolbar: a new tab at the end (no slot)", after.length === before.length + 1 && /b\.txt$/.test(after[after.length - 1]));

    console.log("\n-- a drag that starts over a PAGE (main relays it to the shell)");
    // the files opened above filled the strip: close them so an empty part of the strip exists again
    for (const t of state.tabs.slice(4)) tm.closeTab(t.id);
    await sleep(1200);
    tm.switchTab(state.tabs[0].id); await sleep(800);
    const gapP = await gapNow();
    const page = state.tabs[0].view.webContents;
    check("before: the strip is the drag region", (await settle(gapP, 20, 2)) === 2);
    await dragTo(page, "dragEnter", 300, 300, [a]);
    await dragTo(page, "dragOver", 300, 300, [a]);
    check("file drag over a page: the shell strip is a drop target at once (client)", (await settle(gapP, 20, 1)) === 1);
    await dragTo(page, "dragCancel", 300, 300, [a]);
    check("...and drag region again when the drag leaves (cancelled: no dragleave needed)", (await settle(gapP, 20, 2)) === 2);
    await dragTo(page, "dragEnter", 300, 300, [a]);
    await dragTo(page, "drop", 300, 300, [a]); await sleep(1200);
    check("a drop on the page ends the state too (strip is the drag region again)", (await settle(await gapNow(), 20, 2)) === 2);   // the dropped file opened a tab: measure the empty part again

    // a drag that just stops (Esc / released elsewhere) without any dragleave: the strip must not stay un-draggable
    await dragTo(page, "dragEnter", 300, 300, [a]); await dragTo(page, "dragOver", 300, 300, [a]);
    check("drag begins again: strip is a drop target", (await settle(await gapNow(), 20, 1)) === 1);
    await sleep(1500);
    check("no more dragover for 1.5s: the strip is the drag region again by itself", (await settle(await gapNow(), 20, 2)) === 2);

    console.log("\n-- tab drag-reorder is not disturbed (its own drops are not file drops)");
    const nb = state.tabs.length;
    await shell.executeJavaScript('(() => { const t = document.querySelectorAll(".tab")[0]; t.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() })); return 1; })()');
    check("a synthetic tab drag does not open anything", state.tabs.length === nb);

    console.log("\n-- Restricted Mode");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    const rr = await dom('Array.from(document.querySelectorAll(".tab:not(.closing)")).map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; }).sort((x, y) => x.l - y.l)');
    const gap2 = await gapNow();
    await dragTo(shell, "dragEnter", gap2, 20, [a]);
    await dragTo(shell, "dragOver", gap2, 20, [a]);
    check("Restricted: strip accepts the drag and shows the arrow", (await settle(gap2, 20, 1)) === 1 && !(await arrow()).hidden);
    const rb = urls();
    await dragTo(shell, "drop", gap2, 20, [a]); await sleep(1500);
    check("Restricted: the file opens as a new tab at the end", urls().length === rb.length + 1 && /a\.txt$/.test(urls()[urls().length - 1]));
    check("Restricted: the strip is the drag region again after the drop", (await settle(await gapNow(), 20, 2)) === 2);
    tm.leaveRestricted(); await sleep(800);
    check("no uncaught error", errors.length === 0);
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_DROPUI total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
