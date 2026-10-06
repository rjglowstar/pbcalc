const { ipcMain } = require("electron");
const tabManager = require("../tabs/tabManager");
const vault = require("../vault/passwordVault");
const bookmarks = require("../bookmarks/bookmarkStore");
const downloads = require("../downloads/downloadManager");
const state = require("../state");
const popup = require("../popup");
const settings = require("../settings");
const restricted = require("../restricted");
const { SETTINGS_URL, RESTRICTED_HOME_URL, DOWNLOADS_URL } = require("../constants");

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
  ipcMain.handle("tabs:new", (_e, url) => {
    if (state.restricted) {
      // Restricted Mode: + opens the "Your sites" tiles page. Never a URL.
      return url ? tabManager.getTabState() : tabManager.createTab(null, { allowRestricted: true });
    }
    const r = tabManager.createTab(url);
    if (!url) tabManager.focusAddressBar(); // a blank new tab puts the caret in the omnibox, like Chrome
    return r;
  });
  ipcMain.handle("tabs:switch", (_e, id) => tabManager.switchTab(id));
  ipcMain.handle("tabs:close", (_e, id) => tabManager.closeTab(id));
  ipcMain.on("tabs:navigate", (_e, url) => tabManager.navigate(url));
  ipcMain.on("tabs:back", () => tabManager.goBack());
  ipcMain.on("tabs:forward", () => tabManager.goForward());
  ipcMain.on("tabs:reload", () => tabManager.reload());
  ipcMain.on("tabs:stop", () => tabManager.stop());
  // Address-bar suggestions: typing / arrows / Enter come from the shell; a click comes from the
  // dropdown page itself.
  const omnibox = require("../omnibox");
  const shellOnly = (e) => !!state.mainWindow && e.sender === state.mainWindow.webContents;
  ipcMain.on("omnibox:query", (e, text, rect) => {
    if (!shellOnly(e) || !rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;
    omnibox.query(String(text == null ? "" : text), { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.right - rect.left });
  });
  ipcMain.handle("omnibox:move", (e, dir) => (shellOnly(e) ? omnibox.move(Number(dir)) : null));
  ipcMain.on("omnibox:accept", (e, text) => { if (shellOnly(e)) omnibox.accept(String(text == null ? "" : text)); });
  ipcMain.on("omnibox:close", (e) => { if (shellOnly(e)) omnibox.hide(); });
  ipcMain.on("omnibox:warm", (e) => { if (shellOnly(e)) omnibox.warm(); });
  ipcMain.on("omnibox:pick", (e, index) => { if (omnibox.isSender(e.sender)) omnibox.pick(index); });
  // Tab hover card (from the shell's tab strip only)
  ipcMain.on("hovercard:show", (e, tabId, rect) => {
    if (!state.mainWindow || e.sender !== state.mainWindow.webContents) return;
    if (!rect || !Number.isFinite(rect.left)) return;
    require("../hovercard").show(tabId, rect);
  });
  ipcMain.on("hovercard:hide", (e) => {
    if (state.mainWindow && e.sender === state.mainWindow.webContents) require("../hovercard").hide();
  });
  ipcMain.on("tabs:reset-zoom", () => tabManager.zoom(0));
  ipcMain.on("tabs:move", (_e, id, index) => tabManager.moveTab(id, Number(index)));
  ipcMain.on("tabs:context-menu", (_e, id) => tabManager.tabContextMenu(id));

  // ── Popups (tab search, menu, downloads, site info, find bubble) ─────
  // Opening comes from the shell chrome only; the action channel from the popup page only.
  const fromShell = (e) => !!state.mainWindow && e.sender === state.mainWindow.webContents;
  // Right-click on the reload button (the menu itself only exists while DevTools is open: tabManager.reloadMenu).
  ipcMain.handle("tabs:reload-menu", (e, rect) => (fromShell(e) ? tabManager.reloadMenu(rect) : false));
  ipcMain.on("popup:open", (e, kind, rect) => {
    if (!fromShell(e)) return;
    // "unlock" is deliberately NOT here: the PIN box opens only from the hidden shortcut.
    if (!["tabsearch", "menu", "downloads", "siteinfo"].includes(kind)) return;
    const ok = rect && [rect.left, rect.right, rect.top, rect.bottom].every((n) => Number.isFinite(n));
    popup.open(kind, ok ? rect : null);
  });
  // Admin unlock box: the PIN is checked here in the main process (scrypt, throttled), and only
  // the popup page can ask.
  // Admin panel (opened only by the hidden shortcut). mode "leave": leave Restricted Mode.
  // mode "manage": stay restricted but open the bookmark manager for this one admin session.
  ipcMain.handle("popup:admin", (e, mode) => {
    if (!popup.isSender(e.sender) || !state.restricted) return { ok: false, error: "unavailable" };
    popup.close();
    if (mode === "manage") tabManager.openManager(true);
    else tabManager.leaveRestricted();
    return { ok: true };
  });
  // "Edit bookmark" box: only the popup page, never in Restricted Mode (popup.saveBookmark re-checks too).
  ipcMain.handle("popup:bookmark-save", (e, title, url) => (popup.isSender(e.sender) ? popup.saveBookmark(title, url) : { ok: false, error: "unavailable" }));
  ipcMain.handle("popup:bookmark-remove", (e) => (popup.isSender(e.sender) ? popup.removeBookmark() : { ok: false, error: "unavailable" }));
  ipcMain.handle("popup:get-data", (e) => (popup.isSender(e.sender) ? popup.getData() : null));
  ipcMain.on("popup:action", (e, name, arg) => {
    if (popup.isSender(e.sender)) popup.handleAction(String(name), arg);
  });

  // ── Settings page (only our own local settings page may read/write) ──
  const fromSettingsPage = (e) => {
    try { return e.sender.getURL().startsWith(SETTINGS_URL); } catch (_) { return false; }
  };
  ipcMain.handle("settings:get", (e) => {
    if (!fromSettingsPage(e)) return null;
    return tabManager.settingsSnapshot();
  });
  ipcMain.on("settings:set", (e, key, value) => {
    if (!fromSettingsPage(e)) return;
    if (key === "themeMode") tabManager.applyThemeMode(value);
    else if (key === "showBookmarksBar" && typeof value === "boolean") tabManager.setBookmarksBarVisible(value);
    else if (key === "searchSuggestions" && typeof value === "boolean") tabManager.setSearchSuggestions(value);
    else if (key === "downloadsAsk" && typeof value === "boolean") { downloads.setAsk(value); tabManager.broadcastSettings(); }
  });
  // Settings → Downloads → "Change": the native folder picker (never in Restricted Mode).
  ipcMain.handle("settings:choose-download-dir", async (e) => {
    if (!fromSettingsPage(e) || state.restricted) return null;
    await downloads.chooseDir();
    tabManager.broadcastSettings();
    return tabManager.settingsSnapshot();
  });

  // Restricted Mode setup — only from our own settings page, and only while NOT restricted.
  ipcMain.handle("settings:restricted-status", (e) => {
    if (!fromSettingsPage(e)) return null;
    return { enabled: !!state.restricted, startRestricted: restricted.getStartRestricted(), bookmarks: bookmarks.list().length };
  });
  // Turn Restricted Mode on now, for this session. Refused with no bookmarks: nothing would open.
  ipcMain.handle("settings:restricted-enable", (e) => {
    if (!fromSettingsPage(e) || state.restricted) return { ok: false, error: "unavailable" };
    if (!bookmarks.list().length) return { ok: false, error: "no-bookmarks" };
    // Deferred one tick: enabling closes this very settings tab, and the page should still get
    // its reply first.
    setImmediate(() => tabManager.enableRestricted());
    return { ok: true };
  });
  // "Default Start Restricted" switch.
  ipcMain.handle("settings:restricted-set-start", (e, on) => {
    if (!fromSettingsPage(e) || state.restricted) return { ok: false, error: "unavailable" };
    if (on === true && !bookmarks.list().length) return { ok: false, error: "no-bookmarks" };
    restricted.setStartRestricted(on === true);
    return { ok: true, startRestricted: restricted.getStartRestricted() };
  });

  // The Restricted Mode home page (tiles for the preset sites): only that local page may ask.
  const fromRestrictedHome = (e) => {
    try { return state.restricted && e.sender.getURL().startsWith(RESTRICTED_HOME_URL); } catch (_) { return false; }
  };
  ipcMain.handle("restricted:list", (e) => (fromRestrictedHome(e) ? bookmarks.list() : []));
  ipcMain.on("restricted:open", (e, id) => { if (fromRestrictedHome(e)) tabManager.openBookmark(String(id)); });

  // ── Bookmarks ────────────────────────────────────────────────────────
  ipcMain.handle("bookmarks:list", () => bookmarks.list());
  ipcMain.handle("bookmarks:toggle-active", () => tabManager.toggleBookmarkActive());
  // Bookmark manager page: only the local manager page, and in Restricted Mode only its
  // PIN-verified admin tab.
  const guard = (e) => tabManager.isManagerSender(e.sender);
  ipcMain.handle("manager:list", (e) => (guard(e) ? bookmarks.list() : []));
  const done = (r) => { tabManager.broadcastBookmarks(); return r; };
  ipcMain.handle("manager:add", (e, title, url) => (guard(e) ? done(bookmarks.add({ title, url })) : { ok: false, error: "unavailable" }));
  ipcMain.handle("manager:update", (e, id, title, url) => (guard(e) ? done(bookmarks.update(String(id), { title, url })) : { ok: false, error: "unavailable" }));
  ipcMain.handle("manager:remove", (e, id) => {
    if (!guard(e)) return [];
    const l = bookmarks.remove(String(id));
    tabManager.broadcastBookmarks();
    return l;
  });
  ipcMain.handle("manager:move", (e, id, dir) => {
    if (!guard(e)) return [];
    const l = bookmarks.move(String(id), Number(dir));
    tabManager.broadcastBookmarks();
    return l;
  });

  ipcMain.on("bookmarks:open", (e, id, newTab) => { if (fromShell(e)) tabManager.openBookmark(String(id), newTab); });
  // Drag to reorder on the bar: the shell only. Also in Restricted Mode (the owner's decision): it changes the ORDER of the
  // active list and nothing else - adding, editing and deleting stay refused there.
  ipcMain.on("bookmarks:move", (e, id, index) => {
    if (!fromShell(e)) return;
    bookmarks.moveTo(String(id), Number(index));
    tabManager.broadcastBookmarks();
  });
  ipcMain.on("bookmarks:context-menu", (e, id) => { if (fromShell(e)) tabManager.bookmarkContextMenu(String(id)); });
  ipcMain.handle("bookmarks:remove", (_e, id) => {
    if (state.restricted) return bookmarks.list(); // read-only in Restricted Mode
    const list = bookmarks.remove(String(id));
    notifyBookmarks();
    return list;
  });

  // ── Downloads ────────────────────────────────────────────────────────
  ipcMain.handle("downloads:get", () => downloads.publicList());
  // The Downloads page (pbcalc://downloads): only that local page, re-checked by URL on every call.
  const fromDownloadsPage = (e) => { try { return e.sender.getURL().startsWith(DOWNLOADS_URL); } catch (_) { return false; } };
  ipcMain.handle("downloads:page-list", (e) => (fromDownloadsPage(e) ? downloads.publicList() : []));
  ipcMain.on("downloads:page-action", (e, name, id) => {
    if (!fromDownloadsPage(e)) return;
    if (name === "open") downloads.open(id);
    else if (name === "show") downloads.showInFolder(id);
    else if (name === "copy-link") downloads.copyLink(id);
    else if (name === "remove") downloads.dismiss(id);
    else if (name === "cancel") downloads.cancel(id);
    else if (name === "pause") downloads.togglePause(id);
    else if (name === "retry") downloads.retry(id);
    else if (name === "clear-all") downloads.clearAll();
  });
  // Duplicate tab: hand the copy's preload the source tab's sessionStorage, once. Keyed by the
  // webContents the main process itself created, and only for the origin it was taken from — a
  // page cannot ask for another site's data (it cannot reach this channel at all: the preload
  // sends it, and only when main started that view with the --pbcalc-restore-session flag).
  // NOTE: `e.returnValue` may be assigned only ONCE — Electron sends the reply on the first
  // assignment, so an early `e.returnValue = null` would make every later assignment a no-op.
  ipcMain.on("tabs:session-restore", (e, origin) => {
    e.returnValue = sessionRestoreFor(e.sender.id, origin);
  });

  function sessionRestoreFor(senderId, origin) {
    const pending = state.pendingSessionRestore.get(senderId);
    if (!pending) return null;
    if (Date.now() - pending.at > 60000) { state.pendingSessionRestore.delete(senderId); return null; }
    if (typeof origin !== "string" || origin !== pending.origin) return null; // not the page it came from
    state.pendingSessionRestore.delete(senderId);
    return pending.data;
  }

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
