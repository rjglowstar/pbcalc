// The calculator screen: shown at start when the installer's "start on the calculator screen" answer is set; wheels change the dummy prices;
// five quick presses of the gray "+" open the browser; closing the browser returns to the calculator (session wiped); nothing opens a
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

    const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent`);
    const all = (sel) => js(`Array.from(document.querySelectorAll(${JSON.stringify(sel)})).map((e) => e.textContent)`);
    const setInput = (sel, v, idx = 0) => js(`(() => { const i = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; i.focus(); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); return i.value; })()`);
    const sum = () => js('Array.from(document.querySelectorAll(".c-sum b")).map((e) => e.textContent)');
    const line = (i = 0) => js(`document.querySelectorAll(".c-line")[${i}].textContent`);
    const wheelTo = (col, i, part = 0) => js(`(() => { const w = document.querySelectorAll(".c-card")[${part}].querySelectorAll(".c-wheel-scroll")[${col}]; w.scrollTop = ${i} * 36; return w.scrollTop; })()`);
    const plusBtn = () => js('document.querySelectorAll(".c-btn.grey")[1].click(), 1');

    console.log("-- starts on the calculator");
    check("calculator mode is on, no browser tab exists", state.calcMode === true && state.tabs.length === 0);
    check("the shell shows it (body.calc-mode) and the browser chrome is hidden", await js('document.body.classList.contains("calc-mode") && getComputedStyle(document.querySelector(".strip")).display === "none" && getComputedStyle(document.querySelector(".toolbar")).display === "none"'));
    check("no page view is attached to the window", win().getBrowserViews().length === 0, win().getBrowserViews().length);
    check("window buttons are white on black while it shows", theme.overlayOptions(40).color === "#000000" && theme.overlayOptions(40).symbolColor === "#ffffff");
    await sleep(500); await shot("calc-1-start");

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
    check("card 'Enter Part 'A' Weight' with 5 wheels (Shape, Colour, Clarity, Fluorescence, Discount)", (await text(".c-pw label")) === "Enter Part 'A' Weight" && (await js('document.querySelectorAll(".c-card .c-wheel").length')) === 5);
    const startWheels = JSON.stringify(await js('Array.from(document.querySelectorAll(".c-card .c-wheel")).map((w) => { const s = w.querySelector(".c-wheel-scroll"); return w.querySelectorAll(".c-wheel-item")[Math.round(s.scrollTop / 36)].textContent + "@" + s.scrollTop; })'));
    check("wheels start on ROUND / D / FL / NON / -30%", /^\["ROUND@0","D@0","FL@0","NON@0","-30%@1080"\]$/.test(startWheels), startWheels);
    check("3EX preset on, rows C/P/S all EX", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')) === '["3EX","EX","EX","EX"]');
    check("price line shows zeros before a weight: List 0 $/Ct. 0 Total 0", (await line()) === "List 0 $/Ct. 0 Total 0", await line());
    check("no dropdown / select element anywhere (wheels only)", (await js('document.querySelectorAll("select").length')) === 0);

    console.log("\n-- the numbers of the recording");
    await setInput(".c-pw input", "0.5");
    check("part weight 0.5: List 4700 $/Ct. 3290 Total 1645", (await line()) === "List 4700 $/Ct. 3290 Total 1645", await line());
    check("Polish 0.50 Ct., Total Polish $1645.00", (await sum()).join("|") === "0.50 Ct.|0.00%|$1645.00|$0.00", (await sum()).join("|"));
    await setInput(".c-stone input", "1.05");
    check("stone weight 1.05: Result 47.62%, Rough $1566.67", (await sum()).join("|") === "0.50 Ct.|47.62%|$1645.00|$1566.67", (await sum()).join("|"));
    check("Result turns green when positive", await js('document.querySelector(".c-sum b.res").classList.contains("pos")'));
    check("lab box (Loose / GIA / IGI / HRD) and the price table appear once there is a stone weight", await js('document.querySelector(".c-labs").classList.contains("show") && document.querySelector(".c-table").classList.contains("show")'));
    await shot("calc-2-weighed");

    console.log("\n-- the wheels move the prices");
    await wheelTo(1, 2); await sleep(400);          // colour F
    await wheelTo(2, 4); await sleep(400);          // clarity VS1
    check("colour F + clarity VS1: List 2600 $/Ct. 1820 Total 910", (await line()) === "List 2600 $/Ct. 1820 Total 910", await line());
    await wheelTo(2, 5); await sleep(400);          // clarity VS2
    check("clarity VS2: List 2200 $/Ct. 1540 Total 770; Rough $733.33", (await line()) === "List 2200 $/Ct. 1540 Total 770" && (await sum())[3] === "$733.33", (await line()) + " | " + (await sum()).join("|"));
    await wheelTo(0, 1); await sleep(400);          // shape PEAR
    check("shape PEAR is cheaper than ROUND", /^List 1[0-9]{3} /.test(await line()), await line());
    await wheelTo(0, 0); await wheelTo(4, 25); await sleep(400);   // discount -35 (index 25 of -60..)
    check("discount wheel -35%: $/Ct. falls below 1540", parseInt((await line()).match(/\$\/Ct\. (\d+)/)[1], 10) < 1540, await line());
    await wheelTo(4, 30); await sleep(300);         // back to -30
    await js('document.querySelectorAll(".c-chip")[1].click(), 1'); await sleep(200);
    check("preset EX-VG selects EX EX VG", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')) === '["EX-VG","EX","EX","VG"]');
    await js('document.querySelectorAll(".c-row")[1].querySelectorAll(".c-chip")[2].click(), 1'); await sleep(200);
    check("a custom mix (P = GD) clears the preset highlight", JSON.stringify(await js('Array.from(document.querySelectorAll(".c-chip.on")).map((c) => c.textContent)')) === '["EX","GD","VG"]');
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
    await js('document.querySelector(".c-btn.blue").click(), 1'); await sleep(500);
    check("Add St. adds Part 'B'", JSON.stringify(await all(".c-pw label")) === '["Part \'A\' Weight","Enter Part \'B\' Weight"]', JSON.stringify(await all(".c-pw label")));
    await setInput(".c-pw input", "1", 1);
    check("Polish now adds the parts: 1.50 Ct.", (await sum())[0] === "1.50 Ct.", (await sum()).join("|"));
    await js('document.querySelector(".c-btn.red").click(), 1'); await sleep(300);
    check("the red minus removes the last part", (await js('document.querySelectorAll(".c-card").length')) === 1);
    await js('document.querySelector(".c-update").click(), 1'); await sleep(300);
    check("Update Price keeps working (numbers stay valid)", /^List \d+ \$\/Ct\. \d+ Total \d+$/.test(await line()), await line());

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
    check("back on Calculator: everything typed is still there (stone 1.05, part weight, prices)", JSON.stringify(await viewShown()) === '["calc"]' && (await js('document.querySelector(".c-stone input").value')) === "1.05" && /^List \d+ \$\/Ct\. \d+ Total \d+$/.test(await line()) && (await sum())[1] === "47.62%", (await sum()).join("|"));

    console.log("\n-- Update Price");
    const upd0 = await text(".c-upd-meta");
    await js('document.querySelector(".c-update").click(), 1'); await sleep(200);
    check("Update Price stamps 'Prices updated <time>' next to the button", /^Prices updated \d+:\d\d (AM|PM)$/.test(await text(".c-upd-meta")) && /^Prices updated/.test(upd0));

    console.log("\n-- the gear: settings dialog");
    await js('document.querySelector(".c-gear").click(), 1'); await sleep(200);
    check("the gear opens the Settings dialog (modal, labelled)", (await js('!!document.querySelector(".c-modal .c-dialog[role=dialog][aria-modal=true]")')) === true && /Settings/.test(await text(".c-dialog h2")));
    check("it offers Appearance, Default discount, Lab price table, Reset calculator, Done", (() => true)() && /Appearance/.test(await text(".c-dialog")) && /Default discount/.test(await text(".c-dialog")) && /Lab price table/.test(await text(".c-dialog")) && /Reset calculator/.test(await text(".c-dialog")) && /Done/.test(await text(".c-dialog")));
    await js('document.querySelector(".c-seg button[data-theme=dark]").click(), 1'); await sleep(150);
    check("Dark: the whole calculator turns dark", (await js('document.querySelector(".c-stage").classList.contains("dark")')) === true && (await js('getComputedStyle(document.querySelector(".c-stage")).backgroundColor')) !== "rgb(238, 241, 246)");
    await shot("calc-4-settings-dark");
    await js('document.querySelector(".c-seg button[data-theme=light]").click(), 1'); await sleep(100);
    check("Light: back to the light calculator", (await js('document.querySelector(".c-stage").classList.contains("dark")')) === false);
    const net0 = parseInt((await line()).match(/\$\/Ct\. (\d+)/)[1], 10);
    for (let k = 0; k < 5; k++) await js('document.querySelectorAll(".c-stepper button")[0].click(), 1');
    check("Default discount stepper: 5 clicks on − makes it -35%", (await text(".c-stepper output")) === "-35%", await text(".c-stepper output"));
    await js('document.querySelector(".c-dlgbtn[data-act=apply]").click(), 1'); await sleep(500);
    const net1 = parseInt((await line()).match(/\$\/Ct\. (\d+)/)[1], 10);
    check("'Apply to all parts' moves the Discount wheel to -35% and the price falls", net1 < net0 && (await js('(() => { const s = document.querySelectorAll(".c-card")[0].querySelectorAll(".c-wheel-scroll")[4]; return Math.round(s.scrollTop / 36); })()')) === 25, net0 + " -> " + net1);
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
    check("...the theme and the default discount (-35%) you chose stay: a new part starts on -35%", (await js('(() => { const s = document.querySelectorAll(".c-card")[0].querySelectorAll(".c-wheel-scroll")[4]; return Math.round(s.scrollTop / 36); })()')) === 25);
    await wheelTo(4, 30); await sleep(300);
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

    console.log("\n-- closing the browser returns to the calculator");
    const pbSes = session.fromPartition(require("../electron/constants").TAB_PARTITION);
    tm.createTab("http://127.0.0.1:1/x"); await sleep(1200);
    await pbSes.cookies.set({ url: "http://127.0.0.1/", name: "secret", value: "1", expirationDate: Date.now() / 1000 + 3600 });
    check("(control) the test cookie really exists before the browser is closed", (await pbSes.cookies.get({ name: "secret" })).length === 1);
    shell().sendInputEvent({ type: "keyDown", keyCode: "T", modifiers: ["control"] }); shell().sendInputEvent({ type: "keyUp", keyCode: "T", modifiers: ["control"] }); await sleep(800);
    check("(control) in the BROWSER the same Ctrl+T does open a tab - so the earlier 'opens nothing' was the guard, not a lost key", state.tabs.length === 3, state.tabs.length);
    tm.closeTab(state.tabs[state.tabs.length - 1].id); await sleep(500);
    tm.closeTab(state.tabs[state.tabs.length - 1].id); await sleep(500);
    check("closing tabs one by one keeps the browser while one is left", state.calcMode === false && state.tabs.length === 1);
    const upd = require("../electron/updater"); let postponedCalls = 0; const origIP = upd.installIfPending; upd.installIfPending = () => { postponedCalls++; return false; };
    tm.closeTab(state.tabs[0].id); await sleep(2500);
    upd.installIfPending = origIP;
    check("the browser closed: a POSTPONED update (the user said Cancel in the update popup) is installed now - updater.installIfPending ran once", postponedCalls === 1, postponedCalls);
    check("closing the LAST tab brings the calculator back; the window stays open", state.calcMode === true && state.tabs.length === 0 && !win().isDestroyed());
    check("the calculator is fresh (nothing typed earlier is there)", (await sum()).join("|") === "0.00 Ct.|0.00%|$0.00|$0.00", (await sum()).join("|"));
    check("the browsing session was wiped (the cookie is gone)", (await pbSes.cookies.get({ name: "secret" })).length === 0);
    check("the Ctrl+Shift+T list was forgotten", await (async () => { const n = state.tabs.length; tm.reopenClosedTab(); await sleep(300); return state.tabs.length === n; })());
    for (let k = 0; k < 5; k++) { await plusBtn(); await sleep(120); }
    await sleep(2500);
    check("the browser opens again from the calculator", state.calcMode === false && state.tabs.length === 1);
    win().close(); await sleep(2500);
    check("the window's X in the browser also returns to the calculator (the app does not quit)", state.calcMode === true && state.tabs.length === 0 && !win().isDestroyed());
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    state.quitting = true; calc.onWindowClose(e); state.quitting = false;
    check("a real quit (menu Exit, shutdown) is never held back", e.prevented === false);
    const closed = new Promise((r) => win().once("closed", () => r(true)));
    win().close();
    check("the X on the calculator itself closes the window (app quits)", await Promise.race([closed, sleep(4000).then(() => false)]));

    check("no uncaught error", errors.length === 0, errors.join("|"));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_CALCSCREEN total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
