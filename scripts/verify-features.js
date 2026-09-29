// End-to-end self-test for bookmarks, downloads, password-manager UI and the wipe-on-exit policy.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-features.js
// Uses its own temp userData folder and a local HTTP server; the window is never shown.
const { app, BrowserWindow, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-"));
app.setPath("userData", path.join(tmp, "UserData"));
fs.mkdirSync(app.getPath("userData"), { recursive: true });

const results = [];
const check = (name, cond) => results.push({ name, pass: !!cond });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const state = require("../electron/state");
  const tabManager = require("../electron/tabs/tabManager");
  const vault = require("../electron/vault/passwordVault");
  const bookmarks = require("../electron/bookmarks/bookmarkStore");
  const downloads = require("../electron/downloads/downloadManager");
  const privacy = require("../electron/privacy");
  const { registerIpcHandlers } = require("../electron/ipc/registerIpcHandlers");
  const dir = app.getPath("userData");

  // ── local server ──
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/login")) {
      res.setHeader("content-type", "text/html");
      res.end('<form id="f" action="/home" method="get"><input name="username" id="u"><input type="password" name="p" id="p"><button type="submit">Sign in</button></form>');
    } else if (req.url.startsWith("/home")) {
      res.setHeader("content-type", "text/html");
      res.setHeader("set-cookie", "sess=abc; Max-Age=3600; Path=/");
      res.end("<title>Home</title><h1>welcome</h1>");
    } else if (req.url.startsWith("/file")) {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="report.bin"');
      res.end(Buffer.alloc(50000, 1));
    } else {
      res.statusCode = 404;
      res.end("nf");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;

  // ── wipe of leftovers keeps vault / bookmarks / Local State, removes the rest ──
  fs.writeFileSync(path.join(dir, "Local State"), "{}");
  fs.writeFileSync(path.join(dir, "bookmarks.json"), "[]");
  fs.writeFileSync(path.join(dir, "password-vault.json"), "{}");
  fs.writeFileSync(path.join(dir, "Cookies"), "x");
  fs.mkdirSync(path.join(dir, "Cache"));
  fs.writeFileSync(path.join(dir, "Cache", "data_0"), "x");
  fs.mkdirSync(path.join(dir, "Local Storage"));
  privacy.wipeLeftoversOnDisk();
  const left = fs.readdirSync(dir).sort();
  check("startup wipe keeps only vault/bookmarks/Local State", JSON.stringify(left) === JSON.stringify(["Local State", "bookmarks.json", "password-vault.json"]));

  // ── window + tab ──
  state.mainWindow = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { contextIsolation: true } });
  const sent = [];
  const origSend = state.mainWindow.webContents.send.bind(state.mainWindow.webContents);
  state.mainWindow.webContents.send = (ch, ...a) => { sent.push(ch); return origSend(ch, ...a); };
  registerIpcHandlers();
  downloads.init();

  // ── downloads ──
  session.defaultSession.on("will-download", (_e, item) => item.setSavePath(path.join(tmp, "saved-" + item.getFilename())));
  tabManager.createTab(base + "/login");
  await sleep(1200);
  const wc0 = tabManager.getActiveTab().view.webContents;
  wc0.downloadURL(base + "/file");
  await sleep(1500);
  const dl = downloads.publicList();
  check("download listed and completed", dl.length === 1 && dl[0].state === "completed" && dl[0].filename === "report.bin");
  check("downloaded file exists with full size", fs.existsSync(path.join(tmp, "saved-report.bin")) && fs.statSync(path.join(tmp, "saved-report.bin")).size === 50000);
  check("shelf inset reserved while list non-empty", state.bottomInset === 48);
  const contentH = state.mainWindow.getContentSize()[1];
  check("view height = content - tabbar - shelf", tabManager.getActiveTab().view.getBounds().height === contentH - 104 - 48);
  check("downloads:changed pushed to shell", sent.includes("downloads:changed"));
  downloads.dismiss(dl[0].id);
  check("dismiss empties list and releases inset", downloads.publicList().length === 0 && state.bottomInset === 0);
  check("no download record file on disk", !fs.readdirSync(dir).some((f) => /download/i.test(f)));

  // ── bookmarks ──
  check("non-http URL not bookmarkable", bookmarks.toggle({ url: "about:blank", title: "x" }).length === 0);
  let list = bookmarks.toggle({ url: base + "/home", title: "Home page" });
  check("bookmark added", list.length === 1 && list[0].title === "Home page");
  check("bookmarks.json written", JSON.parse(fs.readFileSync(path.join(dir, "bookmarks.json"), "utf8")).length === 1);
  list = bookmarks.toggle({ url: base + "/home", title: "Home page" });
  check("toggle again removes it", list.length === 0);
  list = bookmarks.toggle({ url: base + "/a", title: "A" });
  check("remove by id", bookmarks.remove(list[0].id).length === 0);

  // ── password manager: navigation-style login -> save prompt ──
  const wc = tabManager.getActiveTab().view.webContents;
  await wc.loadURL(base + "/login");
  await sleep(1500); // let the 1s scan attach handlers
  await wc.executeJavaScript('document.getElementById("u").value="alice";document.getElementById("p").value="pw-123";document.getElementById("f").requestSubmit();0');
  await sleep(3500); // navigate to /home + 1.5s settle
  const barText = await wc.executeJavaScript('(document.querySelector(".pbcalc-pm-bar")||{}).textContent||""');
  check("save-password card appears after navigation login", /Save password\?/.test(barText));
  await wc.executeJavaScript('Array.from(document.querySelectorAll(".pbcalc-pm-btn")).find(b=>b.textContent==="Save").click();0');
  await sleep(500);
  const origin = new URL(base).origin;
  check("credential saved for the tab's origin", vault.getPassword(origin, "alice") === "pw-123");

  // failed login (form shown again) must NOT prompt
  await wc.loadURL(base + "/login");
  await sleep(1500);
  await wc.executeJavaScript('document.getElementById("u").value="bob";document.getElementById("p").value="bad";document.getElementById("f").requestSubmit();0');
  await sleep(200);
  await wc.loadURL(base + "/login"); // server "rejects": login form again
  await sleep(3000);
  check("no card when login form reappears", await wc.executeJavaScript('!document.querySelector(".pbcalc-pm-bar")'));

  // autofill dropdown
  await wc.loadURL(base + "/login");
  await sleep(1500);
  await wc.executeJavaScript('document.getElementById("u").dispatchEvent(new MouseEvent("click",{bubbles:true}));0');
  await sleep(500);
  const dd = await wc.executeJavaScript('(document.querySelector(".pbcalc-pm-dd")||{}).textContent||""');
  check("autofill dropdown lists saved username", /alice/.test(dd));
  check("no silent prefill on load", await wc.executeJavaScript('document.getElementById("u").value===""'));
  await wc.executeJavaScript('document.querySelector(".pbcalc-pm-row").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}));0');
  await sleep(500);
  check("picking a row fills username + password", await wc.executeJavaScript('document.getElementById("u").value==="alice"&&document.getElementById("p").value==="pw-123"'));
  check("page world has no require()", await wc.executeJavaScript('typeof require === "undefined"'));

  // ── wipe of session data ──
  await wc.loadURL(base + "/home"); // sets cookie
  await sleep(500);
  const before = (await session.defaultSession.cookies.get({})).length;
  await privacy.clearSession();
  const after = (await session.defaultSession.cookies.get({})).length;
  check("cookie present before wipe", before >= 1);
  check("clearSession() removes cookies", after === 0);

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log((r.pass ? "PASS " : "FAIL ") + r.name));
  console.log("PBCALC_FEATURES total=" + results.length + " failed=" + failed.length);
  server.close();
  try { state.mainWindow.destroy(); } catch (_) {}
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(failed.length ? 1 : 0);
});
