const settings = require("./settings");
const state = require("./state");

// ── Restricted Mode ────────────────────────────────────────────────────────
// A locked-down mode: the user can only open the preset (bookmarked) sites, sees no address bar,
// can open no arbitrary tab and cannot edit or delete bookmarks — just open and close. This module
// holds the on/off settings and the "which site is this URL" rules; the actual enforcement lives
// where the actions happen (tabManager, ipc, shortcuts, popup, contextMenu).
//
// There is NO PIN. The way in and out is the hidden admin shortcut (Ctrl+Shift, then "pbsecure"),
// which opens a small panel with "Manage sites" and "Leave Restricted Mode". So the lock is only as
// private as that shortcut, and it is an application-level lock, not OS security: someone with
// access to the app folder can edit settings.json.
//
// Restricted Mode itself lasts for the session. The only thing saved is the "Default Start
// Restricted" switch: when it is on, every launch begins in Restricted Mode, even if an admin left
// it during the previous session.

function isEnabled() {
  return !!state.restricted;
}

function getStartRestricted() {
  const c = settings.get("restricted");
  return !!(c && c.startRestricted);
}

function setStartRestricted(on) {
  settings.set("restricted", { startRestricted: !!on });
}

// ── "same site" rule ───────────────────────────────────────────────────────
// A tab opened from a preset bookmark may only navigate within that bookmark's site: the same
// host or any subdomain of the same registrable domain. There is no public-suffix list bundled, so
// the registrable domain is approximated: last two labels, or last three for the common
// second-level country suffixes (co.in, com.au, co.uk, ...). IP addresses and single-label hosts
// (localhost) only match themselves.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "ne", "or"]);

function siteOf(urlOrHost) {
  let host = String(urlOrHost || "");
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(host)) host = new URL(host).hostname;
  } catch (_) {
    return "";
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host; // IP literal
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  const keep = last.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

function sameSite(url, site) {
  return !!site && isWebUrl(url) && siteOf(url) === site;
}

module.exports = {
  isEnabled,
  getStartRestricted,
  setStartRestricted,
  siteOf,
  sameSite,
  isWebUrl,
};
