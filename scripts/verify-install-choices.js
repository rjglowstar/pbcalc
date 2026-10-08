// The installer's answers (install-choices.json) are applied once at the first start. Run:
// env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-install-choices.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-ic-"));
app.setPath("userData", path.join(tmp, "UserData"));
fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };

app.whenReady().then(() => {
  try {
    const ic = require("../electron/installChoices");
    const settings = require("../electron/settings");
    const f = path.join(tmp, "install-choices.json");
    const write = (o) => fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o));
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(path.join(tmp, "UserData", "settings.json"), "utf8")); } catch (_) { return {}; } };

    check("no file: nothing to apply, nothing changed", ic.apply(f) === null && settings.get("calculatorStart") === undefined);
    write({ defaultBrowser: true, calculatorStart: true });
    const r = ic.apply(f);
    check("answers: calculator start is saved in settings.json", settings.get("calculatorStart") === true && onDisk().calculatorStart === true);
    check("...and 'default browser' is handed back so the program can open Windows' Default apps page", r && r.defaultBrowser === true);
    check("...the file is deleted after reading", !fs.existsSync(f));
    check("a second start finds nothing to do", ic.apply(f) === null);

    console.log("-- a file that cannot be deleted (read-only install folder)");
    write({ defaultBrowser: false, calculatorStart: true });
    const t = new Date(Date.now() - 100000); fs.utimesSync(f, t, t);
    settings.set("calculatorStart", false);                       // the owner turned it off later
    fs.chmodSync(f, 0o444);
    const real = fs.unlinkSync; let blocked = 0;
    fs.unlinkSync = (p) => { if (p === f) { blocked++; throw new Error("EPERM"); } return real(p); };
    const first = ic.apply(f);
    check("first read applies it (file stays because deleting is refused)", first && first.defaultBrowser === false && settings.get("calculatorStart") === true && fs.existsSync(f) && blocked === 1);
    settings.set("calculatorStart", false);
    check("the same file is NEVER applied twice: a later change of the setting survives the next start", ic.apply(f) === null && settings.get("calculatorStart") === false);
    fs.unlinkSync = real; fs.chmodSync(f, 0o666);

    console.log("-- a new install brings new answers");
    write({ defaultBrowser: false, calculatorStart: false }); const later = new Date(); fs.utimesSync(f, later, later);
    ic.apply(f);
    check("a new file (new time) applies again: calculator start off", settings.get("calculatorStart") === false);

    console.log("-- junk is ignored");
    settings.set("calculatorStart", true);
    for (const junk of ["not json", "[1,2]", "null", '{"calculatorStart":"yes","defaultBrowser":"true"}']) {
      write(junk); const fut = new Date(Date.now() + 5000 + Math.random() * 1000); fs.utimesSync(f, fut, fut);
      const x = ic.apply(f);
      check("junk " + junk.slice(0, 22) + ": setting untouched, default-browser not triggered", settings.get("calculatorStart") === true && (x === null || x.defaultBrowser === false), JSON.stringify(x));
      try { fs.unlinkSync(f); } catch (_) {}
    }
    // a restart: settings.js loads settings.json again and drops every key it does not know
    settings.set("calculatorStart", true); settings.set("installChoicesStamp", 12345);
    delete require.cache[require.resolve("../electron/settings")];
    const reloaded = require("../electron/settings");
    check("calculatorStart and the stamp survive a restart (settings.js knows both keys)", reloaded.get("calculatorStart") === true && reloaded.get("installChoicesStamp") === 12345, JSON.stringify([reloaded.get("calculatorStart"), reloaded.get("installChoicesStamp")]));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_INSTALLCHOICES total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
});
