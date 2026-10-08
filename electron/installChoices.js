const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const settings = require("./settings");

// The installer's two questions (installer/installer.nsh) are written to "<install folder>\install-choices.json":
//   { "defaultBrowser": true|false, "calculatorStart": true|false }
// At the FIRST start after an install the program reads it once:
//   * calculatorStart -> settings.json "calculatorStart" (electron/calcMode.js starts on the calculator screen);
//   * defaultBrowser  -> returned to main.js, which does NOT act on it (the owner does not want Windows' Default apps page to pop up; PBCalc is
//     listed there anyway, and Windows never lets a program make itself the default - the user picks it in Settings > Default apps).
// The file is deleted after reading. If the install folder is read-only (an "all users" install) it cannot be, so the file's modification
// time is remembered in settings.json (installChoicesStamp) and the same file is never applied twice - a later change of the setting
// is not overwritten at every start. A new install writes a new file (new time) and its answers apply again.
function choicesFile() { return path.join(path.dirname(process.execPath), "install-choices.json"); }

// -> { defaultBrowser: boolean } when there were answers to apply now, else null.   `file` is for tests.
function apply(file) {
  const f = file || choicesFile();
  let stat, parsed;
  try { stat = fs.statSync(f); parsed = JSON.parse(fs.readFileSync(f, "utf8")); } catch (_) { return null; }
  const stamp = Math.round(stat.mtimeMs);
  if (settings.get("installChoicesStamp") === stamp) { try { fs.unlinkSync(f); } catch (_) {} return null; }   // already applied (file could not be deleted before)
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.calculatorStart === "boolean") settings.set("calculatorStart", parsed.calculatorStart);
  settings.set("installChoicesStamp", stamp);
  try { fs.unlinkSync(f); } catch (_) {}
  return { defaultBrowser: parsed.defaultBrowser === true };
}

module.exports = { apply, choicesFile };
