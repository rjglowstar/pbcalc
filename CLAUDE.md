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
- **Switch:** `app.commandLine.appendSwitch("disable-gpu-shader-disk-cache")` only. (An earlier version of this note also listed
  `disable-http-cache`; `main.js` does not set it, and measuring shows the page cache works: warm loads re-fetch ~0-120 KB
  where cold loads fetch 4-6 MB. Do not add it: every revisit would download everything again.)
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

### 6. PDFs, files from downloads, and being a Windows "default browser"

- **A PDF opened as a page needs a PERSISTENT session** (`TAB_PARTITION = "persist:pbcalc"`). Chromium's built-in PDF
  viewer starts but paints NOTHING in an in-memory (off-the-record) session - an empty dark page. Measured with the same
  PDF in four setups: default session and `persist:` partition draw it (184 distinct colours); every in-memory
  partition, with or without PBCalc's preload and with or without `plugins:true`, stays at 9. Pages that draw PDFs
  themselves (smallpdf's editor) never needed it. **The owner chose this trade-off**: while PBCalc runs, cookies and cache
  are on disk; they are deleted when it quits (the detached cleanup helper deletes everything not on the KEEP list) and
  again at the next start (the startup sweep, for a crash or forced kill). Proven end to end with a real window close and
  with a simulated crash (~1 MB of session files while running -> only the KEEP files after close; ~2 MB left by a
  crash -> an empty fresh folder at the next start). Do NOT go back to an in-memory partition without another way to
  draw PDFs.
- **Clicking a finished download opens PDFs, images and text files in a PBCalc tab** (`downloadManager.open` ->
  `tabManager.openLocalFile`; the list, the bubble and the Downloads page all use it). Windows' default app opened them
  before - for the owner that is Chrome. Types: pdf png jpg jpeg gif webp bmp ico avif txt log json. NOT: html / htm / svg
  (a local page would run scripts), csv / md (Chromium turns them into a download again), anything else - those still
  go to Windows. **Restricted Mode opens them in a tab too** (owner's decision: files open there like in normal mode;
  `openLocalFile` passes `allowRestricted`; such a tab has no `site`, so `blockIfOutside` refuses every later move away
  from the file). The type lists live in ONE place, `electron/fileTypes.js` (`IN_TAB` = pdf/images/text, `FROM_USER` =
  those + html/htm/xhtml/svg, `kindOf(ext)`); the Downloads list, `externalOpen.js`, drops and the registry all use it.
  Test: `scripts/verify-open-downloads.js`.
- **Files dragged in from Explorer open in a NEW tab, in both modes** (`electron/dropFiles.js`, the drag/drop block at the
  end of `shell-preload.js` and `tab-preload.js`, IPC `files:dropped`). Before this a drop on the tab strip / toolbar
  showed the "not allowed" cursor and one on a page made Chromium navigate that page to the file. The preload takes only a
  TRUSTED, not-yet-handled drop carrying files (`webUtils.getPathForFile`; a file a page invents has no path), so a page's
  own upload box keeps its drops; main accepts the paths only from the shell or a tab page, absolute, an existing FILE of a
  `FROM_USER` type, at most 10. **Deliberate difference from Chrome:** Chrome replaces the page for a drop on the page area,
  PBCalc opens a new tab (safer: never loses the page you are on) - **except when the tab you are looking at is an empty New Tab page: the file then
  takes THAT tab's place** (no blank tab left behind; `openDropped` in dropFiles.js; several files: the first replaces it, the rest follow in order;
  not in Restricted Mode, where that page is the "Your sites" list). Test: `scripts/verify-drop-blank.js` (13). The empty gap in the tab strip is an OS drag
  region (`-webkit-app-region: drag`) and cannot receive drops. **Trap:** the tab's own `drop` handler (drag-reorder)
  used to `preventDefault()` unconditionally, so the preload ignored every file dropped on a tab; it now does nothing unless
  a tab is being dragged. Test: `scripts/verify-drop-files.js` (19; real trusted drags via CDP `Input.dispatchDragEvent`
  with file paths - a genuine mouse drag from Explorer is NOT driven, check it by hand). Its "cannot navigate away" check
  uses a page-initiated `location.href`: a main-process `loadURL` never fires `will-navigate` and proves nothing.
  **Tab-strip drag UI, Chrome-style** (`scripts/verify-drop-ui.js`, 27 checks; from the owner's Chrome screenshots: drop arrow
  + "Copy", while PBCalc showed the "not allowed" sign). ROOT CAUSE, measured with `WM_NCHITTEST` against the real window: the
  empty strip is `-webkit-app-region: drag` = HTCAPTION (2) and Windows refuses an OLE drop on the caption (tabs, the + button
  and the toolbar are CLIENT = 1). Fix: while a file drag is over the window, `body.file-drag` makes `.strip` no-drag. It is
  switched on by the shell's own `dragenter/over` and by the tab pages through main (`files:drag-state`, repeated every 200ms),
  and off by `dragleave` out of the window, `drop`, `dragend`, or **a 700ms silence watchdog** (a drag that ends without any
  event - Esc, released elsewhere - must never leave the strip un-draggable; CDP's `dragCancel` sends no dragleave).
  **Limit:** a drag entering straight onto the empty strip from outside the window is still refused until the pointer has
  touched a client area first (the OS sees the caption before our page knows a drag exists). Over the strip a Chrome-style
  arrow (`#drop-arrow`) marks the slot (between two tabs / after the last), and the file opens as a NEW tab AT that slot
  (`files:dropped` carries `at`, written to `<html data-drop-index>` by the shell at the moment of the drop); toolbar / page
  drops append. The owner chose "always a new tab" over Chrome's replace-the-tab/page. **Traps:** the arrow is an UNFILLED 12px line arrow measured from Chrome (tip y=45, grey #D2D2D2 in dark; the light colour #474747 is assumed); an `<svg>` has no `hidden`
  property (the arrow was always visible; use the `.show` class); test points on the strip must be re-measured after every tab
  opens (9 tabs leave no empty strip, and the point lands on the window buttons, hit-test 9); send each `dragOver` twice.
- **Per-type file icons** (Explorer shows them once PBCalc is the default app for a type, like Chrome's page + logo +
  label): `scripts/make-file-icons.js` renders `assets/file-icons/{pdf,html,image,text}.ico` (page, PBCalc logo, coloured
  PDF / HTML / IMAGE / TEXT band; re-run after changing the logo). They ship OUTSIDE the asar as
  `<install>\resources\file-icons\*.ico` (`build.extraResources`; verified in `release/win-unpacked/resources/file-icons`),
  because Explorer reads an icon from a real file. Registry layout 3 (`REG_VERSION "3"`): extra ProgIds `PBCalcIMG` /
  `PBCalcTXT`, every extension in `defaultBrowser.EXTENSIONS` listed under the ProgId of its `kindOf`, each ProgId's
  `DefaultIcon` = its .ico (falls back to `exe,0` when the file is missing); installed copies re-register at next start;
  `installer/installer.nsh` removes the new ProgIds on uninstall. **Not verifiable from here:** how Explorer draws them (icon
  cache) - the owner looks. A type whose default is another app keeps THAT app's icon: PBCalc's only apply to types the
  user set to PBCalc. **Update (layout 4):** a fifth icon `svg.ico` (orange "SVG" band) and ProgId `PBCalcSVG` - ONLY `.pdf` and
  `.svg` have an icon of their own (owner's decision; other images keep the shared IMAGE one), `REG_VERSION "4"`.
  **Trap, measured in the registry:** the icon applies only when the file type's ProgId is one of OURS. Choosing PBCalc via
  file Properties > Opens with > Change makes Windows create `HKCU\Classes\pdf_auto_file` (command only, no icon) and
  Explorer then shows the exe's calculator; choosing it in Settings > Default apps uses `PBCalcPDF` and its icon.
  **Fixed in code (`repairOpenWithIcons`, run at every start of the installed copy):** for each listed extension it looks at
  the ProgIds the type resolves to (UserChoice, `.ext` default, OpenWithProgids); a non-PBCalc ProgId whose open command is
  PBCalc's and that has no `DefaultIcon` gets the type's .ico, and an icon of ours is removed again once the command no longer
  is PBCalc's (type given to another app). Never touches PBCalc* ProgIds or someone else's icon. Test: the last block of
  `verify-default-browser.js` (57 checks, test registry root; the real `pdf_auto_file` is asserted untouched).
- **PBCalc lists itself in Windows Settings > Default apps** (the installed program only, per user, no admin):
  `electron/defaultBrowser.js` writes the Chrome-style entries under HKCU (StartMenuInternet client + Capabilities for
  http/https/.htm/.html/.pdf, three ProgIds, RegisteredApplications) the first time the installed copy runs
  (`app.isPackaged`; a dev copy would register Electron's own exe), idempotent by exe path AND layout version
  (`REG_VERSION`, stamped last as `RegistrationVersion`; bump it when the layout changes and installed copies
  re-register at their next start). **The first layout did not make PBCalc appear in the Windows chooser** (the owner
  checked Settings > Default apps > Web browser: Firefox, Chrome, IE, Edge, Opera - no PBCalc, although the keys existed).
  Compared with the registry of the browsers Windows DOES list (Chrome, Opera, Firefox on that PC): all three have
  `Capabilities\Startmenu\StartMenuInternet` and `InstallInfo`, which PBCalc lacked; Chrome's ProgIds also carry an
  `Application` subkey. Layout 2 adds all of these plus `SHChangeNotify(SHCNE_ASSOCCHANGED)` so Windows rebuilds the list now.
  **CONFIRMED by the owner on Windows 10 (build 18362): after the layout-2 entries were written, PBCalc appears under
  Settings > Default apps > Web browser and could be selected.** (It cannot be checked from here: the chooser is a Windows
  UI flyout that opens only with a real click - UI Automation `Invoke` did not open it and
  `FindUriSchemeHandlersAsync` returns nothing on this build - so the owner looks at the list;
  `installer/installer.nsh` (`nsis.include`) removes them on uninstall. Windows never lets an app make itself the default -
  the user picks PBCalc there. A link / .html / .pdf handed over by Windows arrives as `PBCalc.exe <address-or-file>`:
  `electron/externalOpen.js` accepts ONLY http(s) addresses and existing local files of an allowed type (never javascript:,
  ftp:, .exe, a missing file), opens it as a new tab in the running window (or as the first tab at start-up, replacing the
  lone New Tab page), and ignores it in Restricted Mode. **`app.requestSingleInstanceLock()` is the FIRST thing main.js does
  after setting the data path - BEFORE the startup sweep**: that sweep deletes the session folder, so a second copy used to be
  able to wipe a running one's data (it matters now that every link click launches a copy). The second launch quits and its
  argv arrives in the `second-instance` event. **A failed lock only means "another copy" when the data folder is
  writable** (`dataFolderProblem()`): the lock is a file INSIDE that folder, so an unwritable folder fails it too, and
  quitting then would hide the "PBCalc cannot save your data" warning (caught by `verify-datadir.js` with `BAD=1`, which
  printed nothing at all before this was fixed). Test: `scripts/verify-default-browser.js` (the registry part writes to a
  TEST key, never the real Default-apps list). **Not driven:** the Windows Settings screen itself - the entries are checked,
  not how Windows draws them. **Test trap:** launch the extra copies with async `spawn`, never `spawnSync`, from the
  process that is playing the running browser - its blocked event loop can neither answer the second launch (20 s hang)
  nor serve the test web server.

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
  the named, **persistent** partition `TAB_PARTITION` (`"persist:pbcalc"`: a folder under the data folder, see
  "PDFs" below for why it is no longer in-memory — cookies, localStorage and the HTTP cache are ON DISK while
  PBCalc runs and are deleted at quit and again at the next start). **It is NOT `session.defaultSession`, so anything that must see tab
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
  `password-vault.json`, `vault-lock.json`, `bookmarks.json`, `bookmarks-dummy.json`, `settings.json` and `Local State` once our PID is
  gone (the `KEEP` set in privacy.js — six files); the same sweep
  runs at startup for crash leftovers. **`Local State` must stay in the keep list** — it holds the
  `safeStorage` key; deleting it makes the vault undecryptable.
- **Bookmarks** (`electron/bookmarks/`): user-curated, persisted in `bookmarks.json`; bar + star
  button in the shell. Stores only what was explicitly bookmarked (no visit data).
  **TWO bookmark lists (the owner's privacy requirement) - read this before touching bookmarks.** Whoever opens the
  browser must see ordinary bookmarks, not the owner's real ones (`scripts/verify-bookmark-modes.js`, 46 checks):
  - `bookmarkStore` holds a **dummy** list (`bookmarks-dummy.json`, seeded ONCE with the five diamond-trade sites the
    owner chose - GIA, GJEPC, Surat Diamond Bourse, BDB India, Surat Diamond Trade (`DUMMY_DEFAULTS`) - when the file is
    missing; a list the user emptied stays empty) and the **real** list
    (`bookmarks.json`, the owner's existing bookmarks). One is ACTIVE; every store function works on the active
    list, so the bar, star, bubble, manager, omnibox, right-click menu, drag and Restricted Mode all follow it with no
    logic of their own. **Never read a bookmarks file directly** - go through the store.
  - **The mode is in MEMORY ONLY and starts as dummy on every launch** (= "reset when the browser closes"); nothing
    on disk says the real list was ever shown. Persisting it would defeat the purpose.
  - **The hidden switch:** three clicks within 2 seconds on the "100%" in the ⋮ menu's zoom row, in ONE menu session
    (closing the menu forgets the count). The button still resets the zoom. Counted in the MAIN process
    (`countZoomClick` in popup.js, action `zoom-reset`), so the page cannot fake it; three more clicks switch back.
    The menu CLOSES at the moment the list switches (either way); where nothing switches (Restricted Mode) it stays open. `toggleBookmarkMode` also closes an open edit
    box and reloads an open bookmark-manager tab so nothing keeps showing the other list.
  - **Restricted Mode FOLLOWS the active list AND the switch works inside it** (the owner's choices): three clicks in
    Restricted Mode swap dummy <-> real exactly as in normal mode: **open tabs are never closed or touched** (an earlier
    version dropped them in Restricted Mode - a bug); only pages that DISPLAY the list are reloaded (a "Your sites" tab,
    an open bookmark-manager tab) plus the bar. **The switch only works while the bookmarks bar is SHOWN** (the owner's
    condition, both modes): with the bar hidden three clicks just reset the zoom. **Consequences to remember:** (1) a Restricted user who knows the gesture sees the REAL list (the
    gesture is as private as the hidden admin shortcut); (2) the mode resets each launch, so "Default Start Restricted"
    starts Restricted on the DUMMY sites unless the real list is unlocked first.
  - Tests that exercise bookmarks call `store.setMode("real")` first (a fresh launch is on the dummy list); the
    Restricted restart case "no bookmarks" empties the dummy file too.
  - **Dummy sites ship WITH their icons** (`ICONS` in bookmarkStore: each site's own icon rendered to a 32px PNG and
    EMBEDDED as a `data:` image, 1-4 KB each; no download, so they show offline and merely showing the bar contacts
    nobody). A globe on a decoy bookmark gives the decoy away, so **any site added to `DUMMY_DEFAULTS` must get its icon
    in `ICONS`** and be checked on the bar (a screenshot of the bar, not a full test run). To make an icon: take the page's
    declared `<link rel=icon>` (not `/favicon.ico` blindly - some return a web page), render it on a canvas at 32px.
  - **The dummy file is VERSIONED: `{version, items}`** (the real list stays a plain array). A plain array is version 1 -
    the first dummy list, six Google sites - and is upgraded ONCE when loaded: if it still holds any of those six they are
    replaced by the current defaults (placed first) and everything the user added stays; an emptied or fully custom list is
    left exactly as it is, and nothing is ever re-added after the user removed it. `settings.json` could not carry the
    "done" flag: it drops keys it does not know. Sites the user adds keep a globe until opened once, then `learnIcon`
    fills them. Tests: `verify-bookmark-modes.js` (66 checks, including three upgrade cases run as child processes).
  **Editing them is Chrome's, normal mode only** (`scripts/verify-bookmark-edit.js`, 44 checks):
  - **The bookmark box is a form: never rebuild it from pushed data.** Main re-sends every popup its data on
    EVERY tab / title / favicon / download change (`notifyTabs` -> `popup.refresh`). The edit dialog and the star
    bubble used to re-render from the stored values each time, so a page changing its own title (SPAs do) put the old
    name back while the user was typing (measured: "typed by the user" -> "Original"). `render()` in
    `renderer/popup/popup.js` now builds it once per bookmark (`panel.dataset.bookmarkId`); a bookmark deleted
    meanwhile still closes it. Any NEW popup with an input has to do the same (tab search already keeps its input).
  - The ⋮ menu entry is always "Bookmark this tab…" (same as the star: add + bubble, or edit/remove on a bookmarked
    page). It used to say "Remove this bookmark" on a bookmarked page, which stopped being true when the star
    stopped removing.
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
    shell sender only. **Works in Restricted Mode too (the owner's decision; it was blocked in TWO places - the bar items
    were `draggable=false` and `bookmarks:move` refused - and both had to go).** It changes only the ORDER of the active
    list; the right-click menu, the edit box, add and delete stay refused there.
    Favicon `<img>`s are `draggable=false` so the whole bookmark drags. `scripts/verify-bookmark-drag.js` (26
    checks). **Not verified with a real OS pointer:** synthetic
    `sendInputEvent` cannot start Chromium's drag loop, so the test fires the drag events the elements receive
    (dragstart/dragover/drop/dragend); an attempt to inject real OS mouse input failed because PBCalc could not
    be raised above the owner's own windows on that display (`WindowFromPoint` returned VS Code). Say so
    rather than claim a real-mouse drag was proven; the owner confirms it by hand.
  - **A site has one icon: a bookmark of ANOTHER page of an open site gets it too, and right away.** `learnIcon` used to
    match only an IDENTICAL address, so editing a bookmark to `https://site/` while `https://site/login` was open (the
    owner's case: "/" often redirects to "/login") left a globe for ever, even after a reload. It now matches the exact
    address OR the same origin (still only fills an EMPTY icon), and `broadcastBookmarks()` - called after every edit, add
    or list switch - first offers every open tab's icon to the list, so no reload is needed. Not in Restricted Mode (the
    list is read-only there). Caveat: when two open pages of one origin have different icons, the first tab wins. Real
    Chrome's behaviour for this case could NOT be captured (its window stays behind the owner's own windows on the main
    screen, and test windows must not use the second screen), so this is built from the owner's expectation, not
    measured. Test: `verify-bookmark-edit.js` ("ANOTHER page of the open site", 47 checks).
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
- **A PASSWORD IS ASKED BEFORE A SAVED LOGIN IS FILLED** (the owner's rule: whoever sits at the browser and does not know it
  cannot auto-fill saved passwords). Default **1234**; digits 0-9 only, 4 to 8 of them; changed in Settings > Saved passwords with
  Old / New / Confirm (`settings:change-vault-password`). Decisions (owner's answers): asked **EVERY time** a saved login is picked
  (no unlock window), **no recovery** (nothing in the browser resets it; deleting the file would also lose nothing but the
  password - see the limit below), **5 wrong tries = 30 s lockout, doubling each further round (cap 1 h)**, the dropdown still
  shows usernames on a click in the field (like Chrome) and the dialog comes when a row is picked. `electron/vault/vaultLock.js`
  keeps a salted scrypt hash in `vault-lock.json` (encrypted with `safeStorage`/DPAPI like the vault, on the keep list) plus the
  failed-try counter and lockout so closing the browser does not give fresh guesses. The dialog is the popup kind `vault-unlock`
  (`popup.askVaultPassword`, drawn by the BROWSER, allowed in Restricted Mode too); a correct password writes a ONE-TIME grant
  (`electron/vault/fillGrants.js`: one webContents + origin + username, 30 s) and **`vault:get-password` refuses everything
  without it** - which also closes a pre-existing hole: `window.vaultAPI` is exposed to page scripts, so any site could call
  `vaultAPI.getPassword(...)` and read its own saved password with no user action (`getLastSaved` even returned the password;
  it now returns the username only). The preload's row handler ignores untrusted (script-made) clicks, and `vault:request-fill`
  refuses a page that is not the active tab. **Limit:** application-level, not OS security: someone with the user's Windows
  session and the files can delete `vault-lock.json` (back to 1234) or read the vault through DPAPI. Test:
  `scripts/verify-vault-lock.js` (55; negative controls: removing the grant check or the trusted-click check fails the matching
  **MASTER password (owner's request):** in Settings > Saved passwords > Change password the "Old password" box accepts the user's own current password OR the owner's
  master one (`vaultLock.change` -> `verify(pw, {allowMaster:true})`; stored only as a salted scrypt hash, `MASTER_SALT`/`MASTER_HASH`), so a user who forgot theirs can set a new one. It works ONLY in
  that form - never to fill a saved login - and a wrong try counts toward the same lockout; while locked out it is refused too (otherwise the 5-try limit could be bypassed by guessing it).
  Limits: it is 4 digits in the program, so it is a convenience for the owner, not strong security (the file is obfuscated, not secret); it changes the fill password, it does not reveal the old one.
  Tests: the MASTER block of `verify-vault-lock.js` (72).
  checks). `verify-features.js` raises the dialog from the main process because its window is never shown (real mouse input is
  dropped there).
- **Common notification (toast)** for PBCalc's own pages: `renderer/common/toast.js` + the `.pb-toast` block at the end of `theme.css`;
  `PBToast.success/error/warning/info(text)`: green / red / amber / blue, top right, closes by itself (4 s, errors 6 s; hover pauses),
  close button, stacks up to 4. Load `toast.js` after `theme.css` in a page to use it (no inline styles: the pages' CSP forbids them).
  Settings uses it for the password change result and the Restricted Mode errors - the result must live OUTSIDE the form, which
  closes on success (an inline message vanished with it). Test: the Settings part of `verify-vault-lock.js`.
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
    **That rule was only enforced in `will-navigate` / `did-fail-load`, and Chromium has a THIRD path: it asks the
    `openExternal` PERMISSION before handing a link to Windows, and with no handler registered Electron GRANTS it.**
    So any page could launch any registered app, and a scheme nobody handles made Windows show "You'll need a new app to
    open this whatsapp link - Look for an app in the Microsoft Store" (the `api.whatsapp.com` page redirects to
    `whatsapp://` by itself; real Chrome shows nothing when no app is registered). Found by probing: a page navigating to
    `whatsapp://` - by itself, from a button, or in an iframe - raised exactly that request. Now
    `permissionRequestHandler` (tabManager, registered in main.js on the tab AND default session) sends `openExternal`
    through `handleExternalUrl` (confirm for mailto/tel/sms, nothing in Restricted Mode) and ALWAYS answers no, so Chromium
    never launches anything itself; **every other permission is still granted exactly as before** (Electron's default).
    Test: `scripts/verify-link-handling.js` (it wraps the handler the PRODUCT registered, not a copy).
  - **A tab opened from a page goes RIGHT AFTER its opener**, behind the tabs that same opener opened earlier (A, A1, A2,
    then the rest) - Chrome's rule - for `target=_blank`, `window.open`, Ctrl/middle-click (background) and "Open link in new
    tab" (`indexAfterOpener`, uses `tab.openerId`). It used to be appended at the END of the strip. Ctrl+T / the + button
    still append. Same test file.
  - Never pass `findNext:false` to `findInPage` (first search returns nothing). Zoom is per tab.
  - **Zoom = Chrome's preset list, 25..500%** (`ZOOM_STEPS`, `zoomTab` in tabManager): 25 33 50 67 75 80 90 100 110 125 150 175 200 250 300 400 500,
    shared by Ctrl+plus/minus/0, the ⋮ menu's +/- and **Ctrl+mouse wheel** (new: the tab preload reports a Ctrl+wheel to main
    only if the PAGE did not preventDefault it - the decision runs in a `setTimeout(0)` because the preload's listener is registered
    BEFORE the page's, so deciding inside it zoomed pages that use the wheel themselves; small touchpad deltas add up to 50 per step).
    The old code stepped 0.5 zoom-levels clamped to -3..5 = only 58%..249% (the comment said 25..500). The percentage comes from
    `getZoomFactor()`. Image tabs use the same (the owner's Chrome screenshots at 25% and 500%); Chromium's own click-on-image
    fit<->actual-size toggle already works (measured on a 4000px image). **`sendInputEvent` wheel deltaY has the OPPOSITE sign to
    the page's `event.deltaY`.** Zoom is per tab, but Chromium keeps it per HOST in the shared session, so a new tab on a host
    already zoomed starts zoomed. Test: `scripts/verify-zoom.js` (22). Not built: Chrome's zoom bubble (25% - + Reset).
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
  - **Tabs can be dragged to a new position in Restricted Mode, exactly as in normal mode** (the owner's decision; it
    was blocked in TWO places - the strip set `draggable=false` and `moveTab` returned early - and both had to go).
    Reordering reveals no address and changes no bookmark. Test: `scripts/verify-tab-move.js` (both modes).
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
  lost (every tab shares one session — a cookie login survived in the repro). Now `closeTab`
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
- **Reload, like Chrome** (`reload(mode)` and `reloadMenu` in tabManager). Three reloads: normal (Ctrl+R, F5),
  hard (Ctrl+Shift+R, Ctrl+F5, Shift+F5: cache bypassed, `reloadIgnoringCache`) and "Empty Cache and Hard Reload"
  (`session.clearCache()` first). **Right-click on the toolbar Reload button** opens the menu (Normal Reload
  Ctrl+R / Hard Reload Ctrl+Shift+R / Empty Cache and Hard Reload), **ALWAYS - in normal and Restricted Mode, no DevTools
  needed (the owner's decision). This is a DELIBERATE DIFFERENCE FROM CHROME**: measured in a real Chrome (numbers in
  `scripts/chrome-reference/README.md`) the menu exists only while DevTools is open. Not while the button is Stop
  (loading), and `tabs:reload-menu` is accepted from the shell only. DevTools stay blocked in Restricted Mode. It is a native menu (like the tab and
  bookmark menus), not Chrome's own rounded one, and the accelerator text is a hint only (`registerAccelerator:false`).
  Before this, Ctrl+Shift+R and Ctrl+F5 were claimed but did a PLAIN reload (the shift/ctrl was ignored). Not built:
  Chrome's press-and-hold on the button also opens the menu. Test: `scripts/verify-reload-menu.js` (32 checks that
  MEASURE each reload from the requests a local server sees, plus the menu rules; negative controls fail the
  matching check).
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
- Security / permissions / argv: see the "Security audit" section.
- Also: `verify-leaks.js` (11, memory/leaks, see "Memory and leaks"), `verify-vault-lock.js` (64), `verify-zoom.js` (23), `verify-drop-files.js` (19), `verify-drop-ui.js` (27), `verify-default-browser.js` (57), `verify-open-downloads.js` (17), `verify-features.js` (38). Full battery last run: 26 suites, 0 failures (`verify-ui.js` and `manual-os-click.sh` need the real pointer and were not run).
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

## Memory and leaks (audited with `scripts/verify-leaks.js`, 11 checks)

The test runs the same heavy workload 5 times (many tabs of every kind, hover cards, every popup, find, duplicate/close/reopen,
window.open popups, a download, password stash and fill grants, settings, file tabs), closes everything and, after a forced GC,
compares live webContents, BrowserViews, the module-level Maps, the window's listener counts, the main heap and the memory of ALL
processes with the baseline. What it found and what was fixed (each measured, not assumed):
- **`addBrowserView` leaks a "closed" listener on the window per call and `removeBrowserView` never takes it off** (Electron
  internal; the closure keeps the view alive). PBCalc attaches/detaches views constantly (every tab switch, popup, hover card,
  omnibox list, download animation): measured +1 listener per tab switch and per popup, 46 after ~40 operations, and Node's
  "possible EventEmitter memory leak" warning - which `mainWindow.js` had silenced with `setMaxListeners(100)`. All attach/detach now
  go through `electron/viewHost.js`, which removes the listener its attach added; the count stays at the number of attached views.
  **Use `viewHost.attach/detach`, never `win.addBrowserView/removeBrowserView` directly.** The limit is 40, not 100: many tabs opened
  at once keep their old views attached ~300ms and can pass Node's default of 10 for a moment (not a leak: counts return to baseline).
- Entries keyed by a page's webContents id were never removed when the page died before collecting them: `fillGrants` (one per
  password fill), the typed-login stash (a typed PASSWORD in memory for ever; now `electron/vault/pendingCredentials.js`, 60s TTL,
  swept on every stash) and `state.pendingSessionRestore` (up to 512KB each). All three are cleared when the page is destroyed
  (`wireTabEvents`) and swept by TTL.
- Not leaks (measured flat): heap after GC, webContents, BrowserViews, closed-tab list (capped at 20), thumbnails (die with the tab).
  The 1s login-form poll in `tab-preload.js` runs for as long as a page that ever showed a login form stays open: light, left as is.

## Dead code removed in the audit (each checked by grep for senders/callers first)
`preloads/tab-preload-test.js` (a debug interval logger that was packaged into the app), the IPC channels nobody sent
(`tabs:navigate` + `browserAPI.navigate`, `bookmarks:remove`, `downloads:cancel|open|show|dismiss`), `constants.HOME_URL`,
`restricted.isEnabled`, the `closeCircle` icon, two dead CSS rules (`.unlock-msg`, `.btnrow`), unused imports, unused exports, the
preview PNGs of `make-file-icons.js`. `assets/icon.svg`, `icon.ico` and `file-icons/` no longer go into app.asar (the .ico files ship
as `resources/file-icons`; the others are only used by tools/the installer). **Kept on purpose (owner's decision):** `window.vaultAPI`,
exposed to page scripts and unused by PBCalc itself - passwords are protected by the fill password, not by hiding the API.

**`npm run dist` and the network:** `build.electronDist` is `node_modules/electron/dist`, so the builder packages the Electron files already installed (same 41.7.1) instead of downloading them. Without it the build died with `read ECONNRESET` while fetching Electron's checksum file from GitHub (curl worked, Node's downloader did not). After upgrading Electron (`npm install`) the installed dist follows automatically.

**Never run `reg.exe` / `powershell.exe` with `execFileSync` (or any sync call) in the main process.** `defaultBrowser.js` did, five seconds after every start of the installed copy: the repair pass blocked the main thread 4.4 s and the registration 1.8 s, and Windows showed "PBCalc (Not responding)" (Event Log: `AppHangTransient`, PBCalc.exe) - the owner thought the 3-click bookmark switch caused it, but that switch takes 4 ms (measured); it only coincided. All of `defaultBrowser.js` is now async (at most 8 `reg.exe` at once; the repair pass took 1.2 s and the longest event-loop gap was 44 ms) and `verify-default-browser.js` fails if the loop stalls over 250 ms. A dev copy never runs this code (`app.isPackaged`), so such a freeze only shows in the INSTALLED app.

**Uninstall** (`installer/installer.nsh`, `scripts/verify-uninstall.js`, 15 checks): ALWAYS removes PBCalc's Windows registration (Default apps entries, every `PBCalc*` ProgId, `ApplicationsPBCalc.exe`, and - by a PowerShell pass - any Windows-made "Opens with" ProgId whose open command is in this install, plus every `DefaultIcon` pointing into it). Then it ASKS "Also delete all of your PBCalc data?" (Yes/No, default No): Yes removes `%LOCALAPPDATA%PBCalc` and the fallback `%APPDATA%PBCalc` (saved passwords, the fill password, bookmarks, settings, cache, cookies, crash reports) and nothing else; downloaded files are never touched. A silent uninstall (`/S`, which is also how an update replaces the old version) never asks and never deletes data. The NSIS script itself could not be run end to end without uninstalling the owner's real PBCalc: it is compiled by `npm run dist`, its structure is checked, and the PowerShell command is executed for real against a made-up registry area.

## Installer password, setup questions, and the calculator screen (owner's spec 2026-10-08)
**Installer** (`installer/installer.nsh`; read `scripts/verify-calc-*.js` etc. below): after the install-folder page the installer asks for the
installation password (**3 tries, then it quits and nothing is installed**), then two questions - make PBCalc the default browser / start on the
calculator screen. The password is stored only as a salted PBKDF2-SHA256 hash (100000 rounds; `scripts/make-install-hash.js "<password>"` makes new
`PBC_SALT` / `PBC_HASH` lines); PowerShell recomputes it from the typed text. **Trap, measured: `nsExec::ExecToStack` hands back exit code 1 even when
PowerShell printed the right word - trust only the printed `PBC_OK`** (the first version rejected the right password). A silent install (`/S`) shows no
page, so it must be started as `PBCalc Setup.exe /S /PW=<password>` or it stops (exit code 2); a silent install writes no choices. Tested end to end with the
real installer driven through Windows UI messages (BM_CLICK / WM_SETTEXT, no mouse): 3 wrong -> cancelled, nothing installed; right -> both questions ->
install -> uninstall leaves nothing. **Limit (say so): this is a gate for the casual user, not security** - anyone can unpack the installer with 7-Zip.
`electron/installChoices.js` reads `<install folder>\install-choices.json` ONCE at the first start (installed copy only): `calculatorStart` -> settings.json;
`defaultBrowser` -> read but NOT acted on: PBCalc registers itself in Windows' browser list anyway, and the Default apps page is deliberately NOT opened (owner: no Settings window may pop up by itself; Windows never lets a program make itself the default, the user picks it in Settings > Default apps). The file is
deleted; if the folder is read-only its modification time is remembered (`installChoicesStamp`) so the same file never applies twice. Test:
`scripts/verify-install-choices.js` (13).
**Calculator screen** (`renderer/calc/{pricing.js,calc.css,calc.js}`, lives INSIDE the shell page; `electron/calcMode.js`): when `settings.json ->
calculatorStart` is true PBCalc starts on a copy of the owner's iPad recording (Apple look, 1376x1032 stage scaled into the window, black letterbox, iOS
scroll-snap WHEELS for Shape / Colour / Clarity / Fluorescence / Discount - no dropdowns; mint chips 3EX / EX-VG / VG / GD and C P S rows; Stone Weight, Polish /
Result / Total Polish / Rough $/Ct., Add St. = more parts, red minus, gray minus/plus = +-0.05 ct, Update Price = +-2 % list drift). Prices are DUMMY
(`pricing.js`; the real list is a SQL proc in Mfg.API, deliberately not copied) calibrated to the recording: 0.5 ct ROUND D FL -30 % = 4700 / 3290 / 1645, F VS1
2600 / 1820 / 910, F VS2 2200 / 1540 / 770, stone 1.05 -> 47.62 % and $1566.67 (`scripts/verify-calc-pricing.js`, 22). There is NO Settings switch for it
(it would give the disguise away); only the installer sets it. While it shows NO tab exists (`state.calcMode`): `createTab`, every shortcut, files dropped, and
links from Windows are refused. **Five presses of the gray + within 1.5 s each** (counted in MAIN, `calc:plus`, shell page only) open the browser (a New Tab
page at 100 % zoom; the Restricted home when Restricted Mode is on). **Closing the browser - the last tab OR the window's X - returns to the calculator
instead of quitting** (`calcMode.onWindowClose`): every tab closed, the session wiped like at quit (`privacy.clearSession`), the Ctrl+Shift+T list forgotten, a
FRESH calculator. The calculator's own X and the menu's Exit quit (`state.quitting` from `before-quit` / `session-end`). Window buttons turn white-on-black
(`theme.setCalc`). **Traps found by measuring:** (1) a wheel cannot scroll while `display:none` - add `body.calc-mode` BEFORE building the cards (the wheels
started on the wrong item only when a late second `show()` did not rescue it); (2) `requestAnimationFrame` does not run while the window is covered, so the
selected item and the price never wait for a frame (only the fade does); (3) a plain `.c-stage button {...}` reset out-ranked the buttons' own classes
(black Update Price button went transparent) - resets use `:where()`; (4) the installed app, started twice, hands the 2nd launch to the 1st (single-instance
lock): probe it with ONE launch. Tests: `scripts/verify-calc-screen.js` (81 now; first version 54: start state, the recording's numbers, real mouse wheel + drag on a wheel, parts, nothing
opens behind it, the 5-press rule incl. the pause that restarts the count and forged presses, close-returns-to-calculator incl. cookie wiped, X quits) plus
`PBCALC_TEST_PLAIN=1` (no setting = browser starts as always); also run against the INSTALLED obfuscated exe through `--remote-debugging-port` (3 close/open cycles clean).
**Assumption to confirm with the owner:** "when the browser closes we go back to the calculator" was implemented for BOTH the last tab and the window X.
**REDESIGN (owner's request, 2026-10-08) - the screen is no longer an iPad picture.** The first version copied the recording literally: a fixed 1376x1032 stage scaled into the window (black
bars left and right) with an iPad status bar (clock, wifi, battery). Now `renderer/calc/calc.{css,js}` lay it out FLUID so it fills the whole window at any size (tested 1920 wide and 980 wide:
`.c-stage` = the window, nothing scrolls sideways), without the status bar. Functionality and numbers are unchanged. Header (also the window's drag area; the window buttons sit over its right end,
so it keeps ~9.6em free): PBC brand, three tabs **Account | Calculator | Price List** (the two outer ones are "Coming soon" panels, the owner's choice), "Prices updated <time>" + **Update Price**.
Calculator view: Stone Weight tile + four summary tiles (Polish / Result / Total Polish / Rough $/Ct., same labels and values), the Loose/GIA/IGI/HRD row, one card per part (badge A, weight field,
wheels with column titles Shape / Colour / Clarity / Fluor. / Discount, Grade chips and Cut / Polish / Symmetry rows, the "List .. $/Ct. .. Total .." strip, the lab table), the red / blue / gray buttons, a
dark footer with the "Calculator" pill and the **gear = Settings dialog** (Appearance Light/Dark for the calculator, Default discount stepper + "Apply to all parts", Lab price table switch, Reset calculator,
Done; Esc, Done or a click outside closes it; in memory only, gone with the session). Wheel items are 36px (`WHEEL_H` in calc.js = `.c-wheel-item` in calc.css: keep both). **Traps found while building it:**
a CSS `transition` on the weight label never finished while the window was covered (the label stayed over the typed value) - no transitions on anything that carries meaning; the class names the tests and
the 5-press code rely on (`.c-tab`, `.c-update`, `.c-sum`, `.c-card`, `.c-wheel*`, `.c-chip` in the order 3EX / EX-VG / VG / GD first, `.c-btn.grey` index 1 = +) were kept. Test: `verify-calc-screen.js`
now has 81 checks (layout fills the window, tabs, Update Price stamp, every settings control, narrow window); its real-mouse wheel/drag checks can fail once in a while when someone moves the real
mouse over the test window (re-run).

## In-app updates (`electron/updater.js`, dialog `electron/updateDialog.js`; tests `verify-updater.js` 28, `verify-updater-popup.js` 10, `verify-update-dialog.js` 23, installer part of `verify-uninstall.js`)
Built like the ERP shell (`PBERP-EXE - Barcode/electron/updater/autoUpdater.js`: electron-updater + a plain web folder). **The admin puts the THREE files that
`npm run dist` writes into `release/` on the server: `pbcalc.yml`, `PBCalc Setup <version>.exe`, `PBCalc Setup <version>.exe.blockmap`** (names must stay exactly as
built, spaces included). The address is `package.json -> build.publish` (generic, `channel: "pbcalc"`; now the owner's test server `http://192.168.0.8:9995/assets/`)
and is baked into the installed app as `resources/app-update.yml`. A release = raise `version` in package.json, `npm run dist`, upload those 3 files. At each START
(5 s after the window is up, installed program only - never `npm start`) the app asks the server; a higher version is downloaded quietly.
- **Channel `pbcalc`, so the file is `pbcalc.yml`, NOT `latest.yml`.** The ERP keeps `latest.yml` in the same kind of folder (`https://mfg.pb.diamonds/assets/`); PBCalc reading it
  would "update" itself to the ERP's installer. Test: a newer `latest.yml` is ignored. **The test server answers a missing file with a web page (Angular `index.html`, 200)**: the
  updater logs an error and ignores it - nothing is shown (tested with html / 404 / empty / broken files).
- **Nothing is forced (owner's rule).** When the download is done PBCalc's OWN dialog opens (`renderer/updatedialog/`, `preloads/updatedialog-preload.js`, `electron/updateDialog.js`; it replaced
  Windows' plain message box, which stays only as the fallback if the window cannot be made): a modal window (modal to the main window) with an update icon on a blue disc (pulsing ring), "Update
  available", the two versions as chips (v0.1.5 -> v0.2.0), three lines with their own icons (**PBCalc restarts** / **all open tabs are closed and are not restored** / **it opens again by itself**), a note
  that Cancel installs it automatically the next time you close or open PBCalc, and two buttons **Cancel** / **Update** (filled). Light and dark like the browser. **Only a click on Update answers yes**;
  Cancel, Esc, the window's X, and the main window closing are all "no", and Enter decides nothing (no button has keyboard focus at the start, so a stray Enter while typing in a page cannot
  answer). Only THIS dialog's own window may send the answer (an `updatedialog:answer` forged by another window is ignored). Update -> `quitAndInstall(true, true)`. Cancel -> nothing starts,
  `updateDeclined = <version>` is saved in settings.json; the update then installs (a) when PBCalc really quits (electron-updater `autoInstallOnAppQuit`, silent, no restart), (b) when the calculator's
  "browser closed" happens (`calcMode.returnToCalc` -> `updater.installIfPending`), (c) at the NEXT START: the same version is found again, equals `updateDeclined`, so it installs at once WITHOUT
  asking. A dialog that cannot be shown counts as Cancel. A newer version than the declined one asks again. **Trap (crashed the test process): close the dialog with `win.close()`, never
  `win.destroy()`** - after several destroyed modal dialogs a later `nativeTheme.themeSource` change took the whole process down (native crash, exit 127); `close()` fixed it.
  An earlier version used Electron's message box: UI Automation lists it INSIDE the main window with `CCPushButton` buttons - not relevant for the new HTML dialog, whose buttons are ordinary.
- **Silent install** (`quitAndInstall(true, true)`), unlike the ERP's `(false, true)`: the ERP's wizard has a "who should this be installed for" page whose first choice (all users) moved an
  "only me" install into `C:\Program Files` and asked for administrator rights (measured on a real update; the HKLM entry and the files had to be removed with a UAC prompt), and its Finish
  page waited for a click. Silent keeps the folder, the user, and restarts PBCalc by itself (the new window came up maximized and visible).
- **An update never asks the password or the two setup questions** (`installer.nsh`: the pages `Abort` when `${isUpdated}`, i.e. the installer got `--updated`), never rewrites
  `install-choices.json`, and the OLD version's uninstaller (run silently with `--updated`) skips the registry cleanup, so a default browser stays default and the calculator start
  (settings.json, on the keep list) stays. **A silent `--updated` is accepted without the password ONLY when `$INSTDIR\PBCalc.exe` exists** (a made-up `--updated` into an empty folder, a plain
  `/S` and a wrong `/PW` all exit with code 2 and install nothing). Measured end to end with real installers 0.1.5 -> 0.1.6: same folder, per-user, calculator + Default apps entries kept.
- **Traps found by the tests:** electron-updater's `channel` setter switches `allowDowngrade` ON, so set the channel FIRST (an older version on the server was installed before this);
  with `autoDownload` a corrupt download rejects `downloadPromise` as well as the "error" event - the promise is caught; the modal popup is listed by UI Automation INSIDE the main window
  with `CCPushButton` buttons (not as a top-level window, not `ControlType.Button`); dev runs need `dev-app-update.yml` next to the script (the tests write and delete it); build the
  test installers with a local `publish.url` (`127.0.0.1`) and RESTORE package.json (version + production URL), and clear `release/` of them before the real build.
- **Checks happen at START only, plus the Settings button.** There is no timer: the one automatic check runs 5 s after the window opens. **Settings > Privacy > Version has a "Check for update" button**
  (`updater.checkNow`, IPC `settings:check-update` from the settings page only, `settingsAPI.checkUpdate`): the same check at once. A newer version is downloaded and PBCalc's update popup comes when it is ready
  (a version declined earlier is asked AGAIN on a button press instead of being installed at once - `manual` flag); no newer version, a server error or a web page instead of `pbcalc.yml` = NOTHING is shown (owner's
  rule: no result text). The button is disabled only while the check runs. A development copy has no updater, so the button does nothing there. Tests: the "checkNow" and wiring blocks of `verify-updater.js` (37).
  A periodic re-check while PBCalc stays open was offered to the owner and NOT built (ask first).
- Limits to say plainly: the build is unsigned, so the only integrity check is the sha512 in `pbcalc.yml` (a server that is taken over can serve a malicious installer; use https and a trusted
  folder in production); a differential download needs the previous version's blockmap on the server (otherwise the full file is fetched - works, just bigger).

## Video files open in a tab (`fileTypes.VIDEO`, `scripts/verify-video-open.js`, 18 checks)
Chrome plays a local .mp4 in a tab; PBCalc ignored a dropped video and sent a downloaded one to another program. `.mp4 .webm .m4v .ogv .mov` are
now in `IN_TAB` (so also `FROM_USER`): dropped on the window, handed over by Windows, or clicked in the Downloads list -> a new tab with Chromium's
own video page (the same controls as Chrome's; it is Chromium's, not drawn by PBCalc), Restricted Mode too. Measured: a generated webm and the owner's
real H.264 mp4 both decode and play. **Playback froze after ~1 s on the owner's PC (NVIDIA, Win10) for a 2752x2064 H.264 iPad recording**: measured in a plain Electron window too (not PBCalc's
doing): hardware decoding stalls ("waiting", readyState 2, frames stop), `--disable-accelerated-video-decode` plays it 1:1 (6.08 s in 6 s). `main.js` now sets that
switch (video decoded by the CPU; drawing still uses the GPU); trade-off = more CPU for large videos. Other flags tried without effect: `--ignore-gpu-blocklist`,
`--disable-gpu-sandbox`, `--use-angle=d3d11`, `PlatformHEVCDecoderSupport`, `--disable-features=D3D11VideoDecoder`. Trap: `app.getGPUFeatureStatus()` right after `ready`
says everything is "disabled_software" - read it only after a window has loaded. The test video is not in the suite (it is the owner's file).
Not added on purpose: `.mkv/.avi` (Chromium cannot play them), audio files, a Windows file icon / "default app"
entry for video (`kindOf` stays null). Also fixed here: `permissions.check` ignored `details.mediaType` (singular), so after Allow the page got no
device names (Meet: "Mic not found"); test in `verify-capture-indicator.js`.

## Screen sharing (`electron/screenShare.js`, `scripts/verify-screenshare.js`, 29 checks)
Google Meet's "Present now" (any site's `getDisplayMedia()`) said "Can't share your screen" because Electron answers `getDisplayMedia` with
`NotSupportedError` unless the app installs a display-media handler (measured; PBCalc never did). The picker is a copy of **Chrome 154's own dialog**,
laid out from the owner's screenshots (popup kind `screenshare`, `renderShare` in popup.js, `.sh-*` in popup.css): "Choose what to share with <site>" +
"The site will be able to see the contents of your screen", three equal tabs **Chrome Tab / Window / Entire Screen**; Chrome Tab = this browser's OTHER tabs
(favicon + title, selected row tonal with blue lines, preview + caption on the right, "Select a tab to share"), the bar "Share with tab audio" with a switch
(on by default, button says "Share with Audio", off = "Share"); Window = 3-column grid of window thumbnails with the app icon + title; Entire Screen = big
thumbnails "Screen 1", "Screen 2"; Window / Screen show "To share audio, share a tab instead" (Chrome gives no system audio there either); Cancel / Share bottom right.
Flow: Chromium asks the PERMISSION first ("display-capture", or "media" with no camera/microphone) -> `permissions.request` -> `screenShare.pick` shows the dialog
(the consent - nothing is remembered) -> `setDisplayMediaRequestHandler` hands over exactly the picked source.
- **Why the picker lives in the permission step:** refusing inside the display handler (`callback({})`, `null`, nothing - all measured) gives the page
  `AbortError: Invalid capture constraints`, so Meet shows "Can't share your screen" when the user merely cancels; refusing the PERMISSION gives `NotAllowedError`
  (Chrome's answer to a cancelled picker).
- **A tab is captured as a frame** (`video: webContents.mainFrame`, `audio: mainFrame` + `enableLocalEcho` so the tab keeps playing here). **Measured: Electron only
  delivers a stream for a tab that is ON SCREEN - a background tab's request hangs for ever.** So pressing Share switches to the shared tab first (Chrome does too),
  waits 450 ms, then captures. The asking page ends up in the background (Meet keeps running).
- Only the tab you are looking at may ask; the page only ever gets an id/tab that was offered; Restricted Mode: the dialog works but has no "Chrome Tab" list (no other
  tab's title is shown) and starts on Window. Not available: Chrome's system-audio tick box for a whole screen (the screenshot dialog does not show it either).

## Permission state the page sees, and "Microphone in use" (`scripts/verify-capture-indicator.js`, 28 checks)
- **Undecided = "default" / "prompt", like Chrome.** Electron's check handler can only answer yes/no, so a page that had not been asked saw
  `Notification.permission === "denied"` and `permissions.query` "denied" (measured). Google Meet reads that as "blocked" and, when you press
  "Allow notifications", opens its "how to unblock" help page (support.google.com/meet/answer/15236238) instead of asking. `tab-preload.js`
  now patches `Notification.permission` and `Permissions.prototype.query` in the main world from `permissions.statesFor` (sync `perm:states`
  at load, pushed again after every answer). Covers notifications, location, camera, microphone, MIDI, clipboard-read. **Not verified against
  the real Meet** (needs a Google login): the cause is inferred from the measured "denied" before any question - the owner confirms by hand.
- **"Microphone in use" / "Camera in use" / "Camera and microphone in use" pill** left of the site-info icon (`#capture-chip`). The preload wraps
  `getUserMedia` and `MediaStreamTrack.stop` in the main world and reports live audio/video track counts as the NAME of a DOM event
  (`pbc:<random>:<a>:<v>`, no data crosses worlds) -> IPC `page:capture` -> `tab.capture` (sender decides the tab; dropped on navigation).
  Not covered: streams made in iframes, screen sharing, the chip's click bubble and the tab-strip recording dot (Chrome has them; the colours
  and position were taken from the owner's screenshot, not measured from Chrome).

## Security audit (attacker's view) - `scripts/verify-security.js` (49 checks), `verify-permissions.js` (35), `verify-argv-injection.js` (5)

A hostile test page on a local server (real tab, real session) tries what a malicious site tries; every check is written as the SECURE
outcome, so a FAIL is a vulnerability. Found by measuring, fixed, and each fix has a negative control (switching it off makes its check fail):
- **Silent permissions (HIGH).** The permission handler said yes to everything except openExternal: a page got location, camera,
  microphone, notifications, clipboard-read and MIDI without a question. Now `electron/permissions.js`: Chrome-style bubble under the
  site-info icon ("<site> wants to ... Allow while visiting the site / Allow this time / Never allow"), answers kept in MEMORY only
  (closing the browser forgets them - the no-history rule), `setPermissionCheckHandler` so `Notification.permission` /
  `permissions.query` do not claim "granted" (and a page cannot show notifications unasked), benign ones (fullscreen, pointer lock,
  clipboard write, DRM) pass, unknown names are refused, a background tab is refused, one bubble at a time (queue), works in Restricted
  Mode. **Trap:** a PC without a camera/microphone makes Chromium answer NotFoundError BEFORE it asks, so tests must call the handler
  (`permissions.request`) for media; clipboard.readText() on an unfocused page is refused by Chromium itself.
- **Password-guess oracle (HIGH).** `window.vaultAPI.needsSavePrompt(user, guess)` answered false for the saved password and true for any other: a
  page script could guess a saved password with no password dialog. The page-facing call now uses `vault:page-needs-prompt` (answer
  never depends on the password); the browser's own save prompt keeps the exact check on its internal channel.
- **Stray window from a dropped link (HIGH for Restricted Mode).** Dropping a link (text/uri-list) on the toolbar / tab strip made Chromium open a
  NEW unmanaged BrowserWindow (no tabs, no address bar, default session) - an escape from Restricted Mode. `electron/lockdown.js`: the toolbar
  page, popups, omnibox list, hover card and download animation refuse every window.open and every navigation away. A dropped link now opens
  a new tab at the drop slot (normal mode only, http(s) only; never in Restricted Mode).
- **Automatic downloads (MEDIUM).** A page could save dozens of files by script. Like Chrome: one automatic download per page address, the rest refused
  unless the user clicked / pressed a key within 5 s. `DownloadItem.hasUserGesture()` is useless here (measured: true for a script's `<a download>`.click()),
  so the tab preload reports TRUSTED pointer/key events (`page:activity`). Downloads are Mark-of-the-Web'd (Zone.Identifier present) and hostile
  file names are sanitised (traversal, CON, trailing dots, colons: measured safe).
- **Restricted Mode "same site" (MEDIUM).** The last-two-labels rule made `user1.github.io` allow ALL of github.io (also blogspot, herokuapp, vercel.app ...):
  `restricted.js` SHARED_SUFFIXES (a short list, not the full public-suffix list) now makes the site one label + suffix.
- **Command-line injection (MEDIUM, defence in depth).** The registered link handler was `"PBCalc.exe" "%1"`: a quote inside a link from a program that does not
  escape it becomes extra Chromium switches (`--remote-debugging-port` measured to open full remote control). Now `"PBCalc.exe" -- "%1"` (registry layout 5);
  `targetFromArgv` already skipped switches. The Windows-made "Opens with" entries cannot be changed (they carry files, not links).
- **Context menu (LOW).** "Open link in new tab" loaded ANY scheme (file:, javascript:, data:, ms-*) as a browser-initiated load; now http(s) only. The external-application dialog
  showed only 200 characters and opened the raw string; it now shows and opens the whole normalized address.
- **Tab commands (hardening).** `tabs:*`, `bookmarks:list`, `downloads:get` ... answered ANY sender, including the preload of every web page; now toolbar page only.
- **Checked and fine:** page isolation (no Node globals, only `vaultAPI` exposed, renderers sandboxed), file:// / pbcalc:// / data: unreachable from a page,
  8 dangerous schemes never reach Windows, no HTML injection through tab titles / download addresses / error page / site info, saved password unreadable by a
  page, a hung page is closable, strict CSP on every internal page, URL parser fuzz (no throw, `javascript:` typed becomes a search, userinfo hidden, IDN shown as punycode).
- **Not done / for the owner's decision:** Electron fuses (disable `--inspect`, `NODE_OPTIONS`, force asar-only + integrity) need a packaged-exe launch test and
  `runAsNode` must STAY on (the exit-wipe helper in privacy.js runs through it); the page-facing `window.vaultAPI` (save / deleteSaved / neverSave let any page of that origin
  edit its own saved logins - kept at the owner's request); UNC paths (`\\host\share\x.pdf`) handed in by Windows make the OS contact that server (normal for any Windows app).

## Notable gotchas

- `contextIsolation: true` / `nodeIntegration: false` on every window, every `BrowserView` —
  keep it that way. `tab-preload.js` in particular runs against untrusted, arbitrary websites, so
  its exposed surface must stay deliberately narrow.
- `app.setPath("userData", ...)` must run before `app.whenReady()` — Electron only honours it
  before the app is ready. It must also run before any other module that might call
  `app.getPath("userData")` at its own module-load time (none currently do; they all call it
  lazily inside functions, which is why require-order elsewhere in the app does not matter).
