const { ipcMain } = require("electron");
const tabManager = require("../tabs/tabManager");
const vault = require("../vault/passwordVault");
const bookmarks = require("../bookmarks/bookmarkStore");
const downloads = require("../downloads/downloadManager");
const state = require("../state");

// The vault is origin-scoped. The preload passes location.origin, but the main process does not
// take that on trust: it re-derives the origin from the URL the sending webContents is actually
// showing, so the origin used for a lookup can never be something other than the sender's page.
function senderOrigin(e) {
  try {
    const u = new URL(e.sender.getURL());
    return /^https?:$/.test(u.protocol) ? u.origin : null;
  } catch (_) {
    return null;
  }
}

// Credentials typed into a login form, held only in memory between the form submit and the next
// page load (a real navigation destroys the page's JS, so it cannot carry them itself). Keyed by
// the sender's webContents id; expires after 60s; never written to disk, and never handed to page
// scripts — only back to the same tab's preload.
const pending = new Map(); // webContentsId -> { origin, username, password, at }
const PENDING_TTL = 60 * 1000;

function notifyBookmarks() {
  const win = state.mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send("bookmarks:changed", bookmarks.list());
}

function registerIpcHandlers() {
  // ── Tabs ─────────────────────────────────────────────────────────────
  ipcMain.handle("tabs:get-state", () => tabManager.getTabState());
  ipcMain.handle("tabs:new", (_e, url) => tabManager.createTab(url));
  ipcMain.handle("tabs:switch", (_e, id) => tabManager.switchTab(id));
  ipcMain.handle("tabs:close", (_e, id) => tabManager.closeTab(id));
  ipcMain.on("tabs:navigate", (_e, url) => tabManager.navigate(url));
  ipcMain.on("tabs:back", () => tabManager.goBack());
  ipcMain.on("tabs:forward", () => tabManager.goForward());
  ipcMain.on("tabs:reload", () => tabManager.reload());

  // ── Bookmarks ────────────────────────────────────────────────────────
  ipcMain.handle("bookmarks:list", () => bookmarks.list());
  ipcMain.handle("bookmarks:toggle-active", () => {
    const tab = tabManager.getActiveTab();
    if (!tab || tab.view.webContents.isDestroyed()) return bookmarks.list();
    const wc = tab.view.webContents;
    const list = bookmarks.toggle({ url: wc.getURL(), title: wc.getTitle() });
    notifyBookmarks();
    return list;
  });
  ipcMain.handle("bookmarks:remove", (_e, id) => {
    const list = bookmarks.remove(String(id));
    notifyBookmarks();
    return list;
  });

  // ── Downloads ────────────────────────────────────────────────────────
  ipcMain.handle("downloads:get", () => downloads.publicList());
  ipcMain.on("downloads:cancel", (_e, id) => downloads.cancel(id));
  ipcMain.on("downloads:open", (_e, id) => downloads.open(id));
  ipcMain.on("downloads:show", (_e, id) => downloads.showInFolder(id));
  ipcMain.on("downloads:dismiss", (_e, id) => downloads.dismiss(id));

  // ── Password vault ──────────────────────────────────────────────────
  // Every vault call is scoped to senderOrigin(e); any origin argument the preload sends is
  // ignored. A null origin (about:blank, file:, ...) gets empty / no-op answers.
  ipcMain.handle("vault:available", () => vault.isAvailable());
  ipcMain.handle("vault:list-usernames", (e) => {
    const o = senderOrigin(e);
    return o ? vault.listUsernames(o) : [];
  });
  ipcMain.handle("vault:get-password", (e, _o, username) => {
    const o = senderOrigin(e);
    return o ? vault.getPassword(o, username) : null;
  });
  ipcMain.handle("vault:get-last-saved", (e) => {
    const o = senderOrigin(e);
    return o ? vault.getLastSaved(o) : null;
  });
  ipcMain.handle("vault:save", (e, cred) => {
    const o = senderOrigin(e);
    return o ? vault.saveCredential({ ...cred, origin: o }) : false;
  });
  ipcMain.handle("vault:delete", (e, cred) => {
    const o = senderOrigin(e);
    return o ? vault.deleteCredential({ ...cred, origin: o }) : false;
  });
  ipcMain.handle("vault:never-save", (e, cred) => {
    const o = senderOrigin(e);
    return o ? vault.neverSave({ ...cred, origin: o }) : false;
  });
  ipcMain.handle("vault:needs-prompt", (e, _o, username, password) => {
    const o = senderOrigin(e);
    return o ? vault.needsSavePrompt(o, username, password) : false;
  });
  ipcMain.handle("vault:reset-origin", (e) => {
    const o = senderOrigin(e);
    return o ? vault.resetOrigin(o) : false;
  });

  ipcMain.on("vault:stash-pending", (e, cred) => {
    const o = senderOrigin(e);
    if (!o || !cred || !cred.username || !cred.password) return;
    pending.set(e.sender.id, {
      origin: o,
      username: String(cred.username),
      password: String(cred.password),
      at: Date.now(),
    });
  });
  // One-shot: hands the stashed credential back only if this tab is still on the same origin.
  ipcMain.handle("vault:take-pending", (e) => {
    const p = pending.get(e.sender.id);
    pending.delete(e.sender.id);
    if (!p || Date.now() - p.at > PENDING_TTL || p.origin !== senderOrigin(e)) return null;
    return { username: p.username, password: p.password };
  });
}

module.exports = { registerIpcHandlers };
