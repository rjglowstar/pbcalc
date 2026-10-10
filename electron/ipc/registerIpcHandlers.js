const { ipcMain } = require("electron");
const tabManager = require("../tabs/tabManager");
const vault = require("../vault/passwordVault");
const bookmarks = require("../bookmarks/bookmarkStore");
const downloads = require("../downloads/downloadManager");
const state = require("../state");
const popup = require("../popup");
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

const pendingCredentials = require("../vault/pendingCredentials");

function notifyBookmarks() {
  const win = state.mainWindow;
  if (win && !win.isDestroyed()) win.webContents.send("bookmarks:changed", bookmarks.list());
}

function registerIpcHandlers() {
  // The tab commands below drive the whole browser (close, switch, open, list every tab's address). They come from the toolbar page
  // only: every tab page ALSO runs a preload with ipcRenderer, and none of them may be steered by what a page does.
  const shellSender = (e) => !!state.mainWindow && !state.mainWindow.isDestroyed() && e.sender === state.mainWindow.webContents;
  // ── Tabs ─────────────────────────────────────────────────────────────
  ipcMain.handle("tabs:get-state", (e) => (shellSender(e) ? tabManager.getTabState() : null));
  ipcMain.handle("tabs:new", (e, url) => {
    if (!shellSender(e)) return null;
    if (state.restricted) {
      // Restricted Mode: + opens the "Your sites" tiles page. Never a URL.
      return url ? tabManager.getTabState() : tabManager.createTab(null, { allowRestricted: true });
    }
    const r = tabManager.createTab(url);
    if (!url) tabManager.focusAddressBar(); // a blank new tab puts the caret in the omnibox, like Chrome
    return r;
  });
  ipcMain.handle("tabs:switch", (e, id) => (shellSender(e) ? tabManager.switchTab(id) : null));
  ipcMain.handle("tabs:close", (e, id) => (shellSender(e) ? tabManager.closeTab(id) : null));
  ipcMain.on("tabs:back", (e) => { if (shellSender(e)) tabManager.goBack(); });
  ipcMain.on("tabs:forward", (e) => { if (shellSender(e)) tabManager.goForward(); });
  ipcMain.on("tabs:reload", (e) => { if (shellSender(e)) tabManager.reload(); });
  ipcMain.on("tabs:stop", (e) => { if (shellSender(e)) tabManager.stop(); });
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
  ipcMain.on("tabs:reset-zoom", (e) => { if (shellSender(e)) tabManager.zoom(0); });
  // A real click / key in a page (reported by its preload, trusted events only): what makes a download "started by the user".
  ipcMain.on("page:capture", (e, a, v) => tabManager.setCapture(e.sender, a, v));
  ipcMain.on("page:activity", (e) => downloads.noteActivity(e.sender));
  ipcMain.on("tabs:zoom-wheel", (e, deltaY) => tabManager.zoomWheel(e.sender, Number(deltaY)));
  ipcMain.on("tabs:move", (e, id, index) => { if (shellSender(e)) tabManager.moveTab(id, Number(index)); });
  ipcMain.on("tabs:context-menu", (e, id) => { if (shellSender(e)) tabManager.tabContextMenu(id); });

  // ── Popups (tab search, menu, downloads, site info, find bubble) ─────
  // Opening comes from the shell chrome only; the action channel from the popup page only.
  const fromShell = (e) => !!state.mainWindow && e.sender === state.mainWindow.webContents;
  // Right-click on the reload button (the menu itself only exists while DevTools is open: tabManager.reloadMenu).
  // the calculator screen (calcMode.js): which screen is up, and the presses of its "+" button (counted there, shell page only)
  ipcMain.handle("calc:get-mode", (e) => (fromShell(e) ? !!state.calcMode : false));
  // the calculator's dummy data (calc-data.json): only the shell page, and only while the calculator is showing
  ipcMain.handle("calc:get-data", (e) => (fromShell(e) && state.calcMode ? require("../calcData").load() : null));
  ipcMain.on("calc:plus", (e) => { if (fromShell(e) && state.calcMode) require("../calcMode").onPlus(); });
  ipcMain.on("calc:chrome", (e, o) => { if (fromShell(e) && state.calcMode && o && typeof o === "object") require("../theme").setCalcChrome(o, state.mainWindow); });
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
  ipcMain.handle("popup:share-answer", (e, kind, id, audio) => (popup.isSender(e.sender) ? popup.answerScreenShare(String(kind), id, audio === true) : { ok: false }));
  ipcMain.handle("popup:perm-answer", (e, choice) => (popup.isSender(e.sender) ? popup.answerPermission(String(choice)) : { ok: false }));
  ipcMain.handle("popup:vault-verify", (e, pw) => (popup.isSender(e.sender) ? popup.verifyVaultPassword(pw) : { ok: false, error: "unavailable" }));
  ipcMain.handle("popup:get-data", (e) => (popup.isSender(e.sender) ? popup.getData() : null));
  ipcMain.on("popup:action", (e, name, arg) => {
    if (popup.isSender(e.sender)) popup.handleAction(String(name), arg);
  });

  // ── Settings page (only our own local settings page may read/write) ──
  const fromSettingsPage = (e) => {
    try { return e.sender.getURL().startsWith(SETTINGS_URL); } catch (_) { return false; }
  };
  // Change of the password asked before saved logins are filled (Settings > Saved passwords). Checked in vaultLock.
  ipcMain.handle("settings:change-vault-password", (e, oldPw, newPw, confirmPw) => {
    if (!fromSettingsPage(e)) return { ok: false, error: "unavailable" };
    const r = require("../vault/vaultLock").change(String(oldPw), String(newPw), String(confirmPw));
    if (r.ok) tabManager.broadcastSettings();
    return r;
  });
  ipcMain.handle("settings:get", (e) => {
    if (!fromSettingsPage(e)) return null;
    return tabManager.settingsSnapshot();
  });
  // Settings > Version > "Check for update" (see updater.checkNow): answers nothing about the result - a newer version shows the update popup.
  ipcMain.handle("settings:check-update", async (e) => {
    if (!fromSettingsPage(e)) return false;
    try { return await require("../updater").checkNow(); } catch (_) { return false; }
  });
  // Settings > Support > "Send report...": opens the report box (reportDialog.js); nothing is collected or sent until the user presses Send there.
  ipcMain.handle("settings:send-report", (e) => {
    if (!fromSettingsPage(e)) return false;
    require("../reportDialog").ask({ trigger: "manual" }).catch(() => {});
    return true;
  });
  ipcMain.on("settings:set", (e, key, value) => {
    if (!fromSettingsPage(e)) return;
    if (key === "themeMode") tabManager.applyThemeMode(value);
    else if (key === "showBookmarksBar" && typeof value === "boolean") tabManager.setBookmarksBarVisible(value);
    else if (key === "searchSuggestions" && typeof value === "boolean") tabManager.setSearchSuggestions(value);
    else if (key === "memorySaver" && typeof value === "boolean") tabManager.setMemorySaver(value);
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
  ipcMain.handle("bookmarks:list", (e) => (shellSender(e) ? bookmarks.list() : []));
  ipcMain.handle("bookmarks:toggle-active", (e) => (shellSender(e) ? tabManager.toggleBookmarkActive() : null));
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
  // Files dropped on the window from Explorer (see electron/dropFiles.js): the shell or a tab page, never anything else.
  ipcMain.on("files:dropped", (e, paths, at) => {
    const df = require("../dropFiles");
    if (df.isOurPage(e.sender)) df.openDropped(paths, at);
  });
  // A link dropped on the toolbar / tab strip (shell only; web addresses only; never in Restricted Mode: no address entry there).
  ipcMain.on("links:dropped", (e, url, at) => {
    if (!fromShell(e) || state.restricted || typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    let href; try { href = new URL(url).href; } catch (_) { return; }
    tabManager.createTab(href, Number.isInteger(at) && at >= 0 && at <= state.tabs.length ? { index: at } : {});
  });
  // A file drag from Explorer entered / left a tab page: the shell turns its tab strip into a drop target meanwhile.
  ipcMain.on("files:drag-state", (e, active) => {
    const df = require("../dropFiles");
    if (!df.isOurPage(e.sender) || e.sender === (state.mainWindow && state.mainWindow.webContents)) return;
    try { if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.webContents.send("files:drag-state", !!active); } catch (_) {}
  });
  ipcMain.on("bookmarks:context-menu", (e, id) => { if (fromShell(e)) tabManager.bookmarkContextMenu(String(id)); });

  // ── Downloads ────────────────────────────────────────────────────────
  ipcMain.handle("downloads:get", (e) => (shellSender(e) ? downloads.publicList() : []));
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

  // What the page is shown for Notification.permission / permissions.query: prompt until answered (see permissions.statesFor).
  // Derived from the sender's own page, never from a parameter.
  ipcMain.on("perm:states", (e) => { e.returnValue = require("../permissions").statesFor(e.sender, e.senderFrame && e.senderFrame.url); });

  function sessionRestoreFor(senderId, origin) {
    const pending = state.pendingSessionRestore.get(senderId);
    if (!pending) return null;
    if (Date.now() - pending.at > 60000) { state.pendingSessionRestore.delete(senderId); return null; }
    if (typeof origin !== "string" || origin !== pending.origin) return null; // not the page it came from
    state.pendingSessionRestore.delete(senderId);
    return pending.data;
  }


  // ── Password vault ──────────────────────────────────────────────────
  // Every vault call is scoped to senderOrigin(e); any origin argument the preload sends is
  // ignored. A null origin (about:blank, file:, ...) gets empty / no-op answers.
  ipcMain.handle("vault:available", () => vault.isAvailable());
  ipcMain.handle("vault:list-usernames", (e) => {
    const o = senderOrigin(e);
    return o ? vault.listUsernames(o) : [];
  });
  // A saved password is released ONLY with the one-time grant that popup.askVaultPassword writes after the vault password was
  // typed correctly (electron/vault/fillGrants.js) - so a page script calling window.vaultAPI.getPassword gets nothing.
  ipcMain.handle("vault:get-password", (e, _o, username) => {
    const o = senderOrigin(e);
    if (!o || typeof username !== "string") return null;
    if (!require("../vault/fillGrants").take(e.sender.id, o, username)) return null;
    return vault.getPassword(o, username);
  });
  // The preload asks for a fill (after the user picked a row): the dialog opens over the ACTIVE tab; resolves { ok } once the
  // password was right. Only for a username that is saved for this page's own origin.
  ipcMain.handle("vault:request-fill", async (e, username) => {
    const o = senderOrigin(e);
    if (!o || typeof username !== "string") return { ok: false };
    if (!vault.listUsernames(o).some((i) => i.username === username)) return { ok: false };
    const active = tabManager.getActiveTab();
    if (!active || active.view.webContents !== e.sender) return { ok: false };
    return { ok: await popup.askVaultPassword(e.sender, o, username) };
  });
  // Never hands out a password (it used to, to any page script): the username only.
  ipcMain.handle("vault:get-last-saved", (e) => {
    const o = senderOrigin(e);
    const last = o ? vault.getLastSaved(o) : null;
    return last ? { username: last.username } : null;
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
  // For window.vaultAPI (page scripts): the same question, but the answer never depends on the password.
  ipcMain.handle("vault:page-needs-prompt", (e, _o, username, password) => {
    const o = senderOrigin(e);
    return !!o && !!String(username || "").trim() && !!String(password || "");
  });
  ipcMain.handle("vault:reset-origin", (e) => {
    const o = senderOrigin(e);
    return o ? vault.resetOrigin(o) : false;
  });

  ipcMain.on("vault:stash-pending", (e, cred) => {
    const o = senderOrigin(e);
    if (!o || !cred || !cred.username || !cred.password) return;
    pendingCredentials.stash(e.sender.id, o, cred.username, cred.password);
  });
  // One-shot: hands the stashed credential back only if this tab is still on the same origin.
  ipcMain.handle("vault:take-pending", (e) => pendingCredentials.take(e.sender.id, senderOrigin(e)));
}

module.exports = { registerIpcHandlers };
