const { app, safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// The password that must be entered before a SAVED login is filled into a page (the owner's rule: whoever sits at the browser
// and does not know it cannot auto-fill saved passwords). Digits 0-9 only, 4 to 8 of them; the default is 1234 until it is
// changed in Settings. It is checked HERE, in the main process - the page, the preloads and the popup page never see it.
//
// Stored in vault-lock.json (on the keep list in privacy.js) as a salted scrypt hash, and the hash record is additionally
// encrypted with Electron's safeStorage (Windows DPAPI: tied to the Windows user, like the vault) - a copy of the file is no
// use elsewhere. The wrong-try counter and the lockout are in the same file so closing and re-opening the browser does not
// give a fresh set of guesses: 5 wrong tries lock it for 30 seconds, every further round of 5 doubles that (cap 1 hour).
// No recovery: a forgotten password cannot be reset from inside the browser.
const DEFAULT_PASSWORD = "1234";
const MIN_LEN = 4, MAX_LEN = 8;
const TRIES = 5, BASE_LOCK_MS = 30 * 1000, MAX_LOCK_MS = 60 * 60 * 1000;
const FILE = () => path.join(app.getPath("userData"), "vault-lock.json");

const validFormat = (pw) => typeof pw === "string" && new RegExp("^[0-9]{" + MIN_LEN + "," + MAX_LEN + "}$").test(pw);

// { hash, salt } | null (null = still the default). `state`: { failed, round, lockedUntil }.
let cache = null;
function load() {
  if (cache) return cache;
  cache = { rec: null, state: { failed: 0, round: 0, lockedUntil: 0 } };
  try {
    const f = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (f && typeof f === "object") {
      if (f.state && typeof f.state === "object") {
        cache.state = { failed: Math.max(0, f.state.failed | 0), round: Math.max(0, f.state.round | 0), lockedUntil: Number(f.state.lockedUntil) || 0 };
      }
      if (typeof f.enc === "string" && safeStorage.isEncryptionAvailable()) {
        const rec = JSON.parse(safeStorage.decryptString(Buffer.from(f.enc, "base64")));
        if (rec && typeof rec.hash === "string" && typeof rec.salt === "string") cache.rec = rec;
      } else if (f.rec && typeof f.rec.hash === "string" && typeof f.rec.salt === "string") {
        cache.rec = f.rec;   // no encryption available on this machine: still hashed + salted
      }
    }
  } catch (_) { /* no file / unreadable: default password, no lockout */ }
  return cache;
}
function save() {
  const c = load();
  const out = { v: 1, state: c.state };
  if (c.rec) {
    if (safeStorage.isEncryptionAvailable()) out.enc = safeStorage.encryptString(JSON.stringify(c.rec)).toString("base64");
    else out.rec = c.rec;
  }
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(out));
    return true;
  } catch (_) { return false; }
}

const hashOf = (pw, salt) => crypto.scryptSync(pw, Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 }).toString("hex");
function matches(pw) {
  const c = load();
  if (!c.rec) {
    const a = Buffer.from(String(pw)), b = Buffer.from(DEFAULT_PASSWORD);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const got = Buffer.from(hashOf(String(pw), c.rec.salt), "hex"), want = Buffer.from(c.rec.hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Seconds left of a lockout (0 = not locked).
function lockedSecs() {
  const left = load().state.lockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

// Checks a password. { ok:true } | { ok:false, error:"locked", secs } | { ok:false, error:"wrong", left, secs? }
// (a wrong try that uses up the round starts the lockout and says so in `secs`).
function verify(pw) {
  const c = load();
  const secs = lockedSecs();
  if (secs) return { ok: false, error: "locked", secs };
  // Something that cannot be a password at all (empty, letters, wrong length) is not a "try": no counter, no lockout.
  if (typeof pw !== "string" || !validFormat(pw)) return { ok: false, error: "format" };
  if (matches(pw)) {
    if (c.state.failed || c.state.round || c.state.lockedUntil) { c.state = { failed: 0, round: 0, lockedUntil: 0 }; save(); }
    return { ok: true };
  }
  c.state.failed += 1;
  if (c.state.failed >= TRIES) {
    c.state.failed = 0;
    c.state.round += 1;
    c.state.lockedUntil = Date.now() + Math.min(MAX_LOCK_MS, BASE_LOCK_MS * Math.pow(2, c.state.round - 1));
    save();
    return { ok: false, error: "wrong", left: 0, secs: lockedSecs() };
  }
  save();
  return { ok: false, error: "wrong", left: TRIES - c.state.failed };
}

// Change in Settings: the old password has to be right (and counts toward the same lockout), the new one is 4-8 digits and
// typed twice. Returns { ok:true } or { ok:false, error } with error one of: locked, wrong-old, bad-format, mismatch, same, save-failed.
function change(oldPw, newPw, confirmPw) {
  const v = verify(oldPw);
  if (!v.ok) return v.error === "locked" ? v : { ok: false, error: "wrong-old", left: v.left, secs: v.secs };
  if (!validFormat(newPw)) return { ok: false, error: "bad-format" };
  if (newPw !== confirmPw) return { ok: false, error: "mismatch" };
  if (newPw === oldPw) return { ok: false, error: "same" };
  const salt = crypto.randomBytes(16).toString("hex");
  load().rec = { salt, hash: hashOf(newPw, salt) };
  return save() ? { ok: true } : { ok: false, error: "save-failed" };
}

const isDefault = () => !load().rec;
function _reset() { cache = null; }   // tests

module.exports = { verify, change, lockedSecs, isDefault, validFormat, MIN_LEN, MAX_LEN, TRIES, BASE_LOCK_MS, _reset, FILE };
