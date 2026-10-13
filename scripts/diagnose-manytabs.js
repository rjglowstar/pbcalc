// Opens many tabs of a "heavy-ish" page (a table with a few thousand rows + a busy timer, like an ERP grid) on a local server, lets the recorder run, then collects a REAL report and
// prints what the reader makes of it. Shows what the report says when a user opens many tabs: per-tab memory, main-program lag, room for more tabs.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/diagnose-manytabs.js [tabs=30]
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-many-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });
fs.writeFileSync(path.join(tmp, "UserData", "settings.json"), JSON.stringify({ showBookmarksBar: false, reportShare: path.join(tmp, "share") }));
const N = Number(process.argv[2]) || 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  require("../electron/main.js");
  await app.whenReady(); await sleep(3000);
  const tm = require("../electron/tabs/tabManager");
  const dg = require("../electron/diagnostics");
  const http = require("http");
  const page = "<html><title>grid</title><body><script>const t=document.createElement('table');for(let i=0;i<4000;i++){const r=t.insertRow();for(let j=0;j<8;j++)r.insertCell().textContent='row '+i+' col '+j}document.body.appendChild(t);setInterval(()=>{t.rows[Math.floor(Math.random()*4000)].cells[0].textContent=Date.now()},200)</script></body></html>";
  const web = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(page); }).listen(0, "127.0.0.1");
  await new Promise((r) => web.once("listening", r));
  const t0 = Date.now();
  for (let i = 0; i < N; i++) { tm.createTab("http://127.0.0.1:" + web.address().port + "/?t=" + i); await sleep(400); }
  console.log("opened " + N + " tabs in " + ((Date.now() - t0) / 1000).toFixed(1) + " s; letting the recorder run 40 s");
  await sleep(40000);
  const t1 = Date.now();
  const rep = await dg.collect({ note: "many tabs", trigger: "manual" });
  console.log("collect took " + ((Date.now() - t1) / 1000).toFixed(1) + " s; report " + Math.round(JSON.stringify(rep).length / 1024) + " KB");
  const f = path.join(tmp, "many.json"); fs.writeFileSync(f, JSON.stringify(rep, null, 2));
  const last = rep.recent[rep.recent.length - 1];
  console.log("tabs", rep.openTabs.length, "| pages sample:", last.pages.length, "pages, avg", Math.round(last.pages.reduce((a, p) => a + p.mb, 0) / Math.max(1, last.pages.length)), "MB each | PBCalc total private MB", rep.processesNow.reduce((a, p) => a + p.privateMB, 0));
  console.log("peaks", JSON.stringify(rep.peaks));
  console.log("resources", JSON.stringify(rep.resources));
  console.log("REPORT_FILE=" + f);
  app.exit(0);
})().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
