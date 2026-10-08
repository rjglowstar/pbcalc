// The update dialog window (electron/updateDialog.js): content, looks, modality, and that ONLY the Update button can answer "yes". Real input events.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-update-dialog.js     (PBCALC_SHOTS=<dir> saves pictures)
const { app, BrowserWindow, ipcMain, nativeTheme } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-ud-"));
app.setPath("userData", path.join(tmp, "UserData"));
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await app.whenReady();
    const state = require("../electron/state");
    const dlg = require("../electron/updateDialog");
    const keeper = new BrowserWindow({ show: false });                       // keeps Electron alive when the test closes the other windows
    const main = new BrowserWindow({ show: true, width: 900, height: 600, title: "main" });
    state.mainWindow = main; await main.loadURL("data:text/html,<title>main</title>main"); await sleep(400);

    // open the dialog; resolves { win, wc, answer: Promise<boolean> } once it is on screen
    async function open() {
      const answer = dlg.ask({ version: "0.2.0", current: "0.1.5" });
      let win = null;
      for (let i = 0; i < 80 && !(win && win.isVisible()); i++) { await sleep(100); win = dlg._last(); }
      await sleep(300);
      return { win, wc: win.webContents, answer };
    }
    const js = (d, code) => d.wc.executeJavaScript(code, true);
    const center = (d, sel) => js(d, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const click = async (d, sel) => { const c = await center(d, sel); d.wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y }); await sleep(80); d.wc.sendInputEvent({ type: "mouseDown", x: c.x, y: c.y, button: "left", clickCount: 1 }); d.wc.sendInputEvent({ type: "mouseUp", x: c.x, y: c.y, button: "left", clickCount: 1 }); };
    const key = (d, k) => { d.wc.sendInputEvent({ type: "keyDown", keyCode: k }); d.wc.sendInputEvent({ type: "char", keyCode: k }); d.wc.sendInputEvent({ type: "keyUp", keyCode: k }); };
    const settled = (p) => Promise.race([p.then(async (v) => { await sleep(400); return { done: true, v }; }), sleep(1500).then(() => ({ done: false }))]);
    const shot = async (d, name) => { if (process.env.PBCALC_SHOTS) { fs.mkdirSync(process.env.PBCALC_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.PBCALC_SHOTS, name + ".png"), (await d.wc.capturePage()).toPNG()); } };

    console.log("-- the window");
    let d = await open();
    check("it is on screen, titled 'PBCalc update'", d.win.isVisible() && d.win.getTitle() === "PBCalc update", d.win.getTitle());
    check("it is MODAL to the main window (the browser behind cannot be used meanwhile)", d.win.isModal() && d.win.getParentWindow() === main);
    check("not resizable / minimizable / maximizable: a plain small dialog", !d.win.isResizable() && !d.win.isMinimizable() && !d.win.isMaximizable());
    const text = await js(d, "document.body.innerText");
    check("headline 'Update available' and 'PBCalc v0.2.0 is ready to install.'", /Update available/.test(text) && /PBCalc v0\.2\.0 is ready to install/.test(text), text.slice(0, 160));
    check("it shows the two version numbers: v0.1.5 -> v0.2.0", (await js(d, "document.getElementById('ud-from').textContent")) === "v0.1.5" && (await js(d, "document.getElementById('ud-to2').textContent")) === "v0.2.0");
    check("it says PBCalc restarts / all open tabs are closed and not restored / it opens again by itself", /PBCalc restarts/.test(text) && /All open tabs are closed/.test(text) && /not restored/.test(text) && /opens again by itself/.test(text), text);
    check("it says what Cancel does: installs automatically the next time you close or open PBCalc", /press\s+Cancel/i.test(text) && /next time you close or open PBCalc/.test(text), text);
    check("an update icon (arrow into a tray) in a coloured disc, and an icon on every line", (await js(d, "document.querySelectorAll('.badge .disc svg path').length")) === 1 && (await js(d, "document.querySelectorAll('.facts .ico svg').length")) === 3);
    check("two buttons: Cancel and Update (Update has its own icon)", (await js(d, "document.getElementById('ud-cancel').textContent.trim()")) === "Cancel" && /Update/.test(await js(d, "document.getElementById('ud-update').textContent")) && (await js(d, "document.querySelectorAll('#ud-update svg').length")) === 1);
    check("accessible: role=dialog, labelled by its title", (await js(d, "document.querySelector('.dlg').getAttribute('role')")) === "dialog" && (await js(d, "document.querySelector('.dlg').getAttribute('aria-labelledby')")) === "ud-title");
    check("the window fits its content: nothing is cut off or scrolls", (await js(d, "document.documentElement.scrollHeight <= document.documentElement.clientHeight + 1 && document.documentElement.scrollWidth <= document.documentElement.clientWidth")) === true);
    check("no keyboard focus is on a button (a stray Enter while typing elsewhere must decide nothing)", (await js(d, "document.activeElement && document.activeElement.tagName")) !== "BUTTON", await js(d, "document.activeElement && document.activeElement.tagName"));
    await shot(d, "update-dialog-light");

    console.log("\n-- it never answers itself");
    await sleep(3500);
    check("after 3.5 s with nobody touching it: still open, no answer", d.win.isVisible() && !(await settled(d.answer)).done);
    key(d, "Return"); await sleep(400);
    check("Enter pressed with no button focused changes nothing", d.win.isVisible() && !(await settled(d.answer)).done);
    // a different window forging the answer
    const other = new BrowserWindow({ show: false }); await other.loadURL("data:text/html,x");
    ipcMain.emit("updatedialog:answer", { sender: other.webContents }, true); await sleep(300);
    check("an 'Update' answer forged by ANOTHER window is ignored", d.win.isVisible() && !(await settled(d.answer)).done);
    other.destroy();

    console.log("\n-- Cancel");
    await click(d, "#ud-cancel");
    let r = await settled(d.answer);
    check("clicking Cancel answers NO and closes the window", r.done && r.v === false && d.win.isDestroyed());
    check("the main window is usable again after the dialog closes (a modal parent must be re-enabled)", main.isEnabled(), "enabled=" + main.isEnabled());

    console.log("\n-- Update");
    d = await open();
    await click(d, "#ud-update");
    r = await settled(d.answer);
    check("clicking Update (the only way to say yes) answers YES and closes the window", r.done && r.v === true && d.win.isDestroyed());

    console.log("\n-- everything else is 'no'");
    d = await open(); key(d, "Escape"); r = await settled(d.answer);
    check("Esc = Cancel", r.done && r.v === false);
    d = await open(); d.win.close(); r = await settled(d.answer);
    check("the window's X = Cancel", r.done && r.v === false);
    d = await open(); main.close(); r = await settled(d.answer);
    check("the main window closing under it = Cancel (nothing is installed)", r.done && r.v === false && d.win.isDestroyed());

    console.log("\n-- dark mode, and a second look at a window without a parent");
    console.log("   step A: parent cleared");
    state.mainWindow = null; nativeTheme.themeSource = "dark";
    console.log("   step B: dark set");
    d = await open(); await sleep(300);
    console.log("   step C: opened");
    check("with no main window it still opens (not modal)", d.win.isVisible() && !d.win.isModal());
    check("dark: the page follows (dark colour scheme)", (await js(d, "matchMedia('(prefers-color-scheme: dark)').matches")) === true);
    await shot(d, "update-dialog-dark");
    await click(d, "#ud-cancel"); await settled(d.answer);
    nativeTheme.themeSource = "system";
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((x) => !x.pass).length;
  console.log("PBCALC_UPDATEDIALOG total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
