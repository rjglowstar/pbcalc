// PBCalc's data folder is %LOCALAPPDATA%\PBCalc, inside the user's own profile (where Chrome keeps
// its profile too), with %APPDATA%\PBCalc as the fallback. If neither can be written, PBCalc must
// SAY so instead of silently dropping saved passwords, bookmarks and settings.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-datadir.js
//   ...add BAD=1 to run the unwritable case (the two cases need separate processes).
const { app, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const BAD = !!process.env.BAD;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-datadir-"));
const constants = require("../electron/constants");
// C:/Windows/System32/... cannot be created without elevation: the Program Files case in miniature
constants.dataDir = () => (BAD ? "C:/Windows/System32/PBCalcUserDataTest" : path.join(tmp, "UserData"));

const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 60000).unref();

// catch the warning without a real modal blocking the run
let shown = null;
dialog.showMessageBoxSync = (opts) => { shown = opts; return 0; };

require("../electron/main.js");

app.whenReady().then(async () => {
  await sleep(3500);
  const state = require("../electron/state");
  const settings = require("../electron/settings");
  const vault = require("../electron/vault/passwordVault");
  const dir = app.getPath("userData");
  console.log("     userData=" + dir + "  exists=" + fs.existsSync(dir) + "  warned=" + !!shown);

  if (BAD) {
    check("an unwritable data folder is reported, not swallowed", !!shown);
    check("...the warning names the folder", !!shown && shown.detail.includes(dir));
    check("...and says what is at stake", !!shown && /passwords/i.test(shown.detail) && /not be kept/i.test(shown.detail));
    check("...and it is a warning, not a crash: the browser still opens", !!state.mainWindow && state.mainWindow.isVisible() && state.tabs.length === 1);
    // this is the silent data loss the warning is about
    check("(the reason: the vault really cannot save there)", vault.saveCredential({ origin: "https://x.test", username: "u", password: "p" }) === false);
  } else {
    check("a writable data folder produces no warning", shown === null);
    check("...the folder is created", fs.existsSync(dir));
    check("...settings persist", (settings.set("themeMode", "dark"), fs.existsSync(path.join(dir, "settings.json"))));
    check("...and the vault saves", vault.saveCredential({ origin: "https://x.test", username: "u", password: "p" }) === true);
    check("...with the browser open as usual", !!state.mainWindow && state.tabs.length === 1);
  }

  // ── the rule itself: prefer %LOCALAPPDATA%\PBCalc (where Chrome keeps its own profile), fall
  //    back to %APPDATA%\PBCalc when it cannot be written (same shape as the sibling ERP's
  //    D:\Exe Settings -> %APPDATA% fallback) ──
  const { resolveDataDir, PREFERRED_DATA_DIR } = require("../electron/constants");
  // Compare against the env var and a pattern, never against a hand-written Windows path literal:
  // "C:\PBCalc" in a JS string collapses to the relative "C:PBCalc" exactly as it once did in
  // constants.js, and the two bugs would then agree with each other.
  check("the preferred folder is %LOCALAPPDATA%\\PBCalc, inside the user profile",
    PREFERRED_DATA_DIR === path.join(process.env.LOCALAPPDATA, "PBCalc"));
  check("...it is an ABSOLUTE path and not next to the program",
    path.isAbsolute(PREFERRED_DATA_DIR) && /[\\/]AppData[\\/]Local[\\/]PBCalc$/i.test(PREFERRED_DATA_DIR)
    && !/Program Files/i.test(PREFERRED_DATA_DIR) && !PREFERRED_DATA_DIR.startsWith(path.dirname(app.getPath("exe"))));
  check("...and it is NOT a folder in the root of C:", path.dirname(PREFERRED_DATA_DIR).toLowerCase() !== "c:\\");
  check("...and app.setPath accepts it", (() => { try { app.setPath("userData", PREFERRED_DATA_DIR); app.setPath("userData", dir); return true; } catch (_) { return false; } })());
  const writable = path.join(tmp, "prefer-me");
  check("a writable preferred folder is used as-is", resolveDataDir(writable) === writable);
  check("...and it really was created", fs.existsSync(writable));
  const blocked = "C:/Windows/System32/PBCalcPreferredTest";
  const fallback = resolveDataDir(blocked);
  console.log("     blocked -> " + fallback);
  check("an unwritable preferred folder falls back to %APPDATA%\\PBCalc (Roaming)",
    fallback === path.join(app.getPath("appData"), "PBCalc"));
  check("...and the fallback is inside the user profile too, not next to the program",
    fallback.toLowerCase().startsWith(app.getPath("home").toLowerCase()) && !fallback.includes("Program Files"));

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_DATADIR" + (BAD ? "_BAD" : "") + " total=" + results.length + " failed=" + failed.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
