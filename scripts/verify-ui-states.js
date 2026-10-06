// Hover / cursor / contrast audit of every UI surface in light and dark, plus Restricted Mode, as a pass/fail test.
// Run:  env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-ui-states.js
// It hovers every interactive element with synthetic input (the real mouse is not moved), so it is safe to run while the PC
// is in use. Prints `PBCALC_UISTATES total=N failed=M`. See audit-ui-states.js for the rules.
process.env.PBCALC_AUDIT_ASSERT = "1";
require("./audit-ui-states.js");
