const { BrowserView, Menu, clipboard, dialog, shell } = require("electron");
const path = require("path");
const state = require("../state");
const { TAB_STRIP_HEIGHT, TOOLBAR_HEIGHT, BOOKMARKS_BAR_HEIGHT, MAX_TABS, NEWTAB_URL, SETTINGS_URL, RESTRICTED_HOME_URL, MANAGER_URL, DOWNLOADS_URL, TAB_PARTITION } = require("../constants");
const restricted = require("../restricted");
const { resolveInput } = require("../urlInput");
const settings = require("../settings");
const popup = () => require("../popup");
const { buildErrorPage } = require("../pages/errorPage");
const bookmarks = require("../bookmarks/bookmarkStore");

// Hosts the user chose to "Proceed anyway" for after a certificate error. In memory only — it is
// gone when the app closes, and never written anywhere (no-history rule).
const allowedCertHosts = new Set();

// Tracks the last 20 closed tab URLs (in memory only) for Ctrl+Shift+T.
const closedTabsHistory = [];

// Only these external schemes may be handed to the OS, and only after the user confirms. Anything
// else (file:, javascript:, custom app schemes...) is dropped rather than launched.
const EXTERNAL_SCHEMES = new Set(["mailto:", "tel:", "sms:"]);

function notifyTabs() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  try {
    const s = getTabState();
    state.mainWindow.webContents.send("tabs:changed", s);
    const active = s.tabs.find((t) => t.id === s.activeTabId);
    state.mainWindow.setTitle(active && active.title ? active.title + " — PBCalc" : "PBCalc");
  } catch (_) {}
  popup().refresh();
}

function sendToShell(channel, ...args) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  try {
    state.mainWindow.webContents.send(channel, ...args);
  } catch (_) {}
}

const isNewTabUrl = (u) => String(u || "").startsWith(NEWTAB_URL);
const isSettingsUrl = (u) => String(u || "").startsWith(SETTINGS_URL);
const isHomeUrl = (u) => String(u || "").startsWith(RESTRICTED_HOME_URL);
const isManagerUrl = (u) => String(u || "").startsWith(MANAGER_URL);
const isDownloadsUrl = (u) => String(u || "").startsWith(DOWNLOADS_URL);

// Address-bar text for our own pages, Chrome-style (chrome://settings -> pbcalc://settings).
function displayUrlFor(u) {
  if (isNewTabUrl(u)) return "";
  if (isSettingsUrl(u)) return "pbcalc://settings";
  if (isManagerUrl(u)) return "pbcalc://bookmarks";
  if (isDownloadsUrl(u)) return "pbcalc://downloads";
  return u || "";
}

function zoomPercentOf(t) {
  const wc = t.view.webContents;
  return wc.isDestroyed() ? 100 : Math.round(Math.pow(1.2, wc.getZoomLevel()) * 100);
}

// What the omnibox's leading icon should say about the page: "internal" (new tab / our error
// pages: no site info), "secure" (https, valid cert), "insecure" (http), "local" (file:, etc.).
// Chrome's fallback tab title for a page without a <title>: the address without its scheme.
function titleFromUrl(url) {
  const u = String(url || "");
  if (/^about:/i.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return u;
}

function siteKind(tab) {
  const u = String(tab.url || "");
  if (state.restricted || tab.errorPage || !u || isNewTabUrl(u) || isSettingsUrl(u) || isHomeUrl(u) || isManagerUrl(u) || isDownloadsUrl(u)) return "internal";
  if (u.startsWith("https://")) return "secure";
  if (u.startsWith("http://")) return "insecure";
  return "local";
}

function chromeHeight() {
  if (state.mainWindow && !state.mainWindow.isDestroyed() && state.mainWindow.isFullScreen()) return 0;
  return TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT + (state.bookmarksBarVisible ? BOOKMARKS_BAR_HEIGHT : 0);
}

function getTabState() {
  return {
    activeTabId: state.activeTabId,
    bookmarksBarVisible: state.bookmarksBarVisible,
    restricted: !!state.restricted,
    tabs: state.tabs.map((t) => {
      const wc = t.view.webContents;
      const alive = !wc.isDestroyed();
      return {
        id: t.id,
        title: t.title || "New Tab",
        url: state.restricted ? "" : displayUrlFor(t.url), // Restricted Mode never reveals addresses
        zoom: zoomPercentOf(t),
        siteKind: siteKind(t),
        favicon: t.favicon || "",
        canGoBack: alive && wc.navigationHistory.canGoBack(),
        canGoForward: alive && wc.navigationHistory.canGoForward(),
        loading: alive && wc.isLoading(),
      };
    }),
  };
}

function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

function activeWebContents() {
  const t = getActiveTab();
  const wc = t && t.view.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

function resizeActiveView() {
  const tab = getActiveTab();
  if (!tab || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  const isFS = state.mainWindow.isFullScreen();
  const [w, h] = state.mainWindow.getContentSize();
  const top = isFS ? 0 : chromeHeight();
  tab.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
}

// opts.background: open without switching to it (middle-click / ctrl-click on a link).
// Restricted Mode: nothing may open a tab unless it passes opts.allowRestricted (the home page, a
// preset bookmark, or a same-site popup) — so every "new tab" path (shortcut, IPC, menu, page
// scripts) is refused here, in one place, rather than hidden only in the UI.
function createTab(url, opts = {}) {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return getTabState();
  if (state.tabs.length >= MAX_TABS) return getTabState();
  if (state.restricted && !opts.allowRestricted) return getTabState();

  const view = opts.webContents
    ? new BrowserView({ webContents: opts.webContents })
    : new BrowserView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // Only a duplicated tab carries this flag; its preload then asks for the source tab's
          // sessionStorage before any page script runs. Every other tab skips that round trip.
          additionalArguments: opts.sessionRestore ? ["--pbcalc-restore-session"] : [],
          // The user specifically requested that cache is kept in memory to speed up page loads, but
          // never touches the disk and is wiped completely on close. An ephemeral partition does exactly
          // this. NOTE: main.js (UA/headers) and downloadManager (will-download) MUST target this same
          // session (constants.TAB_PARTITION), or tabs leak the Electron UA and downloads are not caught.
          partition: TAB_PARTITION,
          preload: path.join(__dirname, "..", "..", "preloads", "tab-preload.js"),
        },
      });

  // The page canvas stays WHITE even when PBCalc's own UI is dark. Chromium otherwise paints the
  // base background of a page that sets none in its dark colour (measured: #3C3C3C), which made
  // ordinary light websites look dark-themed. Chrome does not do that: measured with
  // --force-dark-mode, a page still paints white while reporting prefers-color-scheme: dark
  // (scripts/chrome-reference/capture-darkmode.ps1). Our dark theme is for the browser, not the web.
  view.setBackgroundColor("#ffffff");



  const tab = {
    id: state.nextTabId++,

    view,
    childWindow: opts.childWindow || null,
    title: "New Tab",
    url: opts.webContents ? view.webContents.getURL() : "",
    favicon: "",
    // Set while the tab is showing one of our own error pages; holds what "Try again" reloads.
    errorPage: null,
    lastCertError: null,
    // Restricted Mode: the site this tab is confined to, the bookmark it came from, and whether it
    // is still the (empty) home page.
    site: opts.site || null,
    bookmarkId: opts.bookmarkId || null,
    // The tab whose window.open / target=_blank created this one. Only used to go back to it when this
    // tab turns out to have been opened just to start a download (closeTabOpenedForDownload).
    openerId: opts.openerId || null,
    isHome: !!(state.restricted && !url),
  };
  if (opts.sessionRestore) {
    state.pendingSessionRestore.set(view.webContents.id, {
      origin: opts.sessionRestore.origin,
      data: opts.sessionRestore.data,
      at: Date.now(),
    });
  }

  if (typeof opts.index === "number" && opts.index >= 0 && opts.index <= state.tabs.length) {
    state.tabs.splice(opts.index, 0, tab);
  } else {
    state.tabs.push(tab);
  }
  wireTabEvents(tab);

  if (opts.background && state.activeTabId != null) {
    // Not attached to the window: only the active tab's view ever is (see switchTab).
  } else {
    switchTab(tab.id);
  }
  if (opts.restore && opts.restore.entries && opts.restore.entries.length) {
    // Duplicate: adopt the source tab's whole back/forward list instead of a plain load, so Back
    // works in the copy exactly as it did in the original (that is what Chrome's Duplicate does).
    Promise.resolve(view.webContents.navigationHistory.restore(opts.restore))
      .catch(() => load(view.webContents, url || NEWTAB_URL));
  } else if (!opts.webContents) {
    load(view.webContents, url || (state.restricted ? RESTRICTED_HOME_URL : NEWTAB_URL));
  }
  // switchTab gave the page focus before the load began, which a brand-new view ignores: repeat it now.
  if (state.activeTabId === tab.id) focusActivePageUnlessShell();

  notifyTabs();
  return getTabState();
}

// loadURL rejects when the load fails, but the did-fail-load handler below already shows the error
// page for that; without a catch Electron also prints an "Failed to load URL" warning to the
// console for every unreachable site.
function load(wc, url) {
  if (wc.isDestroyed()) return;
  wc.loadURL(url).catch(() => {});
}

function openInNewTab(url, background = false) {
  createTab(url, { background });
}

function handleExternalUrl(url) {
  if (state.restricted) return; // no external applications in Restricted Mode
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return;
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return;
  const win = state.mainWindow;
  dialog
    .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: "question",
      buttons: ["Open", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Open external application?",
      message: "This page wants to open an external application.",
      detail: url.length > 200 ? url.slice(0, 200) + "…" : url,
    })
    .then((r) => { if (r.response === 0) shell.openExternal(url); })
    .catch(() => {});
}

function showError(tab, info) {
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return;
  tab.errorPage = { kind: info.kind, url: info.url };
  tab.title = info.kind === "crash" ? "Page crashed" : info.kind === "blocked" ? "Site blocked" : "Can’t reach this page";
  load(wc, buildErrorPage({ ...info, hideUrl: state.restricted }));
}

const originOfUrl = (u) => { try { return new URL(u).origin; } catch (_) { return String(u || ""); } };

// Our own local pages get their own tab icon instead of the default globe. It is built HERE rather
// than declared in the page, because the glyph has to follow the Windows app mode: a
// prefers-color-scheme rule inside an SVG favicon is NOT applied by Chromium (measured: the ink
// came out the same grey in both modes), while from the main process we know which mode is on and
// can rebuild the icon when it changes. Greys match the strip's default icon colour.
const INTERNAL_ICONS = {
  newtab: "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  manager: "M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z",
  downloads: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  home: "M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z",
};

function svgIcon(d) {
  const fill = require("electron").nativeTheme.shouldUseDarkColors ? "#9aa0a6" : "#5f6368";
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='${fill}' d='${d}'/></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// The New Tab page carries PBCalc's own logo, in colour, exactly as a site's favicon would —
// read from assets/icon-32.png (generated from assets/icon.svg by scripts/make-icons.js).
let appIconDataUrl = null;
function appIcon() {
  if (appIconDataUrl === null) {
    try {
      const f = require("path").join(__dirname, "..", "..", "assets", "icon-32.png");
      appIconDataUrl = "data:image/png;base64," + require("fs").readFileSync(f).toString("base64");
    } catch (_) {
      appIconDataUrl = ""; // missing asset: fall back to the grey glyph below
    }
  }
  return appIconDataUrl;
}

function internalFaviconFor(u) {
  if (isNewTabUrl(u)) return appIcon() || svgIcon(INTERNAL_ICONS.newtab);
  if (isSettingsUrl(u)) return svgIcon(INTERNAL_ICONS.settings);
  if (isManagerUrl(u)) return svgIcon(INTERNAL_ICONS.manager);
  if (isDownloadsUrl(u)) return svgIcon(INTERNAL_ICONS.downloads);
  if (isHomeUrl(u)) return svgIcon(INTERNAL_ICONS.home);
  return "";
}

// Light/dark flipped: redraw the icons of every open internal page.
function refreshInternalFavicons() {
  let changed = false;
  state.tabs.forEach((t) => {
    const icon = internalFaviconFor(t.url);
    if (icon && icon !== t.favicon) { t.favicon = icon; changed = true; }
  });
  if (changed) notifyTabs();
}
require("electron").nativeTheme.on("updated", refreshInternalFavicons);

// Our own local pages are never shown as a file path: they have proper names, and after a reload
// there may be no page-title-updated to put one back.
function internalTitleFor(u) {
  if (isNewTabUrl(u)) return "New Tab";
  if (isSettingsUrl(u)) return "Settings";
  if (isDownloadsUrl(u)) return "Downloads";
  if (isManagerUrl(u)) return "Bookmark manager";
  if (isHomeUrl(u)) return "Your sites";
  return "";
}

function wireTabEvents(tab) {
  const wc = tab.view.webContents;
  // Lazy: shortcuts.js requires this module, so requiring it at the top would be circular.
  require("../shortcuts").attachShortcuts(wc);
  require("../contextMenu").attachContextMenu(wc, { openInNewTab: (u) => openInNewTab(u, true) });
  // No developer tools in Restricted Mode, however they were opened.
  wc.on("devtools-opened", () => { if (state.restricted) wc.closeDevTools(); });

  // A page can end itself: an OAuth / sign-in popup calls window.close() when it is done (ChatGPT, Google). Chromium
  // then destroys its webContents, but nothing told the strip, so the tab stayed as the ACTIVE tab with no page behind
  // it ("New Tab", spinning) and the next reload / shortcut threw "Cannot read properties of undefined". Chrome closes
  // the tab and goes back to the page that opened it. Our own closeTab removes the tab from the list BEFORE it
  // destroys the page, so this only fires for pages that ended themselves.
  wc.once("destroyed", () => closePageEndedTab(tab));
  wc.on("page-title-updated", (_e, title) => { if (!tab.errorPage) tab.title = title; notifyTabs(); });
  wc.on("page-favicon-updated", (_e, favicons) => {
    tab.favicon = (favicons && favicons[0]) || "";
    learnBookmarkIcon(tab);
    notifyTabs();
  });
  wc.on("did-navigate", (_e, url) => {
    // While one of our error pages is showing, the address bar keeps the URL that failed.
    if (tab.errorPage && url.startsWith("data:")) tab.url = tab.errorPage.url;
    else {
      const prevUrl = tab.url;
      const reload = prevUrl === url; // F5 / Ctrl+R on the same address
      tab.errorPage = null;
      tab.url = url;
      // Reloading keeps the icon and the title, like Chrome: a reload re-uses the cached favicon
      // and often fires neither page-favicon-updated nor page-title-updated, so clearing them here
      // left the tab with no icon and (for a local page) the file path as its title.
      const internalIcon = internalFaviconFor(url);
      if (internalIcon) tab.favicon = internalIcon; // our own pages always carry their own icon
      if (!reload) {
        if (!internalIcon && originOfUrl(prevUrl) !== originOfUrl(url)) tab.favicon = ""; // another site: Chrome drops it
        // A page with no <title> never fires page-title-updated, so without this the tab would keep
        // the PREVIOUS page's title. Chrome shows the address instead (never in Restricted Mode).
        tab.title = state.restricted ? "" : internalTitleFor(url) || titleFromUrl(url);
      }
    }
    notifyTabs();
  });
  wc.on("did-navigate-in-page", (_e, url) => { tab.url = url; notifyTabs(); });
  wc.on("did-start-loading", notifyTabs);
  wc.on("did-stop-loading", notifyTabs);

  // ── Load failures ─────────────────────────────────────────────────────
  wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED: user pressed stop / navigated away — not an error
    if (validatedURL && validatedURL.startsWith("data:")) return; // our own error page
    if (errorCode === -302) { // ERR_UNKNOWN_URL_SCHEME: mailto:, tel:, ...
      handleExternalUrl(validatedURL);
      return;
    }
    const isCert = errorCode <= -200 && errorCode >= -299;
    showError(tab, {
      kind: isCert ? "cert" : "load",
      url: validatedURL,
      code: errorCode,
      description: errorDescription,
    });
  });

  wc.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit") return;
    showError(tab, { kind: "crash", url: tab.url || wc.getURL(), description: details.reason });
  });

  // Invalid HTTPS certificate: refuse by default; the error page offers an explicit per-host
  // "Proceed anyway". Remembered for this run only.
  wc.on("certificate-error", (event, url, _error, _certificate, callback) => {
    let host = "";
    try { host = new URL(url).host; } catch (_) {}
    if (host && allowedCertHosts.has(host)) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // ── Navigation interception ───────────────────────────────────────────
  // Restricted Mode: a tab may only stay inside its own site. Main-frame navigations (link clicks,
  // form posts, redirects) to anywhere else are cancelled; sub-resources and iframes are not
  // touched, so the site's own CDNs / fonts / embeds keep working. If the very first load is
  // bounced (nothing on screen yet) the tab shows a "blocked" page instead of staying blank.
  const blockIfOutside = (event, url) => {
    // Restricted Mode checks
    if (!state.restricted) return false;
    if (restricted.sameSite(url, tab.site)) return false;
    event.preventDefault();
    if (!wc.getURL() || wc.getURL() === "about:blank") showError(tab, { kind: "blocked", url });
    return true;
  };
  wc.on("will-redirect", (event, url) => { blockIfOutside(event, url); });

  wc.on("will-navigate", (event, url) => {
    if (url.startsWith("pbcalc://")) {
      event.preventDefault();
      // Honoured only while this tab is really showing one of our error pages.
      if (!tab.errorPage || !wc.getURL().startsWith("data:")) return;
      const failed = tab.errorPage.url;
      if (url === "pbcalc://retry" && failed) {
        tab.errorPage = null;
        load(wc, failed);
      } else if (url === "pbcalc://proceed" && failed && !state.restricted) {
        try { allowedCertHosts.add(new URL(failed).host); } catch (_) {}
        tab.errorPage = null;
        load(wc, failed);
      }
      return;
    }
    if (blockIfOutside(event, url)) return;
    let protocol = "";
    try { protocol = new URL(url).protocol; } catch (_) {}
    if (EXTERNAL_SCHEMES.has(protocol)) {
      event.preventDefault();
      handleExternalUrl(url);
    }
  });

  // Belt-and-suspenders: close DevTools if opened/navigated on an internal page
  wc.on("devtools-opened", () => {
    if (!isInspectable(wc)) wc.closeDevTools();
  });
  wc.on("did-navigate", () => {
    if (wc.isDevToolsOpened() && !isInspectable(wc)) wc.closeDevTools();
  });

  wc.on("did-create-window", (childWindow, details) => {
    try { childWindow.hide(); } catch (_) {}
    const childUrl = details.url || (childWindow.webContents && !childWindow.webContents.isDestroyed() ? childWindow.webContents.getURL() : "");
    const background = details.disposition === "background-tab";
    createTab(childUrl, {
      allowRestricted: true,
      site: tab.site,
      background,
      webContents: childWindow.webContents,
      childWindow,
      openerId: tab.id,
    });
  });

  // target="_blank" / window.open / middle-click / ctrl-click become tabs in this window rather
  // than popup windows. Returning action:"allow" with overrideBrowserWindowOptions preserves native
  // window.opener linkage so cross-origin authentication handshakes (e.g. koffionline.in) work.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    let protocol = "";
    try { protocol = new URL(url).protocol; } catch (_) {}
    if (state.restricted) {
      // Same-site popups (e.g. an ERP report) open as tabs; everything else is dropped.
      if (restricted.sameSite(url, tab.site)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: { show: false, width: 0, height: 0 },
        };
      }
      return { action: "deny" };
    }
    if (EXTERNAL_SCHEMES.has(protocol)) {
      handleExternalUrl(url);
      return { action: "deny" };
    }
    if (/^https?:$/.test(protocol) || protocol === "about:" || !protocol) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { show: false, width: 0, height: 0 },
      };
    }
    return { action: "deny" };
  });

  // Find-in-page results feed the shell's find bar.
  wc.on("found-in-page", (_e, result) => {
    popup().sendFindResult({ active: result.activeMatchOrdinal, total: result.matches });
  });

  wc.on("enter-html-full-screen", () => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.setFullScreen(true);
    }
  });
  wc.on("leave-html-full-screen", () => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.setFullScreen(false);
    }
  });
}

// Preview image for the hover card: a small JPEG of the page, kept in memory on the tab only.
async function captureThumb(tab) {
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) return;
  try {
    const img = await wc.capturePage();
    if (img.isEmpty()) return;
    tab.thumb = "data:image/jpeg;base64," + img.resize({ width: 512 }).toJPEG(65).toString("base64");
  } catch (_) {}
}

// What the hover card shows for a tab. A tab that is on screen is captured fresh; a background tab
// uses the picture taken when it was switched away from. The site name is never given in
// Restricted Mode.
async function hoverInfo(id) {
  const tab = state.tabs.find((t) => t.id === Number(id));
  if (!tab || tab.view.webContents.isDestroyed()) return null;
  // Chrome shows no preview for the tab you are already looking at — the page itself is on screen
  // right below the card. Only background tabs get a thumbnail (their last capture).
  const active = tab.id === state.activeTabId;
  let host = "";
  if (!state.restricted && !isNewTabUrl(tab.url) && !isSettingsUrl(tab.url) && !isManagerUrl(tab.url) && !isHomeUrl(tab.url) && !isDownloadsUrl(tab.url)) {
    try { host = new URL(tab.url).host.replace(/^www\./, ""); } catch (_) {}
  }
  return { title: tab.title || "New Tab", host, thumb: active ? "" : tab.thumb || "" };
}

function switchTab(id) {
  const next = state.tabs.find((t) => t.id === Number(id));
  if (!next || !state.mainWindow || state.mainWindow.isDestroyed()) return getTabState();

  if (state.activeTabId !== next.id) {
    if (state.findOpen) closeFind();
    if (popup().isOpen()) popup().close();
    require("../hovercard").hide();
    require("../omnibox").hide();
  }

  const current = getActiveTab();
  const leaving = current && current.id !== next.id && !current.view.webContents.isDestroyed() ? current : null;
  // Take the preview picture while the old page is still on screen. It is detached a moment later
  // (once the picture is taken, or after 300ms at most), underneath the new page that already
  // covers it, so there is no flash.
  const pictureTaken = leaving ? captureThumb(leaving) : null;

  state.activeTabId = next.id;
  try {
    state.mainWindow.addBrowserView(next.view);
  } catch (_) {}
  if (leaving) {
    Promise.race([pictureTaken, new Promise((r) => setTimeout(r, 300))]).then(() => {
      if (state.activeTabId === leaving.id) return; // switched back in the meantime: keep it
      try { if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.removeBrowserView(leaving.view); } catch (_) {}
    });
  }
  // KEYBOARD FOCUS FOLLOWS THE SWITCH — unless the user is working in the shell (typing in the
  // address bar, or just clicked the tab strip). Measured before this existed: after ANY switch that
  // started from a focused page or a popup (Ctrl+Shift+O, Ctrl+Shift+J, Ctrl+Tab, Ctrl+1..9, the ⋮ menu,
  // tab search, closing the active tab, Ctrl+Shift+T) focus sat on the old page at 5ms and was NOBODY
  // by 100ms: the old view is detached a moment later and takes focus with it, while the new view was
  // only attached, never focused. From then on every shortcut reached no before-input-event handler
  // until a mouse click gave focus back — "the shortcut stopped working, opening it manually did".
  focusActivePageUnlessShell();
  resizeActiveView();
  notifyTabs();
  return getTabState();
}

// Give a tab's page keyboard focus (the page view, not the shell), so the next keystroke reaches a
// before-input-event handler. switchTab calls it for every tab change; see the note there.
function focusTabPage(tab) {
  try { if (tab && tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus(); } catch (_) {}
}

// The rule from switchTab: the active page takes keyboard focus unless the shell (address bar, tab
// strip) already has it. createTab calls this again AFTER it has started the load: a brand-new view
// does not accept focus until then, so the call inside switchTab (which runs before loadURL) is lost
// for new tabs — measured: Ctrl+Shift+O, Ctrl+Shift+J and ⋮ → Settings still left nobody focused.
function focusActivePageUnlessShell() {
  if (!state.mainWindow || state.mainWindow.isDestroyed() || state.mainWindow.webContents.isFocused()) return;
  focusTabPage(getActiveTab());
}

// The tab's page is already gone (see wireTabEvents): take the tab out of the strip like Chrome, back to its opener.
function closePageEndedTab(tab) {
  if (!state.tabs.includes(tab)) return; // we closed it ourselves
  const wasActive = state.activeTabId === tab.id;
  const opener = state.tabs.find((t) => t.id === tab.openerId);
  closeTab(tab.id, { pageGone: true });
  if (wasActive && opener && state.tabs.includes(opener)) switchTab(opener.id);
}

function closeTab(id, opts = {}) {
  const idx = state.tabs.findIndex((t) => t.id === Number(id));
  if (idx === -1) return getTabState();

  require("../hovercard").hide();
  const [removed] = state.tabs.splice(idx, 1);

  // Push to history (skipping error pages or local pbcalc:/file: pages) before webContents is destroyed
  let entry = null;
  try {
    if (opts.pageGone) throw new Error("page ended itself: not offered by Ctrl+Shift+T");
    const url = removed.url || removed.view.webContents.getURL();
    if (url && url !== "about:blank" && !url.startsWith("pbcalc:") && !url.startsWith("chrome:") && !url.startsWith("file:") && !url.startsWith("data:")) {
      entry = { url, index: idx, session: null, pending: null };
      closedTabsHistory.push(entry);
      if (closedTabsHistory.length > 20) closedTabsHistory.shift();
    }
  } catch (_) {}

  if (state.adminTabId === removed.id) state.adminTabId = null; // admin session ends with its tab
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    try {
      state.mainWindow.removeBrowserView(removed.view);
    } catch (_) {}
  }
  // The tab disappears from the strip and the window right now; only the page behind it lingers for
  // the few milliseconds it takes to read its sessionStorage. That storage belongs to the TAB and dies
  // with its webContents, and reading it is asynchronous — so the page has to outlive this call. (The
  // PB ERP keeps its login there: without this a restored tab showed the LOGIN page, while Chrome's
  // "reopen closed tab" brings the tab's sessionStorage back. Cookies/localStorage were never lost:
  // every tab shares one session.) Held in memory only, like the rest of the closed-tab list.
  const closedWc = removed.view.webContents; // undefined when the page already ended itself
  const destroyPage = () => {
    if (removed.childWindow && !removed.childWindow.isDestroyed()) {
      try { removed.childWindow.destroy(); } catch (_) {}
    }
    if (closedWc && !closedWc.isDestroyed()) closedWc.destroy();
  };
  if (entry) {
    entry.pending = Promise.race([snapshotSessionStorage(closedWc), new Promise((r) => setTimeout(() => r(null), SESSION_SNAPSHOT_MS))])
      .then((data) => { entry.session = packSessionStorage(entry.url, data); })
      .catch(() => {})
      .then(destroyPage);
  } else {
    destroyPage();
  }

  if (state.activeTabId === removed.id) {
    state.activeTabId = null;
    // Like Chrome: the tab to the right takes over, or the one to the left when it was the last.
    const nextTab = state.tabs[Math.min(idx, state.tabs.length - 1)];
    // (switchTab hands keyboard focus to it — closing the focused tab otherwise leaves nobody
    // focused and the next Ctrl+W / Ctrl+Shift+T goes nowhere; Chrome closes tab after tab.)
    if (nextTab) switchTab(nextTab.id);
  }

  // Like Chrome: closing the last tab closes the window, which quits the app (and runs the
  // no-history wipe in privacy.js).
  if (state.tabs.length === 0) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.close();
    return getTabState();
  }

  notifyTabs();
  return getTabState();
}

// Chrome closes a tab that was opened only to start a download: a site's "Download" button often does
// window.open(url) or a target=_blank link, the new tab appears for a moment, the response turns out
// to be a file, and the tab closes itself (the download carries on) and you are back on the page you
// were on. Called by the download manager when a download starts in `wc`.
// MEASURED at that moment (probe: scripts/chrome-reference/README.md notes): a tab opened by
// window.open / target=_blank / a redirect that ends in a file has wc.getURL() === "" — nothing was
// ever committed, so it has never shown a page — whereas a download started by a link on a page that
// IS showing (same-tab link) has that page's URL. Only the first kind closes; a tab showing a page
// stays, as does the last tab (closing it would quit the app).
function closeTabOpenedForDownload(wc) {
  if (!wc || wc.isDestroyed() || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  const tab = state.tabs.find((t) => t.view.webContents === wc);
  if (!tab || state.tabs.length < 2) return;
  const shown = wc.getURL();
  if (shown && shown !== "about:blank") return;
  const wasActive = state.activeTabId === tab.id;
  const opener = state.tabs.find((t) => t.id === tab.openerId);
  closeTab(tab.id);
  // Chrome returns to the page the tab was opened from. Without this the neighbour to the left of the
  // strip's end would take over, which is not where the user was. Only if the user is still on the
  // download tab: if they already moved elsewhere in those milliseconds, leave them there.
  if (wasActive && opener && state.tabs.includes(opener)) switchTab(opener.id);
}

// How long a closing tab's page may linger so its sessionStorage can be read (see closeTab).
const SESSION_SNAPSHOT_MS = 400;
// A closed tab's sessionStorage is kept only if it is a sensible size: it sits in memory with the
// closed-tab list, and one runaway page should not be able to fill it.
const SESSION_SNAPSHOT_MAX_BYTES = 512 * 1024;

// {origin, data} in the shape createTab({sessionRestore}) wants, or null when there is nothing worth
// keeping (no storage, no readable origin, or too big).
function packSessionStorage(url, data) {
  if (!data || typeof data !== "object" || !Object.keys(data).length) return null;
  let origin = "";
  try { origin = new URL(url).origin; } catch (_) {}
  if (!origin || origin === "null") return null;
  try { if (JSON.stringify(data).length > SESSION_SNAPSHOT_MAX_BYTES) return null; } catch (_) { return null; }
  return { origin, data };
}

// Several quick Ctrl+Shift+T presses must restore tabs in order even though each may wait a moment for
// its sessionStorage snapshot, so the restores are chained.
let reopenChain = Promise.resolve();

function reopenClosedTab() {
  if (closedTabsHistory.length === 0) return;
  const entry = closedTabsHistory.pop(); // taken now, so the list stays LIFO however long a snapshot takes
  reopenChain = reopenChain.then(async () => {
    try { if (entry.pending) await entry.pending; } catch (_) {}
    // Chrome's reopen-closed-tab brings the tab's sessionStorage back with it, so a site that keeps
    // its login there (the PB ERP) is still logged in; the same mechanism Duplicate uses.
    const opts = { index: entry.index, sessionRestore: entry.session || null };
    if (state.restricted) opts.allowRestricted = true;
    // (createTab -> switchTab hands the restored page keyboard focus, so the NEXT Ctrl+Shift+T still
    // reaches a handler; see the note in switchTab.)
    createTab(entry.url, opts);
  }).catch(() => {});
  return reopenChain;
}

function cycleTab(dir) {
  if (state.tabs.length < 2) return;
  const i = state.tabs.findIndex((t) => t.id === state.activeTabId);
  const n = (i + dir + state.tabs.length) % state.tabs.length;
  switchTab(state.tabs[n].id);
}

// Ctrl+1..8 = that tab, Ctrl+9 = last tab (Chrome behaviour).
function selectTabByNumber(n) {
  if (!state.tabs.length) return;
  const tab = n === 9 ? state.tabs[state.tabs.length - 1] : state.tabs[n - 1];
  if (tab) switchTab(tab.id);
}

// A bare search term (no scheme, no dot that looks like a domain) goes to a search engine, same
// as typing into any real browser's address bar. Anything else gets https:// assumed onto it if
// it has no scheme of its own yet.
function navigate(url) {
  if (state.restricted) return; // no address bar in Restricted Mode: nothing may navigate by URL
  const tab = getActiveTab();
  if (!tab) return;
  let target = String(url || "").trim();
  if (!target) return;

  // Our own pages, typed like chrome://settings.
  const internal = target.toLowerCase().replace(/\/+$/, "");
  if (internal === "pbcalc://settings") target = SETTINGS_URL;
  else if (internal === "pbcalc://bookmarks") target = MANAGER_URL;
  else if (internal === "pbcalc://downloads") target = DOWNLOADS_URL;
  else if (internal === "pbcalc://newtab") target = NEWTAB_URL;

  target = resolveInput(target);

  tab.errorPage = null;
  load(tab.view.webContents, target);
}

function goBack() {
  const wc = activeWebContents();
  if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}
function goForward() {
  const wc = activeWebContents();
  if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
}
function reload() {
  const t = getActiveTab();
  if (!t || !t.view.webContents || t.view.webContents.isDestroyed()) return;
  // On an error page, reloading means retrying the URL that failed, not reloading the data: page.
  if (t.errorPage) {
    const failed = t.errorPage.url;
    t.errorPage = null;
    load(t.view.webContents, failed);
  } else {
    t.view.webContents.reload();
  }
}

// ── Address bar / shell focus ───────────────────────────────────────────
function focusAddressBar() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.mainWindow.webContents.focus();
  sendToShell("shell:focus-url");
}

// ── Find in page ────────────────────────────────────────────────────────
// The find box is a small popup bubble over the top-right of the page (like Chrome), see popup.js.
function openFind() {
  if (!state.mainWindow || state.mainWindow.isDestroyed()) return;
  state.findOpen = true;
  popup().open("find", null);
}

function findText(text, opts = {}) {
  const wc = activeWebContents();
  if (!wc) return;
  const q = String(text || "");
  if (!q) {
    wc.stopFindInPage("clearSelection");
    popup().sendFindResult({ active: 0, total: 0 });
    return;
  }
  // findNext is only ever passed as true: an explicit `findNext: false` on the first search of a
  // page makes Chromium return no results at all (verified against Electron 41).
  const o = { forward: opts.forward !== false };
  if (opts.findNext) o.findNext = true;
  wc.findInPage(q, o);
}

function closeFind() {
  const wc = activeWebContents();
  if (wc) wc.stopFindInPage("clearSelection");
  state.findOpen = false;
  popup().close(); // also hands keyboard focus back to the page
}

// ── Zoom / print / devtools ─────────────────────────────────────────────
// dir: +1 / -1 step (0.5 zoom-level, ~20%), 0 = reset. Per tab, clamped to 25%..500%.
function zoom(dir) {
  const wc = activeWebContents();
  if (!wc) return;
  if (dir === 0) wc.setZoomLevel(0);
  else wc.setZoomLevel(Math.max(-3, Math.min(5, wc.getZoomLevel() + dir * 0.5)));
  notifyTabs();
}

function printActive() {
  const wc = activeWebContents();
  if (wc) wc.print({ printBackground: true });
}

function isInspectable(wc) {
  if (!wc || wc.isDestroyed()) return false;
  try {
    const p = new URL(wc.getURL()).protocol;
    return p === "http:" || p === "https:";
  } catch (_) {
    return false;
  }
}

function openDevTools() {
  if (state.restricted) return;
  const wc = activeWebContents();
  if (!wc || wc.isDestroyed() || !isInspectable(wc)) return;

  if (wc.isDevToolsOpened()) {
    if (wc.isDevToolsFocused()) {
      wc.closeDevTools();
    } else {
      try {
        if (wc.devToolsWebContents && !wc.devToolsWebContents.isDestroyed()) {
          wc.devToolsWebContents.focus();
        }
      } catch (_) {}
      wc.openDevTools({ mode: "detach" });
    }
  } else {
    wc.openDevTools({ mode: "detach" });
  }
}

// The star / Ctrl+D, like Chrome: a page that is not bookmarked is added and the "Bookmark added" bubble opens
// under the star (Name, Folder, Done, Remove); on a page that already is, the same bubble opens as "Edit
// bookmark". The star never removes by itself any more - Remove is in the bubble.
// A bookmarked page that is showing its icon gives it to its bookmark if the bookmark has none (see
// bookmarkStore.learnIcon). Not in Restricted Mode: the list is read-only there.
function learnBookmarkIcon(tab) {
  if (state.restricted || !tab || !tab.favicon || !tab.url) return;
  if (bookmarks.learnIcon(tab.url, tab.favicon)) broadcastBookmarks();
}

function toggleBookmarkActive() {
  if (state.restricted) return bookmarks.list(); // bookmarks are read-only in Restricted Mode
  const wc = activeWebContents();
  if (!wc) return bookmarks.list();
  const tab = getActiveTab();
  const url = tab.url || wc.getURL();
  if (!bookmarks.isBookmarkable(url)) return bookmarks.list();
  let added = false;
  if (!bookmarks.list().some((b) => b.url === url)) {
    bookmarks.toggle({ url, title: wc.getTitle(), favicon: tab.favicon });
    added = true;
  }
  const list = bookmarks.list();
  sendToShell("bookmarks:changed", list);
  const b = list.find((x) => x.url === url);
  if (b) showBookmarkBubble(b.id, added);
  return list;
}

// Anchored under the star: read its real rectangle from the shell (the toolbar is flexbox, not constants).
async function showBookmarkBubble(id, added) {
  let rect = null;
  try {
    rect = await state.mainWindow.webContents.executeJavaScript('(() => { const e = document.getElementById("bookmark"); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()');
  } catch (_) {}
  if (state.restricted) return;
  popup().open("bookmark-edit", rect, { bookmarkId: id, bubble: true, added });
}

// Allowed in Restricted Mode as well: this only shows or hides the bar, it cannot change what is
// in it. (Everything that EDITS bookmarks stays blocked there.)
function toggleBookmarksBar() {
  state.bookmarksBarVisible = !state.bookmarksBarVisible;
  settings.set("showBookmarksBar", state.bookmarksBarVisible);
  resizeActiveView();
  notifyTabs();
  broadcastSettings();
}

// Settings live in an ordinary tab (like chrome://settings); reuse it if already open.
// In Restricted Mode the page is still available (Mode, zoom-type preferences...) — it just hides
// the Restricted Mode section and the bookmarks-bar switch.
function openSettings() {
  const existing = state.tabs.find((t) => isSettingsUrl(t.url));
  if (existing) return switchTab(existing.id);
  return createTab(SETTINGS_URL, { allowRestricted: true });
}

// The Downloads page (Ctrl+Shift+J here; plain Ctrl+J is left to the page, see shortcuts.js): reuse
// its tab if it is already open. Allowed in
// Restricted Mode too (it never shows addresses there).
function openDownloadsPage() {
  const existing = state.tabs.find((t) => isDownloadsUrl(t.url));
  if (existing) return switchTab(existing.id);
  return createTab(DOWNLOADS_URL, { allowRestricted: true });
}

// Bookmark manager tab (add / edit / remove / reorder the bookmark list). Normal mode: open freely.
// Restricted Mode: only with admin === true, which the caller passes after a successful PIN check;
// that tab becomes the one admin session (state.adminTabId) and closing it ends the session.
function openManager(admin) {
  if (state.restricted && admin !== true) return;
  const existing = state.tabs.find((t) => isManagerUrl(t.url));
  if (existing) {
    if (state.restricted) state.adminTabId = existing.id;
    return switchTab(existing.id);
  }
  createTab(MANAGER_URL, { allowRestricted: true });
  if (state.restricted) state.adminTabId = state.activeTabId;
}

// Is this webContents allowed to edit the bookmark list right now?
function isManagerSender(wc) {
  try {
    if (!String(wc.getURL()).startsWith(MANAGER_URL)) return false;
    if (!state.restricted) return true;
    const t = state.tabs.find((x) => x.id === state.adminTabId);
    return !!t && t.view.webContents === wc;
  } catch (_) {
    return false;
  }
}

function broadcastBookmarks() {
  sendToShell("bookmarks:changed", bookmarks.list());
}

// The hidden admin shortcut (Ctrl+Shift, then type "pbsecure"). Restricted Mode is only ever LEFT
// through the PIN box, so the shortcut cannot bypass the lock.
function secretToggle() {
  if (state.restricted) return popup().open("unlock", null);
  if (!bookmarks.list().length) return openSettings(); // nothing to allow yet: add bookmarks first
  enableRestricted();
}

// What the settings page displays. It is pushed to every open settings tab whenever one of these
// changes from ANY place (Ctrl+Shift+B, the ⋮ menu, Restricted Mode on/off...), so an open
// Settings page never shows a stale switch.
function settingsSnapshot() {
  return {
    themeMode: settings.get("themeMode"),
    searchSuggestions: !!settings.get("searchSuggestions"),
    version: require("../../package.json").version, // package.json is the one place to bump it
    downloads: require("../downloads/downloadManager").config(), // { dir, ask } for Settings → Downloads
    showBookmarksBar: state.bookmarksBarVisible,
    restricted: !!state.restricted,
  };
}

function broadcastSettings() {
  const snap = settingsSnapshot();
  state.tabs.forEach((t) => {
    if (!isSettingsUrl(t.url) || t.view.webContents.isDestroyed()) return;
    try { t.view.webContents.send("settings:changed", snap); } catch (_) {}
  });
}

function setSearchSuggestions(on) {
  settings.set("searchSuggestions", !!on);
  broadcastSettings();
}

function applyThemeMode(mode) {
  if (!["system", "light", "dark"].includes(mode)) return;
  settings.set("themeMode", mode);
  require("electron").nativeTheme.themeSource = mode;
  broadcastSettings();
}

function setBookmarksBarVisible(visible) {
  if (state.bookmarksBarVisible === !!visible) return;
  toggleBookmarksBar();
}

// Clicking a bookmark. Normal mode: load it in the current tab (as before). Restricted Mode: open
// it as its own tab confined to that site — or switch to the tab already showing it; from the
// home page it loads in place, like a new-tab tile.
function openBookmark(id, newTab = false) {
  const b = bookmarks.list().find((x) => x.id === String(id));
  if (!b) return;
  if (!state.restricted) {
    if (newTab) {
      // In Chrome, Ctrl+Click on a bookmark opens it in a new background tab
      return createTab(b.url, { background: true });
    }
    return navigate(b.url);
  }
  const site = restricted.siteOf(b.url);
  if (!site) return;
  
  if (newTab) {
    // Even in Restricted Mode, Ctrl+Click opens a new tab for the same site
    return createTab(b.url, { allowRestricted: true, site, bookmarkId: b.id, background: true });
  }
  
  const existing = state.tabs.find((t) => t.bookmarkId === b.id);
  if (existing) return switchTab(existing.id);
  const active = getActiveTab();
  if (active && active.isHome) {
    active.isHome = false;
    active.site = site;
    active.bookmarkId = b.id;
    active.errorPage = null;
    load(active.view.webContents, b.url);
    notifyTabs();
    return;
  }
  createTab(b.url, { allowRestricted: true, site, bookmarkId: b.id });
}

// Turn Restricted Mode on: every tab is dropped and the window restarts on the home page, so no
// unrestricted page survives into the locked session.
function enableRestricted() {
  state.restricted = true;
  state.adminTabId = null;
  if (popup().isOpen()) popup().close();
  const old = state.tabs.slice();
  createTab(null, { allowRestricted: true });
  old.forEach((t) => closeTab(t.id));
  resizeActiveView();
  notifyTabs();
  broadcastSettings();
}

function leaveRestricted() {
  state.restricted = false;
  state.adminTabId = null;
  state.tabs.forEach((t) => {
    if (t.isHome && !t.view.webContents.isDestroyed()) load(t.view.webContents, NEWTAB_URL);
    t.isHome = false;
    t.site = null;
  });
  resizeActiveView();
  notifyTabs();
  broadcastSettings();
}

function stop() {
  const wc = activeWebContents();
  if (wc) wc.stop();
}

// ── Tab management (drag-reorder, context menu) ─────────────────────────
function moveTab(id, index) {
  if (state.restricted) return;
  const from = state.tabs.findIndex((t) => t.id === Number(id));
  if (from === -1) return;
  const [t] = state.tabs.splice(from, 1);
  state.tabs.splice(Math.max(0, Math.min(index, state.tabs.length)), 0, t);
  notifyTabs();
}

// Everything the page kept in sessionStorage. Cookies and localStorage are shared by every tab
// already (one session), but sessionStorage belongs to the TAB, so a site that keeps its login
// there (as the PB ERP does) would show the login page in the copy without this.
async function snapshotSessionStorage(wc) {
  try {
    const data = await wc.executeJavaScript(
      '(() => { const d = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); d[k] = sessionStorage.getItem(k); } return d; })()',
      true,
    );
    return data && typeof data === "object" ? data : null;
  } catch (_) {
    return null; // no page, an error page, or a document that forbids storage access
  }
}

// Chrome's "Duplicate tab": a copy of the tab INCLUDING its navigation history AND its
// sessionStorage, opened immediately to the right of the original — so a logged-in page stays
// logged in, which is the whole point of duplicating it. Works in Restricted Mode too (the copy
// stays confined to the same bookmark's site). The approach is the one used by the sibling ERP
// shell: snapshot here, hand it to the copy's preload before any page script runs.
async function duplicateTab(id) {
  const tab = state.tabs.find((t) => t.id === Number(id));
  if (!tab || tab.view.webContents.isDestroyed()) return getTabState();
  let restore = null;
  try {
    const nav = tab.view.webContents.navigationHistory;
    const entries = nav.getAllEntries();
    if (entries.length) restore = { entries, index: nav.getActiveIndex() };
  } catch (_) {}

  let sessionRestore = null;
  const data = await snapshotSessionStorage(tab.view.webContents);
  if (data && Object.keys(data).length) {
    let origin = "";
    try { origin = new URL(tab.url).origin; } catch (_) {}
    if (origin) sessionRestore = { origin, data };
  }
  if (!state.tabs.includes(tab)) return getTabState(); // closed while we were reading it

  createTab(tab.url, {
    restore,
    sessionRestore,
    site: tab.site,
    bookmarkId: tab.bookmarkId,
    allowRestricted: true, // a copy of an allowed tab is allowed; it keeps the same `site` guard
  });
  const created = state.tabs.pop(); // createTab appends; Chrome puts the copy next to the original
  if (created) state.tabs.splice(state.tabs.indexOf(tab) + 1, 0, created);
  notifyTabs();
  return getTabState();
}

function newTabAfter(tab) {
  createTab();
  const created = state.tabs.pop(); // createTab appends; move it right after `tab`
  if (created) state.tabs.splice(state.tabs.indexOf(tab) + 1, 0, created);
  notifyTabs();
  focusAddressBar();
}

function tabContextMenu(id) {
  const tab = state.tabs.find((t) => t.id === Number(id));
  if (!tab) return;
  const idx = state.tabs.indexOf(tab);
  if (state.restricted) {
    Menu.buildFromTemplate([
      { label: "Duplicate", enabled: !!tab.url && !tab.errorPage && !tab.isHome, click: () => duplicateTab(tab.id) },
      { label: "Close", click: () => closeTab(tab.id) },
    ]).popup({ window: state.mainWindow });
    return;
  }
  Menu.buildFromTemplate([
    { label: "New tab to the right", click: () => newTabAfter(tab) },
    { type: "separator" },
    { label: "Reload", click: () => { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload(); } },
    { label: "Duplicate", enabled: !!tab.url && !tab.errorPage && !isNewTabUrl(tab.url), click: () => duplicateTab(tab.id) },
    { type: "separator" },
    { label: "Close", click: () => closeTab(tab.id) },
    { label: "Close other tabs", enabled: state.tabs.length > 1, click: () => state.tabs.filter((t) => t.id !== tab.id).forEach((t) => closeTab(t.id)) },
    { label: "Close tabs to the right", enabled: idx < state.tabs.length - 1, click: () => state.tabs.slice(idx + 1).forEach((t) => closeTab(t.id)) },
  ]).popup({ window: state.mainWindow });
}

function bookmarkContextMenu(id) {
  if (state.restricted) return;
  const b = bookmarks.list().find((x) => x.id === id);
  if (!b) return;
  const active = getActiveTab();
  Menu.buildFromTemplate([
    { label: "Open in new tab", click: () => createTab(b.url) },
    { type: "separator" },
    { label: "Edit...", click: () => openBookmarkEdit(id) },
    { label: "Delete", click: () => { bookmarks.remove(id); broadcastBookmarks(); } },
    { label: "Copy link address", click: () => clipboard.writeText(b.url) },
    { type: "separator" },
    { label: "Add page...", enabled: !!active && bookmarks.isBookmarkable(active.url) && !bookmarks.list().some((x) => x.url === active.url), click: () => toggleBookmarkActive() },
    { label: "Bookmark manager", click: () => openManager() },
    { label: "Show bookmarks bar", type: "checkbox", checked: !!state.bookmarksBarVisible, click: () => toggleBookmarksBar() },
  ]).popup({ window: state.mainWindow });
}

// Chrome's "Edit bookmark" box (Name + URL, Cancel / Save). Normal mode only: the popup kind itself is
// refused in Restricted Mode (popup.js), so this is just the convenient entry point.
function openBookmarkEdit(id) {
  if (state.restricted) return;
  if (!bookmarks.list().some((x) => x.id === id)) return;
  popup().open("bookmark-edit", null, { bookmarkId: id });
}

module.exports = {
  getTabState,
  getActiveTab,
  resizeActiveView,
  createTab,
  switchTab,
  closeTab,
  cycleTab,
  selectTabByNumber,
  navigate,
  goBack,
  goForward,
  reload,
  focusAddressBar,
  openFind,
  findText,
  closeFind,
  zoom,
  printActive,
  openDevTools,
  toggleBookmarkActive,
  toggleBookmarksBar,
  openBookmark,
  enableRestricted,
  leaveRestricted,
  hoverInfo,
  openDownloadsPage,
  duplicateTab,
  setSearchSuggestions,
  openManager,
  settingsSnapshot,
  broadcastSettings,
  isManagerSender,
  broadcastBookmarks,
  secretToggle,
  setBookmarksBarVisible,
  openSettings,
  applyThemeMode,
  stop,
  moveTab,
  tabContextMenu,
  bookmarkContextMenu,
  openBookmarkEdit,
  chromeHeight,
  siteKind,
  reopenClosedTab,
  closeTabOpenedForDownload,
};
