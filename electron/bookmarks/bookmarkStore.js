const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// Bookmarks are user-curated, so they persist (unlike browsing traces, which are wiped on exit —
// see electron/privacy.js). Plain JSON next to the vault in the portable userData folder.
// Deliberately stores only what the user explicitly bookmarked: no visit counts, no timestamps
// of visits, nothing that could double as browsing history.
const FILE = () => path.join(app.getPath("userData"), "bookmarks.json");

let cache = null;

function load() {
  if (cache) return cache;
  cache = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (Array.isArray(parsed)) {
      cache = parsed.filter((b) => b && typeof b.url === "string" && typeof b.id === "string");
    }
  } catch (_) {}
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache || []), "utf8");
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
// next time that exact address shows one. Only fills an EMPTY icon, and only for an address the user bookmarked:
// nothing is recorded about pages that are not bookmarks. Returns true when something changed.
function learnIcon(url, favicon) {
  if (!isIconUrl(favicon)) return false;
  const items = load();
  let changed = false;
  for (const b of items) if (b.url === url && !b.favicon) { b.favicon = String(favicon); changed = true; }
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

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

module.exports = { list, toggle, remove, add, update, move, moveTo, isBookmarkable, learnIcon };
