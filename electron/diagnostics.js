const { app, screen, powerMonitor, webContents } = require("electron");
const netSocket = require("net");
const dns = require("dns");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const state = require("./state");
const settings = require("./settings");

// The support report (owner's request 2026-10-09: one user's PC is slow and nobody can tell why). It describes the COMPUTER and how PBCalc has been running
// on it - never what was browsed: no addresses, page titles, cookies, passwords, bookmarks or history (the no-history rule stands). The user always sees a box
// first (reportDialog.js), can type a note, and decides to send. It is put as a file into a folder of the company's own network (the IT department's share);
// a PC that is not on that network is not an error: the box says so quietly and offers to save the report as a file that can be handed to the IT department.
//
// While PBCalc runs a small recorder keeps the LAST 10 MINUTES in memory (one sample every 5 s: memory and CPU per process, free RAM, the whole computer's CPU, how late
// the main program's timer fires, tabs open / freed) - it is what makes a hang that "comes and goes" visible: the user presses Send while it is slow and the report holds
// the minutes before. A tiny copy of the last minutes (numbers only, no pages) is also written to disk every 30 s and removed again when PBCalc closes normally: if PBCalc
// is killed or the PC hangs and is reset, the NEXT start still has what the last minutes looked like ("previousSession" in the report) - the only way to see a crash after the fact.

const DEFAULT_SHARE = String.raw`\\192.168.0.3\it\Ravi\browser\pbcalc-report`;   // the IT department's network folder; settings.json "reportShare" overrides it
const MAX_REPORT_BYTES = 2 * 1024 * 1024;
const REACH_MS = 2500, WRITE_MS = 10000;
const SAMPLE_MS = 5000, RING_MAX = 120, LAG_MS = 500, EVENTS_MAX = 50, NOTE_MAX = 2000, LOADS_MAX = 60, EXC_MAX = 20, SESSION_SAVE_MS = 30000, SESSION_TAIL = 24;

const ring = [];
const events = [];
const pageLoads = [];
const exceptions = [];
const marks = {};
let timer = null, lagTimer = null, saveTimer = null, lastTick = 0, lagMax = 0, started = false, quitRequested = false;
let onProblem = null, unresponsiveTimers = new Map(), prevCpu = null;
const startedAt = new Date();

function mark(name) { if (marks[name] == null) marks[name] = Math.round(process.uptime() * 1000); }   // ms since the process started

function addEvent(kind, extra) {
  events.push({ at: new Date().toISOString(), up: Math.round(process.uptime()), kind, ...(extra || {}) });
  if (events.length > EVENTS_MAX) events.shift();
}

// a message may mention an address (a failed load): none may travel
// the site's HOST NAME only (owner's decision 2026-10-10: company PCs, no personal data - so the report names the site). Never the path, query or fragment (they can hold tokens / ids).
const hostOf = (u) => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) ? x.hostname.slice(0, 100) : ""; } catch (_) { return ""; } };
const hostOfWc = (wc) => { try { return wc && !wc.isDestroyed() ? hostOf(wc.getURL()) : ""; } catch (_) { return ""; } };
const scrub = (s) => String(s == null ? "" : s).replace(/(?:https?|wss?|ftp|file):\/\/\S+/gi, "<url>").slice(0, 300);
function addException(origin, err) {
  const stack = err && err.stack ? String(err.stack).split("\n").slice(0, 4).map(scrub).join(" | ") : "";
  exceptions.push({ at: new Date().toISOString(), origin: String(origin || ""), message: scrub(err && err.message || err), stack });
  if (exceptions.length > EXC_MAX) exceptions.shift();
}

// ── who is who: which process belongs to the shell, to which tab (by its position, never its address), or to a helper view of ours ──
function roles() {
  const map = new Map(), hosts = new Map();
  const shell = state.mainWindow && !state.mainWindow.isDestroyed() ? state.mainWindow.webContents : null;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    let pid = 0; try { pid = wc.getOSProcessId(); } catch (_) {}
    if (!pid) continue;
    let role = "other";
    const idx = state.tabs.findIndex((t) => t.view && t.view.webContents === wc);
    if (wc === shell) role = "shell";
    else if (idx >= 0) role = "page" + (idx + 1);
    else { let u = ""; try { u = wc.getURL(); } catch (_) {} const m = /\/renderer\/([a-z]+)\//.exec(u); role = m ? "helper:" + m[1] : "other"; }
    map.set(pid, role);
    if (idx >= 0) hosts.set(pid, state.tabs[idx].discarded && state.tabs[idx].url ? hostOf(state.tabs[idx].url) : hostOfWc(wc));
  }
  map.hosts = hosts;
  return map;
}

// the whole computer's CPU use since the last call (percent): tells "PBCalc is busy" from "something else is"
function systemCpu() {
  const now = os.cpus();
  let idle = 0, total = 0;
  if (prevCpu) now.forEach((c, i) => { const p = prevCpu[i]; if (!p) return; const t = c.times; idle += t.idle - p.idle; total += (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq); });
  prevCpu = now.map((c) => ({ ...c.times }));
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null;
}

function sample() {
  const by = {}, pages = [];
  const who = roles();
  for (const p of app.getAppMetrics()) {
    const k = p.type === "Utility" && p.name ? "Utility:" + p.name : p.type;
    const e = by[k] || (by[k] = { n: 0, cpu: 0, privMB: 0 });
    const mb = (p.memory.privateBytes || 0) / 1024;   // privateBytes is in KB
    e.n++; e.cpu += p.cpu.percentCPUUsage || 0; e.privMB += mb;
    const r = who.get(p.pid);
    if (r && /^page\d+$/.test(r)) pages.push({ p: Number(r.slice(4)), host: (who.hosts && who.hosts.get(p.pid)) || "", mb: Math.round(mb), cpu: Math.round((p.cpu.percentCPUUsage || 0) * 100) / 100 });
  }
  for (const e of Object.values(by)) { e.cpu = Math.round(e.cpu * 100) / 100; e.privMB = Math.round(e.privMB); }
  ring.push({
    at: new Date().toISOString(), freeMB: Math.round(os.freemem() / 1048576), sysCpu: systemCpu(), lagMs: Math.max(0, Math.round(lagMax)),
    mainMB: Math.round(process.memoryUsage().rss / 1048576), tabs: state.tabs.length, discarded: state.tabs.filter((t) => t.discarded).length, procs: by, pages,
  });
  lagMax = 0;
  if (ring.length > RING_MAX) ring.shift();
}

// ── the copy kept for the NEXT start (see the header) ──
const sessionFile = () => path.join(app.getPath("userData"), "diag-session.json");
const previousFile = () => path.join(app.getPath("userData"), "diag-previous.json");
function persistSession() {
  try {
    require("./atomicWrite").writeFileAtomic(sessionFile(), JSON.stringify({
      startedAt: startedAt.toISOString(), lastAt: new Date().toISOString(), upSec: Math.round(process.uptime()), version: require("../package.json").version, quitRequested,
      tabs: state.tabs.length, recent: ring.slice(-SESSION_TAIL), events: events.slice(-20), pageLoads: pageLoads.slice(-20), exceptions: exceptions.slice(-10),
    }), "utf8");
  } catch (_) {}
}
// a normal end of PBCalc removes it; what is still there at the next start is the trace of an abnormal end (killed, crashed, power cut)
function cleanExit() { try { fs.unlinkSync(sessionFile()); } catch (_) {} }
function adoptPrevious() {
  try { if (fs.existsSync(sessionFile())) fs.renameSync(sessionFile(), previousFile()); } catch (_) {}
}
function previousSession() {
  try {
    const j = JSON.parse(fs.readFileSync(previousFile(), "utf8"));
    return { endedUncleanly: true, quitWasRequested: !!j.quitRequested, startedAt: j.startedAt, lastSeen: j.lastAt, ranSec: j.upSec, version: j.version, tabs: j.tabs, recent: j.recent || [], events: j.events || [], pageLoads: j.pageLoads || [], exceptions: j.exceptions || [] };
  } catch (_) { return null; }
}
// the report that carried it has been delivered: it need not be carried again
function acknowledgePrevious() { try { fs.unlinkSync(previousFile()); } catch (_) {} }

// Starts the recorder and the problem watchers. opts.onProblem(kind): a page crashed or stopped responding (reportDialog asks the user).
function start(opts = {}) {
  if (started) return;
  started = true;
  onProblem = opts.onProblem || null;
  mark("diagnosticsStarted");
  adoptPrevious();
  prevCpu = os.cpus().map((c) => ({ ...c.times }));
  lastTick = Date.now();
  lagTimer = setInterval(() => { const now = Date.now(); const late = now - lastTick - LAG_MS; if (late > lagMax) lagMax = late; lastTick = now; }, LAG_MS);
  timer = setInterval(() => { try { sample(); } catch (_) {} }, SAMPLE_MS);
  saveTimer = setInterval(persistSession, SESSION_SAVE_MS);
  for (const t of [lagTimer, timer, saveTimer]) if (t.unref) t.unref();
  app.on("before-quit", () => { quitRequested = true; persistSession(); });
  app.on("will-quit", cleanExit);
  process.on("uncaughtExceptionMonitor", (err, origin) => addException(origin, err));   // a MONITOR: it records, and changes nothing about how the error is handled
  app.on("render-process-gone", (_e, _wc, d) => {
    addEvent("render-process-gone", { reason: d.reason, exitCode: d.exitCode, host: hostOfWc(_wc) });
    if (d.reason !== "clean-exit" && d.reason !== "killed" && onProblem) onProblem("crash");
  });
  app.on("child-process-gone", (_e, d) => { addEvent("child-process-gone", { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name || "" }); });
  app.on("web-contents-created", (_e, wc) => {
    // how long each page took to load (a number and the time - never which page)
    let t0 = 0;
    wc.on("did-start-loading", () => { t0 = Date.now(); });
    wc.on("did-stop-loading", () => {
      if (!t0) return;
      const ms = Date.now() - t0; t0 = 0;
      let u = ""; try { u = wc.getURL(); } catch (_) {}
      if (!/^https?:/i.test(u)) return;   // our own pages and error pages are not "the site is slow"
      pageLoads.push({ at: new Date().toISOString(), ms, host: hostOf(u) }); if (pageLoads.length > LOADS_MAX) pageLoads.shift();
    });
    // a page that does not answer: only when it STAYS silent (a brief freeze while a big page loads is not a problem)
    wc.on("unresponsive", () => {
      addEvent("unresponsive", { type: wc.getType(), host: hostOfWc(wc) });
      const id = wc.id;
      clearTimeout(unresponsiveTimers.get(id));
      unresponsiveTimers.set(id, setTimeout(() => { unresponsiveTimers.delete(id); if (onProblem) onProblem("hang"); }, 8000));
    });
    wc.on("responsive", () => { addEvent("responsive", { type: wc.getType() }); clearTimeout(unresponsiveTimers.get(wc.id)); unresponsiveTimers.delete(wc.id); });
    wc.once("destroyed", () => { clearTimeout(unresponsiveTimers.get(wc.id)); unresponsiveTimers.delete(wc.id); });
  });
}

// ── facts about the computer ──
const userName = (() => { try { return os.userInfo().username; } catch (_) { return ""; } })();
// the Windows account name must not travel: it is part of paths like C:\Users\<name>\...
function redact(value) {
  if (!userName) return value;
  const esc = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("([\\\\/]Users[\\\\/])" + esc + "(?=[\\\\/]|$)", "gi");
  const walk = (v) => {
    if (typeof v === "string") return v.replace(re, "$1<user>");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o; }
    return v;
  };
  return walk(value);
}

function installId() {
  let id = settings.get("installId");
  if (typeof id !== "string" || id.length < 16) { id = crypto.randomUUID(); settings.set("installId", id); }
  return id;
}

const { windowsFacts } = require("./winFacts");

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms))]);

// how fast the network answers, in ms: the IT department's computer, the internet (a TCP connection to a public address) and a name lookup. Tells "the network is slow"
// from "the PC is slow" (an ERP page that takes a minute can be either). Only generic addresses - nothing about the sites the user visits.
function connectMs(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let done = false;
    const s = netSocket.connect({ host, port });
    const end = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(ms, () => end(null));
    s.once("connect", () => end(Date.now() - t0));
    s.once("error", () => end(null));
  });
}
async function networkFacts() {
  const itHost = hostOfShare(DEFAULT_SHARE);
  const t0 = Date.now();
  const [it, internet, dnsMs] = await Promise.all([
    itHost ? connectMs(itHost, 445) : null,
    connectMs("1.1.1.1", 443),
    withTimeout(dns.promises.lookup("www.google.com"), 3000).then(() => Date.now() - t0).catch(() => null),
  ]);
  return { itComputerMs: it, internetMs: internet, dnsMs };
}

// size of the data folder (cache, cookies of the running session...), bounded so a huge folder cannot make the report slow
async function folderSizeMB(dir, maxEntries = 20000, maxMs = 2500) {
  const t0 = Date.now(); let bytes = 0, seen = 0; const stack = [dir];
  while (stack.length && seen < maxEntries && Date.now() - t0 < maxMs) {
    const d = stack.pop();
    let list; try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { bytes += (await fs.promises.stat(p)).size; } catch (_) {} }
    }
  }
  return { mb: Math.round(bytes / 1048576), complete: stack.length === 0 };
}

// What goes into the report. opts: { note, trigger: "manual" | "crash" | "hang" }
async function collect(opts = {}) {
  const [gpu, win, dataSize, network] = await Promise.all([
    app.getGPUInfo("complete").catch(() => null), windowsFacts(), folderSizeMB(app.getPath("userData")), networkFacts().catch(() => null),
  ]);
  const cpus = os.cpus() || [];
  let freeGB = null;
  try { const s = fs.statfsSync(app.getPath("userData")); freeGB = Math.round((s.bavail * s.bsize) / 1e8) / 10; } catch (_) {}
  const now = new Date();
  const who = roles();
  const report = {
    format: 2,
    reportId: crypto.randomUUID(),
    trigger: opts.trigger || "manual",
    createdAt: now.toISOString(),
    local: now.toLocaleString("en-GB", { hour12: false }),
    timezoneOffsetMin: -now.getTimezoneOffset(),
    computer: { name: os.hostname(), installId: installId() },
    app: {
      version: require("../package.json").version, packaged: app.isPackaged, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
      locale: app.getLocale(), uptimeSec: Math.round(process.uptime()), startedAt: startedAt.toISOString(),
    },
    windows: { version: process.getSystemVersion(), release: os.release(), arch: os.arch(), uptimeHours: Math.round(os.uptime() / 360) / 10, edition: win.osCaption || null, build: win.osBuild || null, sessionType: process.env.SESSIONNAME || "" },
    hardware: {
      cpuModel: cpus[0] ? cpus[0].model.trim() : "", cpuThreads: cpus.length, cpuMHz: cpus[0] ? cpus[0].speed : 0,
      ramTotalMB: Math.round(os.totalmem() / 1048576), ramFreeMB: Math.round(os.freemem() / 1048576),
      gpu: gpu && Array.isArray(gpu.gpuDevice) ? gpu.gpuDevice.map((d) => ({ name: d.deviceString, driver: d.driverVersion, active: !!d.active, vendorId: d.vendorId, deviceId: d.deviceId })) : [],
      displays: screen.getAllDisplays().map((d) => ({ width: d.size.width, height: d.size.height, scale: d.scaleFactor, hz: d.displayFrequency })),
      onBattery: (() => { try { return powerMonitor.isOnBatteryPower(); } catch (_) { return null; } })(),
    },
    gpuFeatures: app.getGPUFeatureStatus(),
    memory: { windows: win.memory || null, pageFile: win.pageFile || null, available: win.memory2 || null },
    load: win.load || null,
    otherPrograms: { openApps: win.openApps || null, topCpu: win.topCpu || null, startupPrograms: win.startupPrograms || null },
    network,
    storage: { dataFolderFreeGB: freeGB, dataFolderSizeMB: dataSize.mb, dataFolderSizeComplete: dataSize.complete, disks: win.disks || null },
    windowsFacts: { antivirus: win.antivirus || null, powerPlan: win.powerPlan || null, defender: win.defender || null, pbcalcEvents: win.pbcalcEvents || [], unavailable: !!win.unavailable, errors: win.errors || null },
    openTabs: state.tabs.map((t, i) => ({ p: i + 1, host: hostOf(t.url || (t.view && t.view.webContents && !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : "")), active: t.id === state.activeTabId, discarded: !!t.discarded })),
    appState: {
      tabs: state.tabs.length, discarded: state.tabs.filter((t) => t.discarded).length, restricted: !!state.restricted, calculatorMode: !!state.calcMode,
      calculatorStart: settings.get("calculatorStart") === true, memorySaver: settings.get("memorySaver") !== false, themeMode: settings.get("themeMode"),
      searchSuggestions: settings.get("searchSuggestions") !== false, updateDeclined: settings.get("updateDeclined") || "",
    },
    startupMs: { ...marks },
    processesNow: app.getAppMetrics().map((p) => ({ role: who.get(p.pid) || "", type: p.type, name: p.name || "", cpu: Math.round((p.cpu.percentCPUUsage || 0) * 100) / 100, privateMB: Math.round((p.memory.privateBytes || 0) / 1024), workingSetMB: Math.round((p.memory.workingSetSize || 0) / 1024) })),
    recent: ring.slice(),
    pageLoads: pageLoads.slice(),
    events: events.slice(),
    exceptions: exceptions.slice(),
    previousSession: previousSession(),
    note: String(opts.note == null ? "" : opts.note).slice(0, NOTE_MAX),
  };
  return redact(report);
}

function reportShare() {
  const p = settings.get("reportShare");
  return typeof p === "string" && p.trim() ? p.trim() : DEFAULT_SHARE;
}

// The report is kept under MAX_REPORT_BYTES (it is a few KB; this is only a safety net): the oldest recorder samples go first, then the oldest events.
function fitSize(report) {
  const r = { ...report };
  r.recent = (report.recent || []).slice(); r.events = (report.events || []).slice();
  while (Buffer.byteLength(JSON.stringify(r)) > MAX_REPORT_BYTES && r.recent.length) r.recent.shift();
  while (Buffer.byteLength(JSON.stringify(r)) > MAX_REPORT_BYTES && r.events.length) r.events.shift();
  if (Buffer.byteLength(JSON.stringify(r)) > MAX_REPORT_BYTES) r.note = r.note.slice(0, 200);
  return r;
}

const safeName = (s, n) => String(s == null ? "" : s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, n) || "x";
const pad2 = (n) => String(n).padStart(2, "0");
// <yyyy-mm-dd>/<computer>_<installId8>_<hhmmss>_<trigger>_<reportId8>.json  (the report id keeps two reports of the same second apart)
function reportFileName(report) {
  const t = new Date(report.createdAt);
  const d = isNaN(t) ? new Date() : t;
  return {
    day: d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()),
    file: safeName(report.computer.name, 40) + "_" + safeName(report.computer.installId, 8) + "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + "_" + safeName(report.trigger, 10) + "_" + safeName(report.reportId, 8) + ".json",
  };
}

// can the computer in a share path (\\host\...) be reached at all? One quick TCP connection to its file-sharing port: a PC that is away from the company network
// must not wait for Windows' own (long) network time-out.
const hostOfShare = (p) => { const m = /^\\\\([^\\/]+)/.exec(p); return m ? m[1] : null; };
function reachable(host, port = 445, ms = REACH_MS) {
  return new Promise((resolve) => {
    let done = false;
    const s = netSocket.connect({ host, port });
    const end = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(ms, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

// Puts the report into the IT department's folder. -> { ok: true, file } | { ok: false, offline: true } (not on the company network / the folder does not answer)
// | { ok: false, offline: false, reason } (the folder answers but will not take the file: no permission, folder missing...). Never throws.
async function send(report, opts = {}) {
  const dir = opts.dir || reportShare();
  const host = hostOfShare(dir);
  if (host && !(await reachable(host))) return { ok: false, offline: true };
  const { day, file } = reportFileName(report);
  const body = JSON.stringify(fitSize(report), null, 2);
  const dayDir = path.join(dir, day);
  const target = path.join(dayDir, file);
  const attempt = () => withTimeout((async () => {
    await fs.promises.mkdir(dayDir, { recursive: true });
    await fs.promises.writeFile(target + ".part", body, { flag: "wx" });
    await fs.promises.rename(target + ".part", target);   // readers never see half a file
  })(), opts.writeMs || WRITE_MS);
  const failure = (e) => ({ ok: false, offline: e && (e.code === "ETIMEDOUT" || e.code === "ENETUNREACH" || e.code === "EHOSTUNREACH" || e.code === "ENETDOWN" || e.code === "ENOTFOUND"), reason: e && e.code || "error" });
  const done = () => { if (report.previousSession && !opts.keepPrevious) acknowledgePrevious(); return { ok: true, file: target }; };
  try { await attempt(); return done(); } catch (e) {
    const first = failure(e);
    if (first.offline) return first;
    // the PC is on the company network but the file server did not accept it (not signed in): ONE temporary sign-in with the IT account (shareLogin.js), the write again,
    // and the connection is removed right after - only the one we made. Nothing is saved on the PC.
    const loginFn = opts.login || (hostOfShare(dir) ? require("./shareLogin").login : null);
    if (!loginFn) return first;
    let session = null;
    try {
      session = await loginFn(dir);
      if (!session || !session.connected) return first;
      await attempt();
      return done();
    } catch (e2) { return failure(e2); }
    finally { try { if (session && session.connected) await session.disconnect(); } catch (_) {} }
  }
}

// the same report as a file the user chooses (to hand to the IT department when the network is not there)
async function saveToFile(report, file) {
  await fs.promises.writeFile(file, JSON.stringify(fitSize(report), null, 2), "utf8");
  if (report.previousSession) acknowledgePrevious();
  return file;
}

module.exports = {
  start, mark, collect, send, saveToFile, reportShare, reportFileName, fitSize, installId, redact, previousSession, acknowledgePrevious, cleanExit, persistSession, scrub,
  _ring: () => ring, _events: () => events, _pageLoads: () => pageLoads, _exceptions: () => exceptions, NOTE_MAX, DEFAULT_SHARE, MAX_REPORT_BYTES,
};
