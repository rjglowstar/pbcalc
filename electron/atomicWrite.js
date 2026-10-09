const fs = require("fs");

// Writes a small file so that a crash, a power cut or a forced kill in the middle of the write can never leave HALF a file: the new content goes into
// "<file>.tmp" first and is then renamed over the old file (one step on the same drive: either the old file or the whole new one is there).
// Used for everything the user would lose: the saved-password vault, the password for it, bookmarks and settings (settings.json also holds the
// calculator-start choice - a half-written file would silently turn the disguise off). If the rename is refused (antivirus holding the file) the
// plain write is the fallback, so saving never gets worse than before. A leftover .tmp is swept away by privacy.js (it is not on the keep list).
function writeFileAtomic(file, data, encoding) {
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, data, encoding);
    fs.renameSync(tmp, file);
    return;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* nothing to remove */ }
  }
  fs.writeFileSync(file, data, encoding);   // throws when the folder really cannot be written: the callers report that as they always did
}

module.exports = { writeFileAtomic };
