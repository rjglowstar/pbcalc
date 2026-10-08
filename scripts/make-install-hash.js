// Prints the two lines installer/installer.nsh needs for an installation password (salted PBKDF2-SHA256, 100000 rounds - the same
// computation the installer's PowerShell does). Usage: node scripts/make-install-hash.js "<password>"
const crypto = require("crypto");
const pw = process.argv[2];
if (!pw) { console.error('usage: node scripts/make-install-hash.js "<password>"'); process.exit(1); }
const salt = "pbcalc-setup-v1:" + crypto.randomBytes(9).toString("base64url");
const hash = crypto.pbkdf2Sync(pw, Buffer.from(salt, "utf8"), 100000, 32, "sha256").toString("hex");
console.log('!define PBC_SALT "' + salt + '"');
console.log('!define PBC_HASH "' + hash + '"');
