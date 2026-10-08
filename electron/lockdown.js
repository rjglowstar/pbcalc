// The browser's OWN pages (the toolbar / tab strip page, the popup, the omnibox list, the hover card, the download animation) are never
// supposed to open a window or go anywhere. Nothing told them so: dropping a LINK on the tab strip made Chromium open it in a NEW
// stray BrowserWindow (no address bar, no tabs, outside Restricted Mode's rules, default session) - measured with a dropped
// text/uri-list (scripts/verify-security.js). Now they refuse every window.open and every navigation away from their own page.
function lock(wc) {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => { if (url !== wc.getURL()) event.preventDefault(); });
  wc.on("will-redirect", (event) => event.preventDefault());
  wc.on("will-attach-webview", (event) => event.preventDefault());
}

module.exports = { lock };
