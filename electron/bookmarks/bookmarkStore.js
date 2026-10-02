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
      favicon: /^https?:\/\//i.test(String(favicon || "")) ? String(favicon) : "",
    });
  }
  persist();
  return list();
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

module.exports = { list, toggle, remove, add, update, move, isBookmarkable };
