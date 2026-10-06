// A tab opened only to start a download closes itself, like Chrome — and a tab that shows a page does not.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-download-tab.js
//
// Reported: on a site whose "Download" button does window.open(url) / target=_blank, Chrome flashes a
// new tab for a moment and closes it again (the download carries on); PBCalc left that tab open.
// MEASURED at will-download time: such a tab has wc.getURL() === "" (nothing was ever committed), while
// a same-tab link's download has the page's own URL. That is the line the fix draws.
const { app, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-dltab-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { for (let i = 0; i < ms / 50; i++) { if (await fn()) return true; await sleep(50); } return false; };
setTimeout(() => { console.log("WATCHDOG after " + results.length); app.exit(2); }, 120000).unref();

let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/dl.bin" || u === "/slow.bin") {
      const slow = u === "/slow.bin";
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", `attachment; filename="${slow ? "slow" : "plain"}.bin"`);
      const total = slow ? 25 * 4096 : 3000;
      res.setHeader("content-length", String(total));
      if (!slow) return res.end(Buffer.alloc(total, 4));
      let n = 0;
      const t = setInterval(() => { if (n++ >= 25 || res.writableEnded) { clearInterval(t); return res.end(); } res.write(Buffer.alloc(4096, 6)); }, 60);
      req.on("close", () => clearInterval(t));
      return;
    }
    if (u === "/redir") { res.statusCode = 302; res.setHeader("location", "/dl.bin"); return res.end(); }
    res.setHeader("content-type", "text/html");
    if (u === "/page2") return res.end("<!doctype html><title>Page2</title>a real page");
    res.end('<!doctype html><title>Site</title><body>' +
      '<a id=blank href="/dl.bin" target="_blank">link _blank</a>' +
      '<button id=open onclick="window.open(\'/dl.bin\')">window.open</button>' +
      '<a id=same href="/dl.bin">same-tab link</a>' +
      '<a id=redir href="/redir" target="_blank">_blank, 302, file</a>' +
      '<button id=page onclick="window.open(\'/page2\')">window.open a page</button>' +
      '<a id=slow href="/slow.bin" target="_blank">slow file in a new tab</a></body>');
  });
  srv.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + srv.address().port; resolve(); });
});

require("../electron/main.js");

app.whenReady().then(async () => {
  await ready;
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const dm = require("../electron/downloads/downloadManager");
  const settings = require("../electron/settings");
  const win = state.mainWindow;
  win.show(); win.focus(); await sleep(400);
  // keep every file out of the real Downloads folder (registered after the manager's handler, so it wins)
  const ses = session.fromPartition(constants.TAB_PARTITION);
  ses.on("will-download", (_e, item) => item.setSavePath(path.join(tmp, "dl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-" + item.getFilename())));

  const active = () => state.tabs.find((t) => t.id === state.activeTabId);
  const list = () => dm.publicList();
  const strip = () => state.tabs.map((t) => (String(t.url).replace(base, "") || "(blank)").replace(/^file:.*\/(\w+)\.html$/, "<$1>")).join(" | ");
  // a tab count sampler: proves the new tab really OPENED (the Chrome "flash") before it closed
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, state.tabs.length); }, 5);
  sampler.unref();

  const fresh = async (extraTabsAfterSite = 0) => {
    while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
    await sleep(400);
    tm.createTab(base + "/"); await sleep(900);
    const site = active();
    for (let i = 0; i < extraTabsAfterSite; i++) { tm.createTab(base + "/page2"); await sleep(500); }
    tm.switchTab(site.id); await sleep(400);
    return site;
  };
  const run = async (id, site) => {
    peak = state.tabs.length;
    const before = { tabs: state.tabs.length, dls: list().length };
    await site.view.webContents.executeJavaScript(`document.getElementById("${id}").click()`, true);
    await until(() => list().length >= before.dls + 1 && list().slice(-1)[0] && true, 6000);
    await until(() => list().every((d) => d.state === "completed"), 6000);
    await sleep(500);
    return { before, peak, tabsNow: state.tabs.length, newDls: list().length - before.dls };
  };

  // ── 1. the three ways a site opens a download in a new tab ──
  for (const [label, id] of [["a target=_blank link", "blank"], ["window.open(url)", "open"], ["a _blank link that redirects (302) to the file", "redir"]]) {
    const site = await fresh();
    const r = await run(id, site);
    check(`[${label}] the file downloaded (1 new download, completed)`, r.newDls === 1 && list().every((d) => d.state === "completed"));
    check(`[${label}] the new tab DID open for a moment (peak ${r.before.tabs + 1})...`, r.peak >= r.before.tabs + 1);
    check(`[${label}] ...and closed itself again: ${r.before.tabs} -> ${r.tabsNow} tabs  [${strip()}]`, r.tabsNow === r.before.tabs);
    check(`[${label}] and you are back on the page you were on`, active().id === site.id);
  }

  // ── 2. what must NOT close ──
  {
    const site = await fresh();
    const r = await run("same", site);
    check("a link on a page that IS showing downloads in place: no tab opened, the page stays", r.newDls === 1 && r.peak === r.before.tabs && r.tabsNow === r.before.tabs && String(active().url).startsWith(base + "/"));
  }
  {
    const site = await fresh();
    const before = state.tabs.length;
    await site.view.webContents.executeJavaScript('document.getElementById("page").click()', true);
    await sleep(1500);
    const added = state.tabs.length - before;
    check("window.open to a REAL page is not a download: its tab opens and STAYS", added === 1 && String(state.tabs[state.tabs.length - 1].url).endsWith("/page2"));
  }
  {
    // the last tab must never be closed this way (it would quit the browser)
    while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
    await sleep(400);
    tm.closeTabOpenedForDownload(active().view.webContents);
    await sleep(300);
    check("the only tab is never closed by this rule (it would quit the app)", state.tabs.length === 1 && !!state.mainWindow && !state.mainWindow.isDestroyed());
  }

  // ── 3. you return to the tab you came from, even when it is not at the end of the strip ──
  {
    const site = await fresh(2);     // strip: <newtab> | site | page2 | page2   (site is in the MIDDLE)
    const idx = state.tabs.indexOf(site);
    const r = await run("blank", site);
    check(`opener in the middle of the strip (index ${idx} of ${r.before.tabs}): the tab opened and closed`, r.peak >= r.before.tabs + 1 && r.tabsNow === r.before.tabs);
    check("...and you land back on the OPENER, not on whatever tab is last in the strip", active().id === site.id && state.tabs.indexOf(site) === idx);
  }

  // ── 4. closing the tab must not cancel or damage a download that is still running ──
  {
    const site = await fresh();
    peak = state.tabs.length;
    const dls0 = list().length;
    await site.view.webContents.executeJavaScript('document.getElementById("slow").click()', true);
    await until(() => list().length === dls0 + 1, 5000);
    await sleep(250);
    const mid = list()[list().length - 1];
    check("a SLOW download is still in progress after its tab closed", state.tabs.length === 2 && mid && mid.state === "progressing");
    check("...and it finishes in full (not cancelled by closing its tab)", await until(() => { const d = list()[list().length - 1]; return d && d.state === "completed"; }, 8000));
    const done = list()[list().length - 1];
    const saved = fs.readdirSync(tmp).find((f) => f.endsWith("-slow.bin"));
    check("...with every byte on disk", !!saved && fs.statSync(path.join(tmp, saved)).size === 25 * 4096 && done.state === "completed");
  }

  // ── 5. "Ask where to save each file": the tab waits for the Save As answer, then closes ──
  {
    const prev = settings.get("downloads") || {};
    settings.set("downloads", { ...prev, ask: true });
    const site = await fresh();
    const r = await run("blank", site);
    check("with 'ask where to save' the download still completes and the tab still closes", r.newDls === 1 && list().every((d) => d.state === "completed") && r.tabsNow === r.before.tabs && r.peak >= r.before.tabs + 1);
    settings.set("downloads", { ...prev, ask: false });
  }

  // ── 6. a closed download tab is not left in the Ctrl+Shift+T list ──
  {
    const site = await fresh();
    await run("blank", site);
    const beforeRestore = state.tabs.length;
    tm.reopenClosedTab(); await sleep(1200);
    check("Ctrl+Shift+T does not resurrect the blank download tab", !state.tabs.slice(beforeRestore).some((t) => /dl\.bin/.test(String(t.url))));
  }

  clearInterval(sampler);
  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_DLTAB total=" + results.length + " failed=" + failed.length);
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
