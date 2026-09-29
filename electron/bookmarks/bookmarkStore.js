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
  return load().map((b) => ({ id: b.id, title: b.title, url: b.url }));
}

// Only real web pages are bookmarkable — not about:blank, file:, devtools:, etc.
function isBookmarkable(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

// Adds if absent, removes if already present. Returns the new list.
function toggle({ url, title } = {}) {
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

module.exports = { list, toggle, remove, isBookmarkable };
