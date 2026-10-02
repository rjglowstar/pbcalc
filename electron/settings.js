const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// Tiny persisted preferences file next to the vault (portable userData). Holds UI preferences
// only — never anything about pages visited. It is on the keep list in privacy.js.
const FILE = () => path.join(app.getPath("userData"), "settings.json");
// themeMode: system | light | dark.
// restricted.startRestricted: the "Default Start Restricted" switch — begin every launch in
// Restricted Mode. (Restricted Mode itself is per session and is not saved.)
// downloads.dir: "" = the OS Downloads folder; downloads.ask = Chrome's "Ask where to save each
// file" switch (off by default, exactly as in Chrome).
const DEFAULTS = { showBookmarksBar: true, themeMode: "system", searchSuggestions: true, downloads: { dir: "", ask: false }, restricted: { startRestricted: false } };

let cache = null;

function load() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.showBookmarksBar === "boolean") cache.showBookmarksBar = parsed.showBookmarksBar;
      if (["system", "light", "dark"].includes(parsed.themeMode)) cache.themeMode = parsed.themeMode;
      if (typeof parsed.searchSuggestions === "boolean") cache.searchSuggestions = parsed.searchSuggestions;
      const dl = parsed.downloads;
      if (dl && typeof dl === "object") {
        cache.downloads = { dir: typeof dl.dir === "string" ? dl.dir : "", ask: dl.ask === true };
      }
      const r = parsed.restricted;
      if (r && typeof r === "object") {
        // A machine locked by the earlier PIN version (restricted.enabled) stays locked at launch.
        cache.restricted = { startRestricted: r.startRestricted === true || r.enabled === true };
      }
    }
  } catch (_) {}
  return cache;
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load()[key] = value;
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(cache), "utf8");
  } catch (_) {}
}

module.exports = { get, set };
