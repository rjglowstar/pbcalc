// Focused test: default downloads button, Chrome-style popup, downloads page, Settings version.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-downloads.js
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-dl-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 90000).unref();

require("../electron/main.js");

app.whenReady().then(async () => {
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const popup = require("../electron/popup");
  const dm = require("../electron/downloads/downloadManager");
  const win = state.mainWindow;
  const sh = win.webContents;
  const js = (c) => sh.executeJavaScript(c);
  const pkg = require("../package.json");

  // default icon, no downloads yet
  check("downloads button is visible with an empty list", await js('(()=>{const b=document.getElementById("downloads");return !b.hidden && b.getBoundingClientRect().width>0 && !!b.querySelector("svg")})()'));

  // fake finished + running downloads straight into the manager's list
  const file = path.join(tmp, "report.pdf");
  fs.writeFileSync(file, "x");
  const items = dm._items;
  check("manager exposes its list for tests", Array.isArray(items));
  items.push({ id: 101, filename: "report.pdf", received: 2048, total: 2048, state: "completed", savePath: file, url: "https://files.example.com/a/report.pdf", from: "https://files.example.com", startedAt: Date.now() - 5 * 60000, icon: "", item: null });
  items.push({ id: 102, filename: "gone.zip", received: 10, total: 10, state: "completed", savePath: path.join(tmp, "nope.zip"), url: "https://x.test/gone.zip", from: "https://x.test", startedAt: Date.now() - 2 * 3600000, icon: "", item: null });
  items.push({ id: 103, filename: "big.iso", received: 500, total: 1000, state: "progressing", savePath: "", url: "https://x.test/big.iso", from: "https://x.test", startedAt: Date.now(), icon: "", item: null });

  const pl = dm.publicList();
  check("publicList marks a missing file as deleted", pl.find((d) => d.id === 102).deleted === true && !pl.find((d) => d.id === 101).deleted);

  // popup
  popup.open("downloads", { left: 900, right: 930, top: 40, bottom: 80, width: 30, height: 40 });
  await sleep(1200);
  const pv = win.getBrowserViews().pop().webContents;
  const ptxt = await pv.executeJavaScript("document.body.innerText");
  check("popup title is 'Recent download history'", /Recent download history/.test(ptxt));
  check("popup row shows size and time ago", /2 KB\s*•\s*5 minutes ago/.test(ptxt));
  check("popup has the 'Full download history' footer", /Full download history/.test(ptxt));
  check("popup strikes the deleted file", await pv.executeJavaScript('!!document.querySelector(".dl-row.deleted")'));
  check("popup has the circled close button", await pv.executeJavaScript('!!document.querySelector(".dl-close svg")'));
  await pv.executeJavaScript('document.querySelector(".dl-all").click(); 0');
  await sleep(1500);
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  check("footer link opens the Downloads page in a tab", active.url.startsWith(constants.DOWNLOADS_URL));
  check("address shows pbcalc://downloads", tm.getTabState().tabs.find((t) => t.id === active.id).url === "pbcalc://downloads");

  // page
  const wc = active.view.webContents;
  const pj = (c) => wc.executeJavaScript(c);
  await sleep(500);
  check("page lists the three downloads", (await pj('document.querySelectorAll(".item").length')) === 3);
  check("page shows 'From <origin>'", /From https:\/\/files\.example\.com/.test(await pj("document.body.innerText")));
  check("page shows Deleted for the missing file", /Deleted/.test(await pj("document.body.innerText")));
  check("page groups under a 'Today' heading", /Today - /.test(await pj("document.body.innerText")));
  // Chrome: the ✕ ("remove from list") is only on finished rows; a running one is ended via ⋮ → Cancel
  const acts = await pj('[...document.querySelectorAll(".item")].map((i)=>({running:!!i.querySelector(".bar"),x:!!i.querySelector(".acts button[title^=Remove]"),more:!!i.querySelector(".more")}))');
  check("a running row has no remove ✕, only the ⋮ menu", acts.filter((a) => a.running).every((a) => !a.x && a.more));
  check("finished rows do have the remove ✕", acts.filter((a) => !a.running).every((a) => a.x));
  await pj('(()=>{const s=document.getElementById("search");s.value="report";s.dispatchEvent(new Event("input"))})()');
  check("page search filters", (await pj('document.querySelectorAll(".item").length')) === 1);
  await pj('(()=>{const s=document.getElementById("search");s.value="";s.dispatchEvent(new Event("input"))})()');
  await pj('document.querySelector(".acts button[title=\\"Remove from list\\"]").click(); 0');
  await sleep(500);
  check("remove drops one row", (await pj('document.querySelectorAll(".item").length')) === 2);

  // Ctrl+Shift+J reuses the tab
  const before = state.tabs.length;
  tm.openDownloadsPage();
  await sleep(300);
  check("opening the page again reuses its tab", state.tabs.length === before);

  // the page bridge is refused elsewhere
  const other = tm.createTab("about:blank");
  await sleep(800);
  const owc = state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
  check("no downloadsAPI on ordinary pages", (await owc.executeJavaScript("typeof window.downloadsAPI")) === "undefined");

  // clear all
  tm.openDownloadsPage();
  await sleep(500);
  await pj('document.getElementById("clear-all").click(); 0');
  await sleep(500);
  check("Clear all empties the list", (await pj('document.querySelectorAll(".item").length')) === 0 && dm.publicList().length === 0);

  // restricted: `from` hidden
  items.push({ id: 201, filename: "a.txt", received: 1, total: 1, state: "completed", savePath: file, url: "https://s.test/a.txt", from: "https://s.test", startedAt: Date.now(), icon: "", item: null });
  state.restricted = true;
  check("restricted mode hides the source address", dm.publicList()[0].from === "");
  state.restricted = false;

  // settings version
  tm.openSettings();
  await sleep(1500);
  const swc = state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
  check("Settings → Privacy shows package.json version", (await swc.executeJavaScript('document.getElementById("app-version").textContent')) === pkg.version);

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_DOWNLOADS total=" + results.length + " failed=" + failed.length);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
