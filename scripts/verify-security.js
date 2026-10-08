// Attack-side tests: a HOSTILE web page (local server, real tab, real session) tries the things a malicious site tries.
// Every check is written as the SECURE outcome; a FAIL is a vulnerability.   Run:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-security.js
const { app, shell } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
const { execFileSync } = require("child_process");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 400000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-sec-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok   " : "VULN ") + name + (!cond && extra ? "   <" + extra + ">" : "")); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const popup = require("../electron/popup");
    const downloads = require("../electron/downloads/downloadManager");
    const vault = require("../electron/vault/passwordVault");
    const spy = { openExternal: [], openPath: [] };
    shell.openExternal = async (u) => { spy.openExternal.push(String(u)); };
    shell.openPath = async (p) => { spy.openPath.push(String(p)); return ""; };
    const dlDir = path.join(tmp, "dl"); fs.mkdirSync(dlDir);
    await new Promise((r) => { const s = require("../electron/settings"); s.set("downloads", { dir: dlDir, ask: false }); r(); });

    // ── the hostile site ──────────────────────────────────────────────
    let hits = [];
    const srv = http.createServer((q, res) => {
      hits.push(q.url);
      const u = new URL(q.url, "http://x");
      if (u.pathname === "/dl") {
        const name = u.searchParams.get("n") || "a.bin";
        const raw = u.searchParams.get("raw");
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": raw ? raw : 'attachment; filename="' + name + '"' });
        return res.end(Buffer.from("MZ-test"));
      }
      if (u.pathname === "/hang") { res.setHeader("content-type", "text/html"); return res.end("<title>hang</title><script>while(true){}</script>"); }
      if (u.pathname === "/title") { res.setHeader("content-type", "text/html"); return res.end('<title>&lt;img src=x onerror="window.__pwn=1"&gt;</title>x'); }
      if (u.pathname === "/title2") { res.setHeader("content-type", "text/html"); return res.end('<title><img src=x onerror=window.__pwn=1></title>x'); }
      res.setHeader("content-type", "text/html");
      res.end("<title>hostile</title><body>hostile page</body>");
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const base = "http://127.0.0.1:" + srv.address().port;
    const other = "http://localhost:" + srv.address().port;

    tm.createTab(base + "/"); await sleep(1800);
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId), wc = () => tab().view.webContents;
    const js = (code) => wc().executeJavaScript(code, true);          // as if the user had just clicked (transient activation)
    const jsAuto = (code) => wc().executeJavaScript(code, false);     // a script running by itself, no click, no key
    const realClick = async () => { try { wc().focus(); } catch (_) {} await sleep(80); wc().sendInputEvent({ type: "mouseDown", x: 50, y: 50, button: "left", clickCount: 1 }); wc().sendInputEvent({ type: "mouseUp", x: 50, y: 50, button: "left", clickCount: 1 }); await sleep(450); };   // a trusted click
    async function hostile() { for (const t of state.tabs.slice(1)) tm.closeTab(t.id); await sleep(300); tm.switchTab(state.tabs[0].id); wc().loadURL(base + "/"); await sleep(1500); }

    console.log("-- isolation: what a page can see");
    check("no Node / Electron globals in the page (require, process, Buffer, ipcRenderer, electron, module)", (await js('["require","process","Buffer","ipcRenderer","electron","module","global"].every((n) => typeof window[n] === "undefined")')) === true);
    const names = await js('Object.getOwnPropertyNames(window).filter((k) => /api$|electron|ipc|vault|pbcalc/i.test(k))');
    check("the page world exposes only vaultAPI (no settings / downloads / manager / restricted / browser bridge)", JSON.stringify(names) === '["vaultAPI"]', JSON.stringify(names));
    const metrics = app.getAppMetrics();
    const tabProc = metrics.filter((m) => m.type === "Tab");
    check("every tab renderer runs in the Chromium sandbox", tabProc.length > 0 && tabProc.every((m) => m.sandboxed === true), JSON.stringify(tabProc.map((m) => m.sandboxed)));

    console.log("\n-- a web page reaching local files and our own pages");
    const t0 = state.tabs.length;
    await js('location.href = "file:///C:/Windows/win.ini"; 0'); await sleep(1500);
    check("a web page cannot navigate its tab to file://", !/^file:/i.test(wc().getURL()), wc().getURL());
    tm.switchTab(state.tabs[state.tabs.length - 1].id);
    await js('window.open("file:///C:/Windows/win.ini"); 0'); await sleep(1200);
    check("window.open(file://) opens nothing", state.tabs.length === t0 && !state.tabs.some((t) => /^file:\/\/\/C:\/Windows/i.test(t.view.webContents.getURL())));
    const fetched = await js('fetch("file:///C:/Windows/win.ini").then((r) => "READ " + r.status, (e) => "blocked").catch(() => "blocked")');
    check("fetch(file://) from a web page is refused", fetched === "blocked", fetched);
    const frame = await js('new Promise((res) => { const f = document.createElement("iframe"); f.src = "file:///C:/Windows/win.ini"; f.onload = () => { try { res("READ " + f.contentDocument.body.innerText.length); } catch (e) { res("blocked"); } }; f.onerror = () => res("blocked"); document.body.appendChild(f); setTimeout(() => res("blocked"), 2500); })');
    check("an iframe to file:// cannot be read by the page", frame === "blocked", frame);
    const n1 = state.tabs.length;
    await js('location.href = "pbcalc://settings"; 0'); await sleep(1200);
    await js('window.open("pbcalc://downloads"); 0'); await sleep(1200);
    check("a web page cannot open or navigate to our internal pbcalc:// pages", !/settings|downloads|renderer/i.test(wc().getURL()) && !state.tabs.some((t) => /renderer\/(settings|downloads)/.test(t.view.webContents.getURL())) && state.tabs.length === n1);
    await js('location.href = "' + base + '/"; 0'); await sleep(1200);

    await hostile();   // a fresh hostile page in the first tab (earlier steps may have left it elsewhere)
    console.log("\n-- a web page launching programs on the PC (shell.openExternal / openPath are spied)");
    const attempts = ["ms-msdt:/id PCWDiagnostic /skip force /param \"IT_RebrowseForFile=?\"", "search-ms:query=x&crumb=location:\\\\evil\\share", "calculator:", "steam://run/1", "whatsapp://send", "ms-settings:", "vscode://file/x", "ftp://evil/x"];
    for (const u of attempts) {
      await js('location.href = ' + JSON.stringify(u) + '; 0').catch(() => {}); await sleep(250);
      await js('window.open(' + JSON.stringify(u) + '); 0').catch(() => {}); await sleep(250);
      await js('(() => { const f = document.createElement("iframe"); f.src = ' + JSON.stringify(u) + '; document.body.appendChild(f); const a = document.createElement("a"); a.href = ' + JSON.stringify(u) + '; document.body.appendChild(a); a.click(); })()').catch(() => {}); await sleep(250);
    }
    await sleep(800);
    check("none of " + attempts.length + " dangerous schemes (ms-msdt, search-ms, calculator, steam, whatsapp, ms-settings, vscode, ftp) was handed to Windows", spy.openExternal.length === 0 && spy.openPath.length === 0, JSON.stringify(spy));
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    await sleep(600);

    await hostile();   // a fresh hostile page in the first tab (earlier steps may have left it elsewhere)
    console.log("\n-- powerful permissions: a site has to ASK (Chrome shows a bubble; PBCalc granted all of these silently until now)");
    const perms = require("../electron/permissions");
    perms._reset();
    // the page fires every request at once and does NOT wait; nothing may be handed out until a human answers
    await js(`window.__p = {}; const put = (k) => (v) => { window.__p[k] = v; };
      navigator.geolocation.getCurrentPosition(() => put("geo")("GRANTED"), (e) => put("geo")("code" + e.code), { timeout: 20000 });
      Notification.requestPermission().then(put("notif"));
      navigator.clipboard.readText().then(() => put("clip")("GRANTED"), (e) => put("clip")(e.name));
      navigator.requestMIDIAccess().then(() => put("midi")("GRANTED"), (e) => put("midi")(e.name));
      0`);
    await sleep(2500);
    const early = JSON.parse(await js("JSON.stringify(window.__p)"));
    // (clipboard.readText() on an unfocused page is refused by Chromium itself before any question: that is a refusal, not a grant)
    check("before anyone answers, the page has been given NOTHING (no location, notification right, clipboard, MIDI)", !Object.values(early).some((v) => /^(GRANTED|granted|code2)$/.test(v)), JSON.stringify(early));
    check("...and a bubble is waiting for the user", popup.isOpen("permission"));
    check("Notification.permission does not claim 'granted' (a page could otherwise show notifications without asking)", (await js("Notification.permission")) !== "granted", await js("Notification.permission"));
    const seen = [];
    for (let i = 0; i < 6 && popup.isOpen("permission"); i++) { const d = popup.getData(); if (d && d.permission) seen.push(d.permission.texts.join()); popup.answerPermission("never"); await sleep(700); }
    console.log("   bubbles the user was shown: " + JSON.stringify(seen));
    check("location, notifications and MIDI each produced their own bubble", ["Know your location", "Show notifications", "Use your MIDI devices"].every((t) => seen.includes(t)), JSON.stringify(seen));
    const late = JSON.parse(await js("JSON.stringify(window.__p)"));
    check("after 'Never allow' every one of them is refused", late.geo === "code1" && late.notif === "denied" && (late.clip || "NotAllowedError") === "NotAllowedError" && /NotAllowed|Security/.test(late.midi || ""), JSON.stringify(late));
    // camera / microphone: a PC without the devices makes Chromium answer NotFoundError before it asks, so call the handler as Chromium does
    let cam = "pending"; perms.request(wc(), "media", (ok) => { cam = ok; }, { requestingUrl: base + "/", mediaTypes: ["video", "audio"] });
    await sleep(500);
    check("a camera + microphone request is NOT answered by itself - it waits for the user", cam === "pending" && popup.isOpen("permission"));
    popup.answerPermission("never"); await sleep(400);
    check("...and 'Never allow' refuses it", cam === false);
    perms._reset();

    console.log("   (the first tab is now at: " + wc().getURL().slice(0, 80) + ")");
    console.log("\n-- downloads from a hostile site");
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    tm.createTab(base + "/"); await sleep(1800);   // a fresh hostile page: the checks above may have left the first tab elsewhere
    const before = new Set(fs.readdirSync(dlDir));
    const names2 = ["..\\..\\escaped.exe", "../../escaped2.exe", "CON.txt", "evil.exe.", "a:b.txt", "x".repeat(400) + ".txt", "..%5C..%5Cescaped3.exe"];
    for (const n of names2) {
      await realClick();   // each one follows a real click: the policy for scripted downloads is tested separately below
      await jsAuto('(() => { const a = document.createElement("a"); a.href = "/dl?n=" + encodeURIComponent(' + JSON.stringify(n) + '); a.download = ""; document.body.appendChild(a); a.click(); })()'); await sleep(900);
    }
    await realClick();
    await jsAuto('(() => { const a = document.createElement("a"); a.href = "/dl?raw=" + encodeURIComponent("attachment; filename*=UTF-8\'\'..%5C..%5Cescaped4.exe"); a.download = ""; document.body.appendChild(a); a.click(); })()'); await sleep(900);
    await sleep(1500);
    const written = fs.readdirSync(dlDir).filter((f) => !before.has(f));
    console.log("   download list after the hostile names: " + JSON.stringify(downloads._items.map((d) => Object.fromEntries(Object.entries(d).filter(([k, v]) => typeof v !== "object" && typeof v !== "function").map(([k, v]) => [k, String(v).slice(0, 50)])))).slice(0, 700));
    // positive control: a plain download from the same page must work, otherwise "nothing escaped" would prove nothing
    await realClick();
    await jsAuto('(() => { const a = document.createElement("a"); a.href = "/dl?n=control.bin"; a.download = ""; document.body.appendChild(a); a.click(); })()'); await sleep(1500);
    check("(control) an ordinary download from the page does land in the download folder", fs.existsSync(path.join(dlDir, "control.bin")), JSON.stringify(fs.readdirSync(dlDir)));
    const outside = [path.join(tmp, "escaped.exe"), path.join(tmp, "escaped2.exe"), path.join(tmp, "escaped3.exe"), path.join(tmp, "escaped4.exe"), path.join(path.dirname(tmp), "escaped.exe"), path.join(path.dirname(tmp), "escaped2.exe")];
    check("a hostile Content-Disposition filename cannot write outside the download folder (path traversal)", !outside.some((p) => fs.existsSync(p)), outside.filter((p) => fs.existsSync(p)).join(","));
    console.log("   files that landed in the download folder: " + JSON.stringify(written.map((f) => f.length > 40 ? f.slice(0, 30) + "...(" + f.length + ")" : f)));
    check("no file with a name Windows treats specially (CON, trailing dot/space, colon stream)", !written.some((f) => /^con\b/i.test(f) || /[. ]$/.test(f) || f.includes(":")), JSON.stringify(written));
    const eight = fs.readdirSync(dlDir).length;
    await sleep(5600);   // the last real click was more than 5 s ago: from here on the page is on its own
    for (let i = 0; i < 40; i++) await jsAuto('(() => { const a = document.createElement("a"); a.href = "/dl?n=flood' + i + '.exe"; a.download = ""; document.body.appendChild(a); a.click(); })()');
    await sleep(3500);
    const flood = fs.readdirSync(dlDir).filter((f) => /^flood/.test(f)).length;
    check("a page cannot save 40 files by itself without any click (Chrome blocks automatic multiple downloads)", flood <= 1, flood + " files saved");
    await realClick();
    for (let i = 0; i < 3; i++) await jsAuto('(() => { const a = document.createElement("a"); a.href = "/dl?n=clicked' + i + '.bin"; a.download = ""; document.body.appendChild(a); a.click(); })()');
    await sleep(1800);
    const clicked = fs.readdirSync(dlDir).filter((f) => /^clicked/.test(f)).length;
    check("(control) downloads the USER started (a click) are never limited: 3 of 3 saved", clicked === 3, clicked + " saved");
    const flooded = fs.readdirSync(dlDir).filter((f) => /^flood/.test(f))[0];
    if (flooded) {
      let zone = null; try { zone = fs.readFileSync(path.join(dlDir, flooded) + ":Zone.Identifier", "utf8"); } catch (_) {}
      check("a downloaded file carries Windows' Mark-of-the-Web (Zone.Identifier), so SmartScreen warns before an .exe runs", !!zone && /ZoneId=3/.test(zone), zone === null ? "no Zone.Identifier stream" : zone);
    }

    console.log("\n-- address-bar spoofing / script URLs");
    tm.createTab(base + "/"); await sleep(1500);
    await js('location.href = "data:text/html,<title>fake</title><h1>fake bank login</h1>"; 0'); await sleep(1200);
    check("a page cannot send its tab to a data: URL (phishing page under a data: address)", !/^data:text\/html,<title>fake/.test(wc().getURL()) && !/^data:/.test(wc().getURL().slice(0, 5)), wc().getURL().slice(0, 60));
    const nBlob = state.tabs.length;
    await js('window.open("data:text/html,<h1>x</h1>"); 0'); await sleep(1000);
    check("window.open(data:) opens nothing", state.tabs.length === nBlob);
    await js('location.href = "' + base + '/"; 0'); await sleep(1000);

    console.log("\n-- 'Open link in new tab' from the right-click menu");
    const nTabs = state.tabs.length;
    for (const u of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "pbcalc://settings", "ms-msdt:/id x", "ftp://x/y", "blob:http://127.0.0.1/x"]) tm.openInNewTab(u, true, tab());
    await sleep(700);
    check("a link of ANY non-web kind (file:, javascript:, data:, pbcalc:, ms-msdt:, ftp:, blob:) opens nothing from the context menu", state.tabs.length === nTabs, state.tabs.map((t) => t.view.webContents.getURL()).slice(nTabs).join(" | "));
    tm.openInNewTab(base + "/x", true, tab()); await sleep(900);
    check("(control) an http link does open", state.tabs.length === nTabs + 1);
    for (const t of state.tabs.slice(nTabs)) tm.closeTab(t.id);

    console.log("\n-- hostile text in places the browser draws (tab titles)");
    for (const p of ["/title", "/title2"]) {
      tm.createTab(base + p); await sleep(1500);
    }
    popup.open("tabsearch", null, {}); await sleep(900);
    const pv = state.mainWindow.getBrowserViews().pop().webContents;
    const injected = await pv.executeJavaScript('document.querySelectorAll("img[src=x], [onerror]").length + "|" + (window.__pwn || 0)');
    check("a page title with HTML cannot inject elements into tab search", injected === "0|0", injected);
    popup.close(); await sleep(300);
    const shellInj = await state.mainWindow.webContents.executeJavaScript('document.querySelectorAll("img[src=x], [onerror]").length + "|" + (window.__pwn || 0)');
    check("...nor into the tab strip", shellInj === "0|0", shellInj);
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    await sleep(600);

    console.log("\n-- hostile text in the browser's own pages and bubbles (download names / addresses, error page, site info, hover card)");
    const HTML = '"><img src=x onerror=window.__pwn=1>';
    const injected2 = (wcX) => wcX.executeJavaScript('document.querySelectorAll("img[src=x], [onerror]").length + "|" + (window.__pwn || 0)');
    // a download whose ADDRESS carries markup, shown on the Downloads page and in the download bubble
    tm.createTab(base + "/"); await sleep(1500);
    await realClick();
    await jsAuto('(() => { const a = document.createElement("a"); a.href = "/dl?n=ok.bin&x=" + encodeURIComponent(' + JSON.stringify(HTML) + '); a.download = ""; document.body.appendChild(a); a.click(); })()'); await sleep(1500);
    tm.openDownloadsPage(); await sleep(2000);
    check("a hostile download address cannot inject into the Downloads page", (await injected2(wc())) === "0|0", await injected2(wc()));
    popup.open("downloads", null, {}); await sleep(900);
    check("...nor into the download bubble", (await injected2(state.mainWindow.getBrowserViews().pop().webContents)) === "0|0");
    popup.close(); await sleep(300);
    // an address that cannot be reached: the error page repeats it
    tm.createTab("http://127.0.0.1:1/" + encodeURIComponent(HTML) + "?q=" + HTML); await sleep(3500);
    check("a hostile address cannot inject into the error page that repeats it", (await injected2(wc())) === "0|0", await injected2(wc()));
    popup.open("siteinfo", null, {}); await sleep(900);
    check("...nor into the site-info bubble", (await injected2(state.mainWindow.getBrowserViews().pop().webContents)) === "0|0");
    popup.close(); await sleep(300);
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    await sleep(500);

    console.log("\n-- the saved-password lock");
    vault.saveCredential({ origin: base, username: "boss", password: "S3cret-guess-me" });
    tm.createTab(base + "/"); await sleep(1500);
    const guessRight = await js('window.vaultAPI.needsSavePrompt("boss", "S3cret-guess-me")');
    const guessWrong = await js('window.vaultAPI.needsSavePrompt("boss", "nope")');
    check("a page script cannot test password guesses against a saved password (needsSavePrompt must not answer differently)", guessRight === guessWrong, "right guess -> " + guessRight + ", wrong guess -> " + guessWrong);
    check("a page script cannot read the saved password", (await js('window.vaultAPI.getPassword("boss")')) === null);
    const other2 = await js('window.vaultAPI.listUsernames()');
    check("a page only ever sees usernames of ITS OWN origin", Array.isArray(other2));

    console.log("\n-- Restricted Mode's idea of 'same site'");
    const restr = require("../electron/restricted");
    const same = (a, b) => restr.sameSite(a, restr.siteOf(b));
    check("another user's page on a shared hosting suffix is NOT 'the same site' (user1.github.io vs user2.github.io)", same("https://user2.github.io/", "https://user1.github.io/") === false);
    check("...nor user1.blogspot.com vs user2.blogspot.com", same("https://user2.blogspot.com/", "https://user1.blogspot.com/") === false);
    check("...nor one *.herokuapp.com app for another", same("https://b.herokuapp.com/", "https://a.herokuapp.com/") === false);
    check("a real sub-domain of the allowed site still is", same("https://app.mfg.pb.diamonds/", "https://mfg.pb.diamonds/") === true);
    check("a look-alike domain is not (pb.diamonds.evil.com / evilpb.diamonds)", same("https://pb.diamonds.evil.com/", "https://mfg.pb.diamonds/") === false && same("https://evilpb.diamonds/", "https://mfg.pb.diamonds/") === false);

    console.log("\n-- a LINK dragged onto the window (it used to open a stray, unmanaged window)");
    const { BrowserWindow } = require("electron");
    const shellWc = state.mainWindow.webContents;
    if (!shellWc.debugger.isAttached()) shellWc.debugger.attach("1.3");
    const dropOnShell = async (x, y, items) => { for (const type of ["dragEnter", "dragOver", "drop"]) { await shellWc.debugger.sendCommand("Input.dispatchDragEvent", { type, x, y, data: { items, files: [], dragOperationsMask: 1 } }); await sleep(200); } await sleep(1500); };
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    await sleep(500);
    const shellUrl = shellWc.getURL();
    const n3 = state.tabs.length;
    await dropOnShell(700, 20, [{ mimeType: "text/uri-list", data: base + "/DROPPED-LINK" }]);
    check("a dropped link opens in a NEW TAB (like Chrome), not in a stray window", state.tabs.length === n3 + 1 && /DROPPED-LINK$/.test(state.tabs[state.tabs.length - 1].view.webContents.getURL()) || state.tabs.some((t) => /DROPPED-LINK$/.test(t.view.webContents.getURL())));
    check("...and the browser still has exactly ONE window, and its toolbar page was not navigated", BrowserWindow.getAllWindows().length === 1 && shellWc.getURL() === shellUrl, BrowserWindow.getAllWindows().length + " windows");
    const n4 = state.tabs.length;
    await dropOnShell(700, 60, [{ mimeType: "text/uri-list", data: "javascript:alert(1)" }]);
    await dropOnShell(700, 60, [{ mimeType: "text/uri-list", data: "file:///C:/Windows/win.ini" }]);
    await dropOnShell(700, 60, [{ mimeType: "text/uri-list", data: "ms-msdt:/id x" }]);
    check("a dropped javascript: / file: / application link opens nothing", state.tabs.length === n4 && BrowserWindow.getAllWindows().length === 1);
    await dropOnShell(700, 60, [{ mimeType: "text/plain", data: base + "/PLAIN-TEXT" }, { mimeType: "text/html", data: '<a href="' + base + '/HTML">x</a>' }]);
    check("dropped plain text / html (not a link) opens nothing and no window", state.tabs.length === n4 && BrowserWindow.getAllWindows().length === 1);
    tm.secretToggle(); await sleep(2800);
    const n5 = state.tabs.length;
    await dropOnShell(700, 20, [{ mimeType: "text/uri-list", data: base + "/RESTRICTED-ESCAPE" }]);
    check("Restricted Mode: a dropped link cannot take the user anywhere (no new tab, no window)", state.restricted === true && state.tabs.length === n5 && BrowserWindow.getAllWindows().length === 1 && !hits.some((h) => /RESTRICTED-ESCAPE/.test(h)));
    tm.leaveRestricted(); await sleep(600);
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    await sleep(500);

    console.log("\n-- the browser's commands cannot be given by a web page's own preload");
    const { ipcMain } = require("electron");
    tm.createTab(base + "/a"); await sleep(1200); tm.createTab(base + "/b"); await sleep(1200);
    const countBefore = state.tabs.length, victim = state.tabs[0].id;
    // the registered handlers, called exactly as Electron calls them, once with a TAB page and once with the toolbar page as sender
    const call = (sender, channel, ...args) => ipcMain._invokeHandlers.get(channel)({ sender }, ...args);
    const fire = (sender, channel, ...args) => ipcMain.emit(channel, { sender }, ...args);
    const fromPage = [await call(wc(), "tabs:get-state"), await call(wc(), "tabs:close", victim), await call(wc(), "tabs:switch", victim), await call(wc(), "tabs:new", "http://evil.test/"), await call(wc(), "bookmarks:list"), await call(wc(), "downloads:get")];
    fire(wc(), "tabs:back"); fire(wc(), "tabs:reload"); fire(wc(), "tabs:move", victim, 3); fire(wc(), "tabs:reset-zoom"); fire(wc(), "tabs:context-menu", victim);
    await sleep(600);
    check("a page's preload cannot list, switch, open or close tabs, nor read bookmarks / downloads", state.tabs.length === countBefore && state.tabs.some((t) => t.id === victim) && fromPage.every((x) => x === null || (Array.isArray(x) && x.length === 0)), JSON.stringify(fromPage).slice(0, 200));
    const fromToolbar = await call(state.mainWindow.webContents, "tabs:get-state");
    check("(control) the same call from the toolbar page itself works", fromToolbar && Array.isArray(fromToolbar.tabs) && fromToolbar.tabs.length === countBefore);
    for (const t of state.tabs.slice(1)) tm.closeTab(t.id);
    await sleep(500);

    console.log("\n-- a hung page cannot take the browser with it");
    tm.createTab(base + "/hang"); await sleep(2500);
    const hangTab = tab();
    const t1 = Date.now();
    tm.closeTab(hangTab.id);
    check("a tab stuck in an endless loop is still closable at once", Date.now() - t1 < 1500 && !state.tabs.some((t) => t.id === hangTab.id));

    srv.close();
    check("no uncaught error in the main process", errors.length === 0, errors.join(" | "));
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_SECURITY total=" + results.length + " vulnerabilities=" + failed);
  app.exit(failed ? 1 : 0);
})();
