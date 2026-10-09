// The calculator screen: shown at start when the installer's "start on the calculator screen" answer is set; wheels change the dummy prices;
// five quick presses of the gray "+" open the browser; closing the browser quits PBCalc (the calculator shows again only at the next start); nothing opens a
// browser tab behind it. Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-calc-screen.js
// (PBCALC_SHOTS=<dir> saves screenshots of the calculator)
const { app, session } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 150000).unref();
const PLAIN = process.env.PBCALC_TEST_PLAIN === "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-calc-"));
fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });
if (!PLAIN) fs.writeFileSync(path.join(tmp, "UserData", "settings.json"), JSON.stringify({ calculatorStart: true }));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
// What the user SEES while PBCalc opens on the calculator: the window is shown at opacity 0 and becomes visible (setOpacity(1)) only when everything is final -
// the browser's tab strip hidden, the calculator built, the window maximized, the page laid out at that size, the window buttons at the header's height.
// (Before: shown at once -> the calculator appeared small and grew, the window buttons went 40 -> 55 -> 63 px tall, the tab strip flashed.)
const { BrowserWindow, ipcMain } = require("electron");
let readyAt = 0, firstShowOpacity = null, reveal = null, overlayH = 0, overlayAfter = [];
ipcMain.on("calc:ready", () => { if (!readyAt) readyAt = Date.now(); });
const origOpacity = BrowserWindow.prototype.setOpacity;
BrowserWindow.prototype.setOpacity = function (v) {
  if (v === 1 && !reveal) {
    reveal = { at: Date.now(), overlayH, content: this.getContentBounds(), page: null };
    this.webContents.executeJavaScript('({ calcMode: document.body.classList.contains("calc-mode"), stage: !!document.querySelector(".c-stage"), parts: document.querySelectorAll(".c-card").length, strip: document.querySelector(".strip") ? getComputedStyle(document.querySelector(".strip")).display : "none", head: Math.round(document.querySelector(".c-head").getBoundingClientRect().height), w: innerWidth, h: innerHeight })', true)
      .then((r) => { reveal.page = r; }).catch(() => {});
  }
  return origOpacity.call(this, v);
};
const origOverlay = BrowserWindow.prototype.setTitleBarOverlay;
BrowserWindow.prototype.setTitleBarOverlay = function (o) { if (reveal && o.height !== reveal.overlayH) overlayAfter.push(o.height); overlayH = o.height; return origOverlay.call(this, o); };
app.on("browser-window-created", (_e, w) => {
  w.once("show", () => { firstShowOpacity = w.getOpacity(); });
  w.webContents.on("did-finish-load", () => { w.webContents.executeJavaScript("window.__rs = window.__rs || []; window.addEventListener('resize', () => window.__rs.push(Date.now()))", true).catch(() => {}); });
});
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };

(async () => {
  try {
    await app.whenReady(); await sleep(4500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const calc = require("../electron/calcMode");
    const theme = require("../electron/theme");
    const win = () => state.mainWindow;
    const shell = () => state.mainWindow.webContents;
    const js = (code) => shell().executeJavaScript(code, true);
    const shot = async (name) => { if (process.env.PBCALC_SHOTS) { fs.mkdirSync(process.env.PBCALC_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.PBCALC_SHOTS, name + ".png"), (await shell().capturePage()).toPNG()); } };

    if (PLAIN) {
      check("without the setting the browser starts as always (one tab, no calculator)", state.calcMode === false && state.tabs.length === 1 && !(await js('document.body.classList.contains("calc-mode")')));
      check("no uncaught error", errors.length === 0, errors.join("|"));
      console.log("PBCALC_CALCSCREEN total=" + results.length + " failed=" + results.filter((r) => !r.pass).length);
      return app.exit(results.some((r) => !r.pass) ? 1 : 0);
    }

    const rs = await js("window.__rs || []");
    check("the window is first shown at opacity 0 (nothing is seen while it maximizes and the calculator lays itself out)", firstShowOpacity === 0, firstShowOpacity);
    check("it becomes visible only AFTER the page said 'calculator built' (calc:ready)", readyAt > 0 && !!reveal && readyAt <= reveal.at, readyAt + " / " + (reveal && reveal.at));
    check("when it becomes visible the calculator is built, the browser's tab strip is hidden and the page is at the final (maximized) size", !!reveal && !!reveal.page && reveal.page.calcMode === true && reveal.page.stage === true && reveal.page.parts >= 1 && reveal.page.strip === "none" && reveal.page.w >= 1900 && Math.abs(reveal.page.h - reveal.content.height) <= 2, JSON.stringify(reveal));
    check("the window buttons already have the header's height at that moment (no 40 -> 55 -> 63 growing afterwards)", !!reveal && !!reveal.page && reveal.overlayH === reveal.page.head && overlayAfter.length === 0, (reveal && reveal.overlayH) + " vs " + (reveal && reveal.page && reveal.page.head) + " later: " + overlayAfter.join());
    check("the page is not laid out again after it became visible (no growing / jumping)", !!reveal && rs.filter((t) => t > reveal.at + 30).length === 0, JSON.stringify(rs.map((t) => reveal ? t - reveal.at : t)));
    const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent`);
    const all = (sel) => js(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map((e) => e.textContent)`);
    const setInput = (sel, v, idx = 0) => js(`(() => { const i = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); return i.value; })()`);
    const sum = () => js('Array.from(document.querySelectorAll(".c-sum b")).map((e) => e.textContent)');
    const line = (i = 0) => js(`document.querySelectorAll(".c-line")[${i}].textContent`);
    const wheelTo = (col, i, part = 0) => js(`(() => { const w = document.querySelectorAll(".c-card")[${part}].querySelectorAll(".c-wheel-scroll")[${col}]; w.scrollTop = ${i} * 36; return w.scrollTop; })()`);
    const plusBtn = () => js('document.querySelectorAll(".c-btn.grey")[1].click(), 1');
    // adding a part is the grey + now; its presses are counted by main (five quick ones open the browser), so quick adds go through here with the counter off
    const addPartQuick = async () => { const { ipcMain: ipc } = require("electron"); const L = ipc.listeners("calc:plus"); ipc.removeAllListeners("calc:plus"); try { await plusBtn(); } finally { L.forEach((f) => ipc.on("calc:plus", f)); } };

    console.log("-- starts on the calculator");
    check("calculator mode is on, no browser tab exists", state.calcMode === true && state.tabs.length === 0);
    check("the shell shows it (body.calc-mode) and the browser chrome is hidden", await js('document.body.classList.contains("calc-mode") && getComputedStyle(document.querySelector(".strip")).display === "none" && getComputedStyle(document.querySelector(".toolbar")).display === "none"'));
    check("no page view is attached to the window", win().getBrowserViews().length === 0, win().getBrowserViews().length);
    await sleep(500);
    check("window buttons take the calculator header's colour and height (not a black 40px box)", theme.overlayOptions(40).color === "#f3f9fc" && theme.overlayOptions(40).height > 40, JSON.stringify(theme.overlayOptions(40)));
    check("...and the header height they were given is the real header's height", Math.abs(theme.overlayOptions(40).height - (await js('Math.round(document.querySelector(".c-head").getBoundingClientRect().height)'))) <= 1);
    await sleep(500); await shot("calc-1-start");
    {   // at the START (the red button wipes the part's wheels and weight, so it must not run in the middle of the pricing checks)
      const cards = () => js('document.querySelectorAll(".c-card").length');
      const blue = addPartQuick;
      // the red button removes ALL parts: one fresh, empty part A is what is left (the stone weight stays)
      await js('(() => { const i = document.querySelector(".c-stone input"); i.value = "2.5"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
      for (let k = 0; k < 3; k++) { await blue(); await sleep(60); }
      await js('(() => { const i = document.querySelector(".c-card .c-pw input"); i.value = "0.7"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
      check("four parts before the red button", (await cards()) === 4);
      await js('document.querySelector(".c-btn.red").click(), 1'); await sleep(300);
      check("the red button removes all parts: one fresh part A is left, with an empty weight", (await cards()) === 1 && (await js('document.querySelector(".c-partbadge").textContent')) === "A" && (await js('document.querySelector(".c-card .c-pw input").value')) === "");
      check("...and the stone weight is not touched", (await js('document.querySelector(".c-stone input").value')) === "2.5");
      await js('(() => { const i = document.querySelector(".c-stone input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
    }

    // the blue button is "Calculate" now: it opens the result
    {
      const label = await js('document.querySelector(".c-btn.blue span").textContent');
      check("the blue button says Calculate (it used to be Add St.)", label === "Calculate", label);
      await js('document.querySelector(".c-btn.blue").click(), 1'); await sleep(300);
      check("with no weight entered the result says so, and has no table", (await js('!!document.querySelector(".c-dialog.narrow .c-res-empty") && !document.querySelector(".c-res-table")')) === true);
      const w = await js('Math.round(document.querySelector(".c-dialog").getBoundingClientRect().width)');
      check("...and that message window is compact (about 26em wide), not the wide table size", w < 520, String(w));
      await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), 1'); await sleep(200);
      check("Esc closes it", (await js('!document.querySelector(".c-modal")')) === true);
      // a REAL click on the part-weight box and real key presses (the box used to ignore a click: its input was hidden and could not take focus)
      await js('document.querySelector(".c-body").scrollTop = 0, 1'); await sleep(150);   // with the lab table shown from the start the body can be scrolled by now
      const pw = await js('(() => { const b = document.querySelector(".c-pw").getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()');
      shell().focus();
      shell().sendInputEvent({ type: "mouseMove", x: pw.x, y: pw.y }); await sleep(80);
      shell().sendInputEvent({ type: "mouseDown", x: pw.x, y: pw.y, button: "left", clickCount: 1 }); shell().sendInputEvent({ type: "mouseUp", x: pw.x, y: pw.y, button: "left", clickCount: 1 }); await sleep(300);
      check("a click on the part-weight box puts the cursor in it (the input is focused and visible)", (await js('document.activeElement === document.querySelector(".c-pw input") && getComputedStyle(document.activeElement).display !== "none"')) === true);
      for (const ch of "0.5") { shell().sendInputEvent({ type: "keyDown", keyCode: ch }); shell().sendInputEvent({ type: "char", keyCode: ch }); shell().sendInputEvent({ type: "keyUp", keyCode: ch }); await sleep(60); }
      check("typing there works: 0.5 appears and the Polish tile follows", (await js('document.querySelector(".c-pw input").value')) === "0.5" && (await js('document.querySelector(".c-sum b").textContent')) === "0.50 Ct.");
      await js('document.querySelector(".c-btn.red").click(), 1'); await sleep(300);   // back to a fresh part A
    }

    console.log("\n-- the screen, as in the recording");
    check("no iPad status bar: no clock, wifi or battery - the header carries the PBC brand instead", (await js('!document.querySelector(".c-status") && !document.querySelector(".c-battery")')) === true && (await text(".c-brand")) === "PBC");
    check("wheel items are 36px tall (the step the code scrolls by)", (await js('document.querySelector(".c-wheel-item").offsetHeight')) === 36);
    const box = await js('(() => { const r = document.querySelector(".c-stage").getBoundingClientRect(); const c = document.querySelector(".c-body").getBoundingClientRect(); const t = document.querySelector(".c-top").getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, iw: innerWidth, ih: innerHeight, h: r.height, bodyL: c.left, bodyR: c.right, topL: t.left, topR: t.right }; })()');
    check("it fills the WHOLE window: no black bars left or right, full height", box.l === 0 && box.r === box.iw && box.h === box.ih, JSON.stringify(box));
    check("the content spans the width (only a small margin each side)", box.bodyL < 40 && box.iw - box.bodyR < 40 && box.topL < 40 && box.iw - box.topR < 40, JSON.stringify(box));
    check("the window buttons' corner stays free (header leaves room on the right)", (await js('(() => { const u = document.querySelector(".c-update").getBoundingClientRect(); return innerWidth - u.right; })()')) >= 120);
    check("Update Price button, three tab icons", (await text(".c-update")) === "Update Price" && (await js('document.querySelectorAll(".c-tab").length')) === 3);
    check("Stone Weight box + summary labels Polish / Result / Total Polish / Rough $/Ct.", (await all(".c-sum label")).join("|") === "Polish|Result|Total Polish|Rough $/Ct.");
    check("starts empty: 0.00 Ct. / 0.00% / $0.00 / $0.00", (await sum()).join("|") === "0.00 Ct.|0.00%|$0.00|$0.00", (await sum()).join("|"));
    check("card 'Enter Part 'A' Weight' with 5 wheels (Shape, Colour, Clarity, Fluorescence, Add. Disc.)", (await text(".c-pw label")) === "Enter Part 'A' Weight" && (await js('document.querySelectorAll(".c-card .c-wheel").length')) === 5 && (await all(".c-wheel-heads span")).join("|") === "Shape|Colour|Clarity|Fluor.|Add. Disc.");
    const startWheels = JSON.stringify(await js('Array.from(document.querySelectorAll(".c-card .c-wheel")).map((w) => { const s = w.querySelector(".c-wheel-scroll"); return w.querySelectorAll(".c-wheel-item")[Math.round(s.scrollTop / 36)].textContent + "@" + s.scrollTop; })'));
    check("wheels start on ROUND / D / FL / NON / 0%", /^\["ROUND@0","D@0","FL@0","NON@0","0%@0"\]$/.test(startWheels), startWheels);
    check("CPS 3X on; Cut EX, SubCut ID, Polish EX, Symmetry EX, Lab AUTO", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')) === '["3X","EX","EX-ID","EX","EX","AUTO"]', JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')));
    check("the fields are the ERP's: 7 CPS chips, 6 grades per row, Lab = AUTO + 11 labs, Depth 60, Ratio 1", (await js('document.querySelectorAll(".c-chips .c-chip").length')) === 7 && (await js('document.querySelectorAll(".c-row")[0].querySelectorAll(".c-chip").length')) === 6 && (await js('document.querySelectorAll(".c-row")[4].querySelectorAll(".c-chip").length')) === 12 && (await js('document.querySelector(".c-mini input[data-key=depth]").value + "/" + document.querySelector(".c-mini input[data-key=ratio]").value')) === "60/1");
    check("price line shows zeros before a weight", (await line()) === "List 0 Disc 0.00% $/Ct. 0.00 Total 0.00", await line());
    check("no dropdown / select element anywhere (wheels only)", (await js('document.querySelectorAll("select").length')) === 0);

    console.log("\n-- the numbers of the recording");
    await setInput(".c-pw input", "0.5");
    check("part weight 0.5: List 4700 Disc 30.00% $/Ct. 3290.00 Total 102.64 (by hand: (4700 - 1410) x 0.5 = 1645; (1645 - 148 - 60) / 14)", (await line()) === "List 4700 Disc 30.00% $/Ct. 3290.00 Total 102.64", await line());
    check("Polish 0.50 Ct., Total Polish $102.64", (await sum()).join("|") === "0.50 Ct.|0.00%|$102.64|$0.00", (await sum()).join("|"));
    await setInput(".c-stone input", "1.05");
    check("stone weight 1.05: Result 47.62%, Rough $97.75 (= 102.64 / 1.05)", (await sum()).join("|") === "0.50 Ct.|47.62%|$102.64|$97.75", (await sum()).join("|"));
    check("Result turns green when positive", await js('document.querySelector(".c-sum b.res").classList.contains("pos")'));
    check("lab box (Loose / GIA / IGI / HRD) and the price table appear once there is a stone weight", await js('document.querySelector(".c-labs").classList.contains("show") && document.querySelector(".c-table").classList.contains("show")'));
    {
      const lab = await js('Array.from(document.querySelectorAll(".c-card .c-table .r:not(.h)")).map((r) => Array.from(r.children).map((c) => c.textContent).join(" "))');
      check("the lab table is filled for every lab of the data: Disc., $/ct and Total of the SAME part", lab.length === 11 && JSON.stringify(lab.slice(0, 5)) === JSON.stringify(["GIA 30.00% $3290.00 $102.64", "IGI 36.00% $3008.00 $95.29", "HRD 33.00% $3149.00 $99.11", "NONE 44.00% $2632.00 $85.57", "FC 48.00% $2444.00 $79.43"]), JSON.stringify(lab));
      const top = await js('Array.from(document.querySelectorAll(".c-labs > div")).map((d) => d.textContent).join("|")');
      check("the lab row above the parts shows each lab's rough $/Ct. (GIA = the screen's Rough $97.75)", top.startsWith("GIA$97.75/Ct.|IGI$90.75/Ct.|HRD$94.39/Ct.|NONE$81.50/Ct.|FC$75.65/Ct.|JP-GIA"), top);
    }
    await shot("calc-2-weighed");
    // the grey + adds a part, the grey - takes the LAST added one away (the + presses are spaced > 1.5 s apart: five quick ones open the browser)
    {
      const cards = () => js('document.querySelectorAll(".c-card").length');
      const grey = (i) => js('document.querySelectorAll(".c-btn.grey")[' + i + '].click(), 1');
      const blue = addPartQuick;
      for (let k = 0; k < 6; k++) { await grey(0); await sleep(60); }
      check("the grey - on a single part does nothing (there is no added part to take away)", (await cards()) === 1);
      await grey(1); await sleep(300);
      check("the grey + adds a part", (await cards()) === 2);
      await sleep(1700); await grey(1); await sleep(300);
      check("...again: a third part", (await cards()) === 3);
      await js('document.querySelectorAll(".c-card")[2].querySelector(".c-pw input").value = "0.5", 1');
      await grey(0); await sleep(300);
      check("the grey - removes the LAST added part (C), A and B stay", (await cards()) === 2 && (await js('Array.from(document.querySelectorAll(".c-partbadge")).map((b) => b.textContent).join("")')) === "AB");
      await grey(0); await sleep(300); await grey(0); await sleep(300);
      check("...down to the first part, which stays", (await cards()) === 1 && (await js('document.querySelector(".c-partbadge").textContent')) === "A");
      for (let k = 0; k < 8; k++) { await blue(); await sleep(60); }
      await sleep(1700); await grey(1); await sleep(300);
      check("at 6 parts the grey + adds no more", (await cards()) === 6);
      for (let k = 0; k < 6; k++) { await grey(0); await sleep(60); }
      await sleep(1700);
    }

    console.log("\n-- the wheels move the prices");
    await wheelTo(1, 2); await sleep(400);          // colour F
    await wheelTo(2, 4); await sleep(400);          // clarity VS1
    check("colour F + clarity VS1: List 2610 $/Ct. 1827.00 Total 53.11 (by hand: rate 4700 x .872 x .638 = 2615 -> 2610)", (await line()) === "List 2610 Disc 30.00% $/Ct. 1827.00 Total 53.11", await line());
    await wheelTo(2, 5); await sleep(400);          // clarity VS2
    check("clarity VS2: List 2310 $/Ct. 1617.00 Total 46.54; Rough $44.32", (await line()) === "List 2310 Disc 30.00% $/Ct. 1617.00 Total 46.54" && (await sum())[3] === "$44.32", (await line()) + " | " + (await sum()).join("|"));
    await wheelTo(0, 5); await sleep(400);          // shape PEAR
    check("shape PEAR is cheaper than ROUND", /^List 1[0-9]{3} /.test(await line()), await line());
    await wheelTo(0, 0); await sleep(400);          // back to ROUND
    // the wheel is the ERP's Additional Discount: it replaces the lab's discount, and only for NONE / FC (the wheel is dimmed for the other labs)
    check("Add. Disc. wheel is dimmed for lab AUTO? no - AUTO may pick NONE, so it is live; GIA dims it", (await js('document.querySelector(".c-wheel.w-disc").classList.contains("na")')) === false);
    await js('document.querySelector(".c-chip[data-code=GIA]").click(), 1'); await sleep(200);
    check("lab GIA: the Add. Disc. wheel is dimmed and a 20% there changes nothing", (await js('document.querySelector(".c-wheel.w-disc").classList.contains("na")')) === true && (await (async () => { const before = await line(); await wheelTo(4, 20); await sleep(300); const after = await line(); await wheelTo(4, 0); await sleep(300); return before === after; })()));
    await js('document.querySelector(".c-chip[data-code=NONE]").click(), 1'); await wheelTo(4, 20); await sleep(400);
    check("lab NONE + Add. Disc. 20%: Disc 20.00% (it replaces NONE's 44%)", /^List 2310 Disc 20\.00% /.test(await line()), await line());
    await wheelTo(4, 0); await sleep(300);
    await js('document.querySelector(".c-chip[data-code=AUTO]").click(), 1'); await sleep(200);
    // (the Add. Disc. wheel is back on 0% and the lab on AUTO)
    await js('document.querySelectorAll(".c-chip")[1].click(), 1'); await sleep(200);
    check("CPS 2X selects Cut EX, Polish EX, Symmetry VG (the sub-cut stays EX1: the pear before it only had EX1 / EX2, and EX1 is valid for ROUND too)", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')) === '["2X","EX","EX-1","EX","VG","AUTO"]', JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')));
    await js('document.querySelectorAll(".c-row")[2].querySelectorAll(".c-chip")[2].click(), 1'); await sleep(200);   // Polish = GD
    check("a custom mix (Polish = GD) clears the CPS highlight", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')) === '["EX","EX-1","GD","VG","AUTO"]', JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')));
    await js('document.querySelectorAll(".c-row")[0].querySelectorAll(".c-chip")[3].click(), 1'); await sleep(200);   // Cut = FR
    check("Cut FR has no sub-cut: the SubCut row disappears (the ERP's getSubCut)", (await js('document.querySelectorAll(".c-row")[1].hidden')) === true);
    await js('document.querySelectorAll(".c-chips .c-chip")[0].click(), 1'); await sleep(200);
    check("CPS 3X brings Cut EX back and with it the sub-cuts EX-ID ... Excellent (EX-ID chosen)", (await js('Array.from(document.querySelectorAll(".c-row")[1].querySelectorAll(".c-chip")).map((c) => c.textContent + (c.classList.contains("on") ? "*" : "")).join()')) === "EX-ID*,EX-1,EX-2,EX-3,EX-4,EX-5,Excellent");
    await js('document.querySelectorAll(".c-chip")[0].click(), 1'); await sleep(200);

    console.log("\n-- real mouse input on a wheel (wheel notch, drag)");
    const rect = await js('(() => { const r = document.querySelectorAll(".c-card .c-wheel")[0].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    const idxOf = (col) => js(`(() => { const s = document.querySelectorAll(".c-card .c-wheel-scroll")[${col}]; return Math.round(s.scrollTop / 36); })()`);
    const before = await idxOf(0);
    shell().sendInputEvent({ type: "mouseWheel", x: rect.x, y: rect.y, deltaX: 0, deltaY: -120, canScroll: true }); await sleep(700);
    const afterWheel = await idxOf(0);
    check("one mouse-wheel notch moves the Shape wheel exactly one step", afterWheel === before + 1 || afterWheel === before - 1, before + " -> " + afterWheel);
    shell().sendInputEvent({ type: "mouseDown", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    for (let k = 1; k <= 6; k++) { shell().sendInputEvent({ type: "mouseMove", x: rect.x, y: rect.y - k * 12 }); await sleep(30); }
    shell().sendInputEvent({ type: "mouseUp", x: rect.x, y: rect.y - 72, button: "left", clickCount: 1 }); await sleep(900);
    const afterDrag = await idxOf(0);
    const sc = await js('document.querySelectorAll(".c-card .c-wheel-scroll")[0].scrollTop');
    check("dragging the wheel moves it and it snaps to a whole item", afterDrag !== afterWheel && sc % 36 === 0, afterWheel + " -> " + afterDrag + " top=" + sc);

    console.log("\n-- parts");
    await addPartQuick(); await sleep(500);
    check("the grey + adds Part 'B'", JSON.stringify(await all(".c-pw label")) === '["Part \'A\' Weight","Enter Part \'B\' Weight"]', JSON.stringify(await all(".c-pw label")));
    await setInput(".c-pw input", "1", 1);
    check("Polish now adds the parts: 1.50 Ct.", (await sum())[0] === "1.50 Ct.", (await sum()).join("|"));
    await js('document.querySelector(".c-btn.red").click(), 1'); await sleep(300);
    check("the red button removes ALL parts (A and B): one fresh part A, empty weight, the stone weight stays", (await js('document.querySelectorAll(".c-card").length')) === 1 && (await js('document.querySelector(".c-card .c-pw input").value')) === "" && (await js('document.querySelector(".c-stone input").value')) === "1.05");
    await setInput(".c-pw input", "0.5");   // (the checks below go on with the recording's 0.5 ct part)
    {   // Calculate with the recording's numbers (part 0.5 ct, stone 1.05 ct)
      await js('document.querySelector(".c-btn.blue").click(), 1'); await sleep(300);
      const tiles = await js('Array.from(document.querySelectorAll(".c-res-sum b")).map((b) => b.textContent).join("|")');
      check("Calculate shows the same four numbers as the screen: 0.50 Ct. | 47.62% | $102.64 | $97.75", tiles === "0.50 Ct.|47.62%|$102.64|$97.75", tiles);
      check("...the Result is green (positive)", (await js('document.querySelector(".c-res-sum b.pos") && 1')) === 1);
      const rows = await js('Array.from(document.querySelectorAll(".c-res-table .r:not(.h)")).map((r) => Array.from(r.children).map((c) => c.textContent).join(" | "))');
      check("one row per part: A, 0.500 Ct., ROUND D FL NON, 3X EX-ID, GIA (AUTO's pick), 30.00%, List 4700, 3290.00, $102.64", rows.length === 1 && rows[0] === "A | 0.500 Ct. | ROUND D FL NON | 3X EX-ID | GIA | 30.00% | 4700 | 3290.00 | $102.64", JSON.stringify(rows));
      await js('document.querySelector(".c-dlgbtn[data-act=done]").click(), 1'); await sleep(200);
      check("Done closes it, and nothing was changed by calculating", (await js('!document.querySelector(".c-modal")')) === true && (await sum()).join("|") === "0.50 Ct.|47.62%|$102.64|$97.75");
    }
    await js('document.querySelector(".c-update").click(), 1'); await sleep(300);
    check("Update Price keeps working (numbers stay valid)", /^List \d+ Disc \d+\.\d{2}% \$\/Ct\. \d+\.\d{2} Total \d+\.\d{2}$/.test(await line()), await line());

    console.log("\n-- the three tabs");
    const tabNames = () => js('Array.from(document.querySelectorAll(".c-tab")).map((t) => t.textContent.trim() + (t.classList.contains("on") ? "*" : ""))');
    const viewShown = () => js('Array.from(document.querySelectorAll(".c-view")).filter((v) => !v.hidden).map((v) => v.dataset.view)');
    const clickTab = (k) => js('document.querySelector(".c-tab[data-tab=' + k + ']").click(), 1');
    check("tabs: Account | Calculator (selected) | Price List", JSON.stringify(await tabNames()) === '["Account","Calculator*","$Price List"]' || JSON.stringify(await tabNames()) === '["Account","Calculator*","Price List"]', JSON.stringify(await tabNames()));
    await clickTab("account"); await sleep(150);
    check("Account tab: its own panel with 'Coming soon', the calculator is hidden", JSON.stringify(await viewShown()) === '["account"]' && /Account/.test(await text(".c-view[data-view=account] h2")) && /Coming soon/i.test(await text(".c-view[data-view=account] .c-pillsoon")));
    check("...the header (Update Price) stays", (await text(".c-update")) === "Update Price");
    await clickTab("prices"); await sleep(150);
    check("Price List tab: its own 'Coming soon' panel", JSON.stringify(await viewShown()) === '["prices"]' && /Price List/.test(await text(".c-view[data-view=prices] h2")));
    check("the selected tab follows (only the clicked one is on)", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-tab.on")).map((t) => t.dataset.tab)')) === '["prices"]');
    await clickTab("calc"); await sleep(150);
    check("back on Calculator: everything typed is still there (stone 1.05, part weight, prices)", JSON.stringify(await viewShown()) === '["calc"]' && (await js('document.querySelector(".c-stone input").value')) === "1.05" && /^List \d+ Disc \d+\.\d{2}% \$\/Ct\. \d+\.\d{2} Total \d+\.\d{2}$/.test(await line()) && (await sum())[1] === "47.62%", (await sum()).join("|"));

    console.log("\n-- Update Price");
    const upd0 = await text(".c-upd-meta");
    await js('document.querySelector(".c-update").click(), 1'); await sleep(200);
    check("Update Price stamps 'Prices updated <time>' next to the button", /^Prices updated \d+:\d\d (AM|PM)$/.test(await text(".c-upd-meta")) && /^Prices updated/.test(upd0));

    console.log("\n-- the gear: settings dialog");
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(200);
    check("the gear opens the Settings dialog (modal, labelled)", (await js('!!document.querySelector(".c-modal .c-dialog[role=dialog][aria-modal=true]")')) === true && /Settings/.test(await text(".c-dialog h2")));
    check("it offers Appearance, Default additional discount, Lab price table, Reset calculator, Done", /Appearance/.test(await text(".c-dialog")) && /Default additional discount/.test(await text(".c-dialog")) && /Lab price table/.test(await text(".c-dialog")) && /Reset calculator/.test(await text(".c-dialog")) && /Done/.test(await text(".c-dialog")));
    await js('document.querySelector(".c-seg button[data-theme=dark]").click(), 1'); await sleep(150);
    check("Dark: the whole calculator turns dark", (await js('document.querySelector(".c-stage").classList.contains("dark")')) === true && (await js('getComputedStyle(document.querySelector(".c-stage")).backgroundColor')) !== "rgb(238, 241, 246)");
    await shot("calc-4-settings-dark");
    await js('document.querySelector(".c-seg button[data-theme=light]").click(), 1'); await sleep(100);
    check("Light: back to the light calculator", (await js('document.querySelector(".c-stage").classList.contains("dark")')) === false);
    const net0 = parseInt((await line()).match(/\$\/Ct\. (\d+)/)[1], 10);
    for (let k = 0; k < 5; k++) await js('document.querySelectorAll(".c-stepper button")[1].click(), 1');
    check("Default additional discount stepper: 5 clicks on + makes it 5%", (await text(".c-stepper output")) === "5%", await text(".c-stepper output"));
    await js('document.querySelector(".c-dlgbtn[data-act=apply]").click(), 1'); await sleep(500);
    const net1 = parseInt((await line()).match(/\$\/Ct\. (\d+)/)[1], 10);
    check("'Apply to all parts' moves the Add. Disc. wheel to 5% and AUTO now prefers NONE (5% replaces its 44%), so $/Ct. rises", net1 > net0 && (await js('(() => { const s = document.querySelectorAll(".c-card")[0].querySelectorAll(".c-wheel-scroll")[4]; return Math.round(s.scrollTop / 36); })()')) === 5, net0 + " -> " + net1);
    await js('document.querySelector(".c-switch[data-act=labs]").click(), 1'); await sleep(150);
    check("Lab price table off: the lab row and the table disappear", (await js('!document.querySelector(".c-labs").classList.contains("show") && !document.querySelector(".c-table").classList.contains("show")')) === true);
    await js('document.querySelector(".c-switch[data-act=labs]").click(), 1'); await sleep(150);
    check("...and come back when switched on again", (await js('document.querySelector(".c-labs").classList.contains("show") && document.querySelector(".c-table").classList.contains("show")')) === true);
    await shot("calc-5-settings-light");
    await js('document.querySelector(".c-seg button[data-theme=dark]").click(), 1'); await js('document.querySelector(".c-dlgbtn[data-act=done]").click(), 1'); await sleep(300);
    await shot("calc-7-dark");
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(150); await js('document.querySelector(".c-seg button[data-theme=light]").click(), 1'); await js('document.querySelector(".c-dlgbtn[data-act=done]").click(), 1'); await sleep(200);
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(150);
    shell().sendInputEvent({ type: "keyDown", keyCode: "Escape" }); shell().sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await sleep(200);
    check("Esc closes the dialog", (await js('!document.querySelector(".c-modal")')) === true);
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(150);
    await js('document.querySelector(".c-dlgbtn[data-act=done]").click(), 1'); await sleep(150);
    check("Done closes it", (await js('!document.querySelector(".c-modal")')) === true);
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(150);
    await js('document.querySelector(".c-modal").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))'); await sleep(150);
    check("a click outside the dialog closes it too", (await js('!document.querySelector(".c-modal")')) === true);
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(150);
    await js('document.querySelector(".c-dlgbtn[data-act=reset]").click(), 1'); await sleep(400);
    check("Reset calculator: everything empty again, one part, dialog closed", (await sum()).join("|") === "0.00 Ct.|0.00%|$0.00|$0.00" && (await js('document.querySelectorAll(".c-card").length')) === 1 && (await js('document.querySelector(".c-stone input").value')) === "" && (await js('!document.querySelector(".c-modal")')) === true, (await sum()).join("|"));
    check("...the default additional discount (5%) you chose stays: a new part starts on 5%", (await js('(() => { const s = document.querySelectorAll(".c-card")[0].querySelectorAll(".c-wheel-scroll")[4]; return Math.round(s.scrollTop / 36); })()')) === 5);
    await wheelTo(4, 0); await sleep(300);
    await setInput(".c-pw input", "0.5"); await sleep(200);

    console.log("\n-- a narrower window: still fills it, nothing cut off");
    win().unmaximize(); await sleep(400); win().setSize(980, 720); await sleep(800);
    const nb = await js('(() => { const r = document.querySelector(".c-stage").getBoundingClientRect(); return { w: r.width, iw: innerWidth, scrollW: document.documentElement.scrollWidth, bodyScrollW: document.querySelector(".c-body").scrollWidth, bodyW: document.querySelector(".c-body").clientWidth }; })()');
    check("at 980 px wide the stage still fills the window and nothing scrolls sideways", nb.w === nb.iw && nb.scrollW <= nb.iw + 1 && nb.bodyScrollW <= nb.bodyW + 1, JSON.stringify(nb));
    check("narrow: the three tab icons are still there (only the words are hidden)", (await js('Array.from(document.querySelectorAll(".c-tab")).every((t) => t.getBoundingClientRect().width > 20 && t.querySelector("svg, .c-dollar") && getComputedStyle(t.querySelector("svg, .c-dollar")).display !== "none")')) === true);
    await shot("calc-6-narrow");
    win().maximize(); await sleep(600);

    console.log("\n-- nothing opens a browser behind the calculator");
    shell().sendInputEvent({ type: "keyDown", keyCode: "T", modifiers: ["control"] }); shell().sendInputEvent({ type: "keyUp", keyCode: "T", modifiers: ["control"] }); await sleep(500);
    check("Ctrl+T opens nothing", state.tabs.length === 0);
    tm.createTab("https://example.com/"); await sleep(300);
    check("createTab is refused", state.tabs.length === 0 && win().getBrowserViews().length === 0);
    check("a file dropped on the window opens nothing", require("../electron/dropFiles").openDropped([path.join(tmp, "UserData", "settings.json")]) === 0 && state.tabs.length === 0);
    check("a link / file handed over by Windows opens nothing", require("../electron/externalOpen").openFromOutside(["PBCalc.exe", "--", "https://example.com/"], process.cwd()) === false && state.tabs.length === 0);

    console.log("\n-- the gray + : five quick presses open the browser");
    const { ipcMain } = require("electron");
    for (let k = 0; k < 6; k++) ipcMain.listeners("calc:plus")[0]({ sender: { id: 99999 } });
    check("presses from anything but the shell page count for nothing", state.calcMode === true && state.tabs.length === 0);
    for (let k = 0; k < 4; k++) { await plusBtn(); await sleep(150); }
    check("4 presses: still the calculator", state.calcMode === true && state.tabs.length === 0);
    await sleep(1800);
    for (let k = 0; k < 4; k++) { await plusBtn(); await sleep(150); }
    check("4 + a pause + 4: the count starts again, still the calculator", state.calcMode === true && state.tabs.length === 0);
    await plusBtn(); await sleep(2500);
    check("the 5th quick press opens the browser: one New Tab page, calculator mode off", state.calcMode === false && state.tabs.length === 1 && /newtab\.html$/i.test(state.tabs[0].view.webContents.getURL()), state.tabs.length + " " + (state.tabs[0] && state.tabs[0].view.webContents.getURL()));
    check("it is at 100 % zoom", Math.abs(state.tabs[0].view.webContents.getZoomFactor() - 1) < 0.001, state.tabs[0].view.webContents.getZoomFactor());
    check("the browser chrome is back and the calculator is gone from the page", await js('!document.body.classList.contains("calc-mode") && getComputedStyle(document.querySelector(".strip")).display !== "none" && document.getElementById("calc-root").children.length === 0'));
    check("the browser's window-button colours are back", theme.overlayOptions(40).color !== "#000000");
    check("a page view is attached again", win().getBrowserViews().length >= 1);
    await shot("calc-3-browser");

    console.log("\n-- closing the browser quits PBCalc (the calculator does NOT come back; it shows again at the next start)");
    const pbSes = session.fromPartition(require("../electron/constants").TAB_PARTITION);
    tm.createTab("http://127.0.0.1:1/x"); await sleep(1200);
    await pbSes.cookies.set({ url: "http://127.0.0.1/", name: "secret", value: "1", expirationDate: Date.now() / 1000 + 3600 });
    check("(control) the test cookie really exists before the browser is closed", (await pbSes.cookies.get({ name: "secret" })).length === 1);
    shell().sendInputEvent({ type: "keyDown", keyCode: "T", modifiers: ["control"] }); shell().sendInputEvent({ type: "keyUp", keyCode: "T", modifiers: ["control"] }); await sleep(800);
    check("(control) in the BROWSER the same Ctrl+T does open a tab - so the earlier 'opens nothing' was the guard, not a lost key", state.tabs.length === 3, state.tabs.length);
    tm.closeTab(state.tabs[state.tabs.length - 1].id); await sleep(500);
    tm.closeTab(state.tabs[state.tabs.length - 1].id); await sleep(500);
    check("closing tabs one by one keeps the browser while one is left", state.calcMode === false && state.tabs.length === 1);
    check("the calculator's page is empty while the browser is in use", await js('document.getElementById("calc-root").children.length === 0 && !document.querySelector(".c-stage")'));
    check("there is no way back to the calculator any more (no returnToCalc, no close hook)", require("../electron/calcMode").returnToCalc === undefined && require("../electron/calcMode").onWindowClose === undefined);
    const closed = new Promise((r) => win().once("closed", () => r(true)));
    let quitCalls = 0; const realQuit = app.quit; app.quit = () => { quitCalls++; };   // (the test must outlive the quit it provokes; the wipe at quit is verify-browser's / privacy's own checks)
    tm.closeTab(state.tabs[0].id);
    check("closing the LAST tab closes the window - no calculator comes back", await Promise.race([closed, sleep(5000).then(() => false)]));
    await sleep(500);
    check("...PBCalc asks to quit (window-all-closed -> app.quit), and the calculator mode stayed off", quitCalls === 1 && state.calcMode === false && state.tabs.length === 0, quitCalls);
    app.quit = realQuit;

    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_CALCSCREEN total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
