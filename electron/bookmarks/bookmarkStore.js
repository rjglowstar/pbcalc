const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// Bookmarks are user-curated, so they persist (unlike browsing traces, which are wiped on exit —
// see electron/privacy.js). Plain JSON next to the vault in the portable userData folder.
// Deliberately stores only what the user explicitly bookmarked: no visit counts, no timestamps
// of visits, nothing that could double as browsing history.
//
// TWO lists, one of them active (the owner's privacy requirement: whoever opens the browser sees ordinary bookmarks):
//   "dummy" (bookmarks-dummy.json) - what everybody sees by default. Seeded with a few Google sites the first time
//                                    (file missing), after that an ordinary list the user can edit like any other.
//   "real"  (bookmarks.json)       - the owner's own list, shown only after the hidden unlock (three clicks on the
//                                    zoom value in the menu, see popup.js). Existing bookmarks stay here.
// Every function below works on the ACTIVE list, so the bar, star, manager, omnibox, right-click menu, drag and
// Restricted Mode all follow it with no logic of their own. The mode is kept in MEMORY ONLY: every launch starts on
// "dummy", which is the "reset when the browser closes" rule - nothing on disk says a real list was ever shown.
const FILES = { real: "bookmarks.json", dummy: "bookmarks-dummy.json" };
const FILE = (kind) => path.join(app.getPath("userData"), FILES[kind]);

let mode = "dummy";
const caches = { real: null, dummy: null };

// What a fresh install shows (the owner's choice: five diamond-trade sites). The icons are small images EMBEDDED here (not
// downloaded): they always show, also offline, and merely showing the bar sends no request to those sites. Each is the
// site's own icon rendered to 32px. ANY site added to this list MUST come with its icon - a globe on a decoy bookmark
// gives it away - and be checked on the bar.
const ICONS = {
  "GIA": "data:image/png;base64,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",
  "GJEPC": "data:image/png;base64,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",
  "Surat Diamond Bourse": "data:image/png;base64,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",
  "BDB India": "data:image/png;base64,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",
  "Surat Diamond Trade": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADqklEQVR4AeyWXWgcVRTHf3eSmLBd0yTbjVnbZjdiV/OQoLQPGoU8NBTrgwX7IhXEvvjgBxF90QfBD6SCxb6Ib4pSaEWlIkrfrCZaLEgiAWkao0UjCClpYtOk7W52Z3rOTrY7u8zs7iyhUOgwZ+655+N//vfOmctY8d60E+/d4XQn0wWJr486L9fdGLW5sqOQV8zV0bW7OJrvJ5UxljFgjDxwr5IGXh2HwqU2V0zBb4xx7TKqplIwBDzUr1J0W0XFb9SaRfHzI0XV7+ur01hGwPFSEwDv1Bh3Vi1GUkLfZQSMz3K0rEoR2S+m6Ks2+kAXwssIFCx1PoIAg9K9i/DGNEwgCNALXo/eMIF6wOuJuTUJ6JcQtgf8dkMxQu+AFk8k+0im+9mavp9eGZP39dPTdw/q8ysUZNM+CkVAC+Ta40SH9zF/JcP+dw5z4PCH/Le8SvvwE+RiPaFJhCLQEt3Mka9O8OLBA7z26XFiPVuJdHTx5rEveO7Zp3n/8y/RGN3aoFVX2kMRyK1e5ruPjjA68iiHRl/m7RdGeev5Ud596RVeHRni6Buvk1tZrqwROFeioQhg24x/fYLhPY/R3WYw69DR7DL9A4Oc/eVncJwb9nV31SEcgXWosZPfkoi2kojH6O7YRKvJM/3bZKjCCqULaIiAweHX8TG6I9B89RJzM9NS3FHMUKIZVrUMDVDRGP0CkDKuIFttM3HyG+Ymz4jVEkpiUrNImLsqAd2ieFeMe5Mp2u9sx1iGPbuHMcYwODBAoucujGOT2p4Q2cbOBwZpbmqio7OLh3ftpO2OlppcfAkUV63ZKyuXaY200de7nUhkE+NjP5FOp3lo14Ns6Yqye2SECxeXWLq4wJP793Hss4/ZdneCzUJ86JEhhQgUIx5fAuoQn9yGtVyOP8+f5/fpc1y9do2MDX/M/sUnR49z9tzffH/qVCHOaW7h0Hsf8NQzB5memeGHsR85ffqM+IJvXagvgVKKQ14+vUwmi5236ezsxF7LY2ETi8XY+/hemoyFrnQtk2Fl9Yq8gmbyQlpzMtlMCcpH04XWIODNclhcWMA0GfLSckuX/mdqaorYlhiTExNkc3npDUilUt6kmnoIAsgZI/svxbEdsvI6/p37hwvz8ywuLsoO5TWA2dnZmkW9AaEIeBM3Sre0ETYKrBEcSxuhkcSNyrn9Cqq+gpvRH2VNWFmwnv6ozAnXG0YONdxLgeop6EaXnrVySpFyTMjEkXNE/lnkTJGJMVwHAAD//9u/QgoAAAAGSURBVAMAh7oiiqT6sjQAAAAASUVORK5CYII=",
};
const DUMMY_DEFAULTS = [
  ["GIA", "https://www.gia.edu/"],
  ["GJEPC", "https://www.gjepc.org/index.php"],
  ["Surat Diamond Bourse", "https://www.suratdiamondbourse.in/"],
  ["BDB India", "https://bdbindia.org/"],
  ["Surat Diamond Trade", "https://suratdiamondtrade.com/"],
];
// Version 1 of the dummy list (before the owner chose the sites above) was six Google sites. A dummy file written then is a
// plain array; it is upgraded ONCE (see load): those six are replaced by the current defaults, anything else in it stays.
const DUMMY_VERSION = 2;
const V1_DUMMY_URLS = new Set(["https://www.google.com/", "https://mail.google.com/", "https://www.youtube.com/", "https://maps.google.com/", "https://drive.google.com/", "https://calendar.google.com/"]);
const freshDefaults = () => DUMMY_DEFAULTS.map(([title, url]) => ({ id: newId(), title, url, favicon: ICONS[title] || "" }));

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function getMode() { return mode; }
// "real" or "dummy". Returns true when it changed (the caller refreshes everything that shows bookmarks).
function setMode(next) {
  if ((next !== "real" && next !== "dummy") || next === mode) return false;
  mode = next;
  return true;
}

function load(kind = mode) {
  if (caches[kind]) return caches[kind];
  caches[kind] = [];
  let fileExists = false;
  let version = 1;   // the dummy file carries its own version; a plain array (the old format) counts as version 1
  try {
    const raw = fs.readFileSync(FILE(kind), "utf8");
    fileExists = true;
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.items) ? parsed.items : null;
    if (parsed && !Array.isArray(parsed) && Number.isFinite(parsed.version)) version = parsed.version;
    if (items) caches[kind] = items.filter((b) => b && typeof b.url === "string" && typeof b.id === "string");
  } catch (_) {}
  // First ever start of the dummy list only: a MISSING file seeds it; a list the user emptied stays empty.
  if (kind === "dummy" && !fileExists) {
    caches.dummy = freshDefaults();
    persist("dummy");
  }
  // One-time upgrade of a version-1 dummy list: if it still holds any of the old Google defaults, they are replaced by the
  // current defaults (put first) and everything the user added stays. A list WITHOUT them (emptied or fully custom) is left
  // exactly as it is - nothing is ever re-added after the user removed it. Either way the file is stamped with the version.
  if (kind === "dummy" && fileExists && version < DUMMY_VERSION) {
    if (caches.dummy.some((b) => V1_DUMMY_URLS.has(b.url))) {
      caches.dummy = [...freshDefaults(), ...caches.dummy.filter((b) => !V1_DUMMY_URLS.has(b.url))];
    }
    persist("dummy");
  }
  // A dummy list created BEFORE the icons were embedded has these sites with an empty icon: give them theirs (only an
  // EMPTY icon of a default site; anything the user changed, or a site they added, is left alone).
  if (kind === "dummy" && fileExists) {
    let filled = false;
    for (const b of caches.dummy) {
      const d = DUMMY_DEFAULTS.find(([, url]) => url === b.url);
      if (d && !b.favicon && ICONS[d[0]]) { b.favicon = ICONS[d[0]]; filled = true; }
    }
    if (filled) persist("dummy");
  }
  return caches[kind];
}

function persist(kind = mode) {
  try {
    fs.mkdirSync(path.dirname(FILE(kind)), { recursive: true });
    const items = caches[kind] || [];
    fs.writeFileSync(FILE(kind), JSON.stringify(kind === "dummy" ? { version: DUMMY_VERSION, items } : items), "utf8");
  } catch (_) {}
}

function list() {
  return load().map((b) => ({ id: b.id, title: b.title, url: b.url, favicon: b.favicon || "" }));
}

// Only real web pages are bookmarkable — not about:blank, file:, devtools:, etc.
function isBookmarkable(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

// What may be kept as a bookmark's icon: a web address, or a small inline image. Many sites declare their icon as a
// data: URL (the tab strip shows it fine); refusing those left the bookmark with a globe. The size cap keeps
// bookmarks.json small - an oversize inline icon is simply not stored.
const MAX_DATA_ICON = 32 * 1024;
function isIconUrl(u) {
  const s = String(u || "");
  if (/^https?:\/\//i.test(s)) return true;
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(s) && s.length <= MAX_DATA_ICON;
}

// Adds if absent, removes if already present. Returns the new list.
function toggle({ url, title, favicon } = {}) {
  if (!isBookmarkable(url)) return list();
  const items = load();
  const idx = items.findIndex((b) => b.url === url);
  if (idx !== -1) {
    items.splice(idx, 1);
  } else {
    items.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: String(title || url).slice(0, 200),
      url,
      favicon: isIconUrl(favicon) ? String(favicon) : "",
    });
  }
  persist();
  return list();
}

// A bookmark saved before its page had reported an icon (or with an icon the store used to refuse) learns it the
// next time that address (or another page of the same site) shows one. Only fills an EMPTY icon, and only for an address the user bookmarked:
// nothing is recorded about pages that are not bookmarks. Returns true when something changed.
// A site has ONE icon for all its pages, so a bookmark of ANOTHER page of the same site (same origin) gets it as well:
// editing a bookmark to "https://site/" while "https://site/login" is open showed a globe for ever, because only an
// identical address matched (and "/" often redirects to "/login", so the open tab never had the bookmarked address).
const originOf = (u) => { try { const o = new URL(u).origin; return o === "null" ? "" : o; } catch (_) { return ""; } };

function learnIcon(url, favicon) {
  if (!isIconUrl(favicon)) return false;
  const items = load();
  const origin = originOf(url);
  let changed = false;
  for (const b of items) {
    if (b.favicon) continue;
    if (b.url === url || (origin && originOf(b.url) === origin)) { b.favicon = String(favicon); changed = true; }
  }
  if (changed) persist();
  return changed;
}

function remove(id) {
  const items = load();
  const idx = items.findIndex((b) => b.id === id);
  if (idx !== -1) {
    items.splice(idx, 1);
    persist();
  }
  return list();
}

// Normalises what the admin typed: a bare "example.com/x" gets https://; only http(s) is accepted.
function cleanUrl(input) {
  let u = String(input || "").trim();
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  if (!isBookmarkable(u)) return "";
  try { return new URL(u).href; } catch (_) { return ""; }
}

function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, ""); } catch (_) { return u; }
}

// Manual add (bookmark manager). Returns { ok, error?, list }.
function add({ title, url } = {}) {
  const u = cleanUrl(url);
  if (!u) return { ok: false, error: "bad-url", list: list() };
  const items = load();
  if (items.some((b) => b.url === u)) return { ok: false, error: "duplicate", list: list() };
  items.push({ id: newId(), title: String(title || "").trim().slice(0, 200) || hostOf(u), url: u, favicon: "" });
  persist();
  return { ok: true, list: list() };
}

// Edit title and/or address. The stored favicon is dropped when the address changes host.
function update(id, { title, url } = {}) {
  const items = load();
  const b = items.find((x) => x.id === id);
  if (!b) return { ok: false, error: "not-found", list: list() };
  let nextUrl = b.url;
  if (url !== undefined) {
    nextUrl = cleanUrl(url);
    if (!nextUrl) return { ok: false, error: "bad-url", list: list() };
    if (items.some((x) => x.id !== id && x.url === nextUrl)) return { ok: false, error: "duplicate", list: list() };
  }
  if (hostOf(nextUrl) !== hostOf(b.url)) b.favicon = "";
  b.url = nextUrl;
  if (title !== undefined) b.title = String(title).trim().slice(0, 200) || hostOf(nextUrl);
  persist();
  return { ok: true, list: list() };
}

// Move one step up (-1) or down (+1).
function move(id, dir) {
  const items = load();
  const i = items.findIndex((x) => x.id === id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i === -1 || j < 0 || j >= items.length) return list();
  [items[i], items[j]] = [items[j], items[i]];
  persist();
  return list();
}

// Drag and drop on the bookmarks bar: put `id` at position `index` of the list WITHOUT it (so 0 = first,
// length-1 = last). Anything out of range is clamped. Returns the new list.
function moveTo(id, index) {
  const items = load();
  const i = items.findIndex((x) => x.id === id);
  if (i === -1) return list();
  const n = Number(index);
  if (!Number.isFinite(n)) return list();
  const [it] = items.splice(i, 1);
  items.splice(Math.max(0, Math.min(items.length, Math.trunc(n))), 0, it);
  if (items.indexOf(it) !== i) persist();
  return list();
}

module.exports = { list, toggle, remove, add, update, move, moveTo, isBookmarkable, learnIcon, getMode, setMode };
