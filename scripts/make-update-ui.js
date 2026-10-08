// Writes build/update-ui.ps1: the "Updating PBCalc" window as a STATIC script that the INSTALLER starts during a silent update
// (installer/installer.nsh, customInit). Run by `npm run dist` before the installer is built.
//
// WHY: the window PBCalc starts itself (electron/updateProgress.js) is part of the program that is being REPLACED, so an update from a version
// that does not have it yet (every copy installed before 0.1.3) cannot show it - the owner saw no window after pressing Update on 3 PCs.
// The new installer is the one thing that always runs during an update, whatever the old version was, so it shows the same window itself.
const fs = require("fs");
const path = require("path");
const { buildScript, DEFAULTS } = require("../electron/updateProgress");

const out = path.join(__dirname, "..", "build", "update-ui.ps1");
const script = buildScript({ ...DEFAULTS, argsMode: true, dark: false, from: "", to: "", exe: "", oldPid: 0, stopFile: "" });
// UTF-8 with a BOM (Windows PowerShell 5.1 reads a script without it as ANSI)
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, String.fromCharCode(0xfeff) + script + String.fromCharCode(10));
console.log("update-ui.ps1 written (" + script.length + " characters)");
