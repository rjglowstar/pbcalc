const { app, session, shell, clipboard, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const state = require("../state");
const settings = require("../settings");

// Download list for the current run only — kept in memory, never written to disk, gone on exit. The
// file the user saved is theirs; the browser keeps no record of it (no-history rule). Chrome keeps a
// permanent "download history"; PBCalc's equivalent is this session's list.
// The renderer only ever refers to downloads by numeric id, never by path, so the shell can't be
// used to open or reveal arbitrary files.
const items = []; // { id, filename, received, total, state, savePath, url, from, startedAt, icon, item, ... }
let nextId = 1;

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ""; }
}

// Where Chrome puts files: the OS Downloads folder, without asking, unless "Ask where to save each
// file" is on (Settings → Downloads, Chrome's own switch, off by default).
function downloadDir() {
  const chosen = (settings.get("downloads") || {}).dir;
  if (chosen) { try { if (fs.statSync(chosen).isDirectory()) return chosen; } catch (_) {} }
  try { return app.getPath("downloads"); } catch (_) { return app.getPath("temp"); }
}

// Chrome never overwrites: "report.pdf" becomes "report (1).pdf", "report (2).pdf"...
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  // A name is taken if the file is there, if a half-finished download is writing it, or if a row
  // in this session already claimed it (a paused download holds its name until it is removed).
  const claimed = new Set(items.filter((d) => d.savePath).map((d) => d.savePath.toLowerCase()));
  const taken = (p) => fs.existsSync(p) || fs.existsSync(p + ".crdownload") || claimed.has(p.toLowerCase());
  let p = path.join(dir, filename);
  for (let n = 1; taken(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

// What the UI gets. In Restricted Mode no address is ever shown, so `from` is left out.
function publicList() {
  return items.map((d) => ({
    id: d.id,
    filename: d.filename,
    received: d.received,
    total: d.total,
    state: d.state, // progressing | completed | cancelled | interrupted
    paused: !!d.paused,
    speed: d.speed || 0, // bytes/second, for Chrome's "1.2 MB/s - 628 KB of 156 MB" line
    resuming: !!d.resuming, // we asked it to resume and nothing has arrived yet
    stalled: !!d.stalled,   // running, not paused, but no byte has arrived for STALL_MS
    startedAt: d.startedAt,
    icon: d.icon || "",
    from: state.restricted ? "" : d.from,
    // Chrome strikes through a finished download whose file has since been deleted
    deleted: d.state === "completed" && !!d.savePath && !fs.existsSync(d.savePath),
  }));
}

const anyRunning = () => items.some((d) => d.state === "progressing");

// How long Chrome's self-opened download bubble stays up.
const BUBBLE_MS = 5000;
// A running download that has not received a single byte for this long is reported as stalled, so
// the UI never pretends something is happening when it is not. It is NOT cancelled: Chromium may
// still recover, and the moment a byte arrives the flag clears.
const STALL_MS = 15000;

let ticker = null;

// Watches running downloads for a stall. Runs only while something is downloading.
function watch() {
  if (ticker) return;
  ticker = setInterval(() => {
    const running = items.filter((d) => d.state === "progressing");
    if (!running.length) { clearInterval(ticker); ticker = null; return; }
    let changed = false;
    running.forEach((d) => {
      const stuck = !d.paused && Date.now() - (d._progressAt || d.startedAt) > STALL_MS;
      if (stuck !== !!d.stalled) { d.stalled = stuck; changed = true; }
      // a download that is not moving has no speed, whatever the last sample said
      if (stuck && d.speed) { d.speed = 0; changed = true; }
    });
    if (changed) notify();
  }, 2000);
  if (ticker.unref) ticker.unref();
}

// Open (or keep) the compact bubble and have it dismiss itself. Never steals an open popup from
// the user, and never cuts short a bubble the mouse is sitting in (popup.autoCloseDownloads).
function showBubble() {
  const popup = require("../popup");
  if (popup.isOpen("downloads")) return popup.autoCloseDownloads(BUBBLE_MS);
  if (popup.isOpen()) return; // the user has another popup open: leave it alone
  popup.open("downloads", null, { autoCloseMs: BUBBLE_MS, partial: true });
}

// Progress events arrive many times a second. Pushing every one of them would have the UI rebuild
// itself under the user's cursor, which swallows clicks — so plain progress is coalesced into at
// most one push every NOTIFY_MS, while anything that changes a row's STATE goes out at once.
const NOTIFY_MS = 400;
let lastNotify = 0;
let pending = null;

function notifySoon() {
  const wait = NOTIFY_MS - (Date.now() - lastNotify);
  if (wait <= 0) return notify();
  if (pending) return;
  pending = setTimeout(() => { pending = null; notify(); }, wait);
  if (pending.unref) pending.unref();
}

function notify() {
  if (pending) { clearTimeout(pending); pending = null; }
  lastNotify = Date.now();
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  const list = publicList();
  try {
    win.webContents.send("downloads:changed", list);
  } catch (_) {}
  // the Downloads page (pbcalc://downloads), if open
  const { DOWNLOADS_URL } = require("../constants");
  state.tabs.forEach((t) => {
    try {
      if (!t.view.webContents.isDestroyed() && String(t.url).startsWith(DOWNLOADS_URL)) t.view.webContents.send("downloads:changed", list);
    } catch (_) {}
  });
  require("../popup").refresh();
}

// Chrome's rule against automatic downloads: a page may start ONE download on its own (no click, no key); every further one it
// starts without a user gesture is refused until the page is left. Without it a site could drop dozens of files (any name, .exe
// included) into the Downloads folder by script alone - measured: 11 of 40 saved by a page that was never clicked. A download the
// user started (a click, a key) is never limited, and neither is one the app itself starts (Retry: no initiating page).
// "Did the USER just do something on this page?": item.hasUserGesture() cannot tell - measured, it says true for a download that a script
// started by itself (<a download>.click() with no click or key) - so the tab preload reports every TRUSTED pointer-down / key-down
// (a script cannot forge isTrusted) and a download counts as user-started when that was less than 5 s ago (Chrome's transient
// activation window).
const lastActivity = new WeakMap();    // webContents -> time of the last real click / key in it
const ACTIVITY_MS = 5000;
function noteActivity(wc) { if (wc) lastActivity.set(wc, Date.now()); }
const autoDownloads = new WeakMap();   // webContents -> { url, n }
function refuseAutomatic(initiator, item) {
  if (!initiator || initiator.isDestroyed()) return false;
  if (Date.now() - (lastActivity.get(initiator) || 0) < ACTIVITY_MS) return false;
  let url = "";
  try { url = initiator.getURL(); } catch (_) {}
  let rec = autoDownloads.get(initiator);
  if (!rec || rec.url !== url) { rec = { url, n: 0 }; autoDownloads.set(initiator, rec); }
  rec.n += 1;
  return rec.n > 1;
}

function init() {
  const { TAB_PARTITION } = require("../constants");
  // Tabs run in the TAB_PARTITION session (see constants.js), so a download started from a page
  // fires "will-download" THERE, not on defaultSession. Listen on both so every download is caught.
  const onWillDownload = (_event, item, initiator) => {
    if (refuseAutomatic(initiator, item)) { _event.preventDefault(); return; }   // cancels the download
    const ask = !!(settings.get("downloads") || {}).ask;
    // Chrome's default: straight into the Downloads folder, no dialog. With the switch on, Electron
    // shows its native Save As dialog instead (setSavePath left unset).
    if (!ask) {
      try { item.setSavePath(uniquePath(downloadDir(), item.getFilename())); } catch (_) {}
    }
    // Like Chrome: a tab opened only to start this download (window.open / target=_blank) closes
    // itself and the download carries on. Deferred a tick so the tab is not torn down from inside the
    // very event that is creating its download; the tab manager decides whether it qualifies. With
    // "ask where to save" the Save As dialog hangs off that tab's window, so wait until it has been
    // answered (first progress event) or dismissed (done) instead of pulling the window from under it.
    const closeInitiator = () => setImmediate(() => { try { require("../tabs/tabManager").closeTabOpenedForDownload(initiator); } catch (_) {} });
    // The moment the download has REALLY started (at once; after the Save As answer in "ask" mode):
    // Chrome's "download started" flight to the toolbar button, and the auto-close above. The flight is
    // asked first, while the initiating tab still exists, because it only plays for a tab you are
    // looking at (or one opened just for the download).
    const started = () => {
      try { require("../dlanimation").playFor(initiator); } catch (_) {}
      closeInitiator();
    };
    if (!ask) started();
    else { let fired = false; const once = () => { if (!fired) { fired = true; started(); } }; item.once("updated", once); item.once("done", once); }
    const d = {
      id: nextId++,
      filename: item.getFilename(),
      received: 0,
      total: item.getTotalBytes(),
      state: "progressing",
      paused: false,
      speed: 0,
      savePath: "",
      url: item.getURL(),
      from: originOf(item.getURL()),
      startedAt: Date.now(),
      icon: "",
      item,
      _lastBytes: 0,
      _lastAt: Date.now(),
      _progressAt: Date.now(),
    };
    items.push(d);
    watch();
    notify();
    // Like Chrome: a download pops the compact bubble open by itself and it goes away again after a
    // few seconds (unless the mouse is in it). The toolbar ring keeps showing the progress after.
    showBubble();

    item.on("updated", (_e, st) => {
      const now = Date.now();
      const prevState = d.state;
      const prevPaused = d.paused;
      if (item.getReceivedBytes() > d.received) {
        d._progressAt = now; // real movement: whatever we thought was stuck is not
        d.stalled = false;
        d.resuming = false;
      }
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.filename = item.getFilename();
      d.paused = item.isPaused();
      d.state = st === "interrupted" ? "interrupted" : "progressing";
      const dt = (now - d._lastAt) / 1000;
      if (dt >= 0.4) {
        d.speed = d.paused ? 0 : Math.max(0, Math.round((d.received - d._lastBytes) / dt));
        d._lastBytes = d.received;
        d._lastAt = now;
      }
      if (!d.savePath) d.savePath = item.getSavePath();
      const structural = d.state !== prevState || d.paused !== prevPaused;
      // Chrome shows the file-type icon from the start, not only once the file is finished.
      if (!d.icon && !d._iconAsked && d.savePath) {
        d._iconAsked = true;
        app.getFileIcon(d.savePath, { size: "normal" })
          .then((img) => { d.icon = img.toDataURL(); notify(); })
          .catch(() => {});
      }
      if (structural) notify(); else notifySoon();
    });

    item.once("done", async (_e, st) => {
      d.savePath = item.getSavePath();
      d.received = item.getReceivedBytes();
      d.state = st; // completed | cancelled | interrupted
      d.paused = false;
      d.speed = 0;
      d.item = null; // release the DownloadItem
      // Dismissing the Save As dialog cancels the download — nothing to show for that.
      if (st === "cancelled" && !d.savePath) {
        const i = items.indexOf(d);
        if (i !== -1) items.splice(i, 1);
      } else if (st === "completed" && d.savePath) {
        // the same file-type icon Windows shows in Explorer (PDF, image, archive...), like Chrome
        try { d.icon = (await app.getFileIcon(d.savePath, { size: "normal" })).toDataURL(); } catch (_) {}
      }
      notify();
      // Chrome pops the bubble up again when a file is done, to show "Done", and closes it after
      // a few seconds.
      if (st === "completed") showBubble();
      else if (!anyRunning()) require("../popup").autoCloseDownloads(BUBBLE_MS);
    });
  };
  for (const ses of [session.defaultSession, session.fromPartition(TAB_PARTITION)]) {
    ses.on("will-download", onWillDownload);
  }
}

const find = (id) => items.find((d) => d.id === Number(id));

function cancel(id) {
  const d = find(id);
  if (d && d.item) d.item.cancel();
}

// Chrome's Pause / Resume on a running download.
function togglePause(id) {
  const d = find(id);
  if (!d || !d.item || d.state !== "progressing") return;
  if (d.item.isPaused()) {
    // Chrome's Resume. A download the server will not let us continue cannot be resumed at all —
    // say so instead of sitting on "Resuming..." forever; Retry then starts it from scratch.
    if (!d.item.canResume()) {
      d.item.cancel();
      return;
    }
    d.item.resume();
    d.resuming = true;
    d._progressAt = Date.now(); // give the resume a fresh stall window
  } else {
    d.item.pause();
    d.resuming = false;
  }
  d.paused = d.item.isPaused();
  d.stalled = false;
  d.speed = 0;
  notify();
}

// Chrome's "Retry" on a cancelled or failed download: start it again and drop the dead row.
function retry(id) {
  const d = find(id);
  // Allowed on a dead row, and on a running one that is stuck (Chrome's Retry on a stalled item).
  if (!d || !/^https?:/i.test(d.url || "")) return;
  if (d.state === "progressing" && !d.stalled) return;
  if (d.item) { try { d.item.cancel(); } catch (_) {} }
  items.splice(items.indexOf(d), 1);
  try { session.defaultSession.downloadURL(d.url); } catch (_) {}
  notify();
}

// Clicking a finished download opens the files PBCalc can show itself (fileTypes.IN_TAB: PDF, images, plain text) in a PBCalc
// TAB instead of handing them to whatever Windows has as the default app - for the owner that was Chrome, so a downloaded PDF
// "opened directly in Chrome". Every other type still goes to Windows exactly as before. Restricted Mode opens them in a tab
// as well (the owner's decision: files open there like in normal mode).
function open(id) {
  const d = find(id);
  if (!(d && d.state === "completed" && d.savePath && fs.existsSync(d.savePath))) return;
  if (require("../fileTypes").IN_TAB.has(path.extname(d.savePath).toLowerCase())) {
    require("../tabs/tabManager").openLocalFile(d.savePath);
    return;
  }
  shell.openPath(d.savePath);
}

function showInFolder(id) {
  const d = find(id);
  if (d && d.savePath && fs.existsSync(d.savePath)) shell.showItemInFolder(d.savePath);
}

function copyLink(id) {
  const d = find(id);
  if (d && d.url && !state.restricted) clipboard.writeText(d.url);
}

function dismiss(id) {
  const d = find(id);
  if (!d) return;
  if (d.item) d.item.cancel();
  items.splice(items.indexOf(d), 1);
  notify();
}

// "Clear all": forgets the list (the files themselves stay where the user saved them).
function clearAll() {
  items.filter((d) => d.item).forEach((d) => d.item.cancel());
  items.length = 0;
  notify();
}

// Settings → Downloads: where files are saved, and whether to ask every time (Chrome's two rows).
function config() {
  const s = settings.get("downloads") || {};
  return { dir: downloadDir(), ask: !!s.ask };
}

function setAsk(on) {
  settings.set("downloads", { ...(settings.get("downloads") || {}), ask: !!on });
}

async function chooseDir() {
  if (state.restricted || !state.mainWindow || state.mainWindow.isDestroyed()) return config();
  const r = await dialog.showOpenDialog(state.mainWindow, { properties: ["openDirectory", "createDirectory"], defaultPath: downloadDir() });
  if (!r.canceled && r.filePaths[0]) settings.set("downloads", { ...(settings.get("downloads") || {}), dir: r.filePaths[0] });
  return config();
}

module.exports = { _items: items, init, publicList, cancel, togglePause, retry, open, showInFolder, copyLink, dismiss, clearAll, config, setAsk, chooseDir, noteActivity };
