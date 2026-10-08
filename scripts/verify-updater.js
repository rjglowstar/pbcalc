// In-app updates (electron/updater.js): the real electron-updater against a local web folder. Run:
// env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-updater.js
const { app } = require("electron");
const http = require("http"), crypto = require("crypto");
const path = require("path"), fs = require("fs"), os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-upd-"));
process.env.LOCALAPPDATA = tmp;               // electron-updater's download cache goes under here, not into the real %LOCALAPPDATA%
app.setPath("userData", path.join(tmp, "UserData"));
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the "server folder" holds right now (the test changes it between cases)
const NAME = "PBCalc Setup 0.2.0.exe";
const exe = crypto.randomBytes(2 * 1024 * 1024);
const sha = crypto.createHash("sha512").update(exe).digest("base64");
const ymlFor = (version, shaValue) => `version: ${version}\nfiles:\n  - url: ${NAME}\n    sha512: ${shaValue}\n    size: ${exe.length}\npath: ${NAME}\nsha512: ${shaValue}\nreleaseDate: '2026-10-08T00:00:00.000Z'\n`;
let folder = {};
const hits = [];
const server = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split("?")[0]).replace(/^\/assets\//, "");
  hits.push(p);
  const f = folder[p];
  if (f === undefined) { r.statusCode = 404; return r.end("not found"); }
  r.setHeader("content-type", f.type || "application/octet-stream");
  r.end(f.body);
});

const DEV_YML = path.join(__dirname, "dev-app-update.yml");   // electron-updater reads this next to the script when it is not an installed app
const cleanup = () => { try { fs.unlinkSync(DEV_YML); } catch (_) {} };
process.on("exit", cleanup);

(async () => {
  try {
    await app.whenReady();
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const feedUrl = "http://127.0.0.1:" + server.address().port + "/assets/";
    fs.writeFileSync(DEV_YML, ["provider: generic", "url: " + feedUrl, "channel: pbcalc", "updaterCacheDirName: pbcalc-updater", ""].join("\n"));
    const updater = require("../electron/updater");
    const state = require("../electron/state");
    check("the channel is 'pbcalc' (pbcalc.yml, never the ERP's latest.yml)", updater.CHANNEL === "pbcalc");

    // one scenario: fresh state, what the folder holds, what the popup answered / the installer did.
    // opts.answer: "update" (default) | "cancel" | "throw" ; opts.declinedBefore: a version remembered from an earlier session
    async function run(name, files, opts = {}) {
      folder = files; hits.length = 0; state.quitting = false;
      const store = { v: opts.declinedBefore || "" };
      const seen = { notified: [], installed: [], logs: [], declined: store };
      const u = updater.setup({
        feedUrl, delayMs: 3600000, currentVersion: opts.current || "0.1.5",
        ask: async (i) => { seen.notified.push(i.version); if (opts.answer === "throw") throw new Error("no window"); return opts.answer !== "cancel"; },
        install: (i) => { seen.installed.push(i.version); },
        log: (m) => seen.logs.push(m),
        declined: { get: () => store.v, set: (v) => { store.v = v; } },
      });
      await (opts.manual ? u.checkNow() : u.check());
      await sleep(opts.waitMs || 2500);
      u.autoUpdater.removeAllListeners();
      return { seen, hits: hits.slice(), u };
    }
    const yml = (v, s) => ({ "pbcalc.yml": { body: ymlFor(v, s || sha), type: "text/yaml" }, [NAME]: { body: exe } });

    console.log("-- a newer version is on the server, the user presses UPDATE");
    let r = await run("newer", yml("0.2.0"));
    check("it asks for pbcalc.yml (and not latest.yml)", r.hits.includes("pbcalc.yml") && !r.hits.includes("latest.yml"), r.hits.join(","));
    check("the installer file is downloaded", r.hits.includes(NAME), r.hits.join(","));
    check("the popup is shown once, for version 0.2.0", r.seen.notified.join() === "0.2.0", JSON.stringify(r.seen.notified));
    check("Update: the installer is started once", r.seen.installed.join() === "0.2.0", JSON.stringify(r.seen.installed));
    check("...the program knows it is really quitting (the calculator must not hold the window open)", state.quitting === true);
    check("...and nothing stays 'declined'", r.seen.declined.v === "");

    console.log("\n-- nothing is forced: the user presses CANCEL");
    r = await run("cancel", yml("0.2.0"), { answer: "cancel" });
    check("Cancel: the popup was shown, and the installer is NOT started (PBCalc keeps running untouched)", r.seen.notified.join() === "0.2.0" && !r.seen.installed.length && state.quitting === false, JSON.stringify(r.seen));
    check("...the postponed version is remembered for the next start (settings.json -> updateDeclined)", r.seen.declined.v === "0.2.0");
    check("...later, when the browser is closed, the postponed update installs (once)", r.u.installIfPending() === true && r.seen.installed.join() === "0.2.0" && r.u.installIfPending() === false);
    const none = await run("same2", yml("0.1.5"));
    check("nothing was downloaded -> 'browser closed' installs nothing", none.u.installIfPending() === false && !none.seen.installed.length);

    console.log("\n-- the next start after a Cancel: it just updates");
    r = await run("next start", yml("0.2.0"), { declinedBefore: "0.2.0" });
    check("this version was declined earlier: NO popup, the installer starts", !r.seen.notified.length && r.seen.installed.join() === "0.2.0", JSON.stringify(r.seen));
    r = await run("newer again", yml("0.2.0"), { declinedBefore: "0.1.9" });
    check("an even newer version than the declined one: the popup comes again", r.seen.notified.join() === "0.2.0" && r.seen.installed.join() === "0.2.0");

    console.log("\n-- Settings > Version > Check for update (checkNow)");
    r = await run("manual newer", yml("0.2.0"), { manual: true });
    check("a newer version: the popup comes (once, for 0.2.0) with no restart of PBCalc", r.seen.notified.join() === "0.2.0" && r.seen.installed.join() === "0.2.0", JSON.stringify(r.seen));
    r = await run("manual declined", yml("0.2.0"), { manual: true, declinedBefore: "0.2.0", answer: "cancel" });
    check("a version declined earlier is ASKED again on a button press (not installed behind the user's back)", r.seen.notified.join() === "0.2.0" && !r.seen.installed.length, JSON.stringify(r.seen));
    r = await run("manual same", yml("0.1.5"), { manual: true });
    check("no newer version: nothing at all is shown or installed", r.hits.includes("pbcalc.yml") && !r.hits.includes(NAME) && !r.seen.notified.length && !r.seen.installed.length, JSON.stringify({ hits: r.hits, seen: r.seen }));
    r = await run("manual web page", { "pbcalc.yml": { body: "<!doctype html><html></html>", type: "text/html" } }, { manual: true });
    check("a server that answers with a web page: still nothing shown, no crash", !r.seen.notified.length && !r.seen.installed.length);
    r = await run("start after manual", yml("0.2.0"), { declinedBefore: "0.2.0" });
    check("the start rule is unchanged: a declined version still installs at the next START without asking", !r.seen.notified.length && r.seen.installed.join() === "0.2.0", JSON.stringify(r.seen));

    console.log("\n-- the popup cannot be shown: never forced either");
    r = await run("popup fails", yml("0.2.0"), { answer: "throw" });
    check("a popup that fails counts as Cancel: the installer is NOT started, the update waits for the close", r.seen.notified.length === 1 && !r.seen.installed.length && r.seen.declined.v === "0.2.0", JSON.stringify(r.seen));

    console.log("\n-- what Update and Cancel really call (the dialog itself is tested in verify-update-dialog.js / verify-updater-popup.js)");
    const real = require("electron-updater").autoUpdater;
    const origQuit = real.quitAndInstall; let qargs = null; real.quitAndInstall = (a, b) => { qargs = [a, b]; };
    for (const yes of [true, false]) {
      qargs = null; folder = yml("0.2.0"); hits.length = 0; state.quitting = false;
      const u2 = updater.setup({ feedUrl, delayMs: 3600000, currentVersion: "0.1.5", log: () => {}, ask: async () => yes, declined: { get: () => "", set: () => {} } });
      await u2.check(); await sleep(2500); real.removeAllListeners();
      if (yes) {
        check("Update: the installer runs SILENT and PBCalc is started again afterwards: quitAndInstall(true, true)", qargs && qargs[0] === true && qargs[1] === true, JSON.stringify(qargs));
        check("...and the program knows it is really quitting", state.quitting === true);
      } else {
        check("Cancel: quitAndInstall is not called and the app is not quitting", qargs === null && state.quitting === false, JSON.stringify(qargs));
      }
    }
    real.quitAndInstall = origQuit;

    console.log("\n-- nothing to do");
    r = await run("same", yml("0.1.5"));
    check("same version: asked the server, nothing downloaded, no box, no install", r.hits.includes("pbcalc.yml") && !r.hits.includes(NAME) && !r.seen.notified.length && !r.seen.installed.length, JSON.stringify({ hits: r.hits, seen: r.seen }));
    r = await run("older", yml("0.0.9"));
    check("an OLDER version on the server is never installed (no downgrade)", r.hits.includes("pbcalc.yml") && !r.seen.notified.length && !r.seen.installed.length && !r.hits.includes(NAME), JSON.stringify({ hits: r.hits, seen: r.seen }));

    console.log("\n-- the server has nothing usable (must never show anything or crash)");
    r = await run("html", { "pbcalc.yml": { body: "<!doctype html><html><body><app-root></app-root></body></html>", type: "text/html" } });
    check("a web page instead of pbcalc.yml (what the test server answers for a missing file): quietly ignored", r.hits.includes("pbcalc.yml") && !r.seen.notified.length && !r.seen.installed.length && r.seen.logs.some((l) => /error|failed|up to date/.test(l)), JSON.stringify(r.seen.logs));
    r = await run("404", {});
    check("no file at all (404): quietly ignored", r.hits.includes("pbcalc.yml") && !r.seen.notified.length && !r.seen.installed.length);
    r = await run("empty", { "pbcalc.yml": { body: "", type: "text/yaml" } });
    check("an empty pbcalc.yml: quietly ignored", r.hits.includes("pbcalc.yml") && !r.seen.notified.length && !r.seen.installed.length);
    r = await run("garbage", { "pbcalc.yml": { body: "version: [[[\n\t- :", type: "text/yaml" } });
    check("a broken pbcalc.yml: quietly ignored", r.hits.includes("pbcalc.yml") && !r.seen.notified.length && !r.seen.installed.length);

    console.log("\n-- the ERP's file in the same folder");
    r = await run("erp", { "latest.yml": { body: ymlFor("9.9.9"), type: "text/yaml" }, [NAME]: { body: exe } });
    check("a newer latest.yml (the ERP's) is NOT used by PBCalc", !r.seen.notified.length && !r.seen.installed.length && !r.hits.includes("latest.yml") && !r.hits.includes(NAME), r.hits.join(","));

    console.log("\n-- a damaged download");
    r = await run("bad sha", yml("0.2.0", crypto.createHash("sha512").update("other").digest("base64")), { waitMs: 3500 });
    check("wrong checksum: the file WAS downloaded, but the installer is NOT started and no box is shown", r.hits.includes(NAME) && !r.seen.installed.length && !r.seen.notified.length, JSON.stringify(r.seen));

    console.log("\n-- wiring");
    const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    check("Settings page has the button in the Version row", /id="app-version"[\s\S]{0,200}id="check-update"/.test(rd("renderer/settings/settings.html")));
    check("the button calls settingsAPI.checkUpdate and writes no result text", /checkUpdate\(\)/.test(rd("renderer/settings/settings.js")) && !/check-update[\s\S]{0,300}textContent/.test(rd("renderer/settings/settings.js")));
    check("the preload exposes it on the settings bridge only", /"settingsAPI"[\s\S]{0,900}checkUpdate: \(\) => ipcRenderer\.invoke\("settings:check-update"\)/.test(rd("preloads/tab-preload.js")));
    check("main answers settings:check-update only for the settings page", /"settings:check-update", async \(e\) => \{\s*if \(!fromSettingsPage\(e\)\) return false;/.test(rd("electron/ipc/registerIpcHandlers.js")));
    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");
    check("main.js starts the updater only for the installed program (app.isPackaged)", /app\.isPackaged[^\n]*require\("\.\/updater"\)\.setup\(\)/.test(mainSrc));
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const pub = pkg.build.publish[0];
    check("package.json publishes to the generic server folder on channel pbcalc", pub.provider === "generic" && pub.channel === "pbcalc" && /^https?:\/\/.+\/$/.test(pub.url), JSON.stringify(pub));
    check("electron-updater is a runtime dependency (it must be inside the installed app)", !!(pkg.dependencies && pkg.dependencies["electron-updater"]));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  try { require("electron-updater").autoUpdater.autoInstallOnAppQuit = false; } catch (_) {}   // the downloaded file is a fake: never let the quit hook run it
  server.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_UPDATER total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
