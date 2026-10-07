const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { kindOf } = require("./fileTypes");

// Makes PBCalc show up in Windows Settings > Default apps (web browser, and for .html/.htm/.pdf), the same way Chrome's
// and Opera's per-user installs do: a "StartMenuInternet" client with its Capabilities, the ProgIds those point at, and a line
// in RegisteredApplications. Everything is written for the CURRENT user (HKCU): no administrator rights. Windows does not
// let an app make itself the default - it only lists the app; the user picks it there.
// Runs only for the installed program (see main.js): a development copy would register Electron's own exe.
// The installer's uninstall step (installer/installer.nsh) removes the same keys.
//
// What the browsers Windows really lists look like (read from this machine's registry, Chrome + Opera + Firefox) and what
// the first version of this file was MISSING: Capabilities\\Startmenu\\StartMenuInternet (names the browser's Start-menu slot)
// and an InstallInfo key. Both are there now. REG_VERSION is bumped whenever the layout changes: an installed copy whose
// entries carry an older version is rewritten at its next start.
const NAME = "PBCalc";
const DESCRIPTION = "PBCalc - a private web browser";
const APP_ID = "com.pbcalc.browser";
const REG_VERSION = "4";

// Per-type icons (assets/file-icons, shipped next to the exe as resources\file-icons by electron-builder extraResources): what
// Explorer draws for a PDF / image / web page / text file once PBCalc is its default app, like Chrome's page-with-logo-and-label.
// Without the files the ProgId falls back to the exe icon (the calculator).
const KINDS = { html: "PBCalcHTML", pdf: "PBCalcPDF", image: "PBCalcIMG", text: "PBCalcTXT", svg: "PBCalcSVG" };
const LABELS = { html: "PBCalc HTML Document", pdf: "PBCalc PDF Document", image: "PBCalc Image", text: "PBCalc Text Document", svg: "PBCalc SVG Image" };
// Only .pdf and .svg have an icon of their own (the owner's decision); every other image keeps the shared IMAGE one.
const kindOfExt = (ext) => (ext === ".svg" ? "svg" : kindOf(ext));
const iconFor = (exe, kind) => {
  const ico = path.join(path.dirname(exe), "resources", "file-icons", kind + ".ico");
  return fs.existsSync(ico) ? ico : exe + ",0";
};
// every extension PBCalc lists under Default apps (its kind decides the ProgId, so the icon)
const EXTENSIONS = [".htm", ".html", ".xhtml", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svg", ".txt", ".log", ".json"];

const reg = (args) => execFileSync("reg", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).toString();
const addDefault = (key, value) => reg(["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"]);
const addValue = (key, name, value) => reg(["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"]);
const addDword = (key, name, value) => reg(["add", key, "/v", name, "/t", "REG_DWORD", "/d", String(value), "/f"]);
const command = (exe) => '"' + exe + '" "%1"';

// software = the registry path under HKCU that holds Classes / Clients / RegisteredApplications ("Software" for real).
function keys(software) {
  const S = "HKCU\\" + software;
  return {
    S,
    html: S + "\\Classes\\PBCalcHTML", url: S + "\\Classes\\PBCalcURL", pdf: S + "\\Classes\\PBCalcPDF",
    image: S + "\\Classes\\PBCalcIMG", text: S + "\\Classes\\PBCalcTXT", svg: S + "\\Classes\\PBCalcSVG",
    client: S + "\\Clients\\StartMenuInternet\\" + NAME,
    capabilitiesPath: software + "\\Clients\\StartMenuInternet\\" + NAME + "\\Capabilities",
    registered: S + "\\RegisteredApplications",
  };
}

function isRegistered(exe, software = "Software") {
  try {
    const k = keys(software);
    const out = reg(["query", k.client + "\\shell\\open\\command", "/ve"]);
    if (!out.includes(exe)) return false;
    return /REG_SZ\s+4\s*$/m.test(reg(["query", k.client, "/v", "RegistrationVersion"]));
  } catch (_) { return false; }
}

// Tells Explorer / Settings that file and protocol associations changed, so the Default apps list is rebuilt now instead of
// at the next sign-in (what Chrome's installer does). Best effort.
function notifyAssociationsChanged() {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
      'Add-Type -Namespace W -Name N -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);\'; [W.N]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)'],
    { windowsHide: true, stdio: "ignore", timeout: 15000 });
  } catch (_) {}
}

// Returns true when it wrote something (false when everything was already in place for this exe path and layout version).
function register(exe, software = "Software", { notify = software === "Software" } = {}) {
  if (isRegistered(exe, software)) return false;
  const k = keys(software);
  const progIds = [[k.url, "PBCalc URL", null], ...Object.keys(KINDS).map((kind) => [k[kind], LABELS[kind], kind])];
  for (const [key, label, kind] of progIds) {
    addDefault(key, label);
    addValue(key, "FriendlyTypeName", label);
    addValue(key, "AppUserModelId", APP_ID);
    addDefault(key + "\\DefaultIcon", kind ? iconFor(exe, kind) : exe + ",0");
    addDefault(key + "\\shell\\open\\command", command(exe));
    // like Chrome's ProgIds: who this document type belongs to
    addValue(key + "\\Application", "AppUserModelId", APP_ID);
    addValue(key + "\\Application", "ApplicationName", NAME);
    addValue(key + "\\Application", "ApplicationDescription", DESCRIPTION);
    addValue(key + "\\Application", "ApplicationIcon", exe + ",0");
  }
  addValue(k.url, "URL Protocol", "");
  addDefault(k.client, NAME);
  addDefault(k.client + "\\DefaultIcon", exe + ",0");
  addDefault(k.client + "\\shell\\open\\command", '"' + exe + '"');
  addDword(k.client + "\\InstallInfo", "IconsVisible", 1);
  const cap = k.client + "\\Capabilities";
  addValue(cap, "ApplicationName", NAME);
  addValue(cap, "ApplicationDescription", DESCRIPTION);
  addValue(cap, "ApplicationIcon", exe + ",0");
  addValue(cap + "\\Startmenu", "StartMenuInternet", NAME);
  addValue(cap + "\\URLAssociations", "http", "PBCalcURL");
  addValue(cap + "\\URLAssociations", "https", "PBCalcURL");
  for (const ext of EXTENSIONS) addValue(cap + "\\FileAssociations", ext, KINDS[kindOfExt(ext)]);
  addValue(k.registered, NAME, k.capabilitiesPath);
  addValue(k.client, "RegistrationVersion", REG_VERSION);   // written LAST: its presence means the layout above is complete
  if (notify) notifyAssociationsChanged();
  return true;
}

// Reads one registry value as text (null = missing). name omitted = the key's (Default).
function readReg(key, name) {
  try {
    const out = reg(name ? ["query", key, "/v", name] : ["query", key, "/ve"]);
    const line = out.split(/\r?\n/).find((l) => /REG_\w+/.test(l));
    return line ? line.replace(/^\s*(\(Default\)|\S+)\s+REG_\w+\s*/, "").trim() : null;
  } catch (_) { return null; }
}
// Names of the subkeys / values listed under a key ("" lines skipped); [] when it does not exist.
function listValueNames(key) {
  try { return reg(["query", key]).split(/\r?\n/).map((l) => l.match(/^\s{4}(\S+)\s+REG_/)).filter(Boolean).map((m) => m[1]); } catch (_) { return []; }
}

// When the user picks PBCalc through a file's Properties > "Opens with" > Change (instead of Settings > Default apps), Windows
// does NOT use our PBCalcPDF ProgId: it creates its own (`pdf_auto_file`) holding only the open command, so Explorer shows the
// exe's calculator and never pdf.ico (measured in the registry: HKCU\Classes\pdf_auto_file had no DefaultIcon). Here we put
// the type's icon on such a ProgId - but ONLY while its open command is PBCalc's, and only when it has no icon of its own - and
// take it off again once the command no longer is (the user moved the type to another app), so no stale PBCalc icon stays
// behind. Our own PBCalc* ProgIds are never touched. Runs at every start of the installed copy. Returns the number of changes.
function repairOpenWithIcons(exe, software = "Software", { notify = software === "Software" } = {}) {
  const S = "HKCU\\" + software, classes = S + "\\Classes";
  const exts = S + "\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts";
  const ours = (cmd) => !!cmd && cmd.toLowerCase().includes(exe.toLowerCase());
  const myIcons = new Set(Object.keys(KINDS).map((kind) => iconFor(exe, kind).toLowerCase()));
  let changed = 0;
  for (const ext of EXTENSIONS) {
    const candidates = new Set([
      readReg(exts + "\\" + ext + "\\UserChoice", "ProgId"),
      readReg(classes + "\\" + ext),
      ...listValueNames(exts + "\\" + ext + "\\OpenWithProgids"),
      ...listValueNames(classes + "\\" + ext + "\\OpenWithProgids"),
    ].filter((p) => p && !/^PBCalc/i.test(p) && !/^Applications\\/i.test(p)));
    for (const progId of candidates) {
      const key = classes + "\\" + progId;
      const cmd = readReg(key + "\\shell\\open\\command");
      const icon = readReg(key + "\\DefaultIcon");
      try {
        if (ours(cmd) && !icon) { addDefault(key + "\\DefaultIcon", iconFor(exe, kindOfExt(ext))); changed++; }
        else if (!ours(cmd) && icon && myIcons.has(icon.toLowerCase())) { reg(["delete", key + "\\DefaultIcon", "/f"]); changed++; }
      } catch (_) {}
    }
  }
  if (changed && notify) notifyAssociationsChanged();
  return changed;
}

function unregister(software = "Software") {
  const k = keys(software);
  for (const key of [k.html, k.url, k.pdf, k.image, k.text, k.svg, k.client]) { try { reg(["delete", key, "/f"]); } catch (_) {} }
  try { reg(["delete", k.registered, "/v", NAME, "/f"]); } catch (_) {}
}

module.exports = { register, unregister, isRegistered, repairOpenWithIcons, keys, REG_VERSION, EXTENSIONS, iconFor };
