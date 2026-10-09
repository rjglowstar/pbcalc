const { app, session } = require("electron");
const fs = require("fs");
const { spawn } = require("child_process");
const path = require("path");

// "Wipe everything on exit" — the user chose the strict no-trace policy: nothing Chromium keeps
// (HTTP cache, cookies, localStorage, IndexedDB, service workers, ...) survives a restart.
//
// Two things in userData are deliberately NOT wiped because the user curates/owns them, not the
// browsing session:
//   - password-vault.json  the saved-password vault
//   - bookmarks.json       the bookmarks
//   - settings.json        UI preferences (e.g. bookmarks bar shown)
// and one more that looks like junk but is load-bearing:
//   - Local State          holds the os_crypt key that Electron's safeStorage encrypts with. If it
//                          is deleted, a new key is generated and the vault above can no longer be
//                          decrypted. Never remove it.
const KEEP = new Set(["password-vault.json", "vault-lock.json", "bookmarks.json", "bookmarks-dummy.json", "settings.json", "calc-data.json", "Local State"]);

// Startup sweep: removes leftovers from a crash / forced kill, and anything Chromium wrote during
// the previous run's shutdown after we could clear it. Runs before app "ready", when nothing
// holds these files open yet.
function wipeLeftoversOnDisk() {
  const dir = app.getPath("userData");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of entries) {
    if (KEEP.has(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (_) {}
  }
}

async function clearSession() {
  // Tabs run in the TAB_PARTITION session (constants.js), not defaultSession, so clearing only defaultSession would wipe
  // a session no tab uses. Clear both. The partition lives in a folder under userData (persistent, so the PDF viewer
  // works); this empties it, and the final sweep below deletes the folder itself once this process is gone.
  const { TAB_PARTITION } = require("./constants");
  const sessions = [session.defaultSession, session.fromPartition(TAB_PARTITION)];
  await Promise.allSettled(sessions.flatMap((ses) => [
    ses.clearStorageData(),
    ses.clearCache(),
    ses.clearAuthCache(),
    ses.clearHostResolverCache(),
    ses.clearCodeCaches({}),
  ]));
}

let wiped = false;
function installQuitWipe() {
  app.on("before-quit", (event) => {
    if (wiped) return;
    event.preventDefault();
    wiped = true;
    // Never let a hung clear keep the app from quitting.
    const guard = setTimeout(() => app.quit(), 5000);
    clearSession().finally(() => {
      clearTimeout(guard);
      app.quit();
    });
  });

  // Chromium keeps writing to (and locking) files like Network/, DIPS, Session Storage/ until the
  // process is really gone, and some of them name the sites visited this session. So the final
  // sweep has to happen AFTER this process exits: hand it to a tiny detached helper that waits
  // for our PID to disappear, then deletes everything not on the KEEP list. If it never gets to
  // run (crash, power loss), wipeLeftoversOnDisk() does the same job on the next launch.
  app.on("will-quit", () => spawnPostExitCleanup());
}

const CLEANUP_SCRIPT = `
const fs = require("fs"), path = require("path");
const pid = Number(process.argv[1]), dir = process.argv[2], keep = new Set(JSON.parse(process.argv[3]));
const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const sweep = () => {
  let left = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const n of names) {
    if (keep.has(n)) continue;
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (e) {}
    if (fs.existsSync(path.join(dir, n))) left++;
  }
  return left;
};
const started = Date.now();
(function wait() {
  if (alive() && Date.now() - started < 30000) return setTimeout(wait, 200);
  let tries = 0;
  (function go() { if (sweep() && ++tries < 15) setTimeout(go, 200); })();
})();
`;

function spawnPostExitCleanup() {
  try {
    const child = spawn(
      process.execPath,
      ["-e", CLEANUP_SCRIPT, String(process.pid), app.getPath("userData"), JSON.stringify([...KEEP])],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    child.unref();
  } catch (_) {}
}

module.exports = { wipeLeftoversOnDisk, installQuitWipe, clearSession, KEEP };
