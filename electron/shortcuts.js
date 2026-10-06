const state = require("./state");
const tabManager = require("./tabs/tabManager");
const popup = require("./popup");

// The window menu is removed, so no accelerators exist by default. before-input-event on every
// webContents (the shell chrome, each tab and the popups) is the one place shortcuts are handled —
// a tab has keyboard focus most of the time, so listening on the shell alone would miss almost
// everything. Only keys that are NOT needed by the page/input for normal typing are claimed
// (Ctrl+C/V/X/A are left alone), and a claimed key is preventDefault()ed so the page never also
// sees it.
//
// Restricted Mode: only the "use the page" shortcuts remain (see RESTRICTED_OK); every other
// shortcut — new tab, address bar, bookmarks, devtools, tab search... — is swallowed.
const RESTRICTED_OK = new Set([
  "back", "forward", "reload", "close-tab", "cycle-tab", "select-tab", "find", "find-close",
  "print", "downloads", "zoom", "new-tab", "fullscreen",
  // Showing/hiding the bookmarks bar is just a view preference — it changes no bookmark and
  // reveals no address — so Ctrl+Shift+B works in Restricted Mode too (the user asked for it).
  "bookmarks-bar",
]);

// ── Hidden admin shortcut: press Ctrl+Shift together, then type "pbsecure" ─────────────────────
// Toggles Restricted Mode (on; or, when already on, opens the PIN box — it never turns the lock off
// without the PIN). Works whether or not Ctrl+Shift is still held while typing, must finish within
// 12 seconds, and any wrong key cancels it. While a sequence is in progress its letters are
// swallowed so they are not typed into the page or trigger a shortcut (Ctrl+Shift+B, Ctrl+P...).
const SECRET = "pbsecure";
const SECRET_WINDOW_MS = 12000;
let secretIdx = -1; // -1 = not armed
let secretDeadline = 0;

// Returns true if the key was consumed by the sequence.
function secretSequence(event, input) {
  const now = Date.now();
  const key = input.key;
  const isMod = key === "Control" || key === "Shift";
  if (isMod && input.control && input.shift) {
    secretIdx = 0;
    secretDeadline = now + SECRET_WINDOW_MS;
    return false; // the modifier keys themselves still pass through
  }
  if (secretIdx < 0) return false;
  if (isMod || key === "Alt" || key === "Meta") return false; // modifier presses don't cancel
  if (now > secretDeadline) { secretIdx = -1; return false; }
  const ch = key.length === 1 ? key.toLowerCase() : "";
  if (ch === SECRET[secretIdx]) {
    event.preventDefault();
    secretIdx += 1;
    if (secretIdx === SECRET.length) {
      secretIdx = -1;
      setImmediate(() => tabManager.secretToggle());
    }
    return true;
  }
  secretIdx = -1; // wrong key: cancel (that key passes through normally)
  return false;
}

// Holding a key down makes Windows repeat it ~30 times a second. For shortcuts that CREATE or
// DESTROY something that is one action per press, as in Chrome — holding Ctrl+T must open one tab,
// not thirty, and holding Ctrl+W must not close the whole window. Repeats are still swallowed
// (preventDefault) so the page never sees them. Shortcuts where repeating is the point — zoom,
// cycling tabs, back/forward — are left alone.
const NO_AUTO_REPEAT = new Set([
  "new-tab", "close-tab", "reopen-tab", "duplicate-tab", "find", "downloads", "print", "devtools", "settings",
  "bookmark", "bookmarks-bar", "bookmark-manager", "tab-search", "fullscreen", "find-close",
  "address-bar",
]);

function handleInput(event, input) {
  if (input.type !== "keyDown") return;
  if (secretSequence(event, input)) return;
  const ctrl = input.control || input.meta;
  const { key, shift, alt } = input;

  // Run `fn` for shortcut `name`. In Restricted Mode a shortcut outside the whitelist is consumed
  // without doing anything.
  const claim = (name, fn) => {
    event.preventDefault();
    if (input.isAutoRepeat && NO_AUTO_REPEAT.has(name)) return; // held key: one action per press
    if (state.restricted && !RESTRICTED_OK.has(name)) return;
    setImmediate(fn);
  };

  if (alt && !ctrl && key === "ArrowLeft") return claim("back", tabManager.goBack);
  if (alt && !ctrl && key === "ArrowRight") return claim("forward", tabManager.goForward);
  if (key === "F5") return claim("reload", tabManager.reload);
  if (key === "F12") return claim("devtools", tabManager.openDevTools);
  if (key === "F11") return claim("fullscreen", () => state.mainWindow.setFullScreen(!state.mainWindow.isFullScreen()));
  if (key === "Escape" && state.findOpen) return claim("find-close", tabManager.closeFind);

  if (!ctrl || alt) return;
  const k = key.length === 1 ? key.toLowerCase() : key;

  if (k === "t") {
    if (shift) {
      return claim("reopen-tab", tabManager.reopenClosedTab);
    }
    return claim("new-tab", () => {
      // Restricted Mode: a new tab is the "Your sites" tiles page (createTab enforces that).
      if (state.restricted) return tabManager.createTab(undefined, { allowRestricted: true });
      tabManager.createTab();
      tabManager.focusAddressBar();
    });
  }
  if (k === "w") return claim("close-tab", () => tabManager.closeTab(state.activeTabId));
  if (k === "l") return claim("address-bar", tabManager.focusAddressBar);
  if (k === "r") return claim("reload", tabManager.reload);
  if (k === "f") return claim("find", tabManager.openFind);
  if (k === "d") return claim("bookmark", tabManager.toggleBookmarkActive);
  if (k === "p") return claim("print", tabManager.printActive);
  if (k === "i" && shift) return claim("devtools", tabManager.openDevTools);
  if (k === "a" && shift) return claim("tab-search", () => popup.open("tabsearch", null));
  if (k === "b" && shift) return claim("bookmarks-bar", tabManager.toggleBookmarksBar);
  if (k === "o" && shift) return claim("bookmark-manager", () => tabManager.openManager());
  if (k === "j" && shift) {
    // Downloads page = Ctrl+SHIFT+J, a deliberate departure from Chrome (where it is plain Ctrl+J,
    // "Open the Downloads page in a new tab"). Reason, by the owner: one of the sites run in this
    // browser has its own Ctrl+J shortcut (it opens a modal). before-input-event runs BEFORE the
    // page, so claiming plain Ctrl+J would make that shortcut impossible — Chrome lets the page see
    // it first. Plain Ctrl+J therefore must stay UNCLAIMED and reach the page (verify-browser checks
    // that). It goes straight to the PAGE; the small bubble is what the toolbar button opens, and a
    // bubble that happens to be open is closed first so it is not left hanging over the page.
    return claim("downloads", () => {
      if (popup.isOpen("downloads")) popup.close();
      tabManager.openDownloadsPage();
    });
  }
  if (k === "Tab") return claim("cycle-tab", () => tabManager.cycleTab(shift ? -1 : 1));
  if (k === "PageDown") return claim("cycle-tab", () => tabManager.cycleTab(1));
  if (k === "PageUp") return claim("cycle-tab", () => tabManager.cycleTab(-1));
  if (k === "+" || k === "=") return claim("zoom", () => tabManager.zoom(+1));
  if (k === "-" || k === "_") return claim("zoom", () => tabManager.zoom(-1));
  if (k === "0") return claim("zoom", () => tabManager.zoom(0));
  if (/^[1-9]$/.test(k)) return claim("select-tab", () => tabManager.selectTabByNumber(Number(k)));
}

function attachShortcuts(wc) {
  wc.on("before-input-event", handleInput);
}

module.exports = { attachShortcuts };
