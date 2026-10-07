// Clicking a FINISHED download opens PDFs, images and text files in a PBCalc tab (it used to hand them to Windows' default
// app, which for the owner is Chrome); every other type still goes to Windows. Also the tab session: Chromium's PDF viewer
// only renders in a persistent session, so a PDF must really DRAW in a PBCalc tab (it was an empty dark page).
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-open-downloads.js
const { app, shell, nativeImage } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 200000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-opendl-"));
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
    const dm = require("../electron/downloads/downloadManager");
    const dir = path.join(tmp, "files"); fs.mkdirSync(dir);
    const body = "BT /F1 28 Tf 20 100 Td (Hello PBCalc PDF) Tj ET";
    const pdf = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length " + body.length + ">>stream\n" + body + "\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF\n";
    const png = nativeImage.createFromBuffer(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")).resize({ width: 40, height: 40 }).toPNG();
    const files = {
      "doc.pdf": pdf, "pic.png": png, "note.txt": "plain text note 12345", "data.json": '{"hello":"json"}',
      "arch.zip": "PK", "page.html": "<script>document.title='RAN'</script>x", "vec.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>", "run.exe": "MZ", "table.csv": "a,b\n1,2",
    };
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
    // finished download rows, as the manager keeps them
    let nextId = 9000; const ids = {};
    for (const n of Object.keys(files)) { ids[n] = ++nextId; dm._items.push({ id: ids[n], filename: n, state: "completed", savePath: path.join(dir, n), received: 1, total: 1, url: "https://example.test/" + n, from: "https://example.test", startedAt: Date.now(), icon: "" }); }
    const rows = dm._items.length;
    const handedToWindows = [];
    shell.openPath = async (p) => { handedToWindows.push(path.basename(p)); return ""; };
    const active = () => state.tabs.find((t) => t.id === state.activeTabId);
    const clickOpen = async (name) => { const before = state.tabs.length; handedToWindows.length = 0; dm.open(ids[name]); await sleep(2800); return { opened: state.tabs.length > before, tab: state.tabs.length > before ? active() : null }; };
    const colours = async (wc) => { const img = await wc.capturePage(); const bm = img.toBitmap(); const seen = new Set(); for (let i = 0; i < bm.length; i += 4 * 7) seen.add((bm[i] >> 3) + "," + (bm[i + 1] >> 3) + "," + (bm[i + 2] >> 3)); return seen.size; };

    console.log("-- files PBCalc can show open in a PBCalc tab");
    let r = await clickOpen("doc.pdf");
    check("PDF: opens in a new PBCalc tab, not handed to Windows", r.opened && handedToWindows.length === 0 && /^file:\/\/\/.*doc\.pdf$/i.test(r.tab.view.webContents.getURL()));
    await sleep(3500);
    check("PDF: Chromium's PDF viewer really DRAWS it (an empty dark page before the session fix)", (await colours(r.tab.view.webContents)) > 40);
    check("PDF: the viewer is Chrome's built-in one (extension frame loaded)", (await r.tab.view.webContents.executeJavaScript("document.contentType")) === "application/pdf");
    r = await clickOpen("pic.png");
    check("PNG: opens in a tab", r.opened && handedToWindows.length === 0 && (await r.tab.view.webContents.executeJavaScript("document.contentType")) === "image/png");
    r = await clickOpen("note.txt");
    check("TXT: opens in a tab and shows its text", r.opened && handedToWindows.length === 0 && /plain text note 12345/.test(await r.tab.view.webContents.executeJavaScript("document.body.innerText")));
    r = await clickOpen("data.json");
    check("JSON: opens in a tab and shows its text", r.opened && /hello/.test(await r.tab.view.webContents.executeJavaScript("document.body.innerText")));
    check("none of those turned into a new download", dm._items.length === rows);

    console.log("\n-- everything else still goes to Windows, exactly as before");
    for (const n of ["arch.zip", "page.html", "vec.svg", "run.exe", "table.csv"]) {
      r = await clickOpen(n);
      check(n + ": handed to Windows, no tab", !r.opened && handedToWindows.join() === n);
    }

    console.log("\n-- Restricted Mode opens them in a tab too");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    r = await clickOpen("doc.pdf");
    check("PDF in Restricted Mode: opens in a PBCalc tab, not handed to Windows", r.opened && handedToWindows.length === 0);
    tm.leaveRestricted(); await sleep(800);

    console.log("\n-- safety");
    const before = state.tabs.length; handedToWindows.length = 0;
    dm._items.push({ id: 9999, filename: "gone.pdf", state: "completed", savePath: path.join(dir, "gone.pdf"), received: 1, total: 1, url: "", from: "", startedAt: 0, icon: "" });
    dm.open(9999); dm.open(123456); await sleep(600);
    check("a file that is gone / an unknown id: nothing happens", state.tabs.length === before && handedToWindows.length === 0);
    dm._items.push({ id: 9998, filename: "part.pdf", state: "in_progress", savePath: path.join(dir, "doc.pdf"), received: 0, total: 1, url: "", from: "", startedAt: 0, icon: "" });
    dm.open(9998); await sleep(600);
    check("an unfinished download is not opened", state.tabs.length === before && handedToWindows.length === 0);
    check("no uncaught error", errors.length === 0);
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_OPENDL total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
