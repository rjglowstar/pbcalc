const settings = require("./settings");

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

// Hosting services where EVERY customer gets a sub-domain of the same name: user1.github.io and user2.github.io are different
// owners, not one site. With the "last two labels" rule a bookmark on one of them allowed ALL of them in Restricted Mode (measured),
// i.e. any stranger's page that a link could reach. For these suffixes the site is one label PLUS the suffix. (A short list of the
// common ones, not the full public-suffix list.)
const SHARED_SUFFIXES = [
  "github.io", "gitlab.io", "githubusercontent.com", "herokuapp.com", "vercel.app", "netlify.app", "web.app", "firebaseapp.com",
  "appspot.com", "azurewebsites.net", "cloudfront.net", "pages.dev", "workers.dev", "onrender.com", "glitch.me", "repl.co",
  "surge.sh", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "myshopify.com", "wixsite.com", "weebly.com", "wordpress.com",
  "amazonaws.com", "fly.dev", "railway.app", "duckdns.org", "ddns.net", "no-ip.org", "000webhostapp.com", "my.id",
];
const sharedSuffixOf = (host) => {
  const blogspot = host.match(/(?:^|\.)(blogspot\.[a-z]{2,3}(?:\.[a-z]{2})?)$/);   // blogspot.com, blogspot.in, blogspot.co.uk ...
  if (blogspot) return blogspot[1];
  return SHARED_SUFFIXES.find((s) => host === s || host.endsWith("." + s)) || null;
};

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
  const shared = sharedSuffixOf(host);
  if (shared && host !== shared) {
    const before = host.slice(0, -(shared.length + 1)).split(".").pop();   // the customer's own label
    return before + "." + shared;
  }
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
  getStartRestricted,
  setStartRestricted,
  siteOf,
  sameSite,
};
