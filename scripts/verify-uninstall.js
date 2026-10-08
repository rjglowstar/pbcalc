// The uninstaller step (installer/installer.nsh): what it removes from Windows always, and the user's data only when asked.
// The NSIS script cannot be run from here without installing/uninstalling the real PBCalc, so this test (a) checks the script's
// structure and (b) RUNS the exact PowerShell command it contains against a made-up registry area.
// Run: node scripts/verify-uninstall.js
const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
const root = path.join(__dirname, "..");
const nsh = fs.readFileSync(path.join(root, "installer", "installer.nsh"), "utf8");
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

console.log("-- structure of the script");
const code = nsh.split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join("\n");
check("it is wired into the installer build (package.json nsis.include)", JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build.nsis.include === "installer/installer.nsh");
check("a silent uninstall (also how an update replaces the old version) skips the question and keeps the data", /IfSilent pbcalc_keep_data\s+MessageBox/.test(code));
check("the question is Yes/No with NO as the default button", /MessageBox MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2/.test(code));
check("the question says downloads are never deleted", /downloaded files are never deleted/i.test(code));
check("Yes deletes PBCalc's two possible data folders - and nothing else", (code.match(/RMDir \/r "[^"]*"/g) || []).join("|") === 'RMDir /r "$0\\PBCalc"|RMDir /r "$0\\PBCalc"' && /ReadEnvStr \$0 LOCALAPPDATA/.test(code) && /ReadEnvStr \$0 APPDATA/.test(code));
check("those folders are the ones the browser really uses (%LOCALAPPDATA%\\PBCalc, fallback %APPDATA%\\PBCalc)", /LOCALAPPDATA/.test(fs.readFileSync(path.join(root, "electron", "constants.js"), "utf8")) && /"PBCalc"/.test(fs.readFileSync(path.join(root, "electron", "constants.js"), "utf8")) && /APPDATA/.test(fs.readFileSync(path.join(root, "electron", "constants.js"), "utf8")));
check("the Windows registration is removed whatever the answer (every PBCalc ProgId, the browser entry, RegisteredApplications)",
  ["PBCalcURL", "PBCalcHTML", "PBCalcPDF", "PBCalcIMG", "PBCalcTXT", "PBCalcSVG", "StartMenuInternet\\PBCalc", "Applications\\PBCalc.exe"].every((k) => code.includes(k)) && /DeleteRegValue HKCU "Software\\RegisteredApplications" "PBCalc"/.test(code));
check("every ProgId the app can write is covered (defaultBrowser.js KINDS vs the script)", (() => {
  const src = fs.readFileSync(path.join(root, "electron", "defaultBrowser.js"), "utf8");
  const ids = [...src.matchAll(/"(PBCalc[A-Z]+)"/g)].map((m) => m[1]);
  return ids.length >= 5 && [...new Set(ids)].every((id) => id === "PBCalc" || code.includes(id));
})());

console.log("\n-- an UPDATE (the in-app updater starts the installer with --updated) must not disturb the user or Windows");
const fn = (name) => { const m = code.match(new RegExp("Function " + name + "[\\s\\S]*?FunctionEnd")); return m ? m[0] : ""; };
const mac = (name) => { const m = code.match(new RegExp("!macro " + name + "[\\s\\S]*?!macroend")); return m ? m[0] : ""; };
check("the password page is skipped for an update", /\$\{If\} \$\{isUpdated\}\s+Abort/.test(fn("PbcPasswordPage")));
check("the two setup questions are skipped for an update", /\$\{If\} \$\{isUpdated\}\s+Abort/.test(fn("PbcOptionsPage")));
check("a silent update skips the password ONLY when PBCalc really is installed in that folder (a made-up --updated cannot bypass it)", /\$\{If\} \$\{isUpdated\}\s+\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"\s+Goto pbcalc_init_ok/.test(mac("customInit")));
check("an update never rewrites install-choices.json (the user's earlier answers stay)", /\$\{IfNot\} \$\{isUpdated\}\s+\$\{AndIfNot\} \$\{Silent\}/.test(mac("customInstall")));
check("the OLD version's uninstaller, run by an update, leaves the Default apps registration alone", /\$\{If\} \$\{isUpdated\}\s+Goto pbcalc_keep_registration/.test(mac("customUnInstall")) && /pbcalc_keep_registration:/.test(mac("customUnInstall")));
check("...and still asks nothing and deletes no data (silent)", /IfSilent pbcalc_keep_data/.test(mac("customUnInstall")));
check("the installation password itself is not in the script (only salt + hash)", !/pbsecure|paladiya/i.test(nsh) && /PBC_HASH "[0-9a-f]{64}"/.test(nsh));

console.log("\n-- the PowerShell cleanup, run for real on a made-up registry area");
const line = code.split("\n").find((l) => l.includes("nsExec::Exec") && l.includes("powershell") && l.includes("Get-ChildItem"));   // (the installation-password check also runs PowerShell: pick the registry cleanup)
check("the command is there", !!line);
const TEST = "Software\\PBCalcUninstallTest" + process.pid;
const inst = "C:\\Fake Programs\\PBCalc";
const reg = (...a) => { try { return execFileSync("reg", a, { stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch (_) { return null; } };
const add = (key, value) => reg("add", "HKCU\\" + TEST + "\\Classes\\" + key, "/ve", "/t", "REG_SZ", "/d", value, "/f");
const has = (key) => reg("query", "HKCU\\" + TEST + "\\Classes\\" + key) !== null;
add("winmade_pdf\\shell\\open\\command", '"' + inst + '\\PBCalc.exe" "%1"');
add("winmade_pdf\\DefaultIcon", inst + "\\resources\\file-icons\\pdf.ico");
add("other_with_our_icon\\shell\\open\\command", '"C:\\Other\\App.exe" "%1"');
add("other_with_our_icon\\DefaultIcon", inst + "\\resources\\file-icons\\pdf.ico");
add("someone_else\\shell\\open\\command", '"C:\\Other\\App.exe" "%1"');
add("someone_else\\DefaultIcon", "C:\\Other\\a.ico");
add("lookalike\\shell\\open\\command", '"C:\\Fake Programs\\PBCalc2\\PBCalc.exe" "%1"');
add("lookalike\\DefaultIcon", "C:\\Fake Programs\\PBCalc2\\x.ico");
let cmd = line.slice(line.indexOf("`") + 1, line.lastIndexOf("`")).replace(/\$\$/g, "$").replace(/\$INSTDIR/g, inst).replace("HKCU:\\Software\\Classes", "HKCU:\\" + TEST + "\\Classes");
const parts = cmd.match(/^powershell\.exe (.*?) -Command "([\s\S]*)"$/);
check("the command can be taken apart", !!parts);
if (parts) {
  execFileSync("powershell.exe", [...parts[1].split(" "), "-Command", parts[2]], { stdio: "ignore", timeout: 30000 });
  check("a Windows-made ProgId whose open command is PBCalc's is removed completely", !has("winmade_pdf"));
  check("a ProgId of ANOTHER program that only carries PBCalc's icon loses just that icon", has("other_with_our_icon\\shell\\open\\command") && !has("other_with_our_icon\\DefaultIcon"));
  check("another program's ProgId and icon are untouched", has("someone_else\\shell\\open\\command") && has("someone_else\\DefaultIcon"));
  check("a look-alike path (PBCalc2) is not mistaken for this install", has("lookalike\\shell\\open\\command") && has("lookalike\\DefaultIcon"));
}
reg("delete", "HKCU\\" + TEST, "/f");
check("the test registry area was cleaned up", reg("query", "HKCU\\" + TEST) === null);
const failed = results.filter((r) => !r.pass).length;
console.log("PBCALC_UNINSTALL total=" + results.length + " failed=" + failed);
process.exit(failed ? 1 : 0);
