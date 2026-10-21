// Print preview like Chrome's (electron/printPreview.js, renderer/printpreview/): Ctrl+P / ⋮ > Print open PBCalc's own dialog over the page
// (preview + settings) instead of the bare Windows dialog. WHICH settings show must match Chrome's rules (rules.js), which were measured from Chrome on
// this PC: every expectation below marked "Chrome" is what Chrome itself showed for that printer and document (owner 2026-10-15).
// Drives the REAL dialog page. Nothing reaches a printer: the printed page's print() is replaced by a recorder, and Save as PDF writes into a temp
// folder (the save dialog is answered by the test). Needs this PC's printers (TSC TE244, Microsoft XPS Document Writer, OneNote); a case whose printer
// is missing is reported as skipped.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-print-preview.js     (PBCALC_SHOTS=<dir> saves screenshots)
const { app, dialog, nativeTheme, BrowserWindow } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), http = require("http"), { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 420000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbpp-"));
const ud = path.join(tmp, "UserData");
require("../electron/constants").dataDir = () => ud;
fs.mkdirSync(ud, { recursive: true });
fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: false, themeMode: "light" }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0, total = 0;
const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 500) + ">" : "")); };
const SHOTS = process.env.PBCALC_SHOTS;
const TSC = "TSC TE244", XPS = "Microsoft XPS Document Writer", ONENOTE = "OneNote", PDF = "__pdf__";

(async () => {
  require("../electron/main.js");
  await app.whenReady();
  const state = require("../electron/state"), tm = require("../electron/tabs/tabManager"), pp = require("../electron/printPreview");
  for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);

  // printerCaps() is pre-warmed 3s after the window is up (electron/windows/mainWindow.js, owner 2026-10-16: "Chrome preview so fast or our
  // PBCalc take too much time preview") - measured: cold, it is a ~2-3s PowerShell enumeration; cached, ~20ms. Without the warm-up this call
  // (the suite's own setup, same as a user's first Ctrl+P) would be the ~2-3s one; wait past the warm-up delay AND its own ~2-3s PowerShell
  // run (not just the 3s schedule - a call landing WHILE the warm-up is still mid-flight now shares that same call instead of paying twice,
  // but still has to wait for it to finish) before asserting the cache is warm.
  await sleep(7000);
  const warmT0 = Date.now();
  const realCaps = await pp.printerCaps();
  check("printerCaps() is already warm by the time it is needed (pre-warmed in the background, not paid in front of the user's first Ctrl+P)", Date.now() - warmT0 < 500, (Date.now() - warmT0) + "ms");

  // two calls landing on a COLD cache at once must share the ONE PowerShell run, not each pay the ~2-3s cost separately (the race that showed
  // up while writing the warm-up above: a call arriving mid-flight used to start a second, fully independent enumeration)
  pp.setCapsForTest(null);
  const raceT0 = Date.now();
  const [raceA, raceB] = await Promise.all([pp.printerCaps(), pp.printerCaps()]);
  check("two concurrent printerCaps() calls on a cold cache share one PowerShell run (same result, one enumeration's worth of time, not two)",
    raceA === raceB && Date.now() - raceT0 < 6000, (Date.now() - raceT0) + "ms, sameArray=" + (raceA === raceB));
  pp.setCapsForTest(realCaps);   // back to a known-good, instantly-fast cache for the rest of the suite

  const have = (n) => realCaps.some((p) => p.name === n);
  // a web page of about 5 A4 pages, a short page (the TSC label printer turns long pages into thousands of labels), a one-page page, a 5-page PDF
  const body = "<title>Report Q3</title><h1>Report</h1>" + Array.from({ length: 150 }, (_, i) => "<p>Line " + (i + 1) + " of the report text.</p>").join("");
  // the ERP's EXACT real pattern (Mfg.Web jangads.component.ts, printJangadDetail): a hidden, never-navigated iframe, document.write()-ed
  // with onload="window.print(); window.close();" - the fallback it takes because PBCalc hides "Electron" from the UA. The visible page
  // carries a big grid (like the real jangads list) that must NEVER be what prints - only the iframe's own short challan content should.
  // The iframe's content also references the ERP's OWN kind of relative stylesheet (real file: Mfg.Web/src/assets/css/print.css) - proving
  // it actually loads (not just that SOME dialog opened) needs real tab path nesting, matching the ERP's own /jangad/jangads route.
  const ergButton = `<title>Jangads</title>` + Array.from({ length: 200 }, (_, i) => "<p>GRID ROW " + i + " - must never print</p>").join("") +
    `<button id="bigprint">Big Print</button><script>
    document.getElementById("bigprint").onclick = function() { setTimeout(function() {
      var f = document.createElement("iframe"); f.name = "frame1"; f.style.position = "absolute"; f.style.top = "-1000000px";
      document.body.appendChild(f);
      f.contentWindow.document.open();
      f.contentWindow.document.write("<html><head><title>Challan<\\/title><link rel=\\"stylesheet\\" type=\\"text\\/css\\" href=\\".\\/..\\/..\\/assets\\/css\\/print.css\\" media=\\"print\\"><\\/head><body onload=\\"window.print(); window.close();\\"><h1>DELIVERY CHALLAN MARKER<\\/h1><p class=\\"marker\\">styled<\\/p><\\/body><\\/html>");
      f.contentWindow.document.close();
    }, 0); };</script>`;
  const printCss = "@media print { .marker { border: 4px solid rgb(255,0,0); color: rgb(0,0,255); } }";
  const simpleButton = `<title>Simple</title><button id="p" onclick="window.print()">Print</button>`;
  // several real pages' worth even at the label's true (small, zero-margin) printable area - a handful of short lines used to be "enough" when
  // the preview wrongly applied a full ~1cm default margin to a <1in label; with the real (near-zero) margin now used, it needs more content to
  // reliably span multiple pages (the "odd pages" checks below need that to mean something)
  const pages = { "/one": "<title>One</title>short", "/other": "<title>Other</title>other",
    "/label": "<title>Label</title>" + Array.from({ length: 24 }, (_, i) => "<p>Line " + i + "</p>").join(""),
    "/jangad/jangads": ergButton, "/simpleprint": simpleButton };
  const srv = http.createServer((q, s) => {
    if (q.url === "/assets/css/print.css") { s.setHeader("content-type", "text/css"); s.end(printCss); return; }
    s.setHeader("content-type", "text/html"); s.end(pages[q.url] || body);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const base = "http://127.0.0.1:" + srv.address().port + "/";
  const pdfFile = path.join(tmp, "doc.pdf");
  { const w = new BrowserWindow({ show: false }); await w.loadURL("data:text/html,<h1>PDF doc</h1>" + "<p>line</p>".repeat(120)); fs.writeFileSync(pdfFile, await w.webContents.printToPDF({})); w.destroy(); }

  const printed = [];
  const record = (wc) => { wc.print = (opts, cb) => { printed.push(opts); if (cb) setImmediate(() => cb(true, "")); }; };   // never a real printer
  const openTab = async (url) => { tm.createTab(url); await sleep(url.endsWith(".pdf") ? 2500 : 1200); const t = state.tabs[state.tabs.length - 1]; record(t.view.webContents); tm.switchTab(t.id); await sleep(300); return t; };

  const dlgView = () => state.mainWindow.getBrowserViews().find((v) => !v.webContents.isDestroyed() && /printpreview\.html/.test(v.webContents.getURL()));
  const dj = (code) => dlgView().webContents.executeJavaScript(code);
  const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch (_) {} await sleep(100); } return false; };
  const NAMES = { "dest-row": "Destination", "pages-row": "Pages", "copies-row": "Copies", "layout-row": "Layout", "color-row": "Color", "paper-row": "Paper size",
    "pps-row": "Pages per sheet", "margins-row": "Margins", "dpi-row": "Quality", "scale-row": "Scale", "duplex-row": "Two-sided", "options-row": "Options" };
  // what is really DRAWN (height > 0), not just marked: a hidden attribute beaten by CSS fooled the first version of this test
  const ui = () => dj(`(() => { const $ = (i) => document.getElementById(i); const drawn = (i) => $(i).getBoundingClientRect().height > 0;
    const sel = (i) => [...$(i).options].map((o) => o.textContent);
    return { rows: ${JSON.stringify(Object.keys(NAMES))}.filter(drawn), more: drawn("more"), moreOpen: $("more").getAttribute("aria-expanded") === "true",
      dest: $("dest").value, dests: sel("dest"), pages: sel("pages"), papers: sel("paper"), paper: $("paper").value, scales: sel("scale-mode"), margins: sel("margins"),
      headers: drawn("headers-row"), background: drawn("background-row"), collate: drawn("collate-row"), edge: drawn("duplex-edge"), dpis: sel("dpi"),
      sheets: $("sheets").textContent, src: $("pdf").src, go: $("go").textContent, goDisabled: $("go").disabled, loading: $("loading").classList.contains("show"),
      err: !$("custom-err").hidden, bw: $("pdf").classList.contains("bw"), icon: drawn("ico-pdf") ? "pdf" : "printer" }; })()`);
  const rowNames = (u) => u.rows.map((r) => NAMES[r]).join(", ");
  const set = (id, value) => dj(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (el.type === "checkbox") el.checked = ${JSON.stringify(value)}; else el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("change", { bubbles: true })); return 1; })()`);
  const type = (id, value) => dj(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const click = (id) => dj(`document.getElementById(${JSON.stringify(id)}).click(), 1`);
  const previewDone = async (prevSrc) => waitFor(async () => { const u = await ui(); return !u.loading && u.src && u.src !== prevSrc; });
  const openDialog = async () => { tm.printActive(); await waitFor(() => !!dlgView()); await waitFor(async () => (await ui()).dests.length > 0); await previewDone(""); return ui(); };
  const expand = async () => { const u = await ui(); if (u.more && !u.moreOpen) { await click("more"); await sleep(150); } return ui(); };
  const pick = async (destId) => { const u0 = await ui(); if (u0.dest !== destId) { await set("dest", destId); await previewDone(u0.src); } await sleep(200); return expand(); };
  const shot = async (name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await sleep(600); fs.writeFileSync(path.join(SHOTS, name + ".png"), (await dlgView().webContents.capturePage()).toPNG()); };

  let winDefault = "";
  try { winDefault = (/Device\s+REG_SZ\s+(.+)/.exec(execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows", "/v", "Device"], { encoding: "utf8" })) || [])[1].split(",")[0].trim(); } catch (_) {}

  console.log("-- Ctrl+P opens the preview");
  const tab = await openTab(base + "report");
  const wc = tab.view.webContents;
  wc.focus(); await sleep(100);
  wc.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers: ["control"] }); wc.sendInputEvent({ type: "keyUp", keyCode: "P", modifiers: ["control"] });
  check("Ctrl+P opens PBCalc's print dialog (not the Windows one)", await waitFor(() => !!dlgView()) && printed.length === 0);
  const b = dlgView().getBounds(), [cw, ch] = state.mainWindow.getContentSize();
  check("it covers the page area, under the tab strip and toolbar (tab-modal, like Chrome)", b.x === 0 && b.y === tm.chromeHeight() && b.width === cw && b.y + b.height === ch, JSON.stringify(b));
  await waitFor(async () => (await ui()).dests.length > 0);
  check("the preview appears (a PDF of the page in the left part)", await previewDone(""));
  let u = await ui();
  check("Destination list like Chrome's: the chosen printer, then 'Save as PDF', then the other printers (" + u.dests.length + ")", u.dests[1] === "Save as PDF" && u.dests.length >= 2, JSON.stringify(u.dests));
  check("the Windows default printer is chosen first (" + (winDefault || "none") + ") with a printer icon", (winDefault ? u.dest === winDefault : true) && u.icon === "printer", u.dest);
  check("'Background graphics' is CHECKED by default on a fresh session (owner 2026-10-21, from the compressnow.com comparison - no sticky choice has been made yet)", await dj(`document.getElementById("background").checked`));
  wc.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers: ["control"] }); await sleep(400);
  check("a second Ctrl+P while it is open does not open another one", state.mainWindow.getBrowserViews().filter((v) => /printpreview/.test(v.webContents.getURL())).length === 1);

  console.log("-- opening on a COLD caps cache must not block, like Chrome's own dialog (owner 2026-10-21: 'loading print preview... optimise same as chrome print preview open', reproduced with no antivirus running)");
  pp.close(); await sleep(200);
  pp.setCapsForTest(null);
  const coldT0 = Date.now();
  u = await openDialog();
  const coldMs = Date.now() - coldT0;
  check("the dialog opens and a preview renders fast even with a COLD caps cache (never blocks the whole panel on the ~2-3s PowerShell enumeration)", coldMs < 1500 && !!u.src, coldMs + "ms, src=" + !!u.src);
  check("...the destination list is already right (sticky/Windows-default printer first, 'Save as PDF' second) using the SAFE FALLBACK caps for the moment", u.dests.length > 0 && u.papers.join("|") === "Legal|Letter|Tabloid|A0|A1|A2|A3|A4|A5", JSON.stringify(u.papers));
  await sleep(4000);   // printerCaps()'s real PowerShell enumeration has time to finish and push print:caps-updated
  u = await ui();
  check("...the REAL per-printer paper list lands a moment later on its own (no reopen needed, the dialog is still the SAME one)", u.papers.join("|") !== "Legal|Letter|Tabloid|A0|A1|A2|A3|A4|A5" && !!dlgView(), JSON.stringify(u.papers));
  pp.setCapsForTest(realCaps);

  console.log("-- which settings show: a WEB PAGE (Chrome's answers, measured)");
  u = await pick(PDF);
  check("Save as PDF: Destination, Pages, Layout, Paper size, Margins, Scale, Options - no Copies / Color (Chrome; Pages per sheet: see differences)", rowNames(u) === "Destination, Pages, Layout, Paper size, Margins, Scale, Options", rowNames(u));
  check("...Chrome's paper list Legal / Letter / Tabloid / A0..A5, A4 chosen; the button says Save; a PDF icon", u.papers.join("|") === "Legal|Letter|Tabloid|A0|A1|A2|A3|A4|A5" && u.paper === "A4" && u.go === "Save" && u.icon === "pdf", JSON.stringify([u.paper, u.go, u.icon]));
  check("...the count is in pages (" + u.sheets + ")", /^\d+ pages?$/.test(u.sheets), u.sheets);
  check("...Pages: All / Odd pages only / Even pages only / Custom (several pages)", u.pages.join("|") === "All|Odd pages only|Even pages only|Custom", u.pages.join("|"));
  check("...Scale: Default / Custom; Margins: Default / None / Minimum / Custom", u.scales.join("|") === "Default|Custom" && u.margins.join("|") === "Default|None|Minimum|Custom");
  const pagesAll = parseInt(u.sheets, 10);
  check("(the test page is several pages: " + pagesAll + ")", pagesAll >= 2);
  await shot("print-light");

  console.log("-- Margins > Custom: four inch fields, no drag guides (PBCalc's #pdf is Chromium's own stock PDF viewer - chosen by the owner over redesigning the preview's zoom handling)");
  {
    check("hidden while Margins is not Custom", await dj(`document.getElementById("margins-custom").hidden`));
    await set("margins", "custom"); await sleep(300);
    const seeded = await dj(`["margin-top", "margin-left", "margin-right", "margin-bottom"].map(id => document.getElementById(id).value)`);
    check("...shown, seeded with ~1cm (Chromium's own 'Default' margin) the first time - not zero, not a blank field", !(await dj(`document.getElementById("margins-custom").hidden`)) && seeded.every((v) => Math.abs(parseFloat(v) - 0.39) < 0.001), JSON.stringify(seeded));
    let prev = (await ui()).src;
    await type("margin-top", "3"); await type("margin-bottom", "3");
    check("...typing a big top+bottom margin makes a NEW, longer preview (less room per page)", await previewDone(prev) && parseInt((await ui()).sheets, 10) > pagesAll, (await ui()).sheets);
    prev = (await ui()).src;
    await type("margin-top", "999");
    check("...an out-of-range value (999) clamps to the field's own max (5in), not left as typed or silently dropped", await waitFor(async () => (await dj(`document.getElementById("margin-top").value`)) === "5"), await dj(`document.getElementById("margin-top").value`));
    await type("margin-top", "0.1"); await previewDone(prev);
    await set("margins", "default"); await sleep(300);
    await set("margins", "custom"); await sleep(300);
    const kept = await dj(`[document.getElementById("margin-top").value, document.getElementById("margin-bottom").value]`);
    check("...switching away and back to Custom keeps what was typed (0.1 / 3), not re-seeded to ~1cm", kept[0] === "0.1" && kept[1] === "3", JSON.stringify(kept));
    pp.close(); await sleep(200);
    u = await openDialog(); u = await pick(PDF);
    check("...closing the dialog and reopening it still remembers Custom and the typed values (sticky, like the destination)", u.dest === PDF && (await dj(`document.getElementById("margins").value`)) === "custom" && (await dj(`[document.getElementById("margin-top").value, document.getElementById("margin-bottom").value]`)).join() === "0.1,3", JSON.stringify([u.dest, await dj(`document.getElementById("margins").value`)]));
    await set("margins", "default"); await sleep(300);
  }

  console.log("-- the scroll-time 'page N' badge (owner 2026-10-21, measured from real Chrome - Chromium's own never appears in our embedded viewer, even with real OS scrolling, confirmed by hand; print:page-scroll drives our OWN replica, see the big comment in electron/printPreview.js)");
  {
    // Calls the REAL poller's own read function (READ_PAGE_INFO) against the live PDF viewer - not the
    // fake IPC push the rest of this block uses. This is the one check that would have caught the real
    // bug shipped in this feature (owner 2026-10-21: "scroll in print preview but not showing page
    // count"): `vp.documentDimensions` was read as a plain property where the real API is the METHOD
    // `vp.getDocumentDimensions()`, so it threw on every single poll tick and `frac` was always null -
    // the renderer-only test below never caught it because it feeds `frac` in by hand and never
    // actually calls this script against a real viewer.
    // the viewer re-initializes its internals (viewport_ etc.) fresh each time the iframe's src is
    // replaced for a new render (every settings change in the Custom margins block just above did
    // that), so poll like the real poller does rather than assuming the very first read is ready.
    let info = null;
    await waitFor(async () => { info = await pp.readPageInfoForTest(tab.id); return info && typeof info.page === "number" && info.page > 0 && typeof info.frac === "number"; });
    check("the real poller's own read function returns a valid page AND a valid numeric frac (not null) against the live viewer - this is what actually broke before, invisibly, with no error anywhere", info && typeof info.page === "number" && typeof info.frac === "number", JSON.stringify(info));
    // the underlying page-tracking only updates on REAL OS mouse-wheel input (measured - a synthetic
    // sendInputEvent wheel left it frozen), so this cannot drive a real scroll the way the rest of this
    // suite drives everything else; instead it feeds the dialog the exact IPC push the main-process
    // poller would send and checks the RENDERER's own contract (show/position/text/fade) - the owner
    // confirms the real end-to-end scroll-to-badge wiring by hand, same as this project's other
    // real-OS-pointer limits (e.g. the bookmark bar drag test).
    // `frac` is the SAME continuous scroll fraction Chromium's own scrollbar thumb is drawn from
    // (pdf-viewer's viewport_.position.y / (documentDimensions.height - size.height), read in main -
    // see startBadgePoll) - NOT a page/total stand-in, which an earlier version used and which visibly
    // lagged the real thumb whenever scrolling stayed within one page (owner's screenshots: two shots
    // of the same page number showed the real thumb in two different spots - fixed, see the BUG
    // comment on startBadgePoll in electron/printPreview.js). The test feeds `frac` directly since it
    // is simulating the IPC push itself, not a real scroll (see the comment above this block).
    const badgeShown = () => dj(`(() => { const el = document.getElementById("page-badge"); return { shown: el.classList.contains("show"), text: el.textContent, top: el.style.top }; })()`);
    check("hidden before any scroll signal", !(await badgeShown()).shown);
    dlgView().webContents.send("print:page-scroll", { page: 1, frac: 0 });
    await sleep(100);
    let b = await badgeShown();
    check("page 1, frac 0: shows '1' at the top of the preview pane", b.shown && b.text === "1" && parseInt(b.top, 10) <= 2, JSON.stringify(b));
    dlgView().webContents.send("print:page-scroll", { page: pagesAll, frac: 1 });
    await sleep(100);
    b = await badgeShown();
    const areaH = await dj(`document.getElementById("preview").clientHeight`);
    check("the last page, frac 1: shows the final page number, positioned at the BOTTOM of the pane (tracks scroll position)", b.shown && b.text === String(pagesAll) && parseInt(b.top, 10) >= areaH - 42, JSON.stringify([b, areaH]));
    // a frac change WITHIN the same page must still move the badge (this is exactly the bug: the old
    // page/total version never moved unless the page NUMBER changed)
    dlgView().webContents.send("print:page-scroll", { page: pagesAll, frac: 0.5 });
    await sleep(100);
    const bMid = await badgeShown();
    check("...and a frac change alone (same page number) still moves it - the actual bug being fixed here", bMid.shown && bMid.text === String(pagesAll) && Math.abs(parseInt(bMid.top, 10) - parseInt(b.top, 10)) > 20, JSON.stringify([bMid, b]));
    await sleep(2400);
    check("fades out ~2-2.5s after the last scroll signal (measured against real Chrome: still visible at 2000ms, gone by 2500ms)", !(await badgeShown()).shown);
  }

  if (have(XPS)) {
    u = await pick(XPS);
    check("XPS Writer: Destination, Pages, Layout, Color, Paper size, Pages per sheet, Margins, Scale, Options - no Copies (Chrome: it makes 1 copy)", rowNames(u) === "Destination, Pages, Layout, Color, Paper size, Pages per sheet, Margins, Scale, Options", rowNames(u));
    check("...65 paper sizes, Letter first (Chrome: same 65, same order); the A4 chosen before is kept (the XPS Writer has A4 too)", u.papers.length === 65 && u.papers[0] === "Letter" && u.paper === "A4", u.papers.length + " " + u.paper);
    check("...'Headers and footers' AND 'Background graphics' (Chrome)", u.headers && u.background);
    let prev = u.src;
    await set("color", "bw"); await sleep(300); u = await ui();
    check("...Color > Black and white turns the preview grey without making a new one", u.bw && u.src === prev);
    await set("color", "color");
    await set("margins", "none"); await previewDone(prev); u = await ui(); prev = u.src;
    check("...Margins None: 'Headers and footers' goes (Chrome: no room for them)", !u.headers && u.background);
    await set("margins", "default"); await previewDone(prev);
  } else console.log("  .. (skipped: no " + XPS + ")");
  pp.close(); await sleep(200);
  if (have(TSC)) {
    const labelTab = await openTab(base + "label");
    u = await openDialog(); u = await pick(TSC);
    check("TSC label printer: Destination, Pages, Copies, Layout, Paper size, Pages per sheet, Margins, Scale, Options - no Color (Chrome)", rowNames(u) === "Destination, Pages, Copies, Layout, Paper size, Pages per sheet, Margins, Scale, Options", rowNames(u));
    check("...its own paper list USER / 2 x 4 / 4 x 4 / Exe Barcode, 'Exe Barcode' chosen (Chrome; '4 x 6' has USER's size, shown once)", u.papers.join("|") === "USER|2 x 4|4 x 4|Exe Barcode" && u.paper === "Exe Barcode", u.papers.join("|") + " / " + u.paper);
    check("...no 'Headers and footers' (the label is under 1 inch tall), 'Background graphics' yes (Chrome)", !u.headers && u.background);
    check("...'More settings' button present (more than 6 sections)", u.more);
    check("...with 1 copy there is no 'Collate'", !u.collate);
    await set("copies", "3"); await sleep(300); u = await ui();
    check("...3 copies: still no 'Collate' on the TSC (Chrome: it cannot collate) and 3x the labels (" + u.sheets + ")", !u.collate && /sheets of paper/.test(u.sheets));
    await set("copies", "1");
    await set("pages", "odd"); await set("copies", "2"); await set("pps", "2"); await set("layout", "landscape"); await set("background", true);
    await sleep(1200);
    await click("go");
    check("Print hands the job to the printer and the dialog closes", await waitFor(() => printed.length === 1 && !dlgView()));
    const o = printed[0] || {};
    check("...silently, to the TSC (no second dialog)", o.silent === true && o.deviceName === TSC, JSON.stringify(o));
    check("...on its own paper: Exe Barcode = 39878 x 20066 microns", o.pageSize && o.pageSize.width === 39878 && o.pageSize.height === 20066, JSON.stringify(o.pageSize));
    const odd = Array.isArray(o.pageRanges) && o.pageRanges.length >= 1 && o.pageRanges.every((r, i) => r.from === 2 * i && r.to === 2 * i);
    check("...odd pages, 2 copies, 2 per sheet, landscape, background; colour untouched (the TSC has no Color choice)", odd && o.copies === 2 && o.pagesPerSheet === 2 && o.landscape === true && o.printBackground === true && o.color === true, JSON.stringify(o).slice(0, 300));
    // Chrome's rule measures the height AS LAID OUT: in landscape the label is 1.57 in tall, so the header is allowed (ticked by default).
    // No footer at all on the real-printer path (owner's request 2026-10-20: never print the page's address - see pdfOptions' comment).
    check("...landscape: the label is 1.57 in tall, so the (ticked) header is printed - Chrome's rule uses the laid-out height; no address footer", o.header === "Label" && !o.footer, JSON.stringify([o.header, o.footer]));

    console.log("-- BUG found 2026-10-20 (owner: a real print gave no physical output, no error anywhere) - Custom margins on a REAL PRINT --");
    u = await openDialog(); u = await pick(TSC);
    await set("margins", "custom"); await sleep(300);
    await type("margin-top", "0.5"); await type("margin-bottom", "0.25"); await type("margin-left", "0.1"); await type("margin-right", "0.2"); await sleep(700);
    await click("go");
    await waitFor(() => printed.length === 2 && !dlgView());
    const om = printed[1] || {};
    // Electron's print() wants CUSTOM margins in MICRONS alongside marginType:"custom" (unlike printToPDF's margins, which are inches) -
    // the bug sent `{ marginType: undefined }` (an EMPTY object once serialized: no type, no values at all), silently losing the user's
    // own choice to whatever Chromium falls back to. 1 inch = 25400 microns: 0.5in -> 12700, 0.25in -> 6350, 0.1in -> 2540, 0.2in -> 5080.
    check("Custom margins reach the real printer as marginType:custom + the actual values in microns (not an empty object)",
      om.margins && om.margins.marginType === "custom" && om.margins.top === 12700 && om.margins.bottom === 6350 && om.margins.left === 2540 && om.margins.right === 5080,
      JSON.stringify(om.margins));

    console.log("-- BUG found 2026-10-20 - a FAILED real print used to go nowhere (dialog already destroyed before Windows answers) --");
    u = await openDialog(); u = await pick(TSC);
    let errorBoxCalls = [];
    const origErrorBox = dialog.showErrorBox;
    dialog.showErrorBox = (title, content) => errorBoxCalls.push({ title, content });
    const origPrint = labelTab.view.webContents.print;
    labelTab.view.webContents.print = (opts, cb) => { printed.push(opts); if (cb) setImmediate(() => cb(false, "test-forced-failure: printer not found")); };
    await click("go");
    await waitFor(() => !dlgView());
    await sleep(400);
    check("a failed real print now shows a native error box naming the printer and the reason (not silence)",
      errorBoxCalls.length === 1 && /TSC TE244/.test(errorBoxCalls[0].content) && /test-forced-failure/.test(errorBoxCalls[0].content),
      JSON.stringify(errorBoxCalls));
    dialog.showErrorBox = origErrorBox;
    labelTab.view.webContents.print = origPrint;

    tm.switchTab(tab.id); await sleep(300);
  } else console.log("  .. (skipped: no " + TSC + ")");

  console.log("-- settings change the preview (Save as PDF)");
  u = await openDialog(); u = await pick(PDF);
  check("the TSC print's '2 pages per sheet' (remembered) does not halve Save as PDF's page count - it has no Pages per sheet", parseInt(u.sheets, 10) === (await dj(`document.getElementById("layout").value`) === "landscape" ? 8 : pagesAll), u.sheets);
  if (await dj(`document.getElementById("layout").value`) === "landscape") { const p0 = u.src; await set("layout", "portrait"); await previewDone(p0); u = await ui(); }
  let prev = u.src;
  await set("layout", "landscape");
  check("Layout > Landscape makes a new preview with more pages for the same text", await previewDone(prev) && parseInt((await ui()).sheets, 10) > pagesAll, (await ui()).sheets);
  prev = (await ui()).src;
  await set("layout", "portrait"); await previewDone(prev);
  await set("pages", "custom"); await type("custom", "2");
  check("Pages > Custom '2' shows just that page", await waitFor(async () => (await ui()).sheets === "1 page"), (await ui()).sheets);
  await type("custom", "9-3");
  check("an impossible range ('9-3') shows 'Invalid page range' and Save is disabled", await waitFor(async () => { const x = await ui(); return x.err && x.goDisabled; }));
  await set("pages", "all"); await waitFor(async () => !(await ui()).goDisabled);
  await set("scale-mode", "custom"); await type("scale", "50"); await sleep(1500);
  check("Scale 50% fits the text on fewer pages", parseInt((await ui()).sheets, 10) < pagesAll, (await ui()).sheets);
  await set("scale-mode", "default"); await sleep(700);
  const out = path.join(tmp, "saved.pdf");
  const origSave = dialog.showSaveDialog;
  let askedName = "";
  dialog.showSaveDialog = async (_w, opts) => { askedName = path.basename((opts || _w).defaultPath || ""); return { canceled: false, filePath: out }; };
  await click("go");
  check("Save writes a real PDF file and the dialog closes", await waitFor(() => fs.existsSync(out) && !dlgView()) && fs.readFileSync(out).slice(0, 5).toString() === "%PDF-");
  check("...offered under the page's title (" + askedName + ")", askedName === "Report Q3.pdf");
  dialog.showSaveDialog = origSave;

  if (have(XPS)) {
    u = await openDialog(); u = await pick(XPS);
    await set("color", "bw"); await set("paper", "A4"); await sleep(1000);
    const n0 = printed.length;
    await click("go");
    await waitFor(() => !dlgView() && printed.length > n0);
    const o = printed[printed.length - 1] || {};
    // Owner's request 2026-10-20: the page's own address is never printed, even with Headers and footers on (privacy - a printed page can
    // be handed to someone else) - title stays, footer carries no address at all (opts.footer is not even set for the real-printer path).
    check("XPS: black and white, A4 (210058 x 296926 microns from Windows), headers + footers on by default (title only, NO address), 1 copy", o.deviceName === XPS && o.color === false && o.pageSize && o.pageSize.width === 210058 && o.header === "Report Q3" && !o.footer && o.copies === 1, JSON.stringify(o));
    u = await openDialog(); await expand();
    const kept = await dj(`[document.getElementById("color").value, document.getElementById("paper").value, document.getElementById("pages").value].join()`);
    check("the next Print keeps the printer, colour and paper; pages, copies and pages per sheet start fresh (Chrome's sticky settings)", (await ui()).dest === XPS && kept === "bw,A4,all" && (await dj(`document.getElementById("pps").value`)) === "1", kept);
    pp.close(); await sleep(200);
  }

  console.log("-- a destination picked but never printed is still remembered on Cancel, like real Chrome (owner's repro, measured against real Chrome with CDP: pick a destination, Esc, reopen - it is still selected, not only after Print/Save)");
  {
    u = await openDialog();
    const before = u.dest;
    const alt = before === PDF ? (have(XPS) ? XPS : have(TSC) ? TSC : null) : PDF;
    if (alt) {
      u = await pick(alt);
      check("picking a destination updates the remembered one right away", (await ui()).dest === alt, (await ui()).dest);
      pp.close(); await sleep(200);   // Cancel/Esc - never clicked Print or Save
      u = await openDialog();
      check("...the NEXT open still shows it, even though nothing was ever printed or saved", u.dest === alt, u.dest);
      pp.close(); await sleep(200);
    } else console.log("  .. (skipped: no alternate destination installed)");
  }

  console.log("-- 'More settings' has no hover background, like real Chrome (measured with real CDP mouse input against real Chrome: a mouse-move over the row produces a pixel-identical screenshot before/after - only the cursor changes)");
  {
    u = await openDialog();
    const rules = await dj(`[...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch (_) { return []; } })
      .filter(r => r.selectorText).map(r => r.selectorText + " { background: " + (r.style.background || r.style.backgroundColor || "") + " }")`);
    const moreHover = rules.find((r) => r.startsWith("#more:hover"));
    const linkHover = rules.find((r) => r.startsWith(".link:hover"));
    check("...no '#more:hover' rule sets a background any more", !moreHover, moreHover || "(none)");
    check("...'.link:hover' (Print using system dialog...) still keeps its own hover tint - only 'More settings' changed", !!linkHover && /background:\s*var\(--pp-hover\)/.test(linkHover), linkHover);
    pp.close(); await sleep(200);
  }

  console.log("-- which settings show: a PDF FILE (Chrome's answers, measured)");
  await openTab(pathToFileURL(pdfFile).href);
  u = await openDialog();
  check("a PDF tab prints the PDF's own 5 pages", /\b5 (sheets of paper|pages)$/.test(u.sheets), u.sheets);
  if (have(XPS)) {
    u = await pick(XPS);
    check("XPS + PDF: Destination, Pages, Color, Paper size, Pages per sheet, Scale - no Layout / Margins / Options, no 'More settings' (Chrome)", rowNames(u) === "Destination, Pages, Color, Paper size, Pages per sheet, Scale" && !u.more, rowNames(u) + " more=" + u.more);
  }
  if (have(TSC)) {
    u = await pick(TSC);
    check("TSC + PDF: Destination, Pages, Copies, Paper size, Pages per sheet, Scale, no 'More settings' (Chrome)", rowNames(u) === "Destination, Pages, Copies, Paper size, Pages per sheet, Scale" && !u.more, rowNames(u) + " more=" + u.more);
  }
  if (have(ONENOTE)) {
    u = await pick(ONENOTE);
    check("OneNote + PDF: 7 sections, so 'More settings' appears (Chrome)", u.more && rowNames(u) === "Destination, Pages, Copies, Color, Paper size, Pages per sheet, Scale", rowNames(u) + " more=" + u.more);
    await click("more"); await sleep(150); u = await ui();
    check("...closing 'More settings' hides Paper size, Pages per sheet and Scale", rowNames(u) === "Destination, Pages, Copies, Color", rowNames(u));
  }
  u = await pick(PDF);
  check("Save as PDF + PDF: only Destination and Pages (Chrome also shows Pages per sheet - see differences)", rowNames(u) === "Destination, Pages" && !u.more, rowNames(u));
  pp.close(); await sleep(200);

  console.log("-- a one-page document; a printer that prints two-sided with two resolutions");
  await openTab(base + "one");
  u = await openDialog();
  check("one page: Pages offers only All / Custom (Chrome: Odd / Even only with more than 1 page)", u.pages.join("|") === "All|Custom", u.pages.join("|"));
  pp.close(); await sleep(200);
  if (have(XPS)) {
    pp.setCapsForTest(realCaps.map((p) => (p.name === XPS ? { ...p, duplex: true, dpis: ["600x600", "1200x1200"], defDpi: "600x600" } : p)));
    tm.switchTab(tab.id); await sleep(300);
    u = await openDialog(); u = await pick(XPS);
    check("two-sided printer: a 'Two-sided' section; two resolutions: a 'Quality' section (600 dpi / 1200 dpi)", u.rows.includes("duplex-row") && u.rows.includes("dpi-row") && u.dpis.join("|") === "600 dpi|1200 dpi", rowNames(u) + " " + u.dpis.join("|"));
    const sh1 = parseInt(u.sheets, 10);
    await set("duplex", true); await sleep(300); u = await ui();
    check("...'Print on both sides' shows the edge choice and halves the sheets (" + sh1 + " -> " + parseInt(u.sheets, 10) + ")", u.edge && parseInt(u.sheets, 10) === Math.ceil(sh1 / 2), u.sheets);
    await set("duplex-edge", "short"); await set("dpi", "1200x1200"); await sleep(300);
    const n0 = printed.length;
    await click("go"); await waitFor(() => !dlgView() && printed.length > n0);
    const o = printed[printed.length - 1] || {};
    check("...printed two-sided, short edge, at 1200 dpi", o.duplexMode === "shortEdge" && o.dpi && o.dpi.horizontal === 1200, JSON.stringify(o));
    pp.setCapsForTest(null);
  }

  console.log("-- what closes it (Esc / Cancel)");
  tm.switchTab(tab.id); await sleep(300);
  await openDialog();
  dlgView().webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }); dlgView().webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  check("Esc closes it", await waitFor(() => !dlgView()));
  const nPrinted = printed.length;
  await openDialog(); await click("cancel");
  check("Cancel closes it, nothing printed", await waitFor(() => !dlgView()) && printed.length === nPrinted);

  // The DOM element of a tab, found the same way other tests do (by its CSS order = its index in state.tabs) - used to read the pending dot.
  const tabEl = (t) => `[...document.querySelectorAll(".tab:not(.closing)")].find((e) => e.style.order === "${state.tabs.indexOf(t)}")`;
  const dotShows = (t) => js(`(() => { const el = ${tabEl(t)}; return el ? el.querySelector(".tab-pending-dot").classList.contains("show") : null; })()`);
  const js = (code) => state.mainWindow.webContents.executeJavaScript(code);
  const viewCount = () => state.mainWindow.getBrowserViews().length;

  console.log("-- a preview SURVIVES a tab switch, like real Chrome (owner 2026-10-15; measured against Chrome with CDP)");
  const other = await openTab(base + "other");
  tm.switchTab(tab.id); await sleep(300);
  u = await openDialog();
  await set("layout", "landscape"); await previewDone(u.src);
  u = await ui();
  const survivedSrc = u.src;
  check("(setup: landscape chosen, a real preview rendered)", /^blob:/.test(survivedSrc));
  tm.switchTab(other.id); await sleep(400);
  check("switching tabs does NOT close it - it only stops being drawn on screen", !dlgView() && pp.hasPending(tab.id));
  check("a dot appears on the BACKGROUND tab's favicon (Chrome's own colour, measured: var(--omnibox-ring))", (await dotShows(tab)) === true);
  check("...and NOT on the active tab, nor on a tab with no pending preview", (await dotShows(other)) === false);
  tm.switchTab(tab.id); await sleep(400);
  u = await ui();
  check("switching back shows the SAME preview again - same settings (Landscape)", !!dlgView() && (await dj(`document.getElementById("layout").value`)) === "landscape");
  check("...the exact same rendered PDF, not a new one (same blob: address = no re-render, no flash, exactly as measured in Chrome)", u.src === survivedSrc, u.src + " vs " + survivedSrc);
  check("...and the dot is gone now that the tab is active again (matches Chrome: no dot while visible)", (await dotShows(tab)) === false);

  console.log("-- several tabs can each have their OWN pending preview at once (measured in Chrome)");
  tm.switchTab(other.id); await sleep(300);
  u = await openDialog(); u = await pick(PDF);
  await set("paper", "A5"); await sleep(1500);
  check("(setup: a DIFFERENT preview open on the other tab, A5)", (await ui()).paper === "A5");
  check("both tabs show a pending dot for each other (symmetric)", (await dotShows(tab)) === true);
  tm.switchTab(tab.id); await sleep(400);
  check("tab A's preview kept ITS OWN settings (A4, landscape) - unaffected by tab B's A5 choice: no shared state between them", (await ui()).paper !== "A5" && (await dj(`document.getElementById("layout").value`)) === "landscape");
  tm.switchTab(other.id); await sleep(400);
  check("tab B's preview is still exactly A5 (switching through A did not disturb it)", (await ui()).paper === "A5");
  pp.close(); await sleep(200);   // closes tab B's (the one on screen)
  check("closing tab B's preview leaves tab A's pending preview untouched", pp.hasPending(tab.id) && !pp.hasPending(other.id));
  tm.switchTab(tab.id); await sleep(300); pp.close(); await sleep(200);

  console.log("-- a BACKGROUND tab's page navigating away still closes ITS preview (measured: Chrome does too, even a self-triggered redirect)");
  const preListeners = wc.listenerCount("did-start-navigation"), preViews = viewCount();   // BEFORE opening - the preview's own listener/view must not outlive it
  u = await openDialog();
  check("(setup: opening it adds one BrowserView and one listener on the page)", viewCount() === preViews + 1 && wc.listenerCount("did-start-navigation") === preListeners + 1);
  tm.switchTab(other.id); await sleep(400);
  check("(setup: a pending preview on the now-BACKGROUND tab)", pp.hasPending(tab.id) && (await dotShows(tab)) === true);
  wc.loadURL(base + "report?nav-while-background"); await sleep(1200);   // the backgrounded page navigates by itself, as a timer-driven redirect would
  check("the background page's own navigation closed its preview (and took the dot with it, with no need to switch tabs first)", !pp.hasPending(tab.id) && (await dotShows(tab)) === false);
  check("...no leftover listener on the page, no leftover BrowserView", wc.listenerCount("did-start-navigation") === preListeners && viewCount() === preViews);
  tm.switchTab(tab.id); await sleep(300);

  console.log("-- closing a BACKGROUND tab with a pending preview cleans up (no error, no leftover view)");
  const victim = await openTab(base + "other");
  u = await openDialog();   // on the victim tab (active)
  const base1 = viewCount();
  tm.switchTab(tab.id); await sleep(400);
  check("(setup: pending preview on a now-background tab that is about to be closed)", pp.hasPending(victim.id));
  tm.closeTab(victim.id); await sleep(400);
  check("closing that background tab removes its pending preview with no leftover BrowserView", !pp.hasPending(victim.id) && viewCount() === base1 - 1);

  console.log("-- a REAL website (network, owner's request: 'make use of some real site')");
  const wiki = await openTab("https://en.wikipedia.org/wiki/Main_Page");
  await sleep(2500);   // real page, more to settle than the local test server
  if (!wiki.view.webContents.isDestroyed() && /Wikipedia/i.test(wiki.view.webContents.getTitle() || "")) {
    u = await openDialog();
    check("a real external site previews correctly (a non-trivial PDF with content)", /^blob:/.test(u.src) && !!u.sheets);
    u = await pick(PDF);   // the destination carried over from earlier steps could be a real printer - force Save as PDF for this check
    check("Save as PDF works end to end on a real page", u.dest === PDF && u.go === "Save");
    const realOut = path.join(tmp, "wikipedia.pdf");
    const origSave2 = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: realOut });
    await click("go");
    check("...a real, non-empty PDF file was written", await waitFor(() => fs.existsSync(realOut)) && fs.statSync(realOut).size > 5000, fs.existsSync(realOut) ? fs.statSync(realOut).size : "missing");
    dialog.showSaveDialog = origSave2;
  } else {
    console.log("  .. (skipped: could not reach https://en.wikipedia.org - no network from this machine right now)");
  }
  tm.closeTab(wiki.id); await sleep(300);

  console.log("-- what closes it (system dialog / tab close)");
  const nPrinted2 = printed.length;   // recomputed here (not the stale one from much earlier) - robust against anything that printed in between
  tm.switchTab(tab.id); await sleep(300);
  await openDialog(); await click("system");
  check("'Print using system dialog' closes it and opens the Windows dialog (print without 'silent')", await waitFor(() => !dlgView() && printed.length === nPrinted2 + 1) && !printed[nPrinted2].silent, JSON.stringify(printed[nPrinted2]));
  await openDialog();
  dlgView().webContents.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers: ["control", "shift"] });
  check("Ctrl+Shift+P in the dialog = the system dialog too", await waitFor(() => !dlgView() && printed.length === nPrinted2 + 2));
  await openDialog();
  tm.closeTab(tab.id); await sleep(400);
  check("closing the ACTIVE tab closes its (visible) preview", !dlgView());

  console.log("-- a page's OWN 'Print' button, not just Ctrl+P / the menu (owner 2026-10-15: a real site's own button opened the bare native dialog)");
  const pdfTabForBtn = await openTab(pathToFileURL(pdfFile).href);
  const nativePdf = printed.length;
  await sleep(1200);   // let watchPdfViewer's poll install the click hook on the viewer's own toolbar button
  const pdfFrame = pdfTabForBtn.view.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith("chrome-extension://"));
  if (pdfFrame) {
    const clicked = await pdfFrame.executeJavaScript(`(() => { try { document.getElementById("viewer").shadowRoot.querySelector("viewer-toolbar").shadowRoot.querySelector("#print").click(); return "clicked"; } catch(e) { return "ERR:" + e.message; } })()`);
    check("the Chromium PDF viewer's OWN print icon opens PBCalc's dialog too (not the native one)", clicked === "clicked" && await waitFor(() => !!dlgView()) && printed.length === nativePdf, clicked);
    pp.close(); await sleep(200);
  } else console.log("  .. (skipped: no PDF viewer frame found)");

  const bigConsoleErrors = [];
  const bigPrintTab = await openTab(base + "jangad/jangads");
  bigPrintTab.view.webContents.on("console-message", (_e, _level, msg) => { if (/error|invalid url/i.test(msg)) bigConsoleErrors.push(msg); });
  const nativeBig = printed.length;
  await bigPrintTab.view.webContents.executeJavaScript(`document.getElementById("bigprint").click()`);
  check("the ERP's exact pattern (hidden iframe, document.write, onload=window.print()) opens PBCalc's dialog, not the native one", await waitFor(() => !!dlgView()) && printed.length === nativeBig);
  await waitFor(async () => (await ui()).dests.length > 0); await previewDone("");   // wait for the dialog's OWN init(), like openDialog() does elsewhere
  // real browsers print the FRAME that called print(), not the top page - verify PBCalc does too: the iframe's own short content prints,
  // the 200-row visible grid behind it never does (measured bug: before this, the whole visible page printed instead, as dozens of blank pages)
  await set("dest", PDF); await set("headers", true); await sleep(800);
  const bigOut = path.join(tmp, "challan.pdf");
  const origSave3 = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: bigOut });
  await click("go");
  await waitFor(() => fs.existsSync(bigOut) && !dlgView());
  dialog.showSaveDialog = origSave3;
  check("...no 'Invalid URL' / console error while rendering (a bare data: URL used to break any relative resource/script reference)", bigConsoleErrors.length === 0, JSON.stringify(bigConsoleErrors));
  // PDF content streams are compressed (FlateDecode): a raw byte search for the printed TEXT is unreliable (can false-match on
  // compressed binary noise, confirmed by hand). Page COUNT is the reliable signal here, measured against both candidates with the
  // same real printToPDF call: the 200-row visible grid alone makes 7 A4 pages, the iframe's short content makes exactly 1.
  const bigPages = fs.existsSync(bigOut) ? (fs.readFileSync(bigOut).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length : -1;
  check("...PBCalc prints the IFRAME's own short content (1 page), not the 200-row visible grid behind it (which alone makes 7)", bigPages === 1, "pages=" + bigPages);
  // the ERP's OWN relative stylesheet (real file: Mfg.Web/src/assets/css/print.css) must actually apply - owner's real repro: missing table
  // borders/fonts and an awkward page break, because a bare data: URL has no base to resolve "./../../assets/css/print.css" against. Verified
  // visually (the only reliable way for a rendered CSS effect): render the saved PDF and look for the print.css rule's red border pixels.
  if (fs.existsSync(bigOut)) {
    const pdfWin = new BrowserWindow({ show: false });
    await pdfWin.loadFile(bigOut);
    await sleep(2200);
    const img = await pdfWin.webContents.capturePage();
    const bmp = img.toBitmap(), { width, height } = img.getSize();
    let redPixels = 0;
    for (let i = 0; i < bmp.length; i += 4) { const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2]; if (r > 180 && g < 90 && b < 90) redPixels++; }
    check("...the ERP's own print.css actually applied (the '.marker { border: red }' rule is visible as red pixels in the rendered PDF)", redPixels > 20, "redPixels=" + redPixels + " size=" + width + "x" + height);
    pdfWin.destroy();
  }
  await sleep(800);   // let the throwaway holder window (openForFrame) finish being destroyed before the next test - otherwise occasionally still settling

  const simplePrintTab = await openTab(base + "simpleprint");
  const nativeSimple = printed.length;
  await simplePrintTab.view.webContents.executeJavaScript(`document.getElementById("p").click()`);
  check("an ordinary direct window.print() button opens PBCalc's dialog too", await waitFor(() => !!dlgView()) && printed.length === nativeSimple);
  await waitFor(async () => (await ui()).dests.length > 0); await previewDone("");   // wait for the dialog's OWN init() before touching it
  u = await pick(PDF);
  // ROOT CAUSE of the flaky hang found here: this Save click had no dialog.showSaveDialog mock, so it hit the REAL native dialog, which
  // waits forever for a human in this headless test (goDisabled stuck true, no timeout rescues it - confirmed with a 20s poll, never moves).
  // Every other Save-as-PDF check in this file mocks it; this one was missed.
  const simpleOut = path.join(tmp, "simple.pdf");
  const origSave4 = dialog.showSaveDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: simpleOut });
  await click("go");
  check("...a real, working dialog - Save as PDF succeeds from it (the dialog closes)", await waitFor(() => !dlgView()) && fs.existsSync(simpleOut));
  dialog.showSaveDialog = origSave4;

  console.log("-- a BACKGROUND tab's OWN window.print() does not steal the view, like Chrome (measured: the tab called stays hidden/not switched to)");
  const bgTarget = await openTab(base + "simpleprint");
  const lookingAt = await openTab(base + "other");   // the user is now looking at THIS tab
  const nativeBg = printed.length;
  await bgTarget.view.webContents.executeJavaScript(`document.getElementById("p").click()`);   // a timer inside that page could do this while backgrounded
  await sleep(800);
  check("nothing visibly opens - the user's current tab is undisturbed", !dlgView() && state.activeTabId === lookingAt.id && printed.length === nativeBg);
  check("...but the preview WAS created pending", pp.hasPending(bgTarget.id));
  check("...the dot shows on that tab's favicon", (await dotShows(bgTarget)) === true);
  tm.switchTab(bgTarget.id); await sleep(400);
  check("switching to it shows the preview that was already rendered while backgrounded", !!dlgView());
  pp.close(); await sleep(200);

  console.log("-- dark mode + Restricted Mode");
  nativeTheme.themeSource = "dark"; await sleep(300);
  tm.switchTab(other.id); await sleep(300);
  await openDialog(); await expand();
  const dark = await dj(`getComputedStyle(document.getElementById("dlg")).backgroundColor`);
  check("dark mode: the dialog uses Chrome's dark panel #292A2D", dark === "rgb(41, 42, 45)", dark);
  await shot("print-dark");
  pp.close(); nativeTheme.themeSource = "light";
  tm.enableRestricted(); await sleep(1500);
  tm.createTab(null, { allowRestricted: true }); await sleep(900);
  state.tabs.forEach((t) => { const w = t.view.webContents; if (w && !w.isDestroyed()) record(w); });
  tm.printActive();
  check("Restricted Mode: the print dialog opens too", await waitFor(() => !!dlgView()));
  await waitFor(async () => (await ui()).dests.length > 0); await previewDone("");
  u = have(XPS) ? await pick(XPS) : await expand();
  check("...without 'Headers and footers' (the page's address is never printed there)", !u.headers);
  if (have(XPS)) {
    const before = printed.length;
    await set("headers", true); await sleep(300); await click("go");
    check("...and prints with no header / footer, even if the page asks for one", await waitFor(() => printed.length === before + 1) && !printed[before].header && !printed[before].footer, JSON.stringify(printed[before]));
  }
  pp.close(); await sleep(200);

  console.log("-- a page's own Print button works in Restricted Mode too (same no-headers rule)");
  require("../electron/bookmarks/bookmarkStore").add({ title: "Simple", url: base + "simpleprint", icon: "" });
  tm.createTab(base + "simpleprint", { allowRestricted: true }); await sleep(1200);
  const rTab = state.tabs[state.tabs.length - 1];
  record(rTab.view.webContents);
  const nativeR = printed.length;
  await rTab.view.webContents.executeJavaScript(`document.getElementById("p").click()`);
  check("Restricted Mode: a page's own print button opens PBCalc's dialog too", await waitFor(() => !!dlgView()) && printed.length === nativeR);
  await waitFor(async () => (await ui()).dests.length > 0); await previewDone("");
  u = await expand();
  check("...also without 'Headers and footers' there", !u.headers);
  pp.close(); await sleep(200);

  srv.close();
  console.log("\nPBCALC_PRINT total=" + total + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
