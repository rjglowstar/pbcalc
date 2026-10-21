// Print preview, like Chrome's (owner 2026-10-15, from their Chrome screenshots). Electron has no print preview of its own: webContents.print()
// only opens the bare Windows print dialog. So, as with the screen-share picker, we draw Chrome's dialog ourselves:
//   - a BrowserView over the PAGE AREA of the window (tab-modal like Chrome's: the tab strip and toolbar stay usable), with a dark backdrop and
//     the dialog: preview on the left, settings on the right;
//   - the preview is the page turned into a PDF by Chromium's own print engine (webContents.printToPDF, the same layout code that prints), shown
//     in Chromium's PDF viewer inside the dialog (#toolbar=0); it is rebuilt whenever a setting changes. A tab showing a PDF FILE prints that
//     file's own pages (measured: printToPDF of a PDF tab gives the document's pages, not the viewer);
//   - Print sends the page straight to the chosen printer with those settings (webContents.print silent:true + deviceName), Save as PDF writes
//     the PDF to a file the user picks, "Print using system dialog" is the old Windows dialog.
// **A preview belongs to its TAB, not to the window, measured against real Chrome (owner 2026-10-15, "chrome print preview still exists when we
// open other tab"; a throwaway Chrome profile driven by CDP, window.print() on tab A, then switching to tab B):** Chrome's preview survives a tab
// switch untouched - its settings, its rendered PDF, everything - and reappears exactly as left when the tab is chosen again; several tabs can each
// have their own pending preview at once; a BACKGROUND tab's page navigating away (even by itself, a timer-driven redirect) still closes ITS preview;
// a small dot appears on a BACKGROUND tab's favicon while its preview is pending, gone the instant that tab is active again - and the SAME dot shows
// for a pending alert() too, so it is Chrome's generic "this tab has something waiting" mark, not specific to printing. Measured colour (BGR pixel
// sample of a real Chrome window, both app modes): light #0B57D0, dark #A8C7FA - exactly this codebase's existing `--omnibox-ring` variable.
// So: previews are kept in a Map keyed by TAB id, each with its own BrowserView, printed webContents, document-is-PDF flag and navigation/destroy
// listeners; at most one is ATTACHED (visible) at a time. Leaving a tab only DETACHES its preview (hidden, the BrowserView and its renderer live
// on); entering a tab with a pending entry re-ATTACHES the very same view - no reload, no "Loading preview" flash, exactly what was measured.
// Only closing the TAB destroys its entry. `electron/tabs/tabManager.js` calls `leaveTab`/`enterTab` from switchTab and `closeFor` from closeTab;
// `getTabState()` adds `printPending` per tab (renderer/shell draws the dot) - true while an entry exists for a tab that is not the active one.
// WHICH settings show follows Chrome's measured rules (renderer/printpreview/rules.js), so each printer's real abilities are needed: Electron gives
// only names, so they are read from Windows (System.Drawing.Printing + DeviceCapabilities for collate) in ONE asynchronous PowerShell run, cached
// for a minute. Never a sync child process in main (see CLAUDE.md). The Windows default printer comes from the registry, also asynchronously.
// The last choices are remembered in MEMORY only for this run - the ones Chrome remembers (destination, layout, colour, paper, margins, quality, scale,
// collate, two-sided, headers, background), not pages / copies / pages per sheet; nothing is written to disk here. This is GLOBAL (one browser-wide
// preference), not per tab - only the dialog's own open/closed state and its rendered content are per tab.
const { BrowserView, BrowserWindow, ipcMain, dialog, app, webFrameMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const state = require("./state");
const rules = require("../renderer/printpreview/rules");
const { TAB_PARTITION } = require("./constants");

const PPS = [1, 2, 4, 6, 9, 16];
const PDF_DEST = "__pdf__";
const PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
const CAPS_TTL_MS = 60000;
// Chrome's paper list for Save as PDF (measured), sizes in microns; A4 is its default here
const mm = (w, h) => ({ w: w * 1000, h: h * 1000 }), inch = (w, h) => ({ w: Math.round(w * 25400), h: Math.round(h * 25400) });
const PDF_PAPERS = [["Legal", inch(8.5, 14)], ["Letter", inch(8.5, 11)], ["Tabloid", inch(11, 17)], ["A0", mm(841, 1189)], ["A1", mm(594, 841)],
  ["A2", mm(420, 594)], ["A3", mm(297, 420)], ["A4", mm(210, 297)], ["A5", mm(148, 210)]].map(([name, s]) => ({ name, ...s }));
const PDF_CAPS = { copies: 1, collate: false, color: false, duplex: false, dpis: [], papers: PDF_PAPERS, defPaper: "A4" };
// printToPDF margins are in inches. "Default" = Chromium's own default (~1 cm), "Minimum" = a hair inside the page.
const PDF_MARGINS = { default: null, none: { top: 0, bottom: 0, left: 0, right: 0 }, minimum: { top: 0.17, bottom: 0.17, left: 0.17, right: 0.17 } };
const PRINT_MARGINS = { default: "default", none: "none", minimum: "printableArea" };
const DEFAULT_MARGIN_IN = 0.39;   // ~1cm, Chromium's own "Default" margin - what Custom margins are seeded with the first time, never overwriting a value already typed (incl. 0)

// A page's own "Print" button calling window.print() itself, and the Chromium PDF viewer's own print toolbar icon
// (owner 2026-10-15, two real repros: PBCalc's own generated PDF opened in a tab and printed from the viewer's own button; the
// ERP's "Big Print" button) - both ended on Electron's bare native dialog instead of our preview, because neither goes through
// Ctrl+P / the menu / the context menu, the only paths that called `open()` before. `preloads/tab-preload.js` now overrides
// `window.print` itself (dispatches to main via `page:print-request`) AND patches every same-origin iframe's `.contentWindow`
// the moment it is first read, which catches the ERP's trick of document.write()-ing `<body onload="window.print()">` into a
// HIDDEN, never-navigated iframe (measured: this does NOT get Electron's per-frame preload injection at all, even with
// `nodeIntegrationInSubFrames: true` - no real navigation ever happens, so the hook that injects preloads per frame never fires).
// `watchPdfViewer()` below handles the PDF viewer's OWN print icon separately: measured that overriding `window.print` INSIDE
// that frame does nothing (its button does not call the standard DOM API at all - some other, unreachable internal path), so
// instead the real toolbar button is found (through its shadow DOM: #viewer -> viewer-toolbar -> #print) and its click is
// intercepted in the CAPTURE phase (stopImmediatePropagation before Chromium's own handler runs) and bridged out via
// `postMessage` to the top frame, the one channel that crosses into a privileged extension frame our preload cannot reach.
const PDF_PRINT_HOOK = `(function hook(n){
  if (window.__pbcPdfHookStarted) return; window.__pbcPdfHookStarted = true;
  (function poll(tries){
    try {
      var vr = document.getElementById('viewer');
      var tb = vr && vr.shadowRoot && vr.shadowRoot.querySelector('viewer-toolbar');
      var btn = tb && tb.shadowRoot && tb.shadowRoot.querySelector('#print');
      if (btn) { btn.addEventListener('click', function(e){ e.stopImmediatePropagation(); e.preventDefault(); window.parent.postMessage({ __pbcPdfPrint: true }, '*'); }, true); return; }
    } catch (e) {}
    if (tries > 0) setTimeout(function(){ poll(tries - 1); }, 150);
  })(n);
})(30);`;
function watchPdfViewer(wc) {
  wc.on("did-frame-finish-load", (_e, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame || frame.url.indexOf(PDF_VIEWER) !== 0) return;
    frame.executeJavaScript(PDF_PRINT_HOOK).catch(() => {});
  });
}

const previews = new Map();   // tabId -> { view, src(webContents printed), doc:{pdf}, dests, unhook, renderSeq }
let attachedTabId = null;     // which tab's preview is currently attached (visible); at most one
let sticky = null;            // last choices, memory only, GLOBAL across tabs (Chrome's sticky settings)

// what Chrome remembers (its sticky settings): NOT pages, copies or pages per sheet
function stickyFrom(chosen, moreOpen) {
  return { dest: chosen.dest, landscape: chosen.landscape, color: chosen.color, paper: chosen.paper, margins: chosen.margins,
    marginTop: chosen.marginTop, marginLeft: chosen.marginLeft, marginRight: chosen.marginRight, marginBottom: chosen.marginBottom,
    dpi: chosen.dpi, collate: chosen.collate,
    scaleMode: chosen.scaleMode, scale: chosen.scale, duplex: chosen.duplex, duplexEdge: chosen.duplexEdge, headers: chosen.headers, background: chosen.background, moreOpen: !!moreOpen };
}
let capsCache = null;         // { at, list }
let capsInFlight = null;      // the PowerShell call already running, if any - share it instead of starting a second one (found while
                               // pre-warming printerCaps() at startup: a call landing while the warm-up is still mid-flight paid the
                               // full ~2-3s PowerShell cost a second time, even though the warm-up would have cached it moments later)

const tm = () => require("./tabs/tabManager");
const isOpen = () => attachedTabId != null;
const hasPending = (tabId) => previews.has(Number(tabId));
function entryBySender(e) {
  for (const [tabId, entry] of previews) { if (!entry.view.webContents.isDestroyed() && entry.view.webContents === e.sender) return { tabId, entry }; }
  return null;
}
const fromDialog = (e) => !!entryBySender(e);

function bounds() {
  const win = state.mainWindow;
  const [w, h] = win.getContentSize();
  const top = win.isFullScreen() ? 0 : tm().chromeHeight();
  return { x: 0, y: top, width: w, height: Math.max(0, h - top) };
}

// Hide the currently attached preview (if any) WITHOUT destroying it - the entry, its BrowserView and its rendered PDF all live on, exactly
// like Chrome's preview surviving a tab switch. Used when leaving a tab, and before attaching a different one.
function detachCurrent() {
  if (attachedTabId == null) return;
  const entry = previews.get(attachedTabId);
  attachedTabId = null;
  if (!entry) return;
  try { if (state.mainWindow && !state.mainWindow.isDestroyed()) require("./viewHost").detach(state.mainWindow, entry.view); } catch (_) {}
}

// Show a tab's pending preview again, unchanged (same BrowserView, same settings, same PDF) - no re-render, no flash.
function attachEntry(tabId) {
  const entry = previews.get(tabId);
  if (!entry || entry.view.webContents.isDestroyed()) return;
  if (attachedTabId != null && attachedTabId !== tabId) detachCurrent();
  attachedTabId = tabId;
  entry.view.setBounds(bounds());
  require("./viewHost").attach(state.mainWindow, entry.view);
  try { entry.view.webContents.focus(); } catch (_) {}
}

// Fully end a tab's preview (tab closed, Cancel/Esc/Print done/system dialog, or the page navigated/was destroyed). Detaches first if it was
// the visible one, then destroys the view and removes the listeners put on the printed page.
// Closes the DIALOG's own UI (detaches/closes entry.view, same as Chrome - the dialog goes the
// instant Print is pressed) but does NOT touch entry.holder, the throwaway window an iframe-captured
// print (openForFrame) actually prints FROM. Returns the entry (or null) so a caller with a pending
// print job can hang onto entry.holder and destroy it only once that job is actually done - see the
// BUG comment on print:go's real-printer branch for why that matters. Ordinary callers that have no
// print in flight (Cancel/Esc, closing the tab...) should use destroyEntry() below instead, which
// destroys the holder immediately - there's nothing pending to protect in those cases.
function closeDialogKeepHolder(tabId) {
  const entry = previews.get(tabId);
  if (!entry) return null;
  previews.delete(tabId);
  const wasAttached = attachedTabId === tabId;
  if (wasAttached) { attachedTabId = null; try { if (state.mainWindow && !state.mainWindow.isDestroyed()) require("./viewHost").detach(state.mainWindow, entry.view); } catch (_) {} }
  try { entry.unhook(); } catch (_) {}
  try { if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close(); } catch (_) {}
  if (wasAttached) { try { const a = tm().getActiveTab(); if (a && a.view && a.view.webContents && !a.view.webContents.isDestroyed()) a.view.webContents.focus(); } catch (_) {} }
  // the dot on a background tab's favicon must disappear as soon as its preview ends (navigation/destroy can happen with nobody looking at it)
  try { tm().notifyTabs(); } catch (_) {}
  return entry;
}

function destroyEntry(tabId) {
  const entry = closeDialogKeepHolder(tabId);
  if (!entry) return;
  // the throwaway holder window (an iframe's own print() captured its content - see openForFrame) has nothing else keeping it alive
  try { if (entry.holder && !entry.holder.isDestroyed()) entry.holder.destroy(); } catch (_) {}
}

// Cancel / Esc / print done / "Print using system dialog": end whichever preview is currently ON SCREEN (only an attached, visible one can
// receive these - a background entry has no UI to click or focus to receive Esc).
function close() { if (attachedTabId != null) destroyEntry(attachedTabId); }

const isPdfTab = (wc) => { try { return wc.mainFrame.framesInSubtree.some((f) => String(f.url).startsWith(PDF_VIEWER)); } catch (_) { return false; } };

// Build and register a preview entry for `tab`, printing `src` (normally the tab's own page; for openForFrame it is a throwaway holder
// window carrying an iframe's captured content instead - see there). The entry is keyed by TAB id regardless, so the dot/tab-switch
// machinery above works the same either way. Navigation/destroy are always watched on the REAL tab's own page, never on a holder: a
// holder has no navigation of its own to watch, and if the user leaves or closes the actual tab the preview must end either way.
function createEntry(tab, src, show) {
  try { require("./popup").close(); } catch (_) {}
  try { require("./hovercard").hide(); require("./omnibox").hide(); } catch (_) {}
  const doc = { pdf: src === (tab.view && tab.view.webContents) && isPdfTab(src) };
  const v = new BrowserView({ webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "..", "preloads", "printpreview-preload.js") } });
  require("./lockdown").lock(v.webContents);
  // Esc closes; Ctrl+Shift+P = the system dialog (only here: browser-wide it would clash with the hidden Ctrl+Shift + "pbsecure" sequence,
  // which takes the p). Registered BEFORE the shortcut handler so it sees the keys first.
  v.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || attachedTabId !== tab.id) return;
    if (input.key === "Escape") { e.preventDefault(); setImmediate(close); return; }
    if ((input.control || input.meta) && input.shift && !input.alt && String(input.key).toLowerCase() === "p") { e.preventDefault(); setImmediate(() => systemDialog(tab.id)); }
  });
  require("./shortcuts").attachShortcuts(v.webContents);   // Ctrl+Tab, Ctrl+W... still work while the dialog has the keyboard
  v.setBackgroundColor("#00000000");
  v.webContents.loadFile(path.join(__dirname, "..", "renderer", "printpreview", "printpreview.html")).catch(() => {});
  // the REAL page being printed goes away or moves on, even while backgrounded (measured: Chrome closes a BACKGROUND tab's preview too
  // when that page navigates by itself) - the dialog's entry ends either way, not just when it happens to be the one on screen
  const page = tab.view.webContents;
  const onGone = () => destroyEntry(tab.id);
  const onNav = (e, _u, isInPlace, isMainFrame) => {
    const main = e && e.isMainFrame !== undefined ? e.isMainFrame : isMainFrame;
    const same = e && e.isSameDocument !== undefined ? e.isSameDocument : isInPlace;
    if (main && !same) destroyEntry(tab.id);
  };
  page.on("destroyed", onGone);
  page.on("did-start-navigation", onNav);
  const unhook = () => { if (!page.isDestroyed()) { page.removeListener("destroyed", onGone); page.removeListener("did-start-navigation", onNav); } };
  previews.set(tab.id, { view: v, src, doc, dests: [], unhook, renderSeq: 0 });
  v.webContents.once("did-finish-load", () => { if (attachedTabId === tab.id) { try { v.webContents.focus(); } catch (_) {} } });
  if (show) attachEntry(tab.id);
  else try { tm().notifyTabs(); } catch (_) {}   // not shown - just the background dot appearing
}

// Open for the given tab page (default: the active tab). A second Ctrl+P on a tab that already has a pending preview does nothing (it is already
// showing, since only the active tab can receive Ctrl+P / the page's own right-click menu). `wc` can now also be a BACKGROUND tab's own page
// calling window.print() itself (page:print-request, e.g. a delayed/timer-triggered print, or any tab whose print finished loading while the
// user had already switched away): measured against real Chrome (a background tab calling window.print() itself) - the preview is created, but
// the view is NEVER switched to show it and the user's current tab stays exactly as it was; only the dot appears. So here too: only ATTACH
// (show) when the target tab is the one the user is actually looking at; otherwise the entry is created pending, same as any other tab switch.
function open(wc) {
  const win = state.mainWindow;
  if (!win || win.isDestroyed() || state.calcMode) return;
  const tab = wc ? state.tabs.find((t) => t.view && t.view.webContents === wc) : tm().getActiveTab();
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return;
  if (previews.has(tab.id)) { if (tab.id === state.activeTabId) attachEntry(tab.id); return; }
  createEntry(tab, tab.view.webContents, tab.id === state.activeTabId);
}

// A SAME-ORIGIN IFRAME called window.print() on itself (the ERP's "Big Print" hidden-iframe trick, see tab-preload.js): real browsers print
// the FRAME that called print(), not the top document, and Electron's printToPDF has no way to target a subframe directly - so the iframe's
// OWN rendered HTML (captured by the page itself, at the moment print() was called, before this message even arrives) is loaded into a
// throwaway, never-shown window and THAT is what gets printed, matching what a real browser would show. Measured: without this, PBCalc printed
// the tab's whole visible page instead of the iframe's actual printable content (a real repro: a 157-row grid printed as dozens of blank
// pages where a short challan was meant).
function openForFrame(tab, html) {
  const win = state.mainWindow;
  if (!win || win.isDestroyed() || state.calcMode) return;
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return;
  if (previews.has(tab.id)) { if (tab.id === state.activeTabId) attachEntry(tab.id); return; }
  const holder = new BrowserWindow({ show: false, webPreferences: { partition: TAB_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, "..", "preloads", "printholder-preload.js") } });
  // the tab could navigate away, close, or already get a DIFFERENT preview while the holder is still loading - bail out cleanly if so
  holder.webContents.once("did-finish-load", () => {
    if (holder.isDestroyed() || !state.tabs.includes(tab) || tab.view.webContents.isDestroyed() || previews.has(tab.id)) { try { holder.destroy(); } catch (_) {} return; }
    createEntry(tab, holder.webContents, tab.id === state.activeTabId);
    const entry = previews.get(tab.id);
    if (entry) entry.holder = holder; else try { holder.destroy(); } catch (_) {}
  });
  holder.webContents.once("did-fail-load", () => { try { holder.destroy(); } catch (_) {} });
  // the captured markup can reference the REAL site's own resources with a RELATIVE path (the ERP's own print.css, loaded via a relative
  // <link href>) - a bare data: URL has no meaningful base, so those fail to load at all (measured: an "Invalid URL" page error AND the
  // stylesheet simply never applies - the real repro showed no table borders/fonts at all, and an awkward page break, because the ERP's
  // print.css carries exactly those rules). `baseURLForDataURL` fixes it: resources resolve against the directory of the REAL tab's own
  // page, exactly as a genuine (not document.write()'d) iframe inherits its creator's URL for this purpose.
  let base; try { base = new URL(".", tab.view.webContents.getURL()).href; } catch (_) { base = undefined; }
  holder.loadURL("data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf8").toString("base64"), base ? { baseURLForDataURL: base } : undefined)
    .catch(() => { try { holder.destroy(); } catch (_) {} });
}

function reposition() { if (attachedTabId != null && state.mainWindow && !state.mainWindow.isDestroyed()) { const e = previews.get(attachedTabId); if (e) e.view.setBounds(bounds()); } }
// tabManager calls these from switchTab: leaving a tab only HIDES its preview (Chrome keeps it alive); entering one shows its pending preview again
function leaveTab(tabId) { if (attachedTabId === Number(tabId)) detachCurrent(); }
function enterTab(tabId) { if (previews.has(Number(tabId))) attachEntry(Number(tabId)); }
// tabManager calls this from closeTab: the tab is gone, so its preview (attached or not) is gone too
function closeFor(tabId) { destroyEntry(Number(tabId)); }

// Windows' default printer: HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows -> Device = "<name>,winspool,<port>".
function defaultPrinter() {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows", "/v", "Device"], { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve("");
      const m = /Device\s+REG_SZ\s+(.+)/.exec(String(out));
      resolve(m ? m[1].split(",")[0].trim() : "");
    });
  });
}

// Every printer's abilities, the ones Chrome decides by: max copies, collate, colour, two-sided, resolutions, paper list (hundredths of an inch
// -> microns here) and the default paper.
// PrintableArea per paper is collected here (owner 2026-10-15, real repro: "Exe Barcode" showed 72/363 sheets of paper instead of a handful -
// Chromium's printToPDF knows nothing about a chosen PRINTER's actual hardware, so its "Default" margin is a fixed ~1cm regardless of paper size;
// measured on this exact paper: zero hardware margins (fully printable, confirmed by Windows' own PrintableArea AND Chrome's reported
// imageable_area), so a ~1cm margin on each side of a 0.79in-tall label consumes almost the entire page, forcing dozens of near-empty pages for
// content that fits on 2 real pages with the printer's TRUE (zero) margins - confirmed by hand: same content, same tiny page, 56 pages with a
// generic default margin, 2 with the real printable area). Setting `.PaperSize` on a PrinterSettings object MUTATES its DefaultPageSettings, so
// the printer's OWN default paper/resolution are captured BEFORE the per-paper loop that reads PrintableArea.
const CAPS_PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace PbcPrint -Name Dc -MemberDefinition '[DllImport("winspool.drv", CharSet = CharSet.Unicode)] public static extern int DeviceCapabilities(string device, string port, ushort cap, System.IntPtr output, System.IntPtr devMode);'
$out = @()
foreach ($n in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) {
  $p = New-Object System.Drawing.Printing.PrinterSettings
  $p.PrinterName = $n
  if (-not $p.IsValid) { continue }
  $defPaperName = $p.DefaultPageSettings.PaperSize.PaperName
  $defDpiVal = '' + $p.DefaultPageSettings.PrinterResolution.X + 'x' + $p.DefaultPageSettings.PrinterResolution.Y
  $dpis = @($p.PrinterResolutions | Where-Object { $_.X -gt 0 -and $_.Y -gt 0 } | ForEach-Object { '' + $_.X + 'x' + $_.Y } | Select-Object -Unique)
  # PrintableArea needs a fresh PageSettings PER PAPER - a real driver round trip each time (measured: ~10-115ms/paper, 9+ seconds total across
  # every printer's full paper list - XPS Writer alone has 107 standard sizes). Only SMALL papers (either side under 3in) can have a fixed default
  # margin eat a disproportionate share of the page, so only those pay this cost (measured: only the TSC label and some Fax sizes qualify; every
  # other installed printer here has ZERO papers that small, so this adds nothing for them) - the rest keep Chromium's ordinary generic default.
  $papers = @($p.PaperSizes | Where-Object { $_.Width -gt 0 -and $_.Height -gt 0 } | ForEach-Object {
    if ($_.Width -lt 300 -or $_.Height -lt 300) {
      $pg = New-Object System.Drawing.Printing.PageSettings($p)
      $pg.PaperSize = $_
      $a = $pg.PrintableArea
      @{ n = $_.PaperName; w = $_.Width; h = $_.Height; ml = $a.X; mt = $a.Y; mr = ($_.Width - $a.Width - $a.X); mb = ($_.Height - $a.Height - $a.Y) }
    } else { @{ n = $_.PaperName; w = $_.Width; h = $_.Height } }
  })
  $out += @{ name = $n; copies = $p.MaximumCopies; color = $p.SupportsColor; duplex = $p.CanDuplex; collate = ([PbcPrint.Dc]::DeviceCapabilities($n, $null, 22, [System.IntPtr]::Zero, [System.IntPtr]::Zero) -eq 1);
    papers = $papers; defPaper = $defPaperName; dpis = $dpis; defDpi = $defDpiVal }
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
`;
function printerCaps() {
  if (capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) return Promise.resolve(capsCache.list);
  if (capsInFlight) return capsInFlight;
  capsInFlight = new Promise((resolve) => {
    const enc = Buffer.from(CAPS_PS, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      let list = [];
      try {
        list = JSON.parse(String(out).trim() || "[]").map((p) => ({
          name: String(p.name), copies: Number(p.copies) || 1, collate: !!p.collate, color: !!p.color, duplex: !!p.duplex,
          // a size listed twice (Letter Small = Letter, Ledger = Tabloid turned) is shown once, as Chrome does (XPS Writer: 107 -> 65, Chrome's count).
          // margins (microns): the printer's OWN hardware printable area for that paper - floating-point can overshoot the nominal paper size by a
          // hair (measured: Exe Barcode's right margin computed as -0.0064in), so clamp to >= 0 rather than ever pass a negative margin.
          papers: (() => { const seen = new Set(); const mm = (v) => Math.max(0, Math.round(Number(v) * 254));
            return (p.papers || []).map((x) => {
              const o = { name: String(x.n), w: Math.round(x.w * 254), h: Math.round(x.h * 254) };
              if (x.ml !== undefined) { o.marginLeft = mm(x.ml); o.marginTop = mm(x.mt); o.marginRight = mm(x.mr); o.marginBottom = mm(x.mb); }
              return o;
            }).filter((x) => { const k = Math.min(x.w, x.h) + "x" + Math.max(x.w, x.h); if (seen.has(k)) return false; seen.add(k); return true; }); })(),
          defPaper: String(p.defPaper || ""), dpis: (p.dpis || []).map(String), defDpi: String(p.defDpi || ""),
        }));
      } catch (_) { list = []; }
      if (list.length) capsCache = { at: Date.now(), list };
      capsInFlight = null;
      resolve(list);
    });
  });
  return capsInFlight;
}

// "1-5, 8, 11-13" -> [[1,5],[8,8],[11,13]] within 1..n, or null when it is not a valid range (Chrome then shows "Invalid page range").
function parseRanges(text, n) {
  const out = [];
  for (const part of String(text || "").split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] === undefined ? a : (m[2] === "" ? n : Number(m[2]));
    if (a < 1 || b < a || a > n) return null;
    out.push([a, Math.min(b, n)]);
  }
  return out.length ? out : null;
}

// the pages chosen, as 1-based [from,to] ranges (null = all)
function chosenRanges(s, n) {
  if ((s.pages === "odd" || s.pages === "even") && n > 1) {
    const r = [];
    for (let i = s.pages === "odd" ? 1 : 2; i <= n; i += 2) r.push([i, i]);
    return r.length ? r : null;
  }
  if (s.pages === "custom") return parseRanges(s.custom, n);
  return null;
}

const destOfIn = (entry, id) => entry.dests.find((d) => d.id === id) || entry.dests.find((d) => d.kind === "pdf");

// settings from the page -> safe values, with everything the rules say is not available switched off (so a forged or stale value prints nothing extra)
function clean(entry, raw, total) {
  const s0 = raw || {};
  const num = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const numF = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };   // margins: fractional inches, 0 is a real choice - not rounded like num()
  const dest = destOfIn(entry, String(s0.dest || ""));
  const c = dest.caps;
  const s = {
    dest: dest.id,
    pages: ["all", "odd", "even", "custom"].includes(s0.pages) ? s0.pages : "all",
    custom: typeof s0.custom === "string" ? s0.custom.slice(0, 200) : "",
    copies: num(s0.copies, 1, Math.max(1, Math.min(999, c.copies)), 1),
    collate: s0.collate !== false,
    landscape: !!s0.landscape,
    color: s0.color !== false,
    paper: (c.papers.find((p) => p.name === s0.paper) || c.papers.find((p) => p.name === c.defPaper) || c.papers[0] || {}).name || "",
    pps: PPS.includes(Number(s0.pps)) ? Number(s0.pps) : 1,
    margins: ["default", "none", "minimum", "custom"].includes(s0.margins) ? s0.margins : "default",
    marginTop: numF(s0.marginTop, 0, 5, DEFAULT_MARGIN_IN),
    marginLeft: numF(s0.marginLeft, 0, 5, DEFAULT_MARGIN_IN),
    marginRight: numF(s0.marginRight, 0, 5, DEFAULT_MARGIN_IN),
    marginBottom: numF(s0.marginBottom, 0, 5, DEFAULT_MARGIN_IN),
    dpi: c.dpis.includes(s0.dpi) ? s0.dpi : (c.dpis.includes(c.defDpi) ? c.defDpi : (c.dpis[0] || "")),
    scaleMode: s0.scaleMode === "custom" ? "custom" : "default",
    scale: num(s0.scale, 10, 200, 100),
    duplex: !!s0.duplex,
    duplexEdge: s0.duplexEdge === "short" ? "short" : "long",
    headers: !!s0.headers,
    background: !!s0.background,
  };
  // s = the choices as made (shown again next time; Chrome keeps e.g. "Headers and footers" ticked while the chosen printer cannot use it),
  // eff = what is actually printed: everything the rules say is not available here is switched off
  const a = rules.avail(dest, entry.doc, s, total || 1, !!state.restricted);
  const eff = { ...s };
  if (!a.copies) eff.copies = 1;
  if (!a.collate) eff.collate = true;
  if (!a.layout) eff.landscape = false;
  if (!a.color) eff.color = true;
  if (!a.pps) eff.pps = 1;
  if (!a.margins) eff.margins = "default";
  if (!a.scale) eff.scaleMode = "default";
  if (!a.dpi && !c.dpis.includes(eff.dpi)) eff.dpi = "";
  if (!a.duplex) eff.duplex = false;
  if (!a.headers) eff.headers = false;
  if (!a.background) eff.background = false;
  if (!a.oddEven && (eff.pages === "odd" || eff.pages === "even")) eff.pages = "all";
  return { s, eff, dest, a };
}

// Chromium's own BUILT-IN header/footer template pulls title/url straight from the loaded document (measured: a small 8px grey sans-serif
// strip, date + title at the top, address + page numbers at the bottom). Two reasons NEVER to use that default footer here: (1) for
// frame-captured content (openForFrame) the "document" is the throwaway holder loaded from a data: URL, so its own address would be the
// holder's giant base64 data: string (measured, real repro: exactly that string printed across the footer, unreadable, pushing a short
// challan onto 2 pages); (2) owner's request 2026-10-20: the printed page's address is never wanted on paper at all, even for an ordinary
// tab's own real address (real repro: koffionline.in/shop and mfg.pb.diamonds/jangad/jangads both showing up at the bottom of a print) -
// a privacy concern, since printed pages can be handed to someone else. So a CUSTOM footerTemplate with NO address is used for every
// print, holder or not (headerTemplate is left undefined, so Chromium's own default header - date + title, no address - is kept
// unchanged; tested that supplying one without the other works exactly as Chromium's own UI would), keeping only the page count.
const FOOTER_STYLE = "body { font-size: 8px; font-family: sans-serif; color: #333; margin: 0 24px; -webkit-text-size-adjust: none; width: 100%; } " +
  ".flex { display: flex; justify-content: flex-end; width: 100%; } .text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }";
function footerTemplateNoAddress() {
  return `<style>${FOOTER_STYLE}</style><div class="flex"><span class="text"><span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`;
}

function pdfOptions(s, dest, ranges) {
  const paper = rules.paperOf(dest, s);
  const o = { landscape: s.landscape, printBackground: s.background, scale: s.scaleMode === "custom" ? s.scale / 100 : 1, displayHeaderFooter: s.headers };
  if (paper) o.pageSize = { width: paper.w / 25400, height: paper.h / 25400 };   // inches
  if (s.margins === "default" && paper && paper.marginLeft !== undefined) {
    // "Default" on a REAL PRINTER means that printer's OWN hardware margins, not Chromium's generic ~1cm - printToPDF is printer-agnostic and
    // has no idea a tiny label is even involved, so without this a label with ZERO real margins (measured: Windows' own PrintableArea for the
    // TSC "Exe Barcode" paper covers the whole label) lost almost its entire printable height to that fixed default, splitting short content
    // into dozens of near-empty pages (real repro: 72/363 "sheets of paper" instead of a handful). Save as PDF's own paper list has no such
    // hardware (`paper.marginLeft` stays undefined there), so it keeps Chromium's generic default, matching Chrome's own Save-as-PDF behaviour.
    o.margins = { left: paper.marginLeft / 25400, top: paper.marginTop / 25400, right: paper.marginRight / 25400, bottom: paper.marginBottom / 25400 };
  } else if (s.margins === "custom") {
    o.margins = { left: s.marginLeft, top: s.marginTop, right: s.marginRight, bottom: s.marginBottom };
  } else if (PDF_MARGINS[s.margins]) o.margins = PDF_MARGINS[s.margins];
  if (ranges) o.pageRanges = ranges.map(([a, b]) => (a === b ? String(a) : a + "-" + b)).join(",");
  if (s.headers) o.footerTemplate = footerTemplateNoAddress();
  return o;
}

const countPages = (buf) => (buf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;

// Build the preview: the whole document first (to know how many pages it has), then only the chosen pages.
async function makePdf(tabId, entry, raw) {
  if (!entry.src || entry.src.isDestroyed()) throw new Error("gone");
  let { eff: s, dest } = clean(entry, raw, 2);
  const all = await entry.src.printToPDF(pdfOptions(s, dest, null));
  const total = Math.max(1, countPages(all));
  ({ eff: s, dest } = clean(entry, raw, total));
  if (s.pages === "all") return { pdf: all, total, pages: total, s, dest };
  const ranges = chosenRanges(s, total);
  if (!ranges) return { invalid: true, total };
  const part = await entry.src.printToPDF(pdfOptions(s, dest, ranges));
  return { pdf: part, total, pages: ranges.reduce((n, [a, b]) => n + b - a + 1, 0), s, dest };
}

function titleOf(tabId, entry) {
  try { const t = state.tabs.find((x) => x.id === tabId); return (t && t.title) || entry.src.getTitle() || "page"; } catch (_) { return "page"; }
}

// "Print using system dialog…": the Windows print dialog, as before this preview existed
function systemDialog(tabId) {
  const entry = previews.get(tabId);
  const target = entry && entry.src;
  // Same destroy-before-print ordering bug as print:go's real-printer branch (see its big comment) -
  // this path can print from a holder too (openForFrame), so the holder must stay alive until
  // Windows' own system dialog is actually answered and the job (or its cancellation) is done.
  const entryRef = closeDialogKeepHolder(tabId);
  const holder = entryRef && entryRef.holder;
  if (target && !target.isDestroyed()) {
    target.print({ printBackground: true }, () => {
      try { if (holder && !holder.isDestroyed()) holder.destroy(); } catch (_) {}
    });
  } else {
    try { if (holder && !holder.isDestroyed()) holder.destroy(); } catch (_) {}
  }
}

// Build the destination list (printer names + whatever caps are on hand right now) the same way both
// times init is answered: immediately, with best-effort data, and again once the real caps are in.
function buildDests(names, caps, def) {
  const printers = names.map((p) => {
    const c = caps.find((x) => x.name === p.name);
    return { id: p.name, label: p.label, kind: "printer", caps: c || { copies: 1, collate: false, color: true, duplex: false, dpis: [], papers: PDF_PAPERS, defPaper: "A4" } };
  });
  // Chrome's list: the chosen printer, Save as PDF, then the rest
  const first = printers.find((p) => p.id === (sticky && sticky.dest)) || printers.find((p) => p.id === def) || printers[0];
  const dests = [...(first ? [first] : []), { id: PDF_DEST, label: "Save as PDF", kind: "pdf", caps: PDF_CAPS }, ...printers.filter((p) => p !== first)];
  return { dests, first };
}

function register() {
  // BUG found 2026-10-21 (owner: "loading print preview... optimise same as chrome print preview open" -
  // reproduced on a PC with NO antivirus too, so the earlier warm-up alone was not enough): `start()` in
  // printpreview.js keeps the WHOLE settings panel hidden (`$("rows").hidden = false` only runs after
  // `api.init()` resolves) and this handler used to `await Promise.all([printerCaps(), defaultPrinter()])`
  // before answering at all - so EVERY cold cache hit (first Ctrl+P after the 60s TTL expires, which a
  // session of real testing across many sites/printers hits constantly) froze the dialog's settings panel
  // for the full ~2-3s PowerShell enumeration, with nothing visible to the user meanwhile. Real Chrome's
  // own dialog appears AT ONCE and fills in exact per-printer detail (paper list, resolutions...) a moment
  // later - it never makes the whole dialog wait on that. Fix: answer with whatever is ALREADY cached
  // (instant; every printer not yet known gets the same safe fallback caps already used elsewhere in this
  // file), kick off the real printerCaps() in the background if it was not already warm, and push the
  // corrected destination list to the dialog once it lands (`print:caps-updated`) instead of making the
  // first render wait for it. `defaultPrinter()` stays awaited here (a plain registry read, not the slow
  // part) so the correct printer is still picked first even on a cold caps cache.
  ipcMain.handle("print:init", async (e) => {
    const found = entryBySender(e);
    if (!found) return null;
    const { tabId, entry } = found;
    const page = entry.src;
    let names = [];
    try { names = (await page.getPrintersAsync()).map((p) => ({ name: p.name, label: p.displayName || p.name })); } catch (_) {}
    const def = await defaultPrinter();
    if (!previews.has(tabId) || previews.get(tabId) !== entry) return null;   // closed meanwhile
    const capsNow = (capsCache && Date.now() - capsCache.at < CAPS_TTL_MS) ? capsCache.list : [];
    const { dests, first } = buildDests(names, capsNow, def);
    entry.dests = dests;
    const base = sticky || {};
    const destId = base.dest && entry.dests.some((d) => d.id === base.dest) ? base.dest : (first ? first.id : PDF_DEST);
    const { s } = clean(entry, { headers: true, collate: true, ...base, dest: destId, pages: "all", custom: "", copies: 1, pps: 1 }, 2);
    if (!capsNow.length) {
      printerCaps().then((caps) => {
        if (!previews.has(tabId) || previews.get(tabId) !== entry || entry.view.webContents.isDestroyed()) return;   // closed/replaced meanwhile
        entry.dests = buildDests(names, caps, def).dests;
        try { entry.view.webContents.send("print:caps-updated", { dests: entry.dests }); } catch (_) {}
      }).catch(() => {});
    }
    return { dests: entry.dests, doc: entry.doc, pps: PPS, restricted: !!state.restricted, settings: s, moreOpen: !!base.moreOpen };
  });

  ipcMain.handle("print:preview", async (e, raw) => {
    const found = entryBySender(e);
    if (!found) return null;
    const { tabId, entry } = found;
    const seq = ++entry.renderSeq;
    try {
      const r = await makePdf(tabId, entry, raw);
      if (!previews.has(tabId) || previews.get(tabId) !== entry || seq !== entry.renderSeq) return { stale: true };
      if (r.invalid) return { invalid: true, total: r.total };
      return { pdf: r.pdf.toString("base64"), total: r.total, pages: r.pages };
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle("print:go", async (e, raw, moreOpen) => {
    const found = entryBySender(e);
    if (!found) return { ok: false };
    const { tabId, entry } = found;
    const target = entry.src, win = state.mainWindow, title = titleOf(tabId, entry);
    if (!target || target.isDestroyed()) { destroyEntry(tabId); return { ok: false }; }
    // count the pages of the job AS PRINTED (landscape / another paper changes it) so Odd / Even / Custom become real page ranges
    let total = 1;
    try { const c0 = clean(entry, raw, 2); total = Math.max(1, countPages(await target.printToPDF(pdfOptions(c0.eff, c0.dest, null)))); } catch (_) {}
    const { s: chosen, eff: s, dest } = clean(entry, raw, total);
    sticky = stickyFrom(chosen, moreOpen);
    const ranges = chosenRanges(s, total);
    if (s.pages === "custom" && !ranges) return { ok: false, invalid: true };

    if (dest.kind === "pdf") {
      let r;
      try { r = await makePdf(tabId, entry, raw); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
      if (r.invalid) return { ok: false, invalid: true };
      const safe = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "page";
      const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("downloads"), safe.replace(/\.pdf$/i, "") + ".pdf"), filters: [{ name: "PDF", extensions: ["pdf"] }] });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };
      try { fs.writeFileSync(res.filePath, r.pdf); } catch (err) { return { ok: false, error: "Could not save the file." }; }
      destroyEntry(tabId);
      return { ok: true };
    }

    const paper = rules.paperOf(dest, s);
    // BUG found 2026-10-20 (owner: a real print produced no physical output, no error anywhere):
    // PRINT_MARGINS has no "custom" key, so a Custom-margins real print sent `{ marginType: undefined }`
    // - an EMPTY margins object once JSON-serialized, with NO margin type and NO values at all, so
    // Chromium silently fell back to its own default instead of the margins the user actually chose.
    // Electron's print() needs the four values IN MICRONS alongside marginType:"custom" (unlike
    // printToPDF's margins, which pdfOptions() above already sends in inches); s.marginTop etc. are
    // stored in inches (see the Custom margins note in CLAUDE.md), so convert here (1 inch = 25400 microns).
    const margins = s.margins === "custom"
      ? { marginType: "custom", top: Math.round(s.marginTop * 25400), bottom: Math.round(s.marginBottom * 25400), left: Math.round(s.marginLeft * 25400), right: Math.round(s.marginRight * 25400) }
      : { marginType: PRINT_MARGINS[s.margins] || "default" };   // the `|| "default"` is a safety net against ever sending `undefined` again
    const opts = {
      silent: true, deviceName: s.dest, printBackground: s.background, color: s.color, landscape: s.landscape,
      margins, pagesPerSheet: s.pps, copies: s.copies, collate: s.collate,
    };
    if (paper) opts.pageSize = { width: Math.max(353, paper.w), height: Math.max(353, paper.h) };   // the printer's own paper, in microns
    if (s.scaleMode === "custom") opts.scaleFactor = s.scale;
    if (s.dpi) { const [h, v] = s.dpi.split("x").map(Number); if (h > 0 && v > 0) opts.dpi = { horizontal: h, vertical: v }; }
    if (s.duplex) opts.duplexMode = s.duplexEdge === "short" ? "shortEdge" : "longEdge";
    if (ranges) opts.pageRanges = ranges.map(([a, b]) => ({ from: a - 1, to: b - 1 }));
    // Title only, never the page's address - owner's request 2026-10-20: a printed page's own
    // address is a privacy concern (it can be handed to someone else) and is never wanted on paper,
    // whether that address is real or (for frame-captured content) the holder's own data: URL - see
    // the big comment above pdfOptions, which the preview/Save-as-PDF path already follows.
    if (s.headers) { opts.header = title; }
    const destName = s.dest;
    // BUG found 2026-10-21 (owner: real prints kept failing - "Couldn't print... failed" - on BOTH a
    // network printer and the always-available "Microsoft Print to PDF", only on mfg.pb.diamonds's
    // Jangads "Big Print"): destroyEntry(tabId) used to run BEFORE target.print(), and for an
    // iframe-captured print (openForFrame) target IS entry.holder.webContents - the throwaway window
    // being printed FROM. Destroying that window while Windows is still negotiating the actual print
    // job tears the job out from under itself mid-flight, failing it with a generic, printer-agnostic
    // reason regardless of which destination was picked - exactly matching both screenshots showing
    // the SAME bare "failed" for two completely different printers. Root-caused by comparing against
    // the sibling PBERP-EXE-Barcode project's own printManager.js (same shape of problem: printing
    // captured HTML from a hidden BrowserWindow) - it destroys that window ONLY inside the print()
    // callback, once success/failure is already known, specifically to avoid this. Confirmed on THIS
    // codebase too: a live repro with every webContents.print() call hooked showed `isDestroyed()`
    // was NOT yet true at the exact moment .print() was invoked (the destroy had only just been
    // requested, not completed) - consistent with a destroy that was still in flight catching the
    // real print operation mid-negotiation rather than beating it outright.
    // Fix: close the DIALOG's own UI immediately (closeDialogKeepHolder - Chrome does the same the
    // instant Print is pressed), but keep entry.holder (if any) alive until the print() callback
    // actually fires, THEN destroy it - never while a job might still be using it.
    const entryRef = closeDialogKeepHolder(tabId);
    const holder = entryRef && entryRef.holder;
    target.print(opts, (ok, reason) => {
      try { if (holder && !holder.isDestroyed()) holder.destroy(); } catch (_) {}
      if (!ok) {
        try {
          dialog.showErrorBox("Couldn't print", `Windows could not print this page${reason ? ":\n\n" + reason : "."}\n\nCheck that "${destName}" is connected, turned on and ready, then try printing again.`);
        } catch (_) {}
      }
    });
    return { ok: true };
  });

  ipcMain.handle("print:system", (e) => { const f = entryBySender(e); if (!f) return false; systemDialog(f.tabId); return true; });

  // Chrome remembers a setting - destination included - the moment it is CHANGED, not only after Print/Save is pressed (measured
  // against real Chrome: pick a different destination, Cancel the dialog with no print, reopen it - the picked one is still there).
  // print:go already updates `sticky`; this does the same on every change so Cancel/Esc does not lose it.
  ipcMain.handle("print:sticky", (e, raw, moreOpen) => {
    const found = entryBySender(e);
    if (!found) return false;
    const { entry } = found;
    const { s: chosen } = clean(entry, raw, 2);
    sticky = stickyFrom(chosen, moreOpen);
    return true;
  });

  ipcMain.on("print:close", (e) => { const f = entryBySender(e); if (f) destroyEntry(f.tabId); });

  // The page's OWN "Print" button (window.print(), including the hidden-iframe trick - see the big comment above): the tab preload
  // reports it, we re-derive the TAB from the sender ourselves (never trust a tab id the page could forge) and open for that tab.
  // `html` is the iframe's own captured content when the call came from a same-origin iframe (openForFrame); null for the top frame
  // or the PDF-viewer bridge, where the tab's own page already IS what should be printed.
  ipcMain.on("page:print-request", (e, html) => {
    const tab = state.tabs.find((t) => t.view && t.view.webContents === e.sender);
    if (!tab) return;
    if (typeof html === "string" && html) openForFrame(tab, html);
    else open(tab.view.webContents);
  });
}

// tests only: replace the printers' abilities (no printer here can print two-sided or has two resolutions)
function setCapsForTest(list) { capsCache = list ? { at: Infinity, list } : null; }

module.exports = { register, open, close, isOpen, reposition, leaveTab, enterTab, closeFor, hasPending, watchPdfViewer, parseRanges, printerCaps, setCapsForTest, PDF_DEST };
