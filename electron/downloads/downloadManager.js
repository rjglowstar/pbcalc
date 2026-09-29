const { session, shell } = require("electron");
const state = require("../state");
const { DOWNLOAD_SHELF_HEIGHT } = require("../constants");
const { resizeActiveView } = require("../tabs/tabManager");

// In-memory download list for the current run only — never written to disk, gone on exit. The
// file the user saved is theirs; the browser keeps no record of it (no-history rule).
// The renderer only ever refers to downloads by numeric id, never by path, so the shell can't be
// used to open or reveal arbitrary files.
const items = []; // { id, filename, received, total, state, savePath, item }
let nextId = 1;

function publicList() {
  return items.map((d) => ({
    id: d.id,
    filename: d.filename,
    received: d.received,
    total: d.total,
    state: d.state, // progressing | completed | cancelled | interrupted
  }));
}

function notify() {
  const win = state.mainWindow;
  if (!win || win.isDestroyed()) return;
  // Reserve room for the shelf only while there is something on it.
  const inset = items.length ? DOWNLOAD_SHELF_HEIGHT : 0;
  if (inset !== state.bottomInset) {
    state.bottomInset = inset;
    resizeActiveView();
  }
  try {
    win.webContents.send("downloads:changed", publicList());
  } catch (_) {}
}

function init() {
  session.defaultSession.on("will-download", (_event, item) => {
    // No setSavePath(): Electron shows its native Save As dialog so the user picks the location.
    const d = {
      id: nextId++,
      filename: item.getFilename(),
      received: 0,
      total: item.getTotalBytes(),
      state: "progressing",
      savePath: "",
      item,
    };
    items.push(d);
    notify();

    item.on("updated", (_e, st) => {
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.filename = item.getFilename();
      d.state = st === "interrupted" ? "interrupted" : "progressing";
      notify();
    });

    item.once("done", (_e, st) => {
      d.savePath = item.getSavePath();
      d.received = item.getReceivedBytes();
      d.state = st; // completed | cancelled | interrupted
      d.item = null; // release the DownloadItem
      // Dismissing the Save As dialog cancels the download — nothing to show for that.
      if (st === "cancelled" && !d.savePath) {
        const i = items.indexOf(d);
        if (i !== -1) items.splice(i, 1);
      }
      notify();
    });
  });
}

const find = (id) => items.find((d) => d.id === Number(id));

function cancel(id) {
  const d = find(id);
  if (d && d.item) d.item.cancel();
}

function open(id) {
  const d = find(id);
  if (d && d.state === "completed" && d.savePath) shell.openPath(d.savePath);
}

function showInFolder(id) {
  const d = find(id);
  if (d && d.savePath) shell.showItemInFolder(d.savePath);
}

function dismiss(id) {
  const d = find(id);
  if (!d) return;
  if (d.item) d.item.cancel();
  items.splice(items.indexOf(d), 1);
  notify();
}

module.exports = { init, publicList, cancel, open, showInFolder, dismiss };
