// Finds WHAT blocks the browser's main (UI) thread while many tabs open: opens N tabs of a light or heavy (4000-row table) page on a local server, watches the main thread with a 20 ms ticker,
// and records a Chromium trace (content tracing) to name the slowest tasks. Measured 2026-10-10: a light page = no stall; heavy pages = one ~7 s stall in the BROWSER process,
// RenderAccessibilityHost::HandleAXEvents (accessibility trees of the pages), gone with --disable-renderer-accessibility.
// Run: PAGE=heavy|light N=6 [THR=800000 (microseconds)] env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe [--disable-renderer-accessibility] scripts/diagnose-main-thread.js
const { app } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 200000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-lag-"));
require("../electron/constants").dataDir = () => path.join(tmp, "UserData");
fs.mkdirSync(path.join(tmp, "UserData"), { recursive: true });
fs.writeFileSync(path.join(tmp, "UserData", "settings.json"), JSON.stringify({ showBookmarksBar: false }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  require("../electron/main.js"); await app.whenReady(); await sleep(3000);
  const tm = require("../electron/tabs/tabManager");
  const http = require("http");
  const page = process.env.PAGE === 'light' ? '<html><body>hello</body></html>' : "<html><body><script>const t=document.createElement('table');for(let i=0;i<4000;i++){const r=t.insertRow();for(let j=0;j<8;j++)r.insertCell().textContent='r'+i+j}document.body.appendChild(t);setInterval(()=>{t.rows[5].cells[0].textContent=Date.now()},200)</script></body></html>";
  const web = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(page); }).listen(0, "127.0.0.1");
  await new Promise((r) => web.once("listening", r));
  const inspector = require("inspector"); const ses = new inspector.Session(); ses.connect(); ses.post("Profiler.enable");
  await new Promise((r) => ses.post("Profiler.setSamplingInterval", { interval: 500 }, r));
  await new Promise((r) => ses.post("Profiler.start", r));
  console.log("accessibilitySupportEnabled at start:", app.accessibilitySupportEnabled);
  if (process.env.AX === "off") { app.setAccessibilitySupportEnabled(false); console.log("-> set to false"); }
  const { contentTracing } = require("electron");
  await contentTracing.startRecording({ included_categories: ["toplevel", "ipc", "mojom", "navigation", "ui", "views", "viz", "disabled-by-default-toplevel.flow"], excluded_categories: [] });
  const T0 = Date.now(); let last = Date.now(), worst = [], what = "idle", cpu0 = process.cpuUsage();
  setInterval(() => { const now = Date.now(), gap = now - last - 20; last = now; if (gap > 150) { const c = process.cpuUsage(cpu0); worst.push("t=" + ((now - gap - T0) / 1000).toFixed(1) + "s  " + gap + " ms during: " + what + "  (main cpu " + Math.round((c.user + c.system) / 1000) + " ms)"); cpu0 = process.cpuUsage(); } }, 20);
  for (let i = 0; i < Number(process.env.N || 24); i++) { what = "createTab " + i; tm.createTab("http://127.0.0.1:" + web.address().port + "/?t=" + i); await sleep(400); what = "idle"; }
  await sleep(8000);
  const prof = await new Promise((r) => ses.post("Profiler.stop", (e, x) => r(x.profile)));
  const byId = {}; prof.nodes.forEach((n) => { byId[n.id] = n; n.self = 0; });
  prof.samples.forEach((id, i) => { byId[id].self += (prof.timeDeltas[i] || 0) / 1000; });
  const parent = {}; prof.nodes.forEach((n) => (n.children || []).forEach((c) => { parent[c] = n.id; }));
  const key = (f) => (f.functionName || "(anon)") + " " + String(f.url || "").split(/[\\/]/).slice(-2).join("/") + ":" + f.lineNumber;
  const incl = {};
  prof.nodes.forEach((n) => { const seen = new Set(); let cur = n.id; while (cur != null) { const k = key(byId[cur].callFrame); if (!seen.has(k)) { seen.add(k); incl[k] = (incl[k] || 0) + n.self; } cur = parent[cur]; } });
  const ours = Object.entries(incl).filter(([k]) => /electron\//.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 14);
  const tf = await contentTracing.stopRecording(path.join(tmp, "trace.json"));
  const tr = JSON.parse(fs.readFileSync(tf, "utf8")); const evs = (tr.traceEvents || tr);
  const procName = {}; evs.forEach((e) => { if (e.ph === "M" && e.name === "process_name") procName[e.pid] = e.args && e.args.name; });
  const thrName = {}; evs.forEach((e) => { if (e.ph === "M" && e.name === "thread_name") thrName[e.pid + ":" + e.tid] = e.args && e.args.name; });
  const slow = evs.filter((e) => e.ph === "X" && e.dur > Number(process.env.THR || 800000)).sort((a, b) => b.dur - a.dur).slice(0, 40);
  console.log("SLOW TASKS (>0.8 s) in the trace:\n  " + (slow.map((e) => Math.round(e.dur / 1000) + " ms  " + (procName[e.pid] || e.pid) + " / " + (thrName[e.pid + ":" + e.tid] || e.tid) + "  " + e.cat + " :: " + e.name + " " + JSON.stringify(e.args || {}).slice(0, 160)).join("\n  ") || "none"));
  console.log("accessibilitySupportEnabled at end:", app.accessibilitySupportEnabled);
  console.log("INCLUSIVE time of our functions (ms):\n  " + ours.map(([k, v]) => Math.round(v) + "  " + k).join("\n  "));
  const selfNative = Object.entries(incl).filter(([k]) => /^\((program|garbage)/.test(k)).map(([k, v]) => k + " " + Math.round(v));
  console.log("native:", selfNative.join(" | "));
  console.log("BLOCKS (>150 ms):\n  " + worst.join("\n  "));
  app.exit(0);
})();
