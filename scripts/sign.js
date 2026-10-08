// electron-builder calls this for every file it signs (PBCalc.exe, the installer, the uninstaller): package.json -> build.win.sign.
// It signs with PBCalc's own SELF-SIGNED certificate, kept OUTSIDE the project (%USERPROFILE%\.pbcalc-signing: pbcalc.pfx + password.txt,
// override with PBCALC_SIGN_PFX / PBCALC_SIGN_PASSWORD). Windows only calls such a signature "valid" on a PC where the matching public
// certificate (installer/pbcalc-code-signing.cer) is trusted - the installer adds it for the user. Without the key file the file is left
// unsigned (a warning, not an error), so a build on another machine still works.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

exports.default = async function sign(configuration) {
  const dir = path.join(os.homedir(), ".pbcalc-signing");
  const pfx = process.env.PBCALC_SIGN_PFX || path.join(dir, "pbcalc.pfx");
  let password = process.env.PBCALC_SIGN_PASSWORD;
  if (!password) { try { password = fs.readFileSync(path.join(dir, "password.txt"), "utf8").trim(); } catch (_) {} }
  const file = configuration.path;
  if (!fs.existsSync(pfx) || !password) { console.warn("  • sign.js: no signing key (" + pfx + ") - leaving " + path.basename(file) + " unsigned"); return; }
  const ps = "$c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($env:PBC_PFX, $env:PBC_PW, 'Exportable'); " +
    "$r = Set-AuthenticodeSignature -FilePath $env:PBC_FILE -Certificate $c -HashAlgorithm SHA256; " +
    "if ($r.Status -ne 'Valid' -and $r.Status -ne 'UnknownError') { Write-Error ('signing failed: ' + $r.Status + ' ' + $r.StatusMessage); exit 1 }";
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { env: { ...process.env, PBC_PFX: pfx, PBC_PW: password, PBC_FILE: file }, stdio: "inherit" });
  console.log("  • signed " + path.basename(file));
};
