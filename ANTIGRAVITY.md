# ANTIGRAVITY.md

Architectural Reference & System Documentation for **PBCalc Browser**
Maintained by **Antigravity AI** (Google DeepMind Team)
Last verified against live code: 2026-10-22

---

## 1. Project Philosophy & Core Rules

PBCalc is a **Chrome-parity custom Electron browser** built for a diamond-trade business. It follows these non-negotiable principles:

- **No history.** Every session's browsing traces (HTTP cache, cookies, localStorage, IndexedDB, service workers) are wiped on every exit by `privacy.js`. Only the vault, bookmarks, settings, and `Local State` (DPAPI key) survive.
- **Chrome parity.** Every shortcut, UX behaviour, and edge case (tab restore index, pinned-tab reopen, Ctrl+Click bookmark, close-goes-to-right) is measured against real Chrome and reproduced. Comments throughout the codebase cite measurements.
- **No silent grants.** Permissions (camera, mic, location, notifications) are never silently granted. They go through a Chrome-style bubble (`permissions.js` → `popup.js`).
- **`setImmediate` for structural mutations.** Any shortcut handler that closes a BrowserView, creates a tab, or moves focus MUST defer its action via `setImmediate()`. Doing it synchronously inside `before-input-event` on Windows causes the OS to drop keyboard focus.
- **Never `git add` or `git commit` without explicit user permission.**

---

## 2. Data & Session Architecture

### Data Directory
- **Production:** `%LOCALAPPDATA%\PBCalc` (i.e. `C:\Users\<user>\AppData\Local\PBCalc`)
- **Dev:** `d:\Project\PBCalc\.dev-userdata\` (git-ignored)
- Set in `electron/constants.js` via `app.setPath("userData", dataDir())` **before** anything else touches storage.
- Falls back to `%APPDATA%\PBCalc` if Local is unwritable.

### Files that survive across sessions (`privacy.js` KEEP list)

| File | Purpose |
|------|---------|
| `password-vault.json` | DPAPI-encrypted credential store |
| `vault-lock.json` | scrypt hash of the fill-PIN + lockout counter |
| `bookmarks.json` | "real" bookmark list |
| `bookmarks-dummy.json` | decoy/dummy bookmark list (shown by default) |
| `settings.json` | UI preferences (theme, bar visibility, download dir…) |
| `calc-data.json` | Calculator dummy price data |
| `diag-session.json`, `diag-previous.json`, `diag-usage.json` | Diagnostics |
| `Local State` | Chromium's DPAPI key — **NEVER delete** |

### Tab Session Partition
- `TAB_PARTITION = "persist:pbcalc"` — persistent on-disk partition so the Chromium PDF viewer works (in-memory partitions break it).
- `privacy.js` wipes it on every clean exit AND on the next start (crash recovery).
- **All three subsystems MUST target this same partition:** UA spoofing (`main.js`), `will-download` (`downloadManager.js`), and tab views (`tabManager.js`). Misalignment silently breaks UA headers and download tracking.

---

## 3. Process & Module Map

### Startup Order (main process)

```
main.js
  ├── app.setPath("userData", dataDir())          // MUST be first
  ├── app.requestSingleInstanceLock()             // one PBCalc per data folder
  ├── privacy.wipeLeftoversOnDisk()               // crash leftovers swept before Chromium opens anything
  ├── privacy.installQuitWipe()                   // before-quit: clearSession(); will-quit: spawn post-exit cleanup
  ├── registerIpcHandlers()                       // ALL ipcMain channels registered before the window exists
  └── app.whenReady()
        ├── diagnostics.start()
        ├── UA spoofing on defaultSession + TAB_PARTITION session
        ├── screenShare.install() on both sessions
        ├── permissionRequestHandler + permissionCheckHandler on both sessions
        ├── onBeforeSendHeaders (Upgrade-Insecure-Requests, Accept headers) on both sessions
        ├── downloadManager.init()
        ├── updater.setup() / startupInstall() (packaged only)
        └── createMainWindow()
              ├── new BrowserWindow (titleBarStyle:"hidden", shell-preload.js)
              ├── lockdown.lock(shell webContents)
              ├── shortcuts.attachShortcuts(shell webContents)
              ├── contextMenu.attachContextMenu(shell webContents, {isShell:true})
              ├── mainWindow.loadFile(renderer/shell/shell.html)
              ├── ready-to-show → maximize → show → createTab() → resizeActiveView()
              └── event wiring: resize, blur, maximize, fullscreen, closed
```

### Key Modules

| Module | Role |
|--------|------|
| `electron/state.js` | Single shared mutable object: `mainWindow`, `windows: Set<BrowserWindow>`, `activeTabByWindow: Map<windowId, activeTabId>`, `tabs[]`, `activeTabId`, `nextTabId`, `restricted`, `calcMode`, `findOpen`, `bookmarksBarVisible`, `adminTabId`, `quitting`, `pendingSessionRestore` |
| `electron/constants.js` | All path, URL, and geometry constants: `TAB_PARTITION`, `NEWTAB_URL`, `SETTINGS_URL`, `DOWNLOADS_URL`, `MANAGER_URL`, `RESTRICTED_HOME_URL`, `TAB_STRIP_HEIGHT=40`, `TOOLBAR_HEIGHT=40`, `BOOKMARKS_BAR_HEIGHT=32`, `MAX_TABS=150` |
| `electron/tabs/tabManager.js` | The entire browser engine: create/close/switch/restore/duplicate tabs, navigation, find, zoom, devtools, bookmarks, Restricted Mode, memory saver, pinned tabs, session snapshot |
| `electron/ipc/registerIpcHandlers.js` | ALL `ipcMain.handle`/`ipcMain.on` registrations. Security: every handler checks sender identity before acting |
| `electron/windows/mainWindow.js` | `BrowserWindow` creation, calculator start logic, fullscreen events |
| `electron/shortcuts.js` | `before-input-event` handler on every `webContents`. Uses `claim(name, fn)` → `setImmediate(fn)` pattern |
| `electron/popup.js` | Single-popup-at-a-time `BrowserView` overlay system (tabsearch, menu, downloads, siteinfo, find bubble, bookmark-edit, permission, vault-unlock, screenshare) |
| `electron/omnibox.js` | Address-bar suggestion dropdown (bookmarks + open tabs + Google suggestions). Separate `BrowserView` |
| `electron/permissions.js` | Chrome-style permission bubbles: ALLOW set (silent yes), PROMPT map (ask), else refused. In-memory only |
| `electron/privacy.js` | `wipeLeftoversOnDisk()` + `clearSession()` + post-exit cleanup script |
| `electron/settings.js` | `settings.json` get/set with atomic write. DEFAULTS: `showBookmarksBar:true`, `themeMode:"system"`, `searchSuggestions:true`, `memorySaver:true` |
| `electron/bookmarks/bookmarkStore.js` | Two lists ("real" / "dummy"), mode in memory only (always starts "dummy"). Seeded on first run with 5 diamond-trade sites |
| `electron/downloads/downloadManager.js` | `will-download` handler, progress tracking, bubble, stall detection, pause/resume/retry/cancel. In-memory list only |
| `electron/vault/passwordVault.js` | DPAPI-encrypted credential store. Passwords never leave main process until fill-grant issued |
| `electron/vault/vaultLock.js` | scrypt hash of 4-8 digit PIN. 5 wrong tries → lockout (doubles each round, max 1 hour). Master password for recovery |
| `electron/vault/fillGrants.js` | One-time grants issued after vault password verified, consumed on `vault:get-password` |
| `electron/vault/pendingCredentials.js` | 60s in-memory stash for a typed credential across a navigation (login detection) |
| `electron/viewHost.js` | `attach(win, view)` / `detach(win, view)` — tracks Electron's leaked "closed" listeners and removes them on detach |
| `electron/restricted.js` | `siteOf(url)`, `sameSite(url, site)`, `getStartRestricted()` / `setStartRestricted()` |
| `electron/urlInput.js` | `resolveInput(text)` → URL or Google search. Handles schemes, IPs, localhost, intranet names, domains |
| `electron/contextMenu.js` | Right-click menus: shell (cut/copy/paste) and tab page (open link in new tab, etc.) |
| `electron/theme.js` | `titleBarOverlay` colour follows light/dark. `nativeTheme` watcher |
| `electron/lockdown.js` | Prevents the shell from opening new windows or navigating away |
| `electron/atomicWrite.js` | `writeFileAtomic()` — write to temp then rename, prevents corrupt files on crash |
| `electron/hovercard.js` | Tab hover card (title + host + thumbnail). Separate BrowserView |
| `electron/pinToast.js` | "Press Ctrl+W again to close the pinned tab" toast |
| `electron/calcMode.js` | Calculator screen logic: `enter()`, `leave()`, `onPlus()`, `enabled()`, `install()` |
| `electron/calcData.js` | Loads/saves `calc-data.json` |
| `electron/screenShare.js` | `getDisplayMedia` handler: "Choose what to share" dialog |
| `electron/diagnostics.js` | Records last 10 minutes of events in memory for the support report |
| `electron/reportDialog.js` | Support report dialog (crash/unclean-end prompt, manual send) |
| `electron/printPreview.js` | Chrome-style print preview with the pending-dialog dot on background tabs |
| `electron/updater.js` | Auto-updater (installed copy only) |
| `electron/externalOpen.js` | Opens a URL/file handed from a second instance or Windows Default Apps |
| `electron/dropFiles.js` | Drag-drop from Explorer: files → new tab, links → new tab |
| `electron/dlanimation.js` | Download-started animation view |
| `electron/defaultBrowser.js` | Registers PBCalc in Windows Default Apps |
| `electron/pages/errorPage.js` | Builds the data: URI for load errors, cert errors, crashes, blocked pages |

---

## 4. Tab Object Schema

Each tab in `state.tabs[]` holds:

```js
{
  id,           // integer, state.nextTabId++
  windowId,     // BrowserWindow.id owning this tab (multi-window support)
  view,         // BrowserView (or stub {webContents: DEAD_WC, ...} when discarded)
  childWindow,  // BrowserWindow created by window.open() — closed with the tab
  title,        // string
  url,          // string (updated on did-navigate)
  favicon,      // data: URI or ""
  errorPage,    // null | { kind, url }
  lastCertError,
  site,         // Restricted Mode: hostname this tab is confined to
  bookmarkId,   // Restricted Mode: the bookmark this tab came from
  openerId,     // id of the tab whose window.open created this one
  isHome,       // Restricted Mode: still on the "Your sites" page
  pinned,       // boolean — in memory only, gone on close
  newTabPage,   // boolean — true until first URL is known (bookmarks bar logic)
  lastActiveAt, // timestamp for memory saver
  discarded,    // null | { entries, index, session, wcId, at } — memory saver
  capture,      // null | { audio, video } — live camera/mic tracks
  thumb,        // data:image/jpeg;base64 — thumbnail for hover card
}
```

---

## 5. Shortcut System (`shortcuts.js`)

Shortcuts are handled via `wc.on("before-input-event", handleInput)` attached to **every** `webContents` (shell, each tab, popups). No Electron accelerators / menu are used.

### The `claim` pattern

```js
const claim = (name, fn) => {
  event.preventDefault();                          // swallow key synchronously
  if (input.isAutoRepeat && NO_AUTO_REPEAT.has(name)) return;
  if (state.restricted && !RESTRICTED_OK.has(name)) return;
  setImmediate(fn);                                // structural work on NEXT tick
};
```

`setImmediate` is mandatory — synchronous BrowserView teardown inside `before-input-event` causes Windows to drop focus.

### `NO_AUTO_REPEAT` set
`new-tab`, `close-tab`, `reopen-tab`, `duplicate-tab`, `find`, `downloads`, `print`, `devtools`, `settings`, `bookmark`, `bookmarks-bar`, `bookmark-manager`, `tab-search`, `fullscreen`, `find-close`, `address-bar`, `bookmark-mode-toggle`

### `RESTRICTED_OK` set
`back`, `forward`, `reload`, `reload-hard`, `close-tab`, `cycle-tab`, `select-tab`, `find`, `find-close`, `print`, `downloads`, `zoom`, `new-tab`, `fullscreen`, `bookmarks-bar`, `bookmark-mode-toggle`

### Shortcut Table

| Keys | Action |
|------|--------|
| Ctrl+T | New tab + focus address bar |
| Ctrl+Shift+T | Reopen closed tab (LIFO, index-aware) |
| Ctrl+W | Close tab (pinned needs second press via pinToast) |
| Ctrl+L | Focus address bar |
| Ctrl+R / F5 | Reload |
| Ctrl+Shift+R / Ctrl+F5 / Shift+F5 | Hard reload |
| Ctrl+F | Find in page |
| Escape (find open) | Close find |
| Ctrl+D | Toggle bookmark |
| Ctrl+P | Print preview |
| Ctrl+Shift+I / F12 | DevTools (http/https only, never Restricted Mode) |
| Ctrl+Shift+A | Tab search popup |
| Ctrl+Shift+B | Toggle bookmarks bar |
| Ctrl+Shift+O | Bookmark manager |
| Ctrl+Shift+J | Downloads page (NOT plain Ctrl+J — a site uses that) |
| Ctrl+Tab / Ctrl+PageDown | Next tab |
| Ctrl+Shift+Tab / Ctrl+PageUp | Previous tab |
| Ctrl+1..8 | Switch to tab N |
| Ctrl+9 | Switch to last tab |
| Ctrl++/= | Zoom in |
| Ctrl+-/_ | Zoom out |
| Ctrl+0 | Reset zoom |
| F11 | Toggle fullscreen |
| Alt+Left | Back |
| Alt+Right | Forward |
| Ctrl+Shift+Alt+B | Toggle bookmark list (dummy ↔ real) |
| Ctrl+Shift then type "pbsecure" | Secret Restricted Mode toggle |

> **Why Ctrl+J does NOT open the Downloads page:** A business site uses Ctrl+J itself. `before-input-event` runs before the page, so claiming it would break that site's shortcut. Plain Ctrl+J is left **unclaimed** and reaches the page. Downloads are Ctrl+Shift+J.

---

## 6. Tab Lifecycle

### Create — `createTab(url, opts)`
- Refuses if `state.restricted && !opts.allowRestricted`
- Refuses if `state.calcMode && !opts.fromCalc`
- Creates `BrowserView` with `partition: TAB_PARTITION`, `preload: tab-preload.js`
- `setBackgroundColor("#ffffff")` — keeps pages white even in dark mode
- Inserts at `opts.index` (splice) or appends (push)
- Calls `keepPinnedFirst()` after insert
- Calls `wireTabEvents(tab)` — attaches ALL webContents event listeners
- Calls `switchTab(tab.id)` unless `opts.background`
- After `loadURL`: calls `focusActivePageUnlessShell()` again (a brand-new view does not accept focus until after loadURL)

### Wire Events — `wireTabEvents(tab)`
Attaches to the tab's `webContents`:
- `page-title-updated`, `page-favicon-updated`
- `did-navigate`, `did-navigate-in-page`, `did-start-loading`, `did-stop-loading`
- `did-fail-load` → error page (ERR_ABORTED -3 ignored; ERR_UNKNOWN_URL_SCHEME -302 → `handleExternalUrl`)
- `render-process-gone` → crash error page
- `certificate-error` → allowed only if host is in `allowedCertHosts` Set
- `will-navigate` → pbcalc:// scheme, external schemes, Restricted Mode blocking
- `will-redirect` → Restricted Mode blocking
- `devtools-opened` → close if Restricted Mode OR URL is not http/https
- `did-navigate` → `permissions.forgetPage()` (clears "Allow this time")
- `did-create-window` → intercept popup, wrap in new tab
- `setWindowOpenHandler` → allow http/https/blob, deny everything else
- `found-in-page` → send result to find bubble
- `enter-html-full-screen` / `leave-html-full-screen` → `mainWindow.setFullScreen()`
- `destroyed` → cleanup pendingCredentials, fillGrants, pendingSessionRestore

### Switch — `switchTab(id)`
1. Hide hovercard, omnibox; close find; close popup
2. `leaveTab(oldId)` for print preview (HIDE, not close)
3. Capture thumbnail of departing tab (async, max 300ms)
4. `state.activeTabId = next.id`
5. `viewHost.attach(mainWindow, next.view)`
6. `viewHost.detach(mainWindow, leaving.view)` (after thumbnail)
7. `focusActivePageUnlessShell()` — focus the new page UNLESS shell (address bar) already has it
8. `resizeActiveView()` + `printPreview.reposition()`
9. `notifyTabs()`

### Close — `closeTab(id)`
1. Splices tab from `state.tabs`
2. Saves to `closedTabsHistory` (max 20): `{ url, index: idx, session: null, pending: null, pinned }`
3. Async: `snapshotSessionStorage()` → `packSessionStorage()` → stores in entry (max 400ms, max 512KB)
4. Destroys childWindow and webContents
5. If was active: switches to right neighbour (or left if was last)
6. If last tab: `mainWindow.close()`

### Restore — `reopenClosedTab()` (Ctrl+Shift+T)
- Pops last entry from `closedTabsHistory`
- Awaits `entry.pending` (the sessionStorage snapshot, if still in-flight)
- Calls `createTab(entry.url, { index: entry.index, sessionRestore: entry.session, pinned: entry.pinned })`
- Uses `reopenChain = reopenChain.then(async () => {...})` — multiple quick presses restore in LIFO order, never racing

### Tear-Off (Drag Tab to New Window) — `tearOffTab(tabId, coords)`
Chrome-parity tab drag-to-new-window detachment:
1. **Trigger:** In `renderer/shell/shell.js`, when a tab is dragged and dropped outside the tab strip boundary (`clientY > stripRect.bottom + 10` or outside the window viewport), it calls `browserAPI.tabs.tearOffTab(id, { screenX, screenY })`. Pressing `Escape` during the drag cancels detachment.
2. **Single-Tab Guard:** Chrome does not permit detaching the last remaining tab in a window. If `tabsInFromWin.length <= 1`, tear-off is safely rejected (`null`).
3. **Multi-Window Support:**
   - Detaches `tab.view` from the source `BrowserWindow` without destroying the underlying `webContents` (preserving DOM, login session, inputs, and JavaScript state).
   - Automatically switches keyboard and visual focus in the source window to a neighboring tab.
   - Spawns a new full-featured PBCalc `BrowserWindow` at the drop cursor coordinates via `createBrowserWindow({ x, y, width, height })`.
   - Associates `tab.windowId = newWin.id` and maps active tab state in `state.activeTabByWindow`.
   - On new window `ready-to-show`, attaches `tab.view` into the new window, resizes active view, and displays the window.
4. **Window Closure:** Closing the last remaining tab in any browser window closes that window (`win.close()`), returning OS focus to remaining active browser windows.

---

## 7. Popup System (`popup.js`)

One popup at a time. Each popup is a `BrowserView` (created on open, destroyed on close) positioned ABOVE the page view.

### Popup kinds

| Kind | Content |
|------|---------|
| `tabsearch` | Full-window overlay, tab list |
| `menu` | ⋮ menu (zoom, bookmark, theme, etc.) |
| `downloads` | Download bubble (auto-closes 5s; expanded via Ctrl+Shift+J) |
| `siteinfo` | Site info panel under the lock icon |
| `find` | Find bubble (380×48px, top-right of page) |
| `bookmark-edit` | "Bookmark added" / "Edit bookmark" bubble |
| `permission` | Camera/mic/location permission bubble |
| `vault-unlock` | PIN entry for saved-password fill |
| `screenshare` | "Choose what to share" dialog |
| `unlock` | Restricted Mode PIN box |

### Popup bounds
- `find`: `{ x: w - 396, y: chromeHeight() - 1, width: 380, height: 48 }`
- All others: `{ x: 0, y: 0, width: w, height: h }` (full window, modal backdrop)

### Security
`popup.isSender(e.sender)` — only the currently open popup's webContents may invoke popup-specific IPC.

---

## 8. Permission System (`permissions.js`)

### Silent allow (`ALLOW` set)
`fullscreen`, `pointerLock`, `keyboardLock`, `clipboard-sanitized-write`, `mediaKeySystem`, `storage-access`, `top-level-storage-access`, `fileSystem`

### Prompt (`PROMPT` map)
`geolocation`, `notifications`, `clipboard-read`, `midi`, `midiSysex`, `idle-detection`, `window-management`, `display-capture`, `media` (camera/mic)

### Special cases
- `openExternal`: handled in `permissionRequestHandler` (tabManager.js). Only `mailto:`, `tel:`, `sms:` shown with confirm dialog. All others silently dropped.
- `display-capture` / `media` with no mediaTypes → `screenShare.pick()` (that dialog IS the consent)

### Answers (in-memory only)
- "Allow while visiting the site": `remembered` Map by `origin|key`
- "Allow this time": `onceByPage` WeakMap by webContents
- "Never allow": `remembered.set(key, false)`
- Closing bubble: refused once, not remembered

### Check handler (`check`)
Synchronous check Chromium makes for `Notification.permission`, `permissions.query`, device labels. Returns `true` only if `decided()` === true.

### `statesFor(wc)` / `perm:states` IPC
Patches what the PAGE sees so "prompt" shows as "prompt" (not "denied"). Called synchronously from tab-preload via `ipcRenderer.sendSync("perm:states")`.

---

## 9. Bookmarks Architecture (`bookmarkStore.js`)

### Two lists
- `"dummy"` (`bookmarks-dummy.json`): shown to everyone by default. Seeded with 5 diamond-trade sites on first run (embedded PNG icons, no network request). Version 2 format.
- `"real"` (`bookmarks.json`): the owner's actual bookmarks.

### Mode switching
- Mode is **in memory only** — every launch starts on `"dummy"`. Never written to disk.
- Toggle: 3 quick clicks on the zoom % in the ⋮ menu, OR `Ctrl+Shift+Alt+B` → `tabManager.toggleBookmarkMode()`.
- Toggle only works when the bookmarks bar is currently **visible** (per `barShown()`, which includes the New Tab page forcing it on).

### URL types allowed as bookmarks
`bookmarks.isBookmarkable(url)` — only `http://` and `https://`.

---

## 10. Memory Saver (`tabManager.js`)

Background tabs idle for `DISCARD_AFTER_MS = 30 minutes` are "discarded":

1. **Sync checks:** not active, not loading, not audible, not captured, no DevTools, no notifications granted, not an opener/opened-by tab, no error page, http/https only.
2. **Async:** `hasUnsavedInput(wc)` — checks forms/contenteditable (800ms timeout = do not discard).
3. `snapshotSessionStorage(wc)` — up to `SESSION_SNAPSHOT_MS = 400ms`.
4. Destroys the BrowserView renderer. Tab stays in strip (dimmed, `discarded: {...}`).
5. `tab.view` replaced with stub + `DEAD_WC` so all "is it alive?" checks return false safely.
6. On click: `reviveTab(tab)` — creates a new BrowserView, restores navigation history, restores sessionStorage, re-wires all events.

---

## 11. Restricted Mode

Confines the browser to a preset list of bookmarks. Rules:

- All tabs closed on enter. New session starts on the "Your sites" home page.
- Each tab has a `site` (hostname). `will-navigate` and `will-redirect` cancel any navigation that leaves it.
- No address bar (URL suppressed everywhere).
- No DevTools (`devtools-opened` closes them immediately).
- No bookmark editing (manager only via PIN).
- `createTab` refuses unless `opts.allowRestricted = true`.
- Shortcuts outside `RESTRICTED_OK` are swallowed.
- Left only via PIN box → `tabManager.leaveRestricted()`.
- Enter via hidden shortcut (Ctrl+Shift + "pbsecure") → `tabManager.secretToggle()` → `tabManager.enableRestricted()`.

---

## 12. Vault & Password Manager

### `passwordVault.js`
- Credentials: `{ origin, username, password, savedAt }[]`, DPAPI-encrypted.
- Limits: username ≤ 256 chars, password ≤ 1024, 50 per origin, 2000 total.
- `listUsernames(origin)` — usernames only, sorted by savedAt desc. **Passwords never leave main.**
- `getPassword(origin, username)` — only if a fill-grant exists for this (senderId, origin, username).

### `vaultLock.js` (the fill PIN)
- 4–8 digit PIN, digits only. Default: `"1234"`.
- Stored as scrypt hash (N=16384, r=8, p=1), salted, DPAPI-encrypted.
- Lockout: 5 wrong tries → 30s; each further round doubles (cap 1 hour). Persists across restarts.
- Master password: accepted only in Settings > Change password.

### Fill flow
1. User clicks a saved username in the autofill dropdown.
2. Tab preload → `vault:request-fill` IPC → `popup.askVaultPassword(wc, origin, username)` opens PIN box.
3. User types PIN → `popup:vault-verify` → `vaultLock.verify()` → if ok, `fillGrants.grant(wcId, origin, username)`.
4. Popup resolves → preload → `vault:get-password` → `fillGrants.take(...)` → returns password once only.

### Password save flow
1. Tab preload's `passwordManager()` detects login form, watches submit.
2. On submit: `vault:stash-pending` stores credential (60s, keyed by wcId+origin).
3. SPA success / navigation: `vault:take-pending` → if pending and a login prompt is needed, shows "Save password?" card.

---

## 13. Anti-DevTool Bypass (`tab-preload.js`)

Runs via `webFrame.executeJavaScript(script, true)` — injects into the **main world**. Only runs on `http:` / `https:` pages.

### What it does
1. `Object.defineProperty(Object.prototype, 'isSuspend', { get: () => true, enumerable: false, ... })` — neutralises the `disable-devtool` library's main check loop.
2. Dummy `DisableDevtool` / `DISABLE_DEVTOOL` window properties — intercepts inline `DisableDevtool()` calls.
3. `Element.prototype.innerHTML` setter trap — blocks "Developer Tools Detected" / "Access Denied" DOM wipe.

All three are wrapped in `try/catch`. `enumerable: false` is critical — avoids breaking `Object.keys()` in Angular Zone.js.

> **The `window.location.replace` trap is NOT present in the current codebase.**

---

## 14. Chrome UA / WAF Compatibility (`main.js`)

```js
const cleanUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = cleanUA;
session.defaultSession.setUserAgent(cleanUA);
session.fromPartition(TAB_PARTITION).setUserAgent(cleanUA);
```

- Uses the **real** Chromium version from `process.versions.chrome`.
- Applied to BOTH sessions so no tab leaks the `Electron/x.y.z` token.
- No `navigator.userAgentData` override (creating an own property on `navigator` is flagged by Akamai's bot detector).

---

## 15. Session Storage Cloning (Ctrl+Shift+T / Duplicate / Memory Saver)

PBCalc preserves `sessionStorage` across tab restore, duplicate, and memory-saver revival:

1. `snapshotSessionStorage(wc)` — `executeJavaScript` reads all keys/values.
2. `packSessionStorage(url, data)` — validates origin, size ≤ 512KB.
3. Stored as `{ origin, data }` in the closed-tab history or the discarded-tab record.
4. `createTab(..., { sessionRestore: { origin, data } })` → `state.pendingSessionRestore.set(wcId, ...)`.
5. Tab preload has `--pbcalc-restore-session` argv flag → `ipcRenderer.sendSync("tabs:session-restore", location.origin)` → main checks origin match, returns `data` once.

---

## 16. Fullscreen (F11 / HTML5 video)

- `F11` → `mainWindow.setFullScreen(!isFullScreen())` via shortcut.
- `enter-html-full-screen` / `leave-html-full-screen` on tab webContents → `mainWindow.setFullScreen(true/false)`.
- `mainWindow` fires `enter-full-screen` / `leave-full-screen` → IPC `fullscreen:changed` to shell → CSS `.fullscreen` hides tab strip, toolbar, bookmarks bar.
- `chromeHeight()` returns `0` when fullscreen → `resizeActiveView()` fills the whole window.

---

## 17. `viewHost.js` — BrowserView Listener Leak Fix

`addBrowserView(view)` adds a hidden "closed" listener to the window that Electron never removes. Without `viewHost.js`, each tab switch and popup open would permanently leak one listener. `attach/detach` tracks which listeners each `addBrowserView` call added and removes them on `removeBrowserView`, keeping the count equal to the number of currently attached views.

---

## 18. Bookmarks Bar / New Tab Page Interaction

`barShown()` returns `true` if:
- `state.bookmarksBarVisible` is true (the setting), **OR**
- The active tab is a New Tab page or the Restricted Mode home page.

This matches Chrome: even with the bar hidden in settings, it appears on the New Tab page. `chromeHeight()` uses `barShown()`, so the page area adjusts on every tab switch, navigation, or setting toggle. `barWasShown` tracks the previous value so `notifyTabs()` only triggers `resizeActiveView()` when it actually changed.

---

## 19. IPC Security Model

Every IPC handler validates the sender before acting:

| Guard | Meaning |
|-------|---------|
| `shellSender(e)` / `fromShell(e)` | Sender must be `mainWindow.webContents` |
| `popup.isSender(e.sender)` | Sender must be the currently open popup's webContents |
| `fromSettingsPage(e)` | Sender URL must start with `SETTINGS_URL` |
| `fromDownloadsPage(e)` | Sender URL must start with `DOWNLOADS_URL` |
| `fromRestrictedHome(e)` | Restricted Mode on AND sender URL starts with `RESTRICTED_HOME_URL` |
| `tabManager.isManagerSender(wc)` | URL starts with `MANAGER_URL` AND (not restricted OR it is the admin tab) |
| `senderOrigin(e)` | Re-derives origin from sender's actual URL — never trusted from params |

---

## 20. Zoom

Chrome's exact preset steps: `[25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]`

- Per-tab zoom stored in `wc.setZoomFactor()`.
- `zoomWheel(wc, deltaY)` — Ctrl+wheel: accumulates deltas (WeakMap), fires one step per 50 units, resets on 400ms idle.
- Reset (Ctrl+0): `wc.setZoomFactor(1)`.

---

## 21. Omnibox / Address Bar Suggestions (`omnibox.js`)

Rows in priority order (Chrome's order):
1. **What you typed** — as URL or as Google Search
2. **Bookmarks** — title or URL contains query (max 3)
3. **Open tabs** — title or URL contains query (max 2, "Switch to tab")
4. **Google suggestions** — `https://suggestqueries.google.com/complete/search` (no cookies, aborted on new keystroke, skipped in Restricted Mode, configurable off in Settings)

Max 10 rows total. Displayed in a separate `BrowserView` (`renderer/omnibox/`).

---

## 22. Download Manager (`downloadManager.js`)

- Listens on `TAB_PARTITION` session's `will-download`.
- Tracks: `{ filename, received, total, state, savePath, url, from, startedAt, icon, speed, paused, stalled }`.
- **Stall detection:** 15s with no bytes received → `stalled: true` (not cancelled; Chromium may recover).
- **Bubble:** auto-closes 5s after start, never interrupts an open popup, never closes while mouse is inside it.
- **Unique filename:** Chrome-style `report (1).pdf`, `report (2).pdf`…
- `closeTabOpenedForDownload(wc)`: closes a tab whose only purpose was starting a download (URL still `""` / `about:blank` at download-start time, at least 2 tabs open).

---

## 23. DevTools Policy

`isInspectable(wc)`: only `http:` or `https:` URLs.

- `openDevTools()` (F12 / Ctrl+Shift+I): checks `isInspectable`, refuses on internal pages.
- `devtools-opened` event on every tab: closes immediately if not inspectable OR in Restricted Mode.
- `did-navigate` event: closes DevTools if the new URL is not inspectable.
- DevTools are blocked in Restricted Mode globally.

---

## 24. Pinned Tabs

- `pinTab(id, on)`: moves the tab to end of pinned group (if pinning) or first after group (if unpinning).
- `keepPinnedFirst()`: called after every insert/restore.
- `moveTab`: pinned tabs can only move among pinned; unpinned only after the pinned block.
- Tab strip: pinned tabs show only favicon, fixed width, no close button (CSS `.tab.pinned`).
- Middle-click does NOT close a pinned tab.
- Ctrl+W on a pinned tab: first press shows `pinToast.js` notice; second press closes.
- Pinned state is **in memory only** — gone when PBCalc closes.

---

## 25. Build & Scripts

- `npm start` — dev mode, data in `.dev-userdata/`
- `npm run obfuscate` — `node scripts/obfuscate.js` → `build-dist/` with hexadecimal identifiers + base64 string arrays
- `npm run dist` — obfuscate → `electron-builder` → NSIS installer in `release/`
- `scripts/` — 68+ verification scripts (`verify-*.js`) that test features programmatically

### Obfuscator settings (non-destructive)
```js
{
  compact: true,
  controlFlowFlattening: false,  // breaks Electron
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,           // preserves window, document, contextBridge, webFrame, ipcRenderer
  selfDefending: false,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  target: 'node'
}
```

### Excluded from the build
`CLAUDE.md`, `ANTIGRAVITY.md`, `.claude/`, `.git/`, `scripts/`, `.dev-userdata/`

---

## 26. Non-Negotiable Maintenance Rules

1. **Never `Object.defineProperty` on `Object.prototype` without `enumerable: false`.** Breaks Angular Zone.js (`Object.keys()` finds the injected property).
2. **Never globally wrap `Object.defineProperty` itself.** Breaks Angular Zone.js with `TypeError: Illegal invocation`.
3. **`setImmediate` around every structural mutation in `before-input-event`.** Skipping it drops keyboard focus on Windows.
4. **All three session targets (UA, download handler, tab partition) must stay aligned.** Misalignment silently breaks UA spoofing or download tracking.
5. **`TAB_PARTITION = "persist:pbcalc"` must stay persistent** (not in-memory). In-memory partitions break the Chromium PDF viewer.
6. **`Local State` must never be wiped** by `privacy.js`. It holds the DPAPI key for the vault.
7. **Bookmark mode starts on `"dummy"` every launch.** Mode is in-memory only, never written to disk.
8. **Pinned tab state is in-memory only.** Never persist to `settings.json`.
9. **`closedTabsHistory` max 20 entries; sessionStorage snapshots max 512KB each.** Enforced in `closeTab` and `packSessionStorage`.
10. **Never use `npm run dist` for testing.** Use `npm start`.




