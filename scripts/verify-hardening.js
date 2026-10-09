// Regression checks for the bugs found in the 2026-10-09 review (each one was reproduced first, then fixed):
//  1. window.open(blob:...) - a page opening content it generated itself (a report / invoice PDF) - was dropped; Chrome opens it.
//  2. A Retry of a download used the DEFAULT session, so the cookies / login of the site (the tabs' session) were not sent.
//  3. A page could stack any number of "Open external application?" dialogs (mailto: in a loop).
//  4. window.vaultAPI had no size / count limits: a page could fill the vault without end (every save re-encrypts the whole vault).
//  5. A failed save of the vault password left the NEW password active in memory only.
//  6. Files the user would lose (vault, vault password, bookmarks, settings) were written in place: a crash in the middle left half a file.
//  7. An IPv6 address typed in the address bar became a Google search.
//  8. Restricted Mode: a blob: address of the site's own page counts as that site.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-hardening.js
const { app, dialog } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 150000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-hard-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");
fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });
fs.writeFileSync(path.join(tmp, "UserData", "settings.json"), JSON.stringify({ showBookmarksBar: false }));
const prompts = [];
dialog.showMessageBox = (...a) => { prompts.push(a[a.length - 1]); return new Promise(() => {}); };   // a question that is never answered: a second one must not appear
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra !== undefined ? "  <" + extra + ">" : "")); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const { session } = require("electron");
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const downloads = require("../electron/downloads/downloadManager");
    const { TAB_PARTITION } = require("../electron/constants");

    // a tiny site: a page, and a file that only answers with the right cookie
    const hits = [];
    const srv = http.createServer((q, res) => {
      if (q.url.startsWith("/file")) {
        const ok = /(^|;\s*)auth=1/.test(q.headers.cookie || "");
        hits.push(ok);
        if (!ok) { res.statusCode = 403; return res.end("no"); }
        res.setHeader("content-type", "application/octet-stream"); res.setHeader("content-disposition", 'attachment; filename="hard-test.bin"');
        return res.end(Buffer.alloc(2048, 1));
      }
      res.setHeader("content-type", "text/html"); res.end("<html><body style='width:500px;height:500px'>page</body></html>");
    }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = "http://127.0.0.1:" + srv.address().port;

    console.log("-- 1. window.open(blob:)");
    tm.createTab(base + "/"); await sleep(1500);
    const wc = tm.getActiveTab().view.webContents;
    const n0 = state.tabs.length;
    wc.sendInputEvent({ type: "mouseDown", x: 40, y: 40, button: "left", clickCount: 1 }); wc.sendInputEvent({ type: "mouseUp", x: 40, y: 40, button: "left", clickCount: 1 });
    const opened = await wc.executeJavaScript('!!window.open(URL.createObjectURL(new Blob(["<h1>report</h1>"], { type: "text/html" })))', true);
    await sleep(1500);
    const last = state.tabs[state.tabs.length - 1];
    check("a page can open its own blob: content in a new tab", opened === true && state.tabs.length === n0 + 1 && /^blob:http:\/\/127\.0\.0\.1/.test(last.url), opened + " " + state.tabs.length + " " + (last && last.url));
    const n1 = state.tabs.length;
    const evil = await wc.executeJavaScript('!!window.open("file:///C:/Windows/win.ini") || !!window.open("data:text/html,x") || !!window.open("ms-settings:") || !!window.open("pbcalc://settings")', true);
    await sleep(500);
    check("file: / data: / ms-settings: / pbcalc: popups are still refused (javascript: opens an about:blank page, as in Chrome)", evil === false && state.tabs.length === n1, evil + " " + state.tabs.length);

    console.log("-- 2. Retry uses the tabs' session (the cookie of the site)");
    await session.fromPartition(TAB_PARTITION).cookies.set({ url: base, name: "auth", value: "1" });
    tm.switchTab(state.tabs[0].id); await sleep(300);
    wc.downloadURL(base + "/file");
    for (let i = 0; i < 40 && !downloads.publicList().some((d) => d.state === "completed"); i++) await sleep(250);
    const done = downloads.publicList().find((d) => d.state === "completed");
    check("the first download (cookie present) completes", !!done && hits[0] === true, JSON.stringify(hits));
    const before = hits.length;
    downloads.retry(done.id);
    await sleep(2500);
    check("Retry sends the same cookie (before the fix it did not)", hits.length > before && hits[hits.length - 1] === true, JSON.stringify(hits));

    console.log("-- 3. one external-application question at a time");
    const wc2 = tm.getActiveTab().view.webContents;
    prompts.length = 0;
    for (let i = 0; i < 5; i++) { await wc2.executeJavaScript('(() => { const w = window.open("mailto:a' + i + '@b.c"); return 1; })()', true).catch(() => {}); await sleep(250); }
    check("five mailto: attempts raise ONE dialog (it used to be five)", prompts.length === 1, prompts.length);

    console.log("-- 4. the vault limits what a page can store");
    const v = require("../electron/vault/passwordVault.js");
    check("an ordinary login is saved", v.saveCredential({ origin: "https://a.example", username: "bob", password: "pw" }) === true);
    check("a 5000-character password is refused", v.saveCredential({ origin: "https://a.example", username: "big", password: "p".repeat(5000) }) === false);
    check("a 5000-character username is refused", v.saveCredential({ origin: "https://a.example", username: "u".repeat(5000), password: "p" }) === false);
    check("a username that is not text is refused", v.saveCredential({ origin: "https://a.example", username: { x: 1 }, password: "p" }) === false);
    let ok = 0; for (let i = 0; i < 120; i++) if (v.saveCredential({ origin: "https://spam.example", username: "u" + i, password: "p" })) ok++;
    check("one site can keep at most 50 logins", ok === 50, ok);
    check("another site still works, and an existing login can be updated", v.saveCredential({ origin: "https://b.example", username: "al", password: "pw" }) === true && v.saveCredential({ origin: "https://spam.example", username: "u0", password: "new" }) === true);

    console.log("-- 5. a failed save of the vault password changes nothing");
    const lock = require("../electron/vault/vaultLock");
    lock._reset();
    const aw = require("../electron/atomicWrite");
    const real = aw.writeFileAtomic;
    aw.writeFileAtomic = () => { throw new Error("disk full"); };
    const r = lock.change("1234", "5678", "5678");
    aw.writeFileAtomic = real;
    check("the change reports save-failed", r.ok === false && r.error === "save-failed", JSON.stringify(r));
    check("...and the OLD password still works, the new one does not", lock.verify("1234").ok === true && lock.verify("5678").ok === false);
    lock._reset();

    console.log("-- 6. atomic writes");
    const f = path.join(tmp, "atomic.json");
    aw.writeFileAtomic(f, "one", "utf8"); aw.writeFileAtomic(f, "two", "utf8");
    check("the file holds the last content and no .tmp is left", fs.readFileSync(f, "utf8") === "two" && !fs.existsSync(f + ".tmp"));
    check("a missing folder still throws (callers report it as before)", (() => { try { aw.writeFileAtomic(path.join(tmp, "no", "dir", "x"), "z"); return false; } catch (_) { return true; } })());
    const settings = require("../electron/settings");
    settings.set("themeMode", "dark");
    check("settings.json is written through it", JSON.parse(fs.readFileSync(path.join(tmp, "UserData", "settings.json"), "utf8")).themeMode === "dark" && !fs.existsSync(path.join(tmp, "UserData", "settings.json.tmp")));
    settings.set("themeMode", "system");

    console.log("-- 7. the address bar and IPv6");
    const { resolveInput } = require("../electron/urlInput");
    check("[::1]:8080 -> http://[::1]:8080", resolveInput("[::1]:8080") === "http://[::1]:8080", resolveInput("[::1]:8080"));
    check("[fe80::1]/x -> http://[fe80::1]/x", resolveInput("[fe80::1]/x") === "http://[fe80::1]/x");
    check("a word is still a search", /google\.com\/search/.test(resolveInput("hello")) && /google\.com\/search/.test(resolveInput("javascript:alert(1)")));

    console.log("-- 7b. what is typed in the address bar is not sent to Google when it is an ADDRESS");
    const { shouldAskRemote } = require("../electron/omnibox");
    const sent = ["diamond price", "youtube", "how to tie a tie", "what is 5/2 cm"];
    const kept = ["http://192.168.0.8:9995/assets/", "https://mfg.pb.diamonds/dashboard?id=7", "192.168.0.8", "localhost:4200/x", "pb/report?id=42", "example.com/reset?token=abc", "[::1]:8080"];
    check("words and phrases are still sent (" + sent.length + ")", sent.every((t) => shouldAskRemote(t) === true), JSON.stringify(sent.filter((t) => !shouldAskRemote(t))));
    check("addresses are never sent (" + kept.length + ")", kept.every((t) => shouldAskRemote(t) === false), JSON.stringify(kept.filter((t) => shouldAskRemote(t))));

    console.log("-- 8. Restricted Mode: a blob: of the page's own site");
    const R = require("../electron/restricted");
    check("blob:https://site/uuid is that site", R.sameSite("blob:https://pb.example.com/1234", "example.com") === true);
    check("blob:https://other/uuid is not", R.sameSite("blob:https://evil.com/1234", "example.com") === false);
    check("a blob: with no web origin is not (blob:null/..)", R.sameSite("blob:null/1234", "example.com") === false);
  } catch (e) { check("no exception: " + (e && e.stack || e), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_HARDENING total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
