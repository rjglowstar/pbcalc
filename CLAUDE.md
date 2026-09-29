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
2. **Fully portable storage.** Saved passwords, session cookies/localStorage, and any future
   settings all live in a folder next to the app itself (`UserData/` next to the installed .exe
   in a packaged build; `.dev-userdata/` in the project folder under `npm start`) — never the
   Windows-default `%APPDATA%`. The whole install (exe + its data) is meant to be copyable,
   movable, or deletable as one unit. This is set in **one place**: `app.setPath("userData", ...)`
   as literally the first executable line of `electron/main.js`, before anything else runs.
   Everything else (the vault, Electron's own session storage) inherits it automatically through
   `app.getPath("userData")` — do not add a second, independent storage-path call anywhere.

## Commands

- `npm start` — run the app (`electron .`).
- `npm run dist` — package a Windows installer via `electron-builder` (NSIS, output to `release/`).
- No test suite or linter is configured yet.

## Architecture

- `electron/main.js` — entry point. Sets the portable `userData` path first, then wires up the
  main window and IPC handlers.
- `electron/state.js` — single mutable module-level object (`mainWindow`, `tabs`, `activeTabId`),
  same pattern as the sibling ERP project. No store/reducer layer.
- `electron/constants.js` — `portableDataDir()` (dev vs. packaged), tab bar height, tab limit,
  home URL.
- `electron/tabs/tabManager.js` — the tab engine. Each tab is a `BrowserView`. Deliberately **no**
  session partition per tab — every tab shares Electron's default persistent session, so logging
  into a site in one tab keeps you logged in in another tab of the same site, like a real browser.
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
  `password-vault.json`, `bookmarks.json` and `Local State` once our PID is gone; the same sweep
  runs at startup for crash leftovers. **`Local State` must stay in the keep list** — it holds the
  `safeStorage` key; deleting it makes the vault undecryptable.
- **Bookmarks** (`electron/bookmarks/`): user-curated, persisted in `bookmarks.json`; bar + star
  button in the shell. Stores only what was explicitly bookmarked (no visit data).
- **Downloads** (`electron/downloads/`): native Save As dialog, in-memory list shown on a bottom
  shelf (`state.bottomInset` shrinks the tab view). Never persisted; gone on exit.
- **Password-manager UI** (bottom of `preloads/tab-preload.js`): save prompt, autofill dropdown on
  click/typing. No silent pre-fill (untrusted sites). All `vault:*` IPC re-derives the origin from
  the sender's real URL in the main process; a typed credential crosses a navigation only via an
  in-memory 60s stash in main. `window.vaultAPI` is still exposed to page scripts (pre-existing).
- Self-tests: `scripts/verify.js` (19 checks), `scripts/verify-features.js` (22 checks). Run with
  `env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/<file>`.
- No settings window, no extensions. Not requested yet; do not add speculatively.

## Notable gotchas

- `contextIsolation: true` / `nodeIntegration: false` on every window, every `BrowserView` —
  keep it that way. `tab-preload.js` in particular runs against untrusted, arbitrary websites, so
  its exposed surface must stay deliberately narrow.
- `app.setPath("userData", ...)` must run before `app.whenReady()` — Electron only honours it
  before the app is ready. It must also run before any other module that might call
  `app.getPath("userData")` at its own module-load time (none currently do; they all call it
  lazily inside functions, which is why require-order elsewhere in the app does not matter).
