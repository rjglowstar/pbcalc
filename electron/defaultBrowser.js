const { execFile } = require("child_process");
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

// EVERYTHING here runs reg.exe / powershell.exe as a separate process and WAITS FOR IT WITHOUT BLOCKING the app: the first version used
// execFileSync, i.e. the main thread (windows, tabs, clicks) stood still for the whole time. Measured on the owner's PC: the "repair"
// pass alone blocked it for 4.4 s on EVERY start and the registration for 1.8 s more - five seconds after launch Windows showed "Not
// responding" (Event Log: AppHangTransient, PBCalc.exe) while the owner was clicking. Now at most 8 reg.exe run at once, asynchronously.
const MAX_PARALLEL = 8;
let running = 0;
const waiting = [];
function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    running++;
    execFile(job.file, job.args, { windowsHide: true, timeout: job.timeout }, (err, stdout) => {
      running--;
      pump();
      if (err) job.reject(err); else job.resolve(String(stdout));
    });
  }
}
const run = (file, args, timeout = 15000) => new Promise((resolve, reject) => { waiting.push({ file, args, timeout, resolve, reject }); pump(); });
const reg = (args) => run("reg", args);
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

async function isRegistered(exe, software = "Software") {
  try {
    const k = keys(software);
    const out = await reg(["query", k.client + "\\shell\\open\\command", "/ve"]);
    if (!out.includes(exe)) return false;
    return /REG_SZ\s+4\s*$/m.test(await reg(["query", k.client, "/v", "RegistrationVersion"]));
  } catch (_) { return false; }
}

// Tells Explorer / Settings that file and protocol associations changed, so the Default apps list is rebuilt now instead of
// at the next sign-in (what Chrome's installer does). Best effort.
async function notifyAssociationsChanged() {
  try {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
      'Add-Type -Namespace W -Name N -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);\'; [W.N]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)'], 15000);
  } catch (_) {}
}

// Resolves true when it wrote something (false when everything was already in place for this exe path and layout version).
async function register(exe, software = "Software", { notify = software === "Software" } = {}) {
  if (await isRegistered(exe, software)) return false;
  const k = keys(software);
  const progIds = [[k.url, "PBCalc URL", null], ...Object.keys(KINDS).map((kind) => [k[kind], LABELS[kind], kind])];
  const writes = [];
  for (const [key, label, kind] of progIds) {
    writes.push(addDefault(key, label));
    writes.push(addValue(key, "FriendlyTypeName", label));
    writes.push(addValue(key, "AppUserModelId", APP_ID));
    writes.push(addDefault(key + "\\DefaultIcon", kind ? iconFor(exe, kind) : exe + ",0"));
    writes.push(addDefault(key + "\\shell\\open\\command", command(exe)));
    // like Chrome's ProgIds: who this document type belongs to
    writes.push(addValue(key + "\\Application", "AppUserModelId", APP_ID));
    writes.push(addValue(key + "\\Application", "ApplicationName", NAME));
    writes.push(addValue(key + "\\Application", "ApplicationDescription", DESCRIPTION));
    writes.push(addValue(key + "\\Application", "ApplicationIcon", exe + ",0"));
  }
  writes.push(addValue(k.url, "URL Protocol", ""));
  writes.push(addDefault(k.client, NAME));
  writes.push(addDefault(k.client + "\\DefaultIcon", exe + ",0"));
  writes.push(addDefault(k.client + "\\shell\\open\\command", '"' + exe + '"'));
  writes.push(addDword(k.client + "\\InstallInfo", "IconsVisible", 1));
  const cap = k.client + "\\Capabilities";
  writes.push(addValue(cap, "ApplicationName", NAME));
  writes.push(addValue(cap, "ApplicationDescription", DESCRIPTION));
  writes.push(addValue(cap, "ApplicationIcon", exe + ",0"));
  writes.push(addValue(cap + "\\Startmenu", "StartMenuInternet", NAME));
  writes.push(addValue(cap + "\\URLAssociations", "http", "PBCalcURL"));
  writes.push(addValue(cap + "\\URLAssociations", "https", "PBCalcURL"));
  for (const ext of EXTENSIONS) writes.push(addValue(cap + "\\FileAssociations", ext, KINDS[kindOfExt(ext)]));
  writes.push(addValue(k.registered, NAME, k.capabilitiesPath));
  await Promise.all(writes);
  await addValue(k.client, "RegistrationVersion", REG_VERSION);   // written LAST, after everything above is in: its presence means the layout is complete
  if (notify) await notifyAssociationsChanged();
  return true;
}

// Reads one registry value as text (null = missing). name omitted = the key's (Default).
async function readReg(key, name) {
  try {
    const out = await reg(name ? ["query", key, "/v", name] : ["query", key, "/ve"]);
    const line = out.split(/\r?\n/).find((l) => /REG_\w+/.test(l));
    return line ? line.replace(/^\s*(\(Default\)|\S+)\s+REG_\w+\s*/, "").trim() : null;
  } catch (_) { return null; }
}
// Names of the subkeys / values listed under a key ("" lines skipped); [] when it does not exist.
async function listValueNames(key) {
  try { return (await reg(["query", key])).split(/\r?\n/).map((l) => l.match(/^\s{4}(\S+)\s+REG_/)).filter(Boolean).map((m) => m[1]); } catch (_) { return []; }
}

// When the user picks PBCalc through a file's Properties > "Opens with" > Change (instead of Settings > Default apps), Windows
// does NOT use our PBCalcPDF ProgId: it creates its own (`pdf_auto_file`) holding only the open command, so Explorer shows the
// exe's calculator and never pdf.ico (measured in the registry: HKCU\Classes\pdf_auto_file had no DefaultIcon). Here we put
// the type's icon on such a ProgId - but ONLY while its open command is PBCalc's, and only when it has no icon of its own - and
// take it off again once the command no longer is (the user moved the type to another app), so no stale PBCalc icon stays
// behind. Our own PBCalc* ProgIds are never touched. Runs at every start of the installed copy. Resolves the number of changes.
async function repairOpenWithIcons(exe, software = "Software", { notify = software === "Software" } = {}) {
  const S = "HKCU\\" + software, classes = S + "\\Classes";
  const exts = S + "\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts";
  const ours = (cmd) => !!cmd && cmd.toLowerCase().includes(exe.toLowerCase());
  const myIcons = new Set(Object.keys(KINDS).map((kind) => iconFor(exe, kind).toLowerCase()));
  const perExtension = await Promise.all(EXTENSIONS.map(async (ext) => {
    const found = await Promise.all([
      readReg(exts + "\\" + ext + "\\UserChoice", "ProgId"),
      readReg(classes + "\\" + ext),
      listValueNames(exts + "\\" + ext + "\\OpenWithProgids"),
      listValueNames(classes + "\\" + ext + "\\OpenWithProgids"),
    ]);
    const candidates = new Set([found[0], found[1], ...found[2], ...found[3]]
      .filter((p) => p && !/^PBCalc/i.test(p) && !/^Applications\\/i.test(p)));
    let changed = 0;
    for (const progId of candidates) {
      const key = classes + "\\" + progId;
      const [cmd, icon] = await Promise.all([readReg(key + "\\shell\\open\\command"), readReg(key + "\\DefaultIcon")]);
      try {
        if (ours(cmd) && !icon) { await addDefault(key + "\\DefaultIcon", iconFor(exe, kindOfExt(ext))); changed++; }
        else if (!ours(cmd) && icon && myIcons.has(icon.toLowerCase())) { await reg(["delete", key + "\\DefaultIcon", "/f"]); changed++; }
      } catch (_) {}
    }
    return changed;
  }));
  const changed = perExtension.reduce((a, b) => a + b, 0);
  if (changed && notify) await notifyAssociationsChanged();
  return changed;
}

async function unregister(software = "Software") {
  const k = keys(software);
  await Promise.all([k.html, k.url, k.pdf, k.image, k.text, k.svg, k.client].map((key) => reg(["delete", key, "/f"]).catch(() => {})));
  await reg(["delete", k.registered, "/v", NAME, "/f"]).catch(() => {});
}

module.exports = { register, unregister, isRegistered, repairOpenWithIcons, keys, REG_VERSION, EXTENSIONS };
