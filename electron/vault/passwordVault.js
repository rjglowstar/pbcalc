// Chrome-style password vault. Credentials are encrypted with Electron's safeStorage (Windows
// DPAPI) — tied to the current Windows user account, so the vault file cannot be decrypted on
// another PC or by another Windows user, exactly like Chrome's own password store.
//
// Ported verbatim from the sibling PBERP-EXE project's electron/vault/passwordVault.js. It needed
// NO changes to become portable: VAULT_FILE() resolves through app.getPath("userData"), and
// main.js has already redirected that to the portable folder before this module is ever
// required — so the vault file lands next to the app automatically, with no path logic of its
// own to touch.
const { app, safeStorage } = require("electron");
const fs = require("fs");
const path = require("path");

const VAULT_FILE = () => path.join(app.getPath("userData"), "password-vault.json");

// Decrypted, in-memory cache:
//   { credentials: [{ origin, username, password, savedAt }],
//     never:       [{ origin, username }] }   // "Never save" entries
let cache = null;

function isAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

function normOrigin(origin) {
  return String(origin || "").replace(/\/+$/, "").toLowerCase();
}

function emptyData() {
  return { credentials: [], never: [] };
}

function loadData() {
  if (cache) return cache;
  cache = emptyData();
  try {
    const raw = fs.readFileSync(VAULT_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enc && isAvailable()) {
      const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(parsed.enc, "base64")));
      if (decoded && typeof decoded === "object") {
        cache = {
          credentials: Array.isArray(decoded.credentials) ? decoded.credentials : [],
          never: Array.isArray(decoded.never) ? decoded.never : [],
        };
      }
    }
  } catch (_) {
    cache = emptyData();
  }
  return cache;
}

function persist() {
  try {
    if (!isAvailable()) return false;
    const enc = safeStorage.encryptString(JSON.stringify(cache || emptyData())).toString("base64");
    fs.writeFileSync(VAULT_FILE(), JSON.stringify({ v: 1, enc }), "utf8");
    return true;
  } catch (_) {
    return false;
  }
}

// Usernames only (no passwords) — used to populate the autofill dropdown. Passwords never leave
// the main process until a specific one is picked.
function listUsernames(origin) {
  const o = normOrigin(origin);
  return loadData()
    .credentials.filter((c) => normOrigin(c.origin) === o)
    .map((c) => ({ username: c.username, savedAt: c.savedAt || 0 }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

// Returns the plaintext password for one picked credential (for autofill).
function getPassword(origin, username) {
  const o = normOrigin(origin);
  const found = loadData().credentials.find(
    (c) => normOrigin(c.origin) === o && c.username === username,
  );
  return found ? found.password : null;
}

// Most-recently-saved credential for this origin — used to auto-fill a login form when a page
// loads. Returns { username, password } or null.
function getLastSaved(origin) {
  const o = normOrigin(origin);
  let best = null;
  for (const c of loadData().credentials) {
    if (normOrigin(c.origin) !== o) continue;
    if (!best || (c.savedAt || 0) > (best.savedAt || 0)) best = c;
  }
  return best ? { username: best.username, password: best.password } : null;
}

function saveCredential({ origin, username, password } = {}) {
  const u = (username || "").toString().trim();
  const p = (password || "").toString();
  if (!u || !p || !isAvailable()) return false;
  const o = normOrigin(origin);
  const data = loadData();
  // Saving explicitly clears any prior "never" entry for this user.
  data.never = data.never.filter((n) => !(normOrigin(n.origin) === o && n.username === u));
  const idx = data.credentials.findIndex((c) => normOrigin(c.origin) === o && c.username === u);
  if (idx >= 0) {
    data.credentials[idx].password = p;
    data.credentials[idx].savedAt = Date.now();
  } else {
    data.credentials.push({ origin: o, username: u, password: p, savedAt: Date.now() });
  }
  return persist();
}

function deleteCredential({ origin, username } = {}) {
  const o = normOrigin(origin);
  const u = (username || "").toString().trim();
  const data = loadData();
  const before = data.credentials.length;
  data.credentials = data.credentials.filter((c) => !(normOrigin(c.origin) === o && c.username === u));
  return data.credentials.length !== before ? persist() : false;
}

// "Never save for this login" — like Chrome's Never. Blocks per origin+username. Also removes
// any stored password for it.
function neverSave({ origin, username } = {}) {
  const o = normOrigin(origin);
  const u = (username || "").toString().trim();
  if (!u) return false;
  const data = loadData();
  data.credentials = data.credentials.filter((c) => !(normOrigin(c.origin) === o && c.username === u));
  if (!data.never.some((n) => normOrigin(n.origin) === o && n.username === u)) {
    data.never.push({ origin: o, username: u });
  }
  return persist();
}

function isNever(origin, username) {
  const o = normOrigin(origin);
  const u = (username || "").toString().trim();
  return loadData().never.some((n) => normOrigin(n.origin) === o && n.username === u);
}

// True only when worth showing "Save password?": password is non-empty, this username isn't on
// the never-list, and it's either new or its password changed.
function needsSavePrompt(origin, username, password) {
  const u = (username || "").toString().trim();
  const p = (password || "").toString();
  if (!u || !p) return false;
  if (isNever(origin, u)) return false;
  return getPassword(origin, u) !== p;
}

// Wipes every saved credential AND every "Never" block for this origin.
function resetOrigin(origin) {
  const o = normOrigin(origin);
  const data = loadData();
  const before = data.credentials.length + data.never.length;
  data.credentials = data.credentials.filter((c) => normOrigin(c.origin) !== o);
  data.never = data.never.filter((n) => normOrigin(n.origin) !== o);
  const after = data.credentials.length + data.never.length;
  return after === before ? true : persist();
}

module.exports = {
  isAvailable,
  listUsernames,
  getPassword,
  getLastSaved,
  saveCredential,
  deleteCredential,
  neverSave,
  needsSavePrompt,
  resetOrigin,
};
