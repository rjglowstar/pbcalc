# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A general-purpose Electron browser. It split off from a sibling project (`PBERP-EXE - Barcode`,
an Electron shell wrapping one specific ERP web app) — that project's password vault and
`contextIsolation`/preload discipline were reused here; almost everything else was built fresh,
because a real browser (arbitrary navigation, address bar, one shared session across tabs) is a
different shape of problem than an app shell wrapping one trusted site.

Two things define this browser against every mainstream one:
1. **No browsing history is ever recorded.** Not "cleared on exit" — never written at all. There
   is no history array, no history file, nothing to disable in settings. Do not add one without
   being asked; if a feature seems to need "recently visited," that is a sign to stop and ask
   rather than quietly reintroducing history tracking.
2. **One data folder inside the user's profile: `%LOCALAPPDATA%\PBCalc`.** Saved passwords,
   bookmarks, settings and the session data that is wiped on exit all live there in a packaged
   build (`.dev-userdata/` in the project folder under `npm start`, so working on PBCalc never
   touches an installed copy's data). It is out of sight (AppData is hidden by default) rather than
   a folder in the root of `C:`, and it does not depend on where the program was installed — a
   `UserData/` beside the exe meant an install into `C:\Program Files` could save nothing at all.
   **Local, not Roaming**: Chrome keeps its own profile in `%LOCALAPPDATA%\Google\Chrome\User Data`,
   and on a domain profile everything under Roaming is copied to and from the server at each logon,
   which is no place for a browser cache. (The sibling ERP lands in `%APPDATA%\mfg-erp` only
   because it never calls `app.setPath` — that is Electron's default, not a decision; its one
   deliberate choice is `D:\Exe Settings` for the barcode settings file. Verified on disk, not
   assumed.) `resolveDataDir()` in `electron/constants.js` really writes and deletes a probe file
   (a folder that exists but refuses writes is exactly what a bare `existsSync()` waves through)
   and falls back to `%APPDATA%\PBCalc` (Roaming) when the preferred folder cannot be created or
   written; `warnIfDataFolderUnwritable()` in `main.js` says so at startup if even that fails —
   same shape as that ERP's `D:\Exe Settings` → `%APPDATA%` fallback.
   **Build the path with `path.join` from `process.env.LOCALAPPDATA`, never as a hand-written
   Windows literal** — `"C:\PBCalc"` in a JS string is not that path: `\P` is not a valid escape,
   so it collapses to the *relative* `C:PBCalc` and `app.setPath` rejects it with "Path must be
   absolute". This really happened, and the test agreed with the bug because it compared against
   another literal mangled the same way; assert against the env var and a pattern instead.
   It is set in **one place**: `app.setPath("userData", dataDir())` as literally the first
   executable line of `electron/main.js`, before anything else runs. Everything else (the vault,
   Electron's own session storage) inherits it automatically through `app.getPath("userData")` —
   do not add a second, independent storage-path call anywhere. Covered by
   `scripts/verify-datadir.js` (13 checks, and 13 more with `BAD=1`), and end-to-end against the
   packaged exe: with the Windows app mode set to LIGHT, a seeded `settings.json`
   (`themeMode: "dark"`) and `bookmarks.json` in that folder made the real window come up dark with
   the seeded bookmark on its bar — which is what proves the folder is read, where a screenshot of
   a dark window on its own would not.

## Commands

- `npm start` — run the app in dev mode (`electron .`).
- `npm run obfuscate` — run obfuscation script (`node scripts/obfuscate.js`) to generate `build-dist/`.
- `npm run dist` — package a Windows installer via `electron-builder` (runs obfuscation automatically, outputs NSIS installer to `release/`).
- No test suite or linter is configured yet.

## Key Anti-Detection & Compatibility Systems

### 1. Buketo / `disable-devtool` Bypass & Inspect Element Compatibility
- **Target File:** [tab-preload.js](file:///d:/Project/PBCalc/preloads/tab-preload.js)
- **Mechanism:** Injects non-enumerable prototype traps into the main world before page scripts run via `webFrame.executeJavaScript()`.
- **Key Hooks:**
  - `Object.defineProperty(Object.prototype, 'isSuspend', { get: () => true, enumerable: false })`: Neutralizes `disable-devtool`'s internal inspection loops. `enumerable: false` is required so `Object.keys()` and `for...in` loops in third-party frameworks (React, Angular) do not break.
  - `DisableDevtool` & `DISABLE_DEVTOOL` window getters returning a dummy object `{ isSuspend: true, md5: '', version: '' }`.
  - `location.replace` trap to ignore redirects to `about:blank` or `disable-devtool`.
  - `Element.prototype.innerHTML` setter trap targeting `"Developer Tools Detected"` to prevent page blanking when DevTools are opened.
- **Result:** Allows Inspect Element to function on all sites (including Buketo-protected pages) without breaking site functionality or triggering DevTools traps.

### 2. Akamai EdgeSuite WAF & Meesho.com Compatibility
- **Target Files:** [main.js](file:///d:/Project/PBCalc/electron/main.js), [tab-preload.js](file:///d:/Project/PBCalc/preloads/tab-preload.js)
- **Problem & Root Cause:** Meesho.com and other Akamai WAF-protected sites returned `403 Access Denied`. Akamai's bot sensor scripts check if `navigator.hasOwnProperty('userAgentData') === true`. Overriding `navigator.userAgentData` via `Object.defineProperty` created an own property on the `navigator` instance, triggering Akamai's DOM-tampering bot detector.
- **Solution:**
  - Standard Chrome User-Agent set via `session.defaultSession.setUserAgent(cleanUA)` in `main.js`.
  - Removed manual `navigator.userAgentData` property overrides in `tab-preload.js` so Chromium's native `Navigator.prototype.userAgentData` is preserved without own-property detection (`navigator.hasOwnProperty('userAgentData') === false`).
- **Result:** Meesho.com, WhatsApp Web, and all Akamai-protected web apps load normally (HTTP 200).

### 3. Source Code Obfuscation & Build Security Pipeline
- **Target Script:** [obfuscate.js](file:///d:/Project/PBCalc/scripts/obfuscate.js)
- **Config:** [package.json](file:///d:/Project/PBCalc/package.json)
- **Workflow:**
  1. Running `npm run dist` executes `obfuscate.js`.
  2. Copies source files from `electron/`, `preloads/`, `renderer/` to `build-dist/`.
  3. Obfuscates all `.js` files using `javascript-obfuscator` with hexadecimal variable mangling and Base64 string encoding while preserving global IPC bindings (`renameGlobals: false`).
  4. Modifies `build-dist/package.json` to remove the `"build"` block (preventing `electron-builder` v26+ schema errors) and sets `build.directories.app = "build-dist"`.
  5. `electron-builder` packages `build-dist/` into `release/PBCalc Setup <version>.exe`.
  6. All sensitive developer files (`CLAUDE.md`, `ANTIGRAVITY.md`, `.git`, `.claude`, `scripts`, `.dev-userdata`) are strictly excluded from `app.asar`.

### 4. Disk Cache & Startup Error Prevention
- **Target File:** [main.js](file:///d:/Project/PBCalc/electron/main.js)
- **Switches:** `app.commandLine.appendSwitch("disable-gpu-shader-disk-cache")` and `app.commandLine.appendSwitch("disable-http-cache")`.
- **Purpose:** Prevents Windows file locking collisions on Chromium cache files (`net\disk_cache` / `gpu_disk_cache` Access is denied console errors) during app launches or rapid restarts.

### 5. Google sign-in ("This browser or app may not be secure") — `window.chrome`
- **Target File:** [tab-preload.js](file:///d:/Project/PBCalc/preloads/tab-preload.js), the same injected block as the Buketo helpers.
- **Problem & root cause (measured against Google itself, not assumed):** signing in to Google, or to anything that
  uses "Continue with Google" (ChatGPT), ended on `accounts.google.com/v3/signin/rejected`. Real Chrome's
  `window.chrome` has `app`, `csi` and `loadTimes`; Electron's is an EMPTY object, which Google reads as an embedded
  browser. Method: enter an address that does not exist and see which answer Google gives ("Couldn't find this
  account" = browser accepted, "Couldn't sign you in" = refused), with each candidate difference applied ALONE:
  Chrome-like UA/brands/client hints -> still refused; hiding `Object.prototype.isSuspend` -> refused; hiding
  `window.vaultAPI` -> refused; `Notification.permission` -> refused; **filling in `window.chrome` -> accepted.**
- **Solution:** the injected script adds `chrome.app`, `chrome.csi`, `chrome.loadTimes` when missing (additive,
  never replaces anything). The `isSuspend` trap above stays: the Buketo site depends on it.
- **Known differences left alone on purpose** (they did not change Google's answer): the client-hint brand list has
  no "Google Chrome" entry and the UA carries the full Chromium version (Chrome sends `.0.0.0`), `Accept-CH`
  requests are not honoured, `Accept-Language` is `en-US` only. Do not "fix" those without the same kind of test.
- **Limit:** this is Google's heuristic, not a contract; it can change. Re-run the method above if sign-in breaks
  again. Repeated probing makes Google show a "type the text you hear or see" check for a while.

## Architecture

- `electron/main.js` — entry point. Sets the `userData` path (`C:\PBCalc`) first, then wires up the
  main window and IPC handlers.
- `electron/state.js` — single mutable module-level object (`mainWindow`, `tabs`, `activeTabId`),
  same pattern as the sibling ERP project. No store/reducer layer.
- `electron/constants.js` — `dataDir()` / `resolveDataDir()` / `PREFERRED_DATA_DIR` (the
  `%LOCALAPPDATA%\PBCalc` rule above, dev vs. packaged), `TAB_PARTITION`, tab bar height, tab
  ceiling, home URL.
- `electron/tabs/tabManager.js` — the tab engine. Each tab is a `BrowserView`. Deliberately **no
  per-tab** session partition: every tab shares ONE session, so logging into a site in one tab
  keeps you logged in in another tab of the same site, like a real browser. That shared session is
  the named, **in-memory** partition `TAB_PARTITION` (`"pbcalc"`, no `persist:` prefix, so
  `getStoragePath()` is `null` — cookies, localStorage and the HTTP cache live in RAM and are gone
  on exit with nothing on disk). **It is NOT `session.defaultSession`, so anything that must see tab
  traffic has to target `TAB_PARTITION`:** the Chrome User-Agent / header rules (`main.js`), the
  download manager's `will-download` (`downloadManager.init`, which listens on both) and
  `privacy.clearSession()` (clears both). Wiring them to `defaultSession` alone silently broke two
  things at once: tabs sent the `Electron/x` token in their User-Agent (WAFs such as Akamai on
  Meesho answer that with a 403) and page downloads were never caught. Tests that hook a session
  for tab behaviour must use `session.fromPartition(TAB_PARTITION)` too (`verify-features.js`).
  (The sibling ERP project isolates each tab into its own partition instead, because it needs
  several independent logins open side by side — that reasoning does not apply here; do not copy
  that pattern in without a specific reason.) Only the currently active tab's `BrowserView` is
  ever attached to the window (`addBrowserView`/`removeBrowserView` on switch) — simpler and more
  broadly compatible than relying on `setTopBrowserView`, which was not assumed to exist without
  checking.
- `electron/windows/mainWindow.js` — creates the shell `BrowserWindow`, loads `renderer/shell/`,
  opens the first tab once the window is ready to show.
- `electron/vault/passwordVault.js` — ported from the sibling project's vault, unchanged in logic.
  Chrome-style, per-origin, encrypted at rest with Electron's `safeStorage` (Windows DPAPI — tied
  to the current Windows user account, so the file is useless copied elsewhere or opened by
  another user). One shared vault file across all tabs, since they now share one session anyway.
- `electron/ipc/registerIpcHandlers.js` — every `ipcMain.handle`/`ipcMain.on` in one place, called
  once from `main.js`.
- `preloads/shell-preload.js` — narrow bridge for the shell chrome (tab strip + address bar) only:
  create/switch/close tabs, navigate, back/forward/reload, read tab state.
- `preloads/tab-preload.js` — runs inside **every tab**, i.e. on arbitrary websites the user
  navigates to, not just trusted pages. Exposes `window.vaultAPI`, scoped to `location.origin`
  read inside the preload's own isolated context — a page cannot claim to be a different origin
  to read another site's saved credentials.
- `renderer/shell/` — the tab strip + address bar chrome. Not the page content itself, which lives
  in each tab's own `BrowserView`.

## What's built vs. what's a stub

- Tabs, navigation (address bar accepts URLs or falls back to a Google search), back/forward/
  reload, opening links in a new tab (`window.open`/`target="_blank"`) — all real and working.
- The password vault backend (save/list/get/delete/never-save/reset, IPC-wired, encrypted at
  rest) — real and working, verified directly against its exported functions.
- **Wipe on exit** (`electron/privacy.js`): the user chose the strict policy — cookies, cache,
  localStorage, IndexedDB etc. never survive a restart, so logins do not persist either. On quit
  the session is cleared, then a detached helper process deletes everything in `userData` except
  `password-vault.json`, `bookmarks.json`, `settings.json` and `Local State` once our PID is gone
  (the `KEEP` set in privacy.js — four files, not three); the same sweep
  runs at startup for crash leftovers. **`Local State` must stay in the keep list** — it holds the
  `safeStorage` key; deleting it makes the vault undecryptable.
- **Bookmarks** (`electron/bookmarks/`): user-curated, persisted in `bookmarks.json`; bar + star
  button in the shell. Stores only what was explicitly bookmarked (no visit data).
  **Editing them is Chrome's, normal mode only** (`scripts/verify-bookmark-edit.js`, 36 checks):
  - **The star / Ctrl+D** (`toggleBookmarkActive`): a page that is not bookmarked is added and Chrome's
    **"Bookmark added" bubble** opens under the star (page tile, Name pre-selected, Folder, Done / Remove, X);
    on a bookmarked page the same bubble opens as "Edit bookmark". **The star no longer removes by
    itself** (Chrome never did) - Remove is in the bubble. Done / X / Enter keep the name. Folder lists only
    "Bookmarks bar" (there are no folders here; do not fake more). Anchored from the star's real rectangle
    (`showBookmarkBubble`, read from the shell DOM).
  - **Right-click a bookmark on the bar** (`bookmarkContextMenu`): Open in new tab, Edit..., Delete, Copy link
    address, Add page..., Bookmark manager, Show bookmarks bar (checkbox). `Edit...` opens the Name + URL dialog.
    Both are the one popup kind `bookmark-edit` (`renderBookmarkEdit` / `renderBookmarkBubble` in
    `renderer/popup/popup.js`); saves go through `popup:bookmark-save` / `popup:bookmark-remove`
    (`popup.saveBookmark` / `removeBookmark`, popup page only; validation = `bookmarkStore.update`: bad
    address and duplicates are refused with a message).
  - **Restricted Mode is unchanged: read and open only.** Guarded in FOUR places so no single check carries it:
    `bookmarkContextMenu`/`openBookmarkEdit` return, `popup.open` refuses the kind (`RESTRICTED_KINDS`),
    `saveBookmark`/`removeBookmark` re-check `state.restricted`, and `toggleBookmarkActive` returns first.
    `bookmarks:context-menu` is also accepted from the shell only. The test removes the `popup.open` guard to
    prove it is the one that fails (negative control).
  - **A bookmark keeps its page's icon, including inline `data:` ones.** `bookmarkStore` used to accept only
    http(s) icons, so a site declaring its icon inline (the tab strip showed it fine) was bookmarked with an
    empty icon and the bar drew the globe (found with a probe page: `data:` -> stored `""`; http, late-loading and
    `/favicon.ico` icons were fine, so timing was NOT the cause). `isIconUrl` now also accepts `data:image/*` up to
    32 KB (bigger is dropped, keeps `bookmarks.json` small). Bookmarks that already have no icon **learn it** the
    next time that exact address shows one (`learnIcon`, called from `page-favicon-updated`; fills only an EMPTY
    icon, only for a bookmarked address, never in Restricted Mode) - so reopen/reload such a page once. Nothing is
    recorded for pages that are not bookmarks. The bar shows the TITLE the page had when it was bookmarked (as in
    Chrome), which can differ from the tab's current title.
  - **Drag to reorder on the bookmarks bar** (Chrome): HTML5 drag like the tab strip (`bmDragId`, `renderBookmarks`
    in `shell.js`): the dragged one dims, a 2px accent line shows the landing spot (before/after the hovered
    bookmark), dropping on the empty part of the bar puts it last, dropping on itself does nothing. Main side:
    `bookmarks:move` -> `bookmarkStore.moveTo(id, index)` (index into the list WITHOUT the dragged one, clamped),
    shell sender only, **refused in Restricted Mode** (there the bar items are also `draggable=false`).
    Favicon `<img>`s are `draggable=false` so the whole bookmark drags. `scripts/verify-bookmark-drag.js` (22
    checks, run on the second display when there is one). **Not verified with a real OS pointer:** synthetic
    `sendInputEvent` cannot start Chromium's drag loop, so the test fires the drag events the elements receive
    (dragstart/dragover/drop/dragend); an attempt to inject real OS mouse input failed because PBCalc could not
    be raised above the owner's own windows on that display (`WindowFromPoint` returned VS Code). Say so
    rather than claim a real-mouse drag was proven; the owner confirms it by hand.
  - A popup **closes when the window loses focus** (`mainWindow.js` "blur", on purpose, like Chrome), so a
    test that opens one fails if the PC's owner clicks elsewhere meanwhile; `verify-bookmark-edit.js`
    refocuses and retries its opens.
- **Downloads** (`electron/downloads/`): in-memory list, never persisted, gone
  on exit (Chrome's permanent download history is deliberately absent). Like Chrome: the toolbar
  downloads button is ALWAYS visible; it opens the "Recent download history" popup (newest 5, system
  file icon, "size • time ago", hover folder/open icons, circled-X close, "Full download history"
  footer; auto-opens 5s when a download starts). Ctrl+Shift+J, ⋮ → Downloads and that footer open the
  full page `pbcalc://downloads` (`renderer/downloads/`, reuses its tab). **The shortcut is
  Ctrl+SHIFT+J, not Chrome's plain Ctrl+J, on purpose (the owner's decision):** one of the sites run
  in this browser has its own Ctrl+J shortcut that opens a modal, and `before-input-event` runs
  BEFORE the page, so claiming plain Ctrl+J would make that impossible (Chrome lets the page see it
  first). Plain Ctrl+J must therefore stay UNCLAIMED and reach the page — `verify-browser.js` has a
  page-side key listener proving that, and that Ctrl+Shift+J is swallowed by the browser. Do not
  "restore Chrome parity" here; Chrome's Ctrl+Shift+J (DevTools console) is not implemented, devtools
  are Ctrl+Shift+I / F12. The labels (toolbar tooltip in `shell.html`/`shell.js`, ⋮ menu hint in
  `popup.js`) must say Ctrl+Shift+J. It goes straight to the PAGE; only the toolbar button opens
  the bubble, and a bubble that is already open is closed first. A past change made the key toggle the
  bubble and reach the page only on a second press; `verify-browser.js` guards page, reuse and bubble-open.
  Page features: search, Clear all, day groups,
  filename link, "From <origin>", copy link / show in folder / remove, strike-through "Deleted" when
  the file is gone. `window.downloadsAPI` exists only on that file; `downloads:page-*` IPC re-checks the
  sender URL. In Restricted Mode the "From" address is withheld (`publicList`).
  **The download process copies Chrome's** (`verify-download-flow.js`): files go straight to the OS
  Downloads folder with **no Save As dialog** (Settings → Downloads has Chrome's "Ask where to save
  each file", off by default, plus the folder + Change); an existing name gets " (1)" (`uniquePath`,
  Electron would otherwise overwrite). While a download runs the toolbar button shows a conic-gradient
  progress ring (`.busy`, `--p`; `.spin` when the server sends no length) and stays accented (`.fresh`)
  until the bubble is opened. Rows show Chrome's wording — "6.1 KB • Done", "0.6/156 MB • Resuming...",
  "… • 2 minutes left", "Paused", "Canceled" — with Pause/Resume + Cancel while running and
  Retry/Remove after. **Never claim progress that is not happening:** "Resuming..." is shown only
  after an actual Resume and clears on the first byte; a download that has received nothing yet says
  "Starting…"; one that gets no byte for 15s is marked `stalled` (`STALL_MS`, the `watch()` ticker)
  and shows "Stalled" with a Retry in place of Pause. Resume on an item whose server will not allow
  it (`canResume()` false) cancels instead of hanging on "Resuming...". `uniquePath` also avoids
  names already taken by live rows and any `.crdownload`, so a second download of the same file can
  never write over a paused one. The page repeats that with grey struck-through cards for cancelled/failed ones
  and a ⋮ row menu. Row actions follow Chrome exactly: copy-link always, then **folder** for a
  finished file or **⋮** otherwise, and the **✕ ("remove from list") only once the download is over**
  — a running or paused row is ended through ⋮ → Cancel, never by dropping the row.
  **Never re-render a live list under the pointer:** a download fires `updated` many times a second;
  main coalesces plain progress into one push per `NOTIFY_MS` (state changes still go out at once),
  and both the bubble and the page compare a per-row "shape" (`id|state|paused|stalled|deleted|icon`)
  — same shape means the status text and bar width are patched in place, so a button is never torn
  out mid-click. Rebuilding on every tick was why buttons needed two or three clicks.
  **Two bubbles, as in Chrome:** a download starting (and each one finishing) pops open the COMPACT
  one — rows only, no title, no footer — which dismisses itself after 5s (`BUBBLE_MS`,
  `popup.open(..., {partial:true})`); clicking the toolbar button gives the FULL one (title, newest 5,
  "Full download history"), and that one is never auto-dismissed (`autoCloseDownloads` ignores a
  non-partial bubble), nor is a bubble the mouse is inside. The compact view shows what is running
  plus anything finished in the last minute (max 3). Once it hides, the toolbar ring is what keeps
  showing progress. A self-opened bubble never replaces a popup the user already has open.
  Structure test: `verify-downloads.js`.
- **Version row**: Settings → Privacy ends with "Version", read from `package.json` (`settingsSnapshot().version`;
  bump it there only). Not `app.getVersion()`, which reports Electron's version when run as a script.
- **Password-manager UI** (bottom of `preloads/tab-preload.js`): save prompt, autofill dropdown on
  click/typing. No silent pre-fill (untrusted sites). All `vault:*` IPC re-derives the origin from
  the sender's real URL in the main process; a typed credential crosses a navigation only via an
  in-memory 60s stash in main. `window.vaultAPI` is still exposed to page scripts (pre-existing).
- **Chrome UI (standing rule: copy Chrome; check what Chrome does first, ask the user if unsure).**
  Frameless window (`titleBarStyle: hidden` + `titleBarOverlay`, recoloured by `electron/theme.js`),
  40px tab strip + 40px toolbar + optional 32px bookmarks bar (`chromeHeight()` in tabManager; keep
  in sync with `renderer/shell/shell.css`). Light and dark palettes in `renderer/common/theme.css`
  follow the Windows app mode (`prefers-color-scheme`). Tab strip: tab-search chevron, favicon/
  spinner, close on hover, drag-reorder, middle-click close, right-click menu (new tab to right,
  reload, duplicate, close others/right). Omnibox: site-info icon (secure/"Not secure"), short
  address when unfocused, select-all on focus, star inside. Reload becomes Stop while loading.
  Toolbar: downloads button (always shown), ⋮ menu. No History page anywhere. **Ctrl+Shift+T
  (reopen closed tab) exists by the user's decision** and is the one deliberate exception to "keep
  nothing about visited pages": `closedTabsHistory` in tabManager is a plain in-memory array (last 20
  http/https URLs, each tab's slot index and its sessionStorage — see "Reopen closed tab brings the
  LOGIN back"), never written to disk, and gone when the browser
  closes. It must stay in memory only and must never feed a "recently closed" list or any UI.
  **KEYBOARD FOCUS FOLLOWS EVERY TAB SWITCH** (`switchTab` ends with `focusActivePageUnlessShell()`, and
  `createTab` repeats it once the load has started). Without it, after ANY switch that started from a
  focused page or a popup — Ctrl+Shift+O, Ctrl+Shift+J, Ctrl+Tab, Ctrl+1..9, the ⋮ menu, tab search, closing
  the active tab, Ctrl+Shift+T — focus sat on the old page at 5ms and was NOBODY by 100ms: `switchTab`
  only ATTACHED the new view, and ~300ms later the old view (still holding focus) was detached. Every
  later shortcut then reached no `before-input-event` handler until a mouse click gave focus back —
  "the shortcut does nothing, opening it from the menu works", "Ctrl+W works once", "one Ctrl+Shift+T
  works, then nothing". These all had ONE cause, which is why fixing them one call site at a time
  (first Ctrl+W, then Ctrl+Shift+T) was not enough. **The rule:** the active page takes focus unless
  the SHELL already has it (typing in the address bar, or just clicked the tab strip) — never steal
  that. **Trap:** a brand-new view ignores `focus()` until its first load has started, and `createTab`
  calls `switchTab` BEFORE `load()`, so the focus given inside `switchTab` is lost for new tabs;
  `createTab` therefore repeats it after `load()` (measured: Ctrl+Shift+O, Ctrl+Shift+J and ⋮ → Settings stayed
  dead with only the first). Closing a BACKGROUND tab does not switch, so it moves no focus. After a
  close the tab to the right takes over, or the left one when the last tab was closed (Chrome).
  `verify-tabs.js` "[reopen]", "[ctrl+w]", "[focus]" and "[flow]" send each keystroke ONLY to the
  webContents that holds focus, like the OS, so lost focus shows up as a lost keystroke; "[flow]" is
  the reported sequence (close down to one tab, restore them all, then open our pages by shortcut).
  **Test traps:** (1) these checks need the window to stay OS-active, so they fail wholesale if the PC
  is used while they run — the helpers print a `[diag]` line with the window's OS-active state when
  nobody holds focus; (2) the suite's time limit has to fit it (now 360s). **Not measured:** whether
  Chrome puts the cursor in the omnibox rather than the page when a close lands on a New Tab page —
  `scripts/chrome-reference/capture-keys.ps1` drives a real Chrome to find out, but it refuses to send
  keys unless the machine is idle (it must never fire Ctrl+W into a user's own windows), so run it
  when nobody is using the PC.
  Bookmarks bar toggle (Ctrl+Shift+B) persists in
  `settings.json`. Closing the last tab closes the window and quits (Chrome behaviour). Zoom chip
  in the omnibox when zoom is not 100%.
- **Settings page** (`renderer/settings/`, address `pbcalc://settings`, ⋮ → Settings): Appearance
  Mode (Device / Light / Dark → `nativeTheme.themeSource`, saved as `themeMode` in `settings.json`)
  and the bookmarks-bar switch. `window.settingsAPI` is exposed by `tab-preload.js` only on that
  file, and `settings:get/set` re-check the sender URL in main.
- **Popups** (`electron/popup.js`, `renderer/popup/`, `preloads/popup-preload.js`): tab search
  (Ctrl+Shift+A), ⋮ menu, downloads (toolbar button; auto-opens 5s when a download starts), site info, and
  the find bubble (Ctrl+F). They are a transparent BrowserView stacked above the page view (an HTML
  dropdown inside the shell would be hidden under it). Modal ones cover the window with a backdrop
  so outside clicks close them; the find bubble is only its own small rect so the page stays
  clickable. Created on open, destroyed on close. `popup:open` is accepted from the shell only,
  `popup:action` from the popup only.
- **New tab page** (`renderer/newtab/`): local page (logo + search box), no tiles, no history.
  Address bar shows empty for it.
- **Browser essentials** (`tabManager.js`, `shortcuts.js`, `contextMenu.js`, `pages/errorPage.js`):
  - Shortcuts live in one `before-input-event` handler attached to the shell, every tab and popups (Ctrl+T/W/L/R/F/D/P/J/Tab/1-9, Ctrl+Shift+A/B/I, Alt+←/→, F5, F11, F12, Ctrl+=/−/0).
  - Right-click menu (link/image/edit/page items, Inspect). Middle-/Ctrl-click links open background tabs.
  - Load failures, cert errors and renderer crashes render an in-memory `data:` error page; its buttons are `pbcalc://retry|proceed`, honoured in `will-navigate` only while that tab is showing an error page. "Proceed anyway" is per host, memory only.
  - Address-bar text → URL or search follows Chrome (`electron/urlInput.js`, mirrored by hand in `renderer/newtab/newtab.js`): `localhost:4200`, IPs and `host:port` / single-word `pb/` load over http, `name.tld` over https, everything else is a Google search. All `loadURL` calls in tabManager go through `load()` (swallows the rejection; the error page is shown by `did-fail-load`).
  - `mailto:`/`tel:`/`sms:` go to the OS after a confirm dialog; any other external scheme is dropped.
  - Never pass `findNext:false` to `findInPage` (first search returns nothing). Zoom is per tab.
- **Restricted Mode** (`electron/restricted.js`, `renderer/restricted/`, Settings → Restricted Mode):
  an admin-locked mode. The preset sites are simply the bookmarks. Users can open/close those and
  nothing else: no address bar (hidden and non-interactive, URL never sent to the shell), no
  menu/tab search/site info/star, bookmarks read-only, no devtools, no external
  apps, only whitelisted shortcuts (`RESTRICTED_OK` in shortcuts.js), page right-click without link
  or Inspect items. It opens on a local "Your sites" tile page.
  - Enforcement is in the main process, not just hidden buttons: `createTab` refuses anything
    without `opts.allowRestricted`; `navigate`, IPC `tabs:new` (with a URL), popup kinds/actions, bookmark
    edits and settings are guarded; each tab is confined to its bookmark's site (`tab.site`,
    same host or same registrable domain, see `siteOf`): `will-navigate`/`will-redirect` block
    main-frame moves elsewhere, `setWindowOpenHandler` allows same-site popups only. Sub-resources
    and iframes are untouched. A bounced first load shows a "blocked" page without any address.
  - **No PIN** (the user removed it). Who can leave Restricted Mode is whoever knows the hidden
    shortcut, so the lock is only as private as that; it is application-level, not OS security.
    Restricted Mode itself is per session. Saved setting: **Default Start Restricted**
    (`settings.json` → `restricted.startRestricted`, Settings → Restricted Mode card, normal mode
    only): when on, every launch starts restricted even if an admin left it last session; ignored
    when there are no bookmarks (nothing to allow). Old PIN-era files with `enabled:true` are
    treated as the switch being on. "Turn on Restricted Mode now" (Settings) needs ≥1 bookmark and
    drops all tabs.
  - The + button and Ctrl+T stay, but only open another "Your sites" tiles tab, never an address.
  - Ordinary settings stay: the ⋮ menu (New tab, Downloads, Zoom, Print, Find, Settings, Exit) and
    the Settings page (Mode Device/Light/Dark) work in Restricted Mode. Hidden there: bookmark
    entries, bookmark manager, developer tools and the whole Restricted Mode card
    (`data.restricted` in popup.js, `restricted` from `settings:get`).
    **Showing/hiding the bookmarks bar IS allowed** (Ctrl+Shift+B, the ⋮ entry and the Settings
    switch): it changes no bookmark and reveals no address. The rule is edit vs. view. It was
    blocked in FOUR places, and all of them had to go: `RESTRICTED_OK`, `RESTRICTED_ACTIONS` plus
    the menu entry, the `bar-row` in settings.js, the `state.restricted` guard inside
    `toggleBookmarksBar()` — and, the one that made it look broken even after the rest, the
    `|| state.restricted` in `chromeHeight()` and `getTabState()`, which forced the bar visible no
    matter what the flag said. When testing this, assert the SHELL element `#bookmark-bar` and the
    page view's top edge (112 with the bar, 80 without): the flag alone proves nothing.
    Hidden in Restricted Mode instead: the **Address bar card** (Google suggestions) — there is no
    address bar to type in there.
  - The lock icon in the toolbar is only an indicator ("Restricted Mode is on"); clicking does
    nothing. **The admin panel opens only through the hidden shortcut** (IPC `popup:open` refuses it).
  - **Hidden admin shortcut:** press Ctrl+Shift, then type `pbsecure` (within 12s; modifiers may be
    released; a wrong key cancels; its letters are swallowed while in progress) →
    normal mode: turns Restricted Mode ON for the session (opens Settings if there are no bookmarks yet);
    restricted: opens the admin panel with two buttons, "Manage sites" and "Leave Restricted Mode",
    no PIN. Lives in `secretSequence()` in shortcuts.js, runs before every other shortcut.
  - **Bookmark manager** (`renderer/manager/`, `pbcalc://bookmarks`, ⋮ menu, Ctrl+Shift+O):
    add / edit / delete / reorder the preset list. Normal mode: open. Restricted: only via the admin
    panel's "Manage sites" button → `tabManager.openManager(true)` sets `state.adminTabId`; the
    `manager:*` IPC checks the sender is exactly that tab; closing it ends the session.
  - Not done yet: extra allowed domains per site (SSO / login on another domain is blocked).
- **Tab strip = measured Chrome 153, not guessed.** Geometry and colours were pixel-sampled from a
  real Chrome window (light + dark; method and numbers in `scripts/chrome-reference/README.md`):
  slot pitch 238 (body = slot - 6), inactive pill y6..34 radius 10, active body runs into the toolbar
  with radius-12 flares, separators 2x16, search button 28px radius-8 square, + is a 28px circle,
  hover fills A8C7FA (light) / 004A77 (dark), frame D3E3FD / 1F2020, toolbar FFFFFF / 3C3C3C.
  Address bar (also measured): fill EDF2FA / 282828, hover E1E6ED / unchanged in dark, focused =
  toolbar fill + 2px ring 0B57D0 / A8C7FA. Known difference left alone: Chrome's toolbar is 46px tall
  with a 34px-tall address bar (PBCalc: 40 / 32); changing it touches every chrome-height constant.
  Tabs shrink like Chrome: the inactive close X only when the body is >= 84px, titles fade out, the
  active tab squeezes its favicon out before its X (all with `cqw` units on `.tab`). **The container
  (`container-type`) must stay on `.tab` itself**: on a descendant it made real OS clicks on the tab's
  buttons fall into the window-drag region. A page without a `<title>` shows its address as the tab
  title (as Chrome does; never in Restricted Mode). `verify-ui.js` asserts all of it against the
  reference numbers (`scripts/chrome-reference/measure.js`).
- **Address-bar suggestions** (`electron/omnibox.js`, `renderer/omnibox/`, `preloads/omnibox-preload.js`):
  typing shows Chrome's dropdown — the typed text first (as a Google search, or as an "open" row
  when it looks like an address), then matching **bookmarks**, matching **open tabs** ("Switch to
  this tab"), then **Google's suggestions** (`suggestqueries.google.com`, request sent without
  cookies, nothing stored, stale answers aborted/dropped). **No history rows exist** (Chrome's
  "visited pages" rows can't). ↑/↓ fill the bar with the highlighted row (↑ above the first gives the
  typed text back), Enter opens it, click opens it, Esc / leaving the bar closes it. It is a
  transparent BrowserView that is NEVER focused (typing stays in the shell's input) and is preloaded
  when the bar is focused. Settings → Address bar has a switch to stop asking Google
  (`searchSuggestions` in settings.json); bookmarks/tabs still suggest. Restricted Mode: nothing.
  `PBCALC_SUGGEST_URL` overrides the endpoint (tests). Test it alone with
  `scripts/verify-suggestions.js` (add `PBCALC_LIVE=1` to print what the real Google returns).
- **The tab strip is PATCHED, never rebuilt** (`renderTabs` in `renderer/shell/shell.js`): one element
  per tab for its whole life, with only the changed bits touched (title text, favicon, active class,
  flex `order` for position). Rebuilding it on every push (title, favicon, loading, navigation) was
  why favicons kept vanishing — a re-created `<img>` starts blank and re-decodes — and it also made
  CSS transitions impossible. Handlers close over the tab **id**, never over a tab object.
- **Tab animations are measured, not guessed** (`scripts/chrome-reference/capture-anim.ps1` and
  `capture-close.ps1`, numbers in that folder's README): open and close are **200ms ease-out**
  (a new tab animates flex-basis/min-width from 0; a closed one keeps its slot and shrinks away,
  `collapseAway`), the hover fill fades **in 175ms ease-out / out 185ms ease-in**, and — measured —
  **Chrome does not re-widen the other tabs while the pointer is still in the strip**: it waits for
  the pointer to leave, pauses ~330ms, then expands (`lockTabWidths` / `TAB_RELAYOUT_DELAY_MS`).
  Re-measure with those scripts before changing any of these numbers. Test: `scripts/verify-tabs.js`.
  **Three flexbox traps, all found by frame-by-frame measurement** (`--n` is the row's width budget,
  and a tab's rendered width comes from flex-SHRINK, not from its basis):
  1. `--n` must count the tab that is still shrinking away (`sizeStrip()` adds the `.closing`
     ghosts). Dropping it the moment a tab closed made the row narrower than its contents and every
     remaining tab was squeezed (225 -> 190px in one frame) before growing back. Chrome never
     squeezes.
  2. Freezing widths must be instant: write `flex-basis` with `transition: none`, flush, then
     restore. Otherwise the basis animates from the stylesheet's 238px and every tab jumps to full
     width and slides back. Freezing also needs `flex-shrink: 0`, and the widths must be MEASURED
     FIRST and written after (measuring and writing in one loop yields a staircase: 113, 81, 59...).
  3. Un-freezing has to animate explicitly (FLIP: measure where they land, put them back, animate):
     clearing the inline width only SNAPS, because a compressed tab's size never came from its
     basis. That pin must be dropped the instant anything else changes the strip
     (`clearWidthFlip()`), or tabs opened during those 240ms keep stale widths — it showed up as tab
     pitches lagging one step behind in `verify-ui`.
- **Duplicate tab** (`duplicateTab`, async) copies three things, like Chrome, and the copy opens
  immediately to the right of the original:
  1. the address;
  2. the whole back/forward list (`createTab(url, {restore})` -> `navigationHistory.restore`);
  3. **the tab's `sessionStorage`** (`{sessionRestore}`). Cookies and localStorage are shared by every
     tab already, but sessionStorage belongs to the tab, so a site that keeps its login there — the
     PB ERP does — showed the LOGIN page in the copy without this. Same approach as the sibling ERP
     shell: main snapshots it, stashes it in `state.pendingSessionRestore` keyed by the new view's
     `webContents.id`, the view is created with `additionalArguments: ["--pbcalc-restore-session"]`,
     and only a view carrying that flag asks (`tabs:session-restore`, sendSync in `tab-preload.js`)
     before any page script runs. Main serves it **once**, only to that webContents and only when the
     page's origin matches the source tab's. **`e.returnValue` may be assigned only once** — Electron
     sends the reply on the first assignment, so an early `e.returnValue = null` silently wins.
  Available in **both modes**: in Restricted Mode the copy inherits the source tab's `site`, so it
  stays confined to the same bookmark, and the tab right-click menu there is Duplicate + Close.
- **Reopen closed tab brings the LOGIN back (sessionStorage), like Chrome.** The PB ERP
  (mfg.pb.diamonds) keeps its login in `sessionStorage` (the sibling ERP shell reads
  `fxCredentials` there), which belongs to the TAB and died with its `webContents`; the closed-tab
  list only remembered the URL, so Ctrl+Shift+T showed the login page. Cookies/localStorage were never
  lost (every tab shares one in-memory session — a cookie login survived in the repro). Now `closeTab`
  removes the tab from the strip at once but lets its PAGE linger a few ms: it reads the tab's
  `sessionStorage` (`snapshotSessionStorage`, async, so the page must outlive the call) into the
  closed-tab entry (`entry.session`, `packSessionStorage`), and only then destroys the page and its
  child window (`destroyPage`). `reopenClosedTab` waits for that snapshot (`entry.pending`) and hands
  it to `createTab({sessionRestore})` — the same mechanism Duplicate uses. Rules that matter:
  the snapshot has a 400ms timeout (`SESSION_SNAPSHOT_MS`) so a HUNG page still gets destroyed (tested
  with a page that spins forever); only tabs that go into the restore list are snapshotted (internal
  pages and blanks are destroyed immediately); anything over 512KB is dropped (`SESSION_SNAPSHOT_MAX_BYTES`,
  the list lives in RAM); the entry is taken from the list synchronously and restores are chained
  (`reopenChain`), so quick Ctrl+Shift+T presses stay LIFO and each tab keeps its OWN login; the data is
  served once, only to that tab and only for its origin, so a later reload or another tab on the same
  site does not inherit it. It stays in memory only and is gone when the browser closes — which is
  the rule: closing a tab clears nothing, closing the BROWSER clears everything (`privacy.js`).
  Test: `verify-tabs.js` "[restore]".
- **"Download started" animation, like Chrome** (`electron/dlanimation.js`, `renderer/dlanim/`). With no
  Save As dialog and no progress anywhere, nothing told you a download had begun. Chrome flies a circled
  download arrow from the page up to the toolbar Downloads button. **Measured from a real Chrome, not
  guessed** (`scripts/chrome-reference/capture-dlanim.ps1`, numbers in that folder's README): 64px circle,
  centred on the button's column, starting ~46.5% of the way down the page, rising ~500ms, opacity ramping
  0 -> 0.93 then fading out; light = pale blue circle + blue glyph, dark = grey circle + white glyph. It plays
  for EVERY download here because PBCalc's Downloads button is always present (Chrome plays it only once the
  button exists; a first download in a clean profile just fades the button in). Mechanics: the shell sits
  UNDER the page views, so the animation is a small transparent `BrowserView` (like the hover card) kept
  warm after startup (`warm()`, 2s after the window opens; `play()` builds it on demand if a download comes
  sooner), attached to the window only for the flight (~640ms) and then taken off. It is positioned from
  the Downloads button's REAL rectangle (read from the shell DOM; the toolbar is flexbox, not constants) and
  driven by Web Animations keyframes (`dlanim.js`: the measured table, as fractions of the path so it scales
  with the window). Triggered from `downloadManager`'s `will-download` at the moment the download really
  starts (at once; after the Save As answer in "ask" mode), via `playFor(initiator)`: it plays for the
  tab you are looking at, or a tab opened just for the download (which closes itself); NOT for a background
  tab, not for a download the app itself starts (no initiator, e.g. Retry), not in full screen or when
  minimised. A second download restarts the flight (never two overlays). **Known limit:** an Electron view
  cannot be click-through, so a click in that 80px column during the half second goes to the overlay;
  Chrome's is click-through. **Gotchas:** `capturePage` returns PREMULTIPLIED colour (at 93% opacity every
  channel reads 7% darker — un-premultiply before comparing); capturing a view that is not attached never
  resolves, so tests must read it while the flight is on. Test: `scripts/verify-dlanim.js` (renders the
  circle at t=134/220/300ms in both themes and checks position, opacity, size and fill against the
  measurements, plus the when-not-to-play rules).
- **A page that ends itself takes its tab with it, like Chrome** (`closePageEndedTab`, `wc.once("destroyed")` in
  `wireTabEvents`). An OAuth / sign-in popup (ChatGPT, Google) calls `window.close()` when it is done; Chromium
  destroys its webContents, but the popup is wrapped as a TAB (`did-create-window`) and nothing told the strip, so the
  tab stayed as the ACTIVE tab with no page ("New Tab", spinner) and the next reload / shortcut threw
  "Cannot read properties of undefined (reading 'isDestroyed')" in the main process (an error dialog). Reproduced
  with a local page whose popup closes itself, then fixed: the tab is removed, you return to the tab that opened it
  (only if you were on the popup; if you moved on you are left alone), it is NOT offered by Ctrl+Shift+T, and
  `view.webContents` may be `undefined` after this - `closeTab`, `activeWebContents` and `reload` tolerate that.
  Our own `closeTab` takes the tab out of `state.tabs` BEFORE destroying its page, so the handler only ever fires for
  pages that ended themselves. Test: `scripts/verify-popup-close.js` (11; fails without the handler).
- **A tab opened only to start a download closes itself, like Chrome** (`closeTabOpenedForDownload`,
  called from `downloadManager`'s `will-download` with the initiating webContents). A site's Download
  button often does `window.open(url)` / `target=_blank` / a redirect that ends in a file; Chrome flashes
  the new tab and closes it, the download carries on, and you are back on your page. PBCalc left a
  blank tab behind. **The line it draws, measured** (`scripts/chrome-reference/README.md`): at
  `will-download` such a tab has `wc.getURL() === ""` (nothing ever committed — it never showed a page),
  whereas a same-tab link's download has the page's own URL. Only the first kind closes; a tab showing
  a page stays, a `window.open` to a real page stays, and the LAST tab is never closed (it would quit
  the app). It returns to the tab that opened it (`tab.openerId`, set in `did-create-window`) rather
  than to whichever tab is last in the strip, but only if the user is still on the download tab. The
  download is not cancelled by closing its tab (a slow one finishes in full). With "Ask where to save
  each file" the close waits until the Save As dialog is answered or dismissed, because that dialog
  hangs off the tab's window. The blank tab never enters the Ctrl+Shift+T list. Test:
  `scripts/verify-download-tab.js` (also keeps its files out of the real Downloads folder — a probe
  that did not left files there).
- **Our own pages have their own tab icon**, not the default globe: magnifier (New Tab), gear
  (Settings), bookmark (Bookmark manager), download arrow (Downloads), grid ("Your sites").
  Built in the MAIN process (`internalFaviconFor` / `svgIcon` in tabManager) and set in
  `did-navigate`, **not** declared as a `<link rel="icon">` in the page: the glyph has to follow the
  Windows app mode, and a `prefers-color-scheme` rule inside an SVG favicon is ignored by Chromium
  (measured — the ink came out the same grey in both modes). `nativeTheme`'s "updated" event
  redraws them (`refreshInternalFavicons`). Because main owns `tab.favicon`, the tab strip, the
  hover card and tab search all get it for free.
- **No tab limit, Chrome-style compression.** Chrome never refuses a new tab; it shrinks them
  (measured from a real 82-tab window: inactive pitch **18px**, active body **32px**, and the strip
  does NOT scroll). `MAX_TABS` is therefore no longer a UI limit (it was 30, which simply stopped
  Ctrl+T working) — it is a safety ceiling of 150 against a runaway `window.open`. The strip matches
  Chrome with `min-width: 18px` on `.tab`, `34px` on `.tab.active`, and a
  `@container tab (max-width: 40px)` rule that drops the body insets to 1px, centres the favicon and
  hides title/X. **Spell both `.tab:not(.active) .tab-icon` and `.tab.active .tab-icon` out there**:
  a bare `.tab-icon` loses on specificity however late it appears, and the icon stays left-aligned.
- **Narrow-tab look**, in three bands (all measured, see `scripts/chrome-reference/README.md`):
  `@container tab (max-width: 40px)` drops the separators, the title and the inactive X and centres
  the favicon; `(max-width: 48px)` drops the ACTIVE tab's favicon and keeps its close X (Chrome ref
  table at pitch 47/39, confirmed by an ink map at 37px and 28px); `(max-width: 35px)`, i.e. the
  active tab at its floor, puts the favicon back and reveals the X **on hover** (the user's own
  82-tab window). The last two blocks have equal specificity, so **source order decides** — keep
  the 35px block after the 48px one. In both narrow bands the close button must stay Chrome's
  **16x16 circle** (`left: 50%; width: 16px; margin-left: -8px`) — stretching it across the body
  (`left:1;right:1;width:auto`) turned its hover highlight into a 39x16 ellipse. A clean Chrome profile here disagrees about the floor band and
  about separators at 15px; the real-world window wins and the README records the conflict.
- **`growIn` must not depend on rAF alone**: requestAnimationFrame does not fire while the window is
  occluded, and a new tab pinned at `flex-basis: 0` then stays invisible (seen as width-0 tabs in a
  background window). It releases on a 300ms timeout as well.
- **The window opens MAXIMIZED** (`mainWindow.maximize()` in `ready-to-show`, before `show()` so it
  never flashes small first); 1400x900 stays as the restore size. Two consequences: the first tab's
  view is positioned while the content size is still settling, so `resizeActiveView` is re-applied
  on the next tick and again 150ms later (without it the page sat 2px short of the bottom), and
  **`setPosition`/`setSize` are no-ops on a maximized window** — any test that moves or resizes the
  window must `unmaximize()` first (`verify-ui.js` and `verify-download-flow.js` do).
- **A held shortcut is ONE action.** Windows repeats a held key ~30x/s and Chromium flags each repeat
  with the `isAutoRepeat` modifier. Holding Ctrl+T used to open ~30 tabs and Ctrl+W to close them all.
  `claim()` in shortcuts.js now drops auto-repeats for everything in `NO_AUTO_REPEAT` (new tab, close
  tab, find, downloads, print, devtools, bookmark, bookmarks bar, tab search, fullscreen, address
  bar) while zoom / tab cycling / back / forward still repeat, as in Chrome. In tests, send a repeat
  as `modifiers: [..., "isAutoRepeat"]` — there is no `isAutoRepeat` field on `sendInputEvent`.
- **A reload keeps the tab's icon and title.** `did-navigate` fires for a reload too, and clearing
  them there left the tab iconless (a reload re-uses the cached favicon, so `page-favicon-updated`
  often never fires again) and, on a local page with no fresh title event, showed the FILE PATH as
  the title. `did-navigate` now only resets them when the address actually changed, the favicon only
  when the ORIGIN changed (Chrome keeps a site's icon while you move around inside it), and our own
  local pages get their proper name from `internalTitleFor()` instead of a path.
- **Tab hover (Chrome look):** a hovered inactive tab gets a rounded highlight (`.tab-bg`, colour
  `--tab-hover`) and, after 500ms (instant when moving between tabs), Chrome's hover card: title,
  site name, page preview. No native `title` tooltip on tabs. The card is a transparent BrowserView
  sized to the card (`electron/hovercard.js`, `renderer/hovercard/`, receive-only
  `hovercard-preload.js`), shown/hidden by IPC `hovercard:show|hide` from the shell only, hidden
  on leave / click / drag / tab switch / popup / resize (resize hides a tick later, never inside
  the resize emit), destroyed after 30s idle. Previews are in-memory JPEGs on the tab
  (`captureThumb` in tabManager, taken when a tab is switched away from; the old view is detached
  only after the picture is taken or 300ms) — never on disk. **The ACTIVE tab's card has no preview**
  (Chrome: that page is already on screen right below the card), so it uses the short card height.
  **No site name in Restricted Mode.**
- **Settings page stays live:** anything that changes a setting from elsewhere (Ctrl+Shift+B, the ⋮
  menu, theme, Restricted Mode on/off) calls `tabManager.broadcastSettings()`, which pushes
  `settings:changed` to every open settings tab (`settingsAPI.onChanged`), so a switch never shows a
  stale value. Add a call there when you add a new setting that can change outside the page.
- **Popup vs window resize gotcha:** never destroy a popup view synchronously from the window's
  own `resize` event (fullscreen / maximize / drag-resize) — Electron's per-view autoResize listener
  still runs afterwards and throws "#autoResize called without owner window" (an error dialog).
  `popup.reposition()` defers the close with `setImmediate`; the fullscreen action closes first.
- **Native-menu hover gotcha:** a native context menu takes the mouse away from Chromium, so the
  renderer never sees the pointer leave and CSS `:hover` stays stuck on the element that was
  right-clicked. It showed up as the ORIGINAL tab keeping its blue hover fill after
  right-click → Duplicate (it is not even the active tab any more). The shell therefore calls
  `suppressHover()` whenever it opens a native menu: `body.no-hover` neutralises the hover styling
  until a real `mousemove` arrives, which is the first moment `:hover` can be trusted again. Do the
  same for any new native menu, and hide the hover card there too.
- **Draggable-region gotcha:** the tab strip is `-webkit-app-region: drag`, and every interactive
  descendant must opt out explicitly (`.tab *`). Opting out only on `.tab` left the tab's close X
  dead for real mouse clicks while every synthetic-click test passed. Anything clickable in the
  strip needs `scripts/manual-os-click.sh` (real OS clicks, moves the mouse; do NOT run it while someone is using the computer, their mouse movement makes it fail), not just `sendInputEvent`.
- Self-tests (run any with `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/<file>`):
  `verify.js` (19), `verify-features.js` (36), `verify-downloads.js` (23), `verify-dlanim.js` (41: the download-started flight, rendered and compared with Chrome's measurements), `verify-download-tab.js` (22: a download opened in a new tab closes that tab, a page tab stays), `verify-download-flow.js` (49), `verify-suggestions.js` (19), `verify-browser.js` (68, needs `openssl`; its window is
  off-screen and needs the occlusion-off switches at the top of the file or synthetic mouse input is
  dropped), `verify-theme.js` (8: dark mode never reaches the page), `verify-datadir.js` (13, and 13 more with `BAD=1`: the `%LOCALAPPDATA%\PBCalc` rule, the Roaming fallback and the unwritable-folder warning), `verify-tabs.js` (155: login restored by Ctrl+Shift+T incl. a hung page and quick close/restore order, keyboard focus after every tab switch incl. the close-all / restore-all / open-our-pages flow, Ctrl+W / Ctrl+Shift+T focus and tab slots, tab User-Agent + in-memory session, favicons incl. internal pages and the app icon, many-tab compression and narrow-tab look, light/dark and reload, stale hover after a native menu, animations, Duplicate incl. session + Restricted Mode), `verify-restricted.js` (103 incl. a restart phase), `verify-ui.js` (117, real mouse events + Chrome tab geometry; `PBCALC_SHOTS=<dir>` saves screenshots). `verify-ui.js` is the only flaky one, and only because it uses the real pointer: a stray mouse move shows up as an odd hover colour or a wrong tab pitch, so re-run it before believing a failure.
- **Hover / cursor / contrast audit of every surface, light + dark + Restricted** (`scripts/verify-ui-states.js`,
  40 checks; engine `scripts/audit-ui-states.js`, run it alone for the full per-surface table, env
  `PBCALC_AUDIT_ONLY=<surface text>`, `PBCALC_AUDIT_VERBOSE=<element text>`). It hovers every interactive element with
  synthetic input (the real mouse never moves, safe while the PC is in use) and reports: arrow cursor on something
  clickable, no hover change, hover too faint, hover contrast < 3:1 (or washed out), element unreachable. It starts with a
  **self-test**: a button planted with the wrong cursor and a pale hover under white text MUST be flagged, because this
  auditor twice printed "0 issues" while testing nothing. Coverage minimums per surface fail the run if a surface comes
  back empty. **Found and fixed with it:** `.btn:hover:not(:disabled)` (0,3,0) beat `.btn.primary` (0,2,0), turning every
  primary button pale with white text on hover (Bookmark manager "Add", Settings, admin panel) - primary hover is now
  `--accent-hover`; `#downloads.fresh` (id + class) beat `.icon-btn:hover`; omnibox rows had no hover. **Cursor:** every
  button/link/row now shows the pointer (shared rule at the bottom of `renderer/common/theme.css`; disabled = default;
  the Restricted lock `#unlock` is an indicator and stays default). That is the owner's explicit request and a
  deliberate difference from Chrome's native toolbar, which keeps the arrow. A new button needs no CSS for it, but a new
  `:hover` rule must not lose a specificity fight to a `.primary` rule: run the audit.
- No settings window, no extensions. Not requested yet; do not add speculatively.

## App icon

`assets/icon.svg` is the source of truth — a calculator with the PB diamond on its screen (the
browser is meant to look ordinary; a calculator screen is planned behind it). `scripts/make-icons.js`
renders it to `assets/icon.png` (512, the BrowserWindow / taskbar icon), `assets/icon.ico`
(16/24/32/48/64/128/256, used by `build.win.icon` and the NSIS installer, uninstaller and shortcuts)
and `assets/icon-32.png`, which `tabManager.appIcon()` serves as the **New Tab page's favicon** — in
colour, like a real site icon, while the other internal pages keep their themed grey glyphs. Re-run
that script after editing the SVG. Three traps it already works around: the capture window needs
`useContentSize: true, frame: false` (a framed window yields 496x447, squashed into every .ico
entry), `overflow:hidden` (scrollbars otherwise end up in the icon) and
`transparent: true` + `backgroundColor: "#00000000"` with a transparent page (otherwise the icon
ships on opaque white and the taskbar shows a white box around the rounded square).
`verify-tabs.js` asserts the corner pixel's alpha is 0 in both the PNG and the .ico.

## Packaging / installer

`npm run dist` builds `release/PBCalc Setup 0.1.0.exe` (NSIS, ~93MB; the unpacked app is ~300MB,
which is Electron). Verified after a build: the packaged exe starts maximized, carries the app icon
(the exe's and the installer's embedded icons are pixel-identical to `assets/icon-32.png`), and
creates and uses `%LOCALAPPDATA%\PBCalc` — verified end-to-end on the real exe: the folder fills
while it runs, seeded `settings.json` / `bookmarks.json` there are actually read (window came up
dark with the seeded bookmark while the Windows app mode was LIGHT), and on quit the sweep leaves
exactly the keep-list (`settings.json`, `bookmarks.json`, `password-vault.json`, `Local State`)
with its contents untouched.

**The data folder used to be the install's weak spot**, which is why it is no longer next to the
exe. The installer is `oneClick: false`, so the user may install "for all users"
(`C:\Program Files\PBCalc`) or type any path; a `UserData/` beside the exe then sat somewhere a
standard user cannot write, and PBCalc ran perfectly while silently keeping no passwords, bookmarks
or settings (measured: `vault.saveCredential()` -> false, `settings.set()` swallows the error).
`%LOCALAPPDATA%\PBCalc` is independent of the install path, `resolveDataDir()` falls back to
`%APPDATA%\PBCalc`, and `warnIfDataFolderUnwritable()` in `main.js` still probes the resolved folder
at startup (mkdir + write + unlink) and shows a dialog naming it if even the fallback fails. Test:
`scripts/verify-datadir.js` (writable case) and the same script with `BAD=1` (unwritable case).

**When a window's pixels are the evidence, capture that window, not the screen.** A
`CopyFromScreen(0,0)` grab of the top of the display caught whatever app was in front and "proved"
a dark theme that was never PBCalc's. Bring the window forward and capture its own `GetWindowRect`,
then compare against the measured palette (frame `1F2020`, toolbar `3C3C3C` in dark).

**Leftover debug code is a packaged-only crash.** A stray `T(...)` trace call left in `main.js`
after removing its helper threw `ReferenceError` before the window existed — under `npm start` it
was easy to miss, packaged it is a bare "Error" dialog with no text worth reading. Every self-test
that `require`s `../electron/main.js` (e.g. `verify-datadir.js`) catches it; run one before
`npm run dist` rather than debugging the installed copy.

**When running the packaged exe by hand, clear `ELECTRON_RUN_AS_NODE`** — this environment sets it,
and Electron then runs main.js as plain Node and exits instantly ("bad option: --enable-logging"),
which looks exactly like a broken build.

## Dark mode stops at the browser

`themeMode` (Device / Light / Dark) drives `nativeTheme.themeSource`, which is what makes our own
surfaces dark — and it also tells every web page `prefers-color-scheme: dark`. **Chrome does that
too** (measured with `--force-dark-mode`), but Chrome still paints a page that sets no background
WHITE, while Chromium-in-Electron painted it #3C3C3C: ordinary light sites looked dark-themed.
Every tab view therefore gets `setBackgroundColor("#ffffff")` in `createTab`. Do not "fix" this by
dropping `themeSource` — the page is then told the wrong colour scheme and sites with a real dark
design stop following the browser, which is not what Chrome does. **Re-measured with Chrome's own Appearance
setting (not only `--force-dark-mode`)**, same probe page in every case: normal Chrome window with Mode = Dark
tells pages `dark`; Mode = Light / Device tell `light` (Windows apps mode light); a Chrome **Incognito** window tells
`light` even with Mode = Dark (its UI is dark, the page is not). PBCalc matches the normal window: Mode Dark -> pages
`dark`, Device / Light -> `light`. So a site such as ChatGPT turning dark in PBCalc's Dark mode while it stays light
in an Incognito window is NOT a bug - compare against a normal Chrome window. If the owner ever wants pages to stay
light whatever the browser's mode (Incognito behaviour), that is a deliberate change to `themeSource` handling, not
a fix. Our own pages are unaffected
because each one sets its own background from the palette (`--frame` / `--toolbar`); any NEW
internal page must do the same or it will be white in dark mode. Test: `scripts/verify-theme.js`.

## Notable gotchas

- `contextIsolation: true` / `nodeIntegration: false` on every window, every `BrowserView` —
  keep it that way. `tab-preload.js` in particular runs against untrusted, arbitrary websites, so
  its exposed surface must stay deliberately narrow.
- `app.setPath("userData", ...)` must run before `app.whenReady()` — Electron only honours it
  before the app is ready. It must also run before any other module that might call
  `app.getPath("userData")` at its own module-load time (none currently do; they all call it
  lazily inside functions, which is why require-order elsewhere in the app does not matter).
