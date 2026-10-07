// PBCalc as a candidate for Windows' "Default apps": (1) what an outside program hands us (a link / a file) is parsed safely,
// (2) a second launch forwards it to the running window - and does NOT run the startup sweep that would wipe the running
// session -, (3) PBCalc started BY a link shows it as its first tab, (4) the registry entries that make Windows list PBCalc
// are complete, idempotent and removable. (The Settings > Default apps screen itself is Windows UI and is not driven here.)
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-default-browser.js
const { app } = require("electron");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
const PHASE = process.env.PBCALC_PHASE || "";
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 200000).unref();
const root = PHASE ? process.env.PBCALC_UD : fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-defbrowser-"));
const ud = path.join(root, "UserData");
require("../electron/constants").dataDir = () => ud;
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

// the SECOND launch has nothing to do: main.js quits it (that is what is being tested)
if (PHASE === "second") return;

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const eo = require("../electron/externalOpen");
    const db = require("../electron/defaultBrowser");

    // first-launch child: reports its tabs and ends
    if (PHASE === "first") {
      await sleep(2500);
      console.log("CHILD_TABS " + JSON.stringify(state.tabs.map((t) => t.view.webContents.getURL())));
      app.exit(0); return;
    }

    const tabUrls = () => state.tabs.map((t) => t.view.webContents.getURL());
    const srv = http.createServer((q, res) => { res.setHeader("content-type", "text/html"); res.end("<title>" + q.url + "</title>x"); });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;

    console.log("-- what an outside program may hand us");
    const f = path.join(root, "files"); fs.mkdirSync(f);
    const pdf = path.join(f, "a b.pdf"); fs.writeFileSync(pdf, "%PDF-1.1\n");
    const html = path.join(f, "p.htm"); fs.writeFileSync(html, "<title>local</title>");
    const exe = path.join(f, "x.exe"); fs.writeFileSync(exe, "MZ");
    const t = (argv, cwd) => eo.targetFromArgv(["PBCalc.exe", ...argv], cwd);
    check("an https address", t(["https://example.org/a?b=1"]) === "https://example.org/a?b=1");
    check("flags are skipped, the address after them is used", t(["--some-flag", "http://x.test/"]) === "http://x.test/");
    check("a local PDF by path (with a space)", /^file:\/\/\/.*a%20b\.pdf$/i.test(t([pdf])));
    check("the same by relative path + working folder", /a%20b\.pdf$/.test(t(["a b.pdf"], f)));
    check("a file:// address of a real file", /a%20b\.pdf$/.test(t([require("url").pathToFileURL(pdf).href])));
    check("a local .htm page", /p\.htm$/.test(t([html])));
    check("NOT: an .exe", t([exe]) === null);
    check("NOT: javascript:", t(["javascript:alert(1)"]) === null);
    check("NOT: ftp:", t(["ftp://x/y"]) === null);
    check("NOT: a file that does not exist", t([path.join(f, "nope.pdf")]) === null);
    check("NOT: the app folder Electron is started with ('.')", t(["."]) === null);
    check("NOT: nothing at all", t([]) === null);

    console.log("\n-- a second launch is forwarded to the running window");
    await sleep(500);
    const sentinel = path.join(ud, "sentinel-must-survive.tmp"); fs.writeFileSync(sentinel, "x");
    // Extra copies are started ASYNCHRONOUSLY: this process is the running browser (its event loop must stay free to answer the
    // second launch and to serve the test web server) - a blocking spawnSync froze both and made the test lie.
    const launch = (arg, phase, ud2) => new Promise((resolve) => {
      const env = { ...process.env, PBCALC_PHASE: phase, PBCALC_UD: ud2 }; delete env.ELECTRON_RUN_AS_NODE;
      const c = spawn(process.execPath, [__filename, ...(arg ? [arg] : [])], { env, stdio: ["ignore", "pipe", "ignore"] });
      let out = ""; c.stdout.on("data", (d) => (out += d));
      const kill = setTimeout(() => { try { c.kill(); } catch (_) {} }, 60000);
      c.on("exit", (code) => { clearTimeout(kill); resolve({ status: code, stdout: out }); });
    });
    const second = (arg) => launch(arg, "second", root);
    const n0 = state.tabs.length;
    const t0 = Date.now();
    const r1 = await second(base + "/from-another-program");
    const took = Date.now() - t0;
    check("the second launch ends by itself (exit code 0, no window of its own)", r1.status === 0 && took < 20000);
    await sleep(2500);
    check("...and its address opened as a NEW TAB in the running window", state.tabs.length === n0 + 1 && /from-another-program$/.test(tabUrls()[tabUrls().length - 1]));
    check("the second launch did NOT run the startup sweep (the running session's files are untouched)", fs.existsSync(sentinel));
    await second(pdf); await sleep(2500);
    check("a local PDF handed over opens in a tab", /a%20b\.pdf$/.test(tabUrls()[tabUrls().length - 1]));
    const n1 = state.tabs.length;
    await second("--nothing-to-open"); await sleep(1500);
    check("a launch with nothing to open opens no tab", state.tabs.length === n1);

    console.log("\n-- Restricted Mode never opens anything from outside");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    const n2 = state.tabs.length;
    await second(base + "/must-not-open"); await sleep(2000);
    check("a link from another program opens NOTHING in Restricted Mode", state.tabs.length === n2 && !tabUrls().some((u) => /must-not-open/.test(u)));
    tm.leaveRestricted(); await sleep(800);

    console.log("\n-- PBCalc started BY a link shows it as the first tab");
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-defbrowser2-"));
    const tabsOf = (out) => { const l = (out || "").split(/\r?\n/).find((x) => x.startsWith("CHILD_TABS ")); try { return JSON.parse(l.slice(11)); } catch (_) { return []; } };
    const c1 = await launch(base + "/opened-at-start", "first", root2);
    const tabs2 = tabsOf(c1.stdout);
    check("started with an address: exactly one tab, and it is that address (the New Tab page made room)", tabs2.length === 1 && /opened-at-start$/.test(tabs2[0]));
    const c2 = await launch(null, "first", root2);
    const tabs3 = tabsOf(c2.stdout);
    check("started normally (no address): the usual single New Tab page", tabs3.length === 1 && /newtab\.html$/.test(tabs3[0]));
    try { fs.rmSync(root2, { recursive: true, force: true }); } catch (_) {}

    console.log("\n-- the registry entries that make Windows list PBCalc (written under a TEST key, not the real one)");
    const sw = "Software\\PBCalcRegTest" + process.pid;
    const fakeExe = "C:\\Program Files\\PBCalc Test\\PBCalc.exe";
    // value of a registry entry as text; null = it does not exist
    const q = (key, name) => {
      try {
        const out = execFileSync("reg", name ? ["query", key, "/v", name] : ["query", key, "/ve"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
        const line = out.split(/\r?\n/).find((l) => /REG_(SZ|DWORD)/.test(l));
        return line ? line.split(/REG_(?:SZ|DWORD)/)[1].trim() : null;   // a DWORD comes back as "0x1"
      } catch (_) { return null; }
    };
    const realPdfCmd = q("HKCU\\Software\\Classes\\pdf_auto_file\\shell\\open\\command");
    const realBefore =q("HKCU\\Software\\RegisteredApplications", "PBCalc");
    const k = db.keys(sw);
    check("not registered at first", db.isRegistered(fakeExe, sw) === false);
    check("register() writes", db.register(fakeExe, sw) === true);
    check("the browser entry opens PBCalc", q(k.client + "\\shell\\open\\command") === '"' + fakeExe + '"');
    check("http and https both point at the URL handler", q(k.client + "\\Capabilities\\URLAssociations", "http") === "PBCalcURL" && q(k.client + "\\Capabilities\\URLAssociations", "https") === "PBCalcURL");
    check(".htm / .html / .pdf point at their handlers", q(k.client + "\\Capabilities\\FileAssociations", ".htm") === "PBCalcHTML" && q(k.client + "\\Capabilities\\FileAssociations", ".html") === "PBCalcHTML" && q(k.client + "\\Capabilities\\FileAssociations", ".pdf") === "PBCalcPDF");
    check("each handler launches PBCalc with the clicked address/file (\"%1\")", [k.url, k.html, k.pdf].every((key) => q(key + "\\shell\\open\\command") === '"' + fakeExe + '" "%1"'));
    check("the URL handler is marked as a protocol (an empty 'URL Protocol' value exists)", q(k.url, "URL Protocol") === "");
    check("name and description are there", q(k.client + "\\Capabilities", "ApplicationName") === "PBCalc" && !!q(k.client + "\\Capabilities", "ApplicationDescription"));
    check("it is listed in RegisteredApplications, pointing at the Capabilities key", q(k.registered, "PBCalc") === k.capabilitiesPath);
    // what Chrome / Opera / Firefox have and PBCalc's first version did NOT (read from the registry of the owner's PC)
    check("the browser names its Start-menu slot (Capabilities\\Startmenu\\StartMenuInternet)", q(k.client + "\\Capabilities\\Startmenu", "StartMenuInternet") === "PBCalc");
    check("InstallInfo\\IconsVisible = 1", q(k.client + "\\InstallInfo", "IconsVisible") === "0x1");
    check("each ProgId says which application it belongs to (like Chrome's)", [k.url, k.html, k.pdf].every((key) => q(key + "\\Application", "ApplicationName") === "PBCalc" && q(key + "\\Application", "AppUserModelId") === "com.pbcalc.browser" && !!q(key, "FriendlyTypeName")));
    check("the layout version is stamped (4)", q(k.client, "RegistrationVersion") === db.REG_VERSION && db.REG_VERSION === "4");
    // per-type handlers: every extension PBCalc lists belongs to the ProgId of its kind, and there is one for images and text
    const FA = k.client + "\\Capabilities\\FileAssociations";
    const want = { ".htm": "PBCalcHTML", ".xhtml": "PBCalcHTML", ".pdf": "PBCalcPDF", ".png": "PBCalcIMG", ".jpg": "PBCalcIMG", ".webp": "PBCalcIMG", ".svg": "PBCalcSVG", ".txt": "PBCalcTXT", ".json": "PBCalcTXT" };
    check("images and text files are listed under the matching handler too", Object.entries(want).every(([ext, id]) => q(FA, ext) === id));
    check("every extension in EXTENSIONS is registered", db.EXTENSIONS.every((ext) => !!q(FA, ext)));
    check("the image / text handlers launch PBCalc with the file", [k.image, k.text].every((key) => q(key + "\\shell\\open\\command") === '"' + fakeExe + '" "%1"'));
    check("without icon files the handlers fall back to the exe's icon", [k.pdf, k.image, k.text, k.html].every((key) => q(key + "\\DefaultIcon") === fakeExe + ",0"));
    check("calling register() again changes nothing (idempotent)", db.register(fakeExe, sw) === false);
    // an installed copy that registered with the FIRST layout (no version stamp) is upgraded at its next start
    try { execFileSync("reg", ["delete", k.client, "/v", "RegistrationVersion", "/f"], { stdio: "ignore" }); } catch (_) {}
    check("an old registration (no version stamp) is NOT taken for current", db.isRegistered(fakeExe, sw) === false);
    check("...and register() rewrites it", db.register(fakeExe, sw) === true && db.isRegistered(fakeExe, sw) === true);
    db.unregister(sw);
    check("unregister() removes the entries", db.isRegistered(fakeExe, sw) === false && q(k.registered, "PBCalc") === null && q(k.url + "\\shell\\open\\command") === null);
    check("unregister() removes the image / text handlers too", q(k.image + "\\shell\\open\\command") === null && q(k.text + "\\shell\\open\\command") === null);
    // installed layout: <install>\PBCalc.exe with <install>\resources\file-icons\*.ico beside it -> each type gets its own icon
    const inst = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-inst-"));
    fs.mkdirSync(path.join(inst, "resources", "file-icons"), { recursive: true });
    const realIcons = path.join(__dirname, "..", "assets", "file-icons");
    for (const kind of ["pdf", "html", "image", "text", "svg"]) fs.copyFileSync(path.join(realIcons, kind + ".ico"), path.join(inst, "resources", "file-icons", kind + ".ico"));
    const exe2 = path.join(inst, "PBCalc.exe");
    check("the four shipped .ico files exist and start with a valid ICO header", ["pdf", "html", "image", "text", "svg"].every((kind) => { const b = fs.readFileSync(path.join(realIcons, kind + ".ico")); return b.readUInt16LE(0) === 0 && b.readUInt16LE(2) === 1 && b.readUInt16LE(4) === 7; }));
    db.register(exe2, sw);
    const icon = (key) => q(key + "\\DefaultIcon");
    check("with the icon files present each handler gets ITS OWN icon", icon(k.pdf) === path.join(inst, "resources", "file-icons", "pdf.ico") && icon(k.html).endsWith("html.ico") && icon(k.image).endsWith("image.ico") && icon(k.text).endsWith("text.ico") && icon(k.svg).endsWith("svg.ico"));
    check("only .pdf and .svg have an icon of their own: .png / .jpg share the IMAGE one", q(FA, ".png") === "PBCalcIMG" && q(FA, ".jpg") === "PBCalcIMG" && q(FA, ".svg") === "PBCalcSVG" && q(FA, ".pdf") === "PBCalcPDF");
    check("...while the URL handler and the browser entry keep the exe icon", icon(k.url) === exe2 + ",0" && q(k.client + "\\DefaultIcon") === exe2 + ",0");
    // "Opens with > Change": Windows makes its own ProgId (pdf_auto_file) with only the open command -> no icon
    console.log("\n-- a type the user gave to PBCalc through 'Opens with > Change' (Windows' own ProgId, no icon)");
    const add = (key, name, value) => execFileSync("reg", name ? ["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"] : ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
    const T = "HKCU\\" + sw, FE = T + "\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts";
    add(FE + "\\.pdf\\UserChoice", "ProgId", "pdf_auto_file");
    add(T + "\\Classes\\pdf_auto_file\\shell\\open\\command", null, '"' + exe2 + '" "%1"');
    const pdfIcon = path.join(inst, "resources", "file-icons", "pdf.ico");
    check("before: the Windows-made ProgId has no icon (the reported bug)", q(T + "\\Classes\\pdf_auto_file\\DefaultIcon") === null);
    check("repairOpenWithIcons puts the PDF icon on it", db.repairOpenWithIcons(exe2, sw) === 1 && q(T + "\\Classes\\pdf_auto_file\\DefaultIcon") === pdfIcon);
    check("...and running it again changes nothing", db.repairOpenWithIcons(exe2, sw) === 0);
    add(T + "\\Classes\\otherfile\\shell\\open\\command", null, '"C:\\Other\\App.exe" "%1"');
    add(T + "\\Classes\\otherfile\\DefaultIcon", null, "C:\\Other\\App.exe,0");
    add(FE + "\\.png\\UserChoice", "ProgId", "otherfile");
    check("a ProgId that opens ANOTHER app is left alone (icon and command untouched)", db.repairOpenWithIcons(exe2, sw) === 0 && q(T + "\\Classes\\otherfile\\DefaultIcon") === "C:\\Other\\App.exe,0");
    add(T + "\\Classes\\ownicon\\shell\\open\\command", null, '"' + exe2 + '" "%1"');
    add(T + "\\Classes\\ownicon\\DefaultIcon", null, "C:\\Mine\\mine.ico");
    add(FE + "\\.txt\\UserChoice", "ProgId", "ownicon");
    check("a ProgId that already has an icon of its own keeps it", db.repairOpenWithIcons(exe2, sw) === 0 && q(T + "\\Classes\\ownicon\\DefaultIcon") === "C:\\Mine\\mine.ico");
    // the user moves .pdf to another app: Windows repoints the ProgId's command; our icon must not stay on it
    add(T + "\\Classes\\pdf_auto_file\\shell\\open\\command", null, '"C:\\Other\\Reader.exe" "%1"');
    check("when the type is given to another app the PBCalc icon is taken off again", db.repairOpenWithIcons(exe2, sw) === 1 && q(T + "\\Classes\\pdf_auto_file\\DefaultIcon") === null);
    check("our own PBCalc* ProgIds are never touched by it", (() => { db.register(exe2, sw); add(FE + "\\.svg\\UserChoice", "ProgId", "PBCalcSVG"); const before = q(k.svg + "\\DefaultIcon"); db.repairOpenWithIcons(exe2, sw); return q(k.svg + "\\DefaultIcon") === before && !!before; })());
    check("the REAL pdf_auto_file was not touched by this test", q("HKCU\\Software\\Classes\\pdf_auto_file\\shell\\open\\command") === realPdfCmd);
    db.unregister(sw);
    try { fs.rmSync(inst,{ recursive: true, force: true }); } catch (_) {}
    try { execFileSync("reg", ["delete", "HKCU\\" + sw, "/f"], { stdio: "ignore" }); } catch (_) {}
    check("the REAL Default-apps list is exactly as it was before this test", q("HKCU\\Software\\RegisteredApplications", "PBCalc") === realBefore);
    check("no uncaught error", errors.length === 0);
    srv.close();
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_DEFBROWSER total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
