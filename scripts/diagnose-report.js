#!/usr/bin/env node
// Reads a PBCalc support report (the .json in the IT folder, or the file a user saved) and says in plain words what it shows: the facts, then FINDINGS - each one a possible reason
// why that computer runs slowly or crashed, with the number it is based on. Run:   node diagnose-report.js <report.json>
// CPU figures: Electron reports a process's CPU as a percentage of ALL the computer's threads (measured: one page thread fully busy on a 20-thread PC shows 4.73),
// so "cores busy" below = percentage x threads / 100.
const fs = require("fs");

// what the exception code of a Windows crash entry usually means
const CODES = {
  c0000005: "access violation (a program touched memory it must not - often a faulty driver / module)",
  c0000409: "stack buffer overrun / fail-fast (a protected stop)",
  c00000fd: "stack overflow",
  c000012d: "the system ran out of virtual memory",
  c0000017: "not enough memory",
  c0000142: "a required DLL failed to start",
  80000003: "breakpoint",
  e0434352: ".NET exception",
};
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function analyse(r) {
  const out = { facts: [], findings: [] };
  const F = (s) => out.facts.push(s);
  const find = (level, title, detail) => out.findings.push({ level, title, detail });
  const hw = r.hardware || {}, w = r.windows || {}, app = r.app || {}, st = r.storage || {}, wf = r.windowsFacts || {}, gf = r.gpuFeatures || {};
  const recent = Array.isArray(r.recent) ? r.recent : [];
  const mem = (r.memory && r.memory.windows) || null, pf = (r.memory && r.memory.pageFile) || null, load = r.load || null, net = r.network || null, others = r.otherPrograms || {};
  const threads = hw.cpuThreads || 1;
  const gb = (mb) => (mb / 1024).toFixed(1) + " GB";

  F("Computer " + (r.computer && r.computer.name) + "  (install " + String(r.computer && r.computer.installId).slice(0, 8) + ")  -  " + r.local + "  -  reason: " + r.trigger);
  F("PBCalc " + app.version + (app.packaged ? "" : " (development copy)") + "  -  Electron " + app.electron + " / Chromium " + app.chromium + "  -  running " + Math.round((app.uptimeSec || 0) / 60) + " min");
  F("Windows " + (w.edition || w.version) + " (" + w.version + ") " + (w.arch || "") + "  -  up " + w.uptimeHours + " h" + (w.sessionType && w.sessionType !== "Console" ? "  -  session: " + w.sessionType : ""));
  F("CPU " + hw.cpuModel + "  (" + threads + " threads)  -  RAM " + gb(hw.ramTotalMB || 0) + ", free now " + gb(hw.ramFreeMB || 0));
  F("Graphics " + ((hw.gpu || []).map((g) => g.name + (g.active ? " [active]" : "") + " drv " + g.driver).join("; ") || "unknown") + "  -  screens " + (hw.displays || []).map((d) => d.width + "x" + d.height + "@" + d.scale + "x/" + d.hz + "Hz").join(", "));
  F("Disks " + JSON.stringify(st.disks) + "  -  data folder " + st.dataFolderSizeMB + " MB, " + st.dataFolderFreeGB + " GB free  -  antivirus " + JSON.stringify(wf.antivirus) + "  -  power plan " + wf.powerPlan + (hw.onBattery ? "  (ON BATTERY)" : ""));
  if (mem) F("Windows memory: " + gb(mem.physTotalMB) + " physical, " + gb(mem.physFreeMB) + " free; commit " + gb(mem.commitLimitMB - mem.commitFreeMB) + " of " + gb(mem.commitLimitMB) + (pf && pf.length ? "; page file " + pf.map((x) => x.usedMB + "/" + x.sizeMB + " MB (peak " + x.peakMB + ")").join(", ") : ""));
  if (load) F("The whole computer right now: CPU " + load.cpuPct + " %, disk busy " + load.diskPct + " %, disk queue " + load.diskQueue);
  if (net) F("Network: IT computer " + (net.itComputerMs == null ? "no answer" : net.itComputerMs + " ms") + ", internet " + (net.internetMs == null ? "no answer" : net.internetMs + " ms") + ", name lookup " + (net.dnsMs == null ? "no answer" : net.dnsMs + " ms"));
  F("Memory now: " + gb(hw.ramTotalMB - hw.ramFreeMB) + " used of " + gb(hw.ramTotalMB) + " (" + gb(hw.ramFreeMB) + " free)" + (mem && mem.commitLimitMB ? "; commit " + gb(mem.commitLimitMB - mem.commitFreeMB) + " of " + gb(mem.commitLimitMB) : ""));
  if (others.openApps && others.openApps.length) F("Apps open (" + others.openApps.length + ", as in Task Manager > Apps): " + others.openApps.map((p) => p.name + (p.processes > 1 ? " (" + p.processes + " processes)" : "") + " " + p.workingSetMB + " MB").join(", "));
  if (others.startupPrograms && others.startupPrograms.length) F("Start with Windows (" + others.startupPrograms.length + "): " + others.startupPrograms.join(", "));
  if (others.openApps && others.openApps.length >= 12 && hw.ramTotalMB && hw.ramTotalMB <= 8200) find("MEDIUM", "Many programs open on a small-memory PC", others.openApps.length + " programs have a window open on " + gb(hw.ramTotalMB) + " of RAM: " + others.openApps.slice(0, 6).map((p) => p.name).join(", ") + "...");
  if (wf.errors) F("Windows facts that failed: " + Object.entries(wf.errors).map(([k, v]) => k + " = " + v).join("; "));
  if (others.topCpu && others.topCpu.length) F("Using the CPU now: " + others.topCpu.slice(0, 5).map((p) => p.name + " " + p.cpuOfOneCore + "%").join(", "));
  F("PBCalc state: " + (r.appState ? r.appState.tabs + " tabs, " + r.appState.discarded + " freed by the memory saver" : "?") + "  -  startup (ms since launch): " + JSON.stringify(r.startupMs));
  if (r.note) F("USER NOTE: " + r.note);

  // ── the last session ended badly ──
  const prev = r.previousSession;
  if (prev) {
    const last = (prev.recent || [])[(prev.recent || []).length - 1] || {};
    const detail = "It started " + prev.startedAt + ", was last seen " + prev.lastSeen + " (ran " + Math.round((prev.ranSec || 0) / 60) + " min, " + prev.tabs + " tabs). Its last sample: free RAM " + (last.freeMB != null ? gb(last.freeMB) : "?") + ", whole-PC CPU " + last.sysCpu + " %, main timer " + last.lagMs + " ms late, " + (last.pages || []).length + " page(s)" + ((last.pages || []).length ? " (largest " + Math.max(...last.pages.map((x) => x.mb)) + " MB)" : "") + ".";
    if (prev.quitWasRequested) find("LOW", "The last session was closed normally but did not finish cleaning up", detail);
    else find("HIGH", "PBCalc ended abnormally last time (killed, crashed, or the PC was reset)", detail + (last.freeMB != null && last.freeMB < 500 ? " Memory had almost run out." : "") + (last.lagMs >= 1000 ? " The program had been frozen." : "") + ((prev.exceptions || []).length ? " Errors: " + prev.exceptions.map((e) => e.message).join(" | ") : ""));
  }

  // ── memory ──
  const free = recent.map((s) => s.freeMB).filter((x) => x != null);
  const minFree = free.length ? Math.min(...free) : hw.ramFreeMB;
  // "free" RAM does not count the cache Windows gives back at once, so a low free figure alone is NOT proof of a shortage: the real signs are "available" memory and hard page faults (Windows reading memory back from the disk)
  const av = (r.memory && r.memory.available) || null;
  const swapping = !!(av && (av.pagesInPerSec >= 300 || av.pageReadsPerSec >= 100));
  const lowAvail = !!(av && hw.ramTotalMB && av.availableMB < Math.max(600, hw.ramTotalMB * 0.1));
  const lowFree = hw.ramTotalMB && minFree < Math.max(600, hw.ramTotalMB * 0.1);
  if (av) F("Memory Windows could give a program right now: " + gb(av.availableMB) + " available; swapping to the disk: " + (swapping ? "YES (" + av.pagesInPerSec + " pages/s read back)" : "no (" + av.pagesInPerSec + " pages/s)") + "; commit in use " + av.commitPct + " %");
  if (lowFree && av && !lowAvail && !swapping) find("LOW", "Free RAM is low but Windows has memory to spare", "Free " + gb(minFree) + " of " + gb(hw.ramTotalMB) + ", but " + gb(av.availableMB) + " is available (the rest is cache that Windows hands back at once) and it is not swapping. Not a shortage right now." + (others.openApps && others.openApps.length ? " Open apps by memory: " + others.openApps.slice(0, 5).map((p) => p.name + " " + p.workingSetMB + " MB").join(", ") + "." : ""));
  else if (lowFree && (!av || lowAvail || swapping)) find(av || minFree < Math.max(600, hw.ramTotalMB * 0.04) ? "HIGH" : "MEDIUM", "The computer is short of memory" + (av ? "" : " (not confirmed: no 'available memory' figure in this report)"), "Free RAM fell to " + gb(minFree) + " of " + gb(hw.ramTotalMB) + (av ? ", available " + gb(av.availableMB) + (swapping ? ", and Windows is swapping" : "") : "") + ": Windows has to use the disk for memory (everything stutters). Close other programs, or add RAM." + (others.openApps && others.openApps.length ? " Open apps by memory: " + others.openApps.slice(0, 6).map((p) => p.name + " " + p.workingSetMB + " MB").join(", ") + "." : ""));
  else if (hw.ramTotalMB && hw.ramTotalMB <= 8192 && minFree < 1500 && !(av && av.availableMB > 2000)) find("MEDIUM", "Memory is tight", "Only " + gb(minFree) + " free of " + gb(hw.ramTotalMB) + " at the lowest point.");
  if (mem && mem.commitLimitMB && (mem.commitLimitMB - mem.commitFreeMB) / mem.commitLimitMB >= 0.9) find("HIGH", "Windows is nearly out of memory (commit)", gb(mem.commitLimitMB - mem.commitFreeMB) + " of " + gb(mem.commitLimitMB) + " promised: programs start failing or crash. Add RAM / enlarge the page file / close programs.");
  if (pf && pf.some((x) => x.sizeMB && x.usedMB / x.sizeMB >= 0.8)) find("MEDIUM", "The page file is almost full", pf.map((x) => x.usedMB + " of " + x.sizeMB + " MB").join(", "));
  const lastP = recent.length ? recent[recent.length - 1].procs || {} : {};
  const ours = Object.values(lastP).reduce((a, p) => a + (p.privMB || 0), 0);
  if (ours) F("PBCalc's own private memory in the last sample: " + ours + " MB in " + Object.values(lastP).reduce((a, p) => a + p.n, 0) + " processes");
  if (ours > 1500) find("MEDIUM", "PBCalc itself uses a lot of memory", ours + " MB: many or heavy tabs. The memory saver frees idle tabs after 30 minutes.");
  // a page that keeps growing = a leak in that page (it is named by its position in the strip, never by its address)
  const siteOfTab = (pg) => { for (let i = recent.length - 1; i >= 0; i--) { const q = (recent[i].pages || []).find((x) => x.p === Number(pg)); if (q && q.host) return q.host; } return ""; };
  const growth = {};
  recent.forEach((s, i) => (s.pages || []).forEach((p) => { (growth[p.p] = growth[p.p] || []).push({ i, mb: p.mb }); }));
  Object.entries(growth).forEach(([pg, arr]) => { if (arr.length >= 12) { const a = arr[0].mb, b = arr[arr.length - 1].mb; if (b - a >= 300 && b >= a * 1.5) find("MEDIUM", "Tab " + pg + " keeps growing" + (siteOfTab(pg) ? " (" + siteOfTab(pg) + ")" : ""), a + " MB -> " + b + " MB within " + Math.round(arr.length * 5 / 60) + " min: a page that leaks memory."); } });

  // ── graphics / session ──
  const soft = gf.gpu_compositing !== "enabled" || gf.rasterization !== "enabled";
  const onlyBasic = (hw.gpu || []).length > 0 && !(hw.gpu || []).some((g) => g.active && !/basic render/i.test(g.name || ""));
  if (soft || onlyBasic) find("HIGH", "Pages are drawn by the processor, not the graphics card", "gpu_compositing=" + gf.gpu_compositing + ", rasterization=" + gf.rasterization + (onlyBasic ? ", only 'Microsoft Basic Render Driver' is active" : "") + ". Usually a missing or old graphics driver (or a remote-desktop session). Install the manufacturer's driver.");
  if (/^(RDP|ICA|Citrix)/i.test(w.sessionType || "")) find("HIGH", "PBCalc runs inside a remote session (" + w.sessionType + ")", "Remote sessions have no real graphics card: everything is drawn in software and sent over the network.");
  if (gf.video_decode && gf.video_decode !== "enabled") F("Video decoding: " + gf.video_decode + " (PBCalc decodes video with the processor by design)");

  // ── the main program blocked ──
  const lag = recent.reduce((m, s) => Math.max(m, s.lagMs || 0), 0);
  if (lag >= 1000) find("HIGH", "PBCalc's main program froze", "Its timer ran " + lag + " ms late: the window could not react for that long.");
  else if (lag >= 200) find("MEDIUM", "PBCalc's main program was blocked briefly", "Timer " + lag + " ms late at worst.");

  // ── CPU: PBCalc against the rest of the computer ──
  if (recent.length >= 3) {
    const avg = (key) => recent.reduce((a, s) => a + Object.entries(s.procs || {}).filter(([k]) => k === key).reduce((x, [, p]) => x + p.cpu, 0), 0) / recent.length;
    const all = recent.reduce((a, s) => a + Object.values(s.procs || {}).reduce((x, p) => x + p.cpu, 0), 0) / recent.length;
    const busy = (all * threads) / 100;
    const sysList = recent.map((s) => s.sysCpu).filter((x) => x != null);
    const sysAvg = sysList.length ? sysList.reduce((a, b) => a + b, 0) / sysList.length : null;
    F("PBCalc's average CPU over the last " + Math.round(recent.length * 5 / 60 * 10) / 10 + " min: " + all.toFixed(1) + "% of the computer = " + busy.toFixed(2) + " cores busy (pages " + avg("Tab").toFixed(1) + "%, graphics " + avg("GPU").toFixed(1) + "%)" + (sysAvg != null ? "; the WHOLE computer averaged " + sysAvg.toFixed(0) + " %" : ""));
    if (busy >= 1.5 || all >= 40) find("HIGH", "PBCalc keeps the processor busy", busy.toFixed(1) + " cores busy on average (pages " + avg("Tab").toFixed(1) + "%, graphics " + avg("GPU").toFixed(1) + "%). A page that keeps working in the background, or a video.");
    else if (busy >= 0.6) find("MEDIUM", "PBCalc uses a noticeable part of the processor", busy.toFixed(2) + " cores busy on average.");
    if (sysAvg != null && sysAvg >= 70 && all < sysAvg * 0.3) find("HIGH", "Something ELSE is using the processor", "The whole computer averaged " + sysAvg.toFixed(0) + " % but PBCalc only " + all.toFixed(1) + " %." + (others.topCpu && others.topCpu.length ? " Busiest now: " + others.topCpu.slice(0, 4).map((p) => p.name + " " + p.cpuOfOneCore + "%").join(", ") + "." : ""));
    if (threads <= 2 && busy >= 0.4) find("MEDIUM", "A very small processor (" + threads + " threads)", hw.cpuModel + ": even light pages take a large share.");
  }
  if (load && load.cpuPct >= 85) find("MEDIUM", "The processor was nearly full when the report was made", load.cpuPct + " %.");
  if (load && (load.diskPct >= 80 || load.diskQueue >= 2)) find("HIGH", "The disk is the bottleneck", "Disk busy " + load.diskPct + " %, queue " + load.diskQueue + ": programs wait for the disk (a hard disk, antivirus scanning, or a big copy / update running).");

  // ── network and slow pages ──
  if (net) {
    if (net.internetMs == null && net.itComputerMs != null) find("MEDIUM", "No internet answer, but the office network answers", "Pages outside the office may not load.");
    else if (net.internetMs != null && net.internetMs > 400) find("MEDIUM", "The internet connection is slow", net.internetMs + " ms just to open a connection.");
    if (net.dnsMs != null && net.dnsMs > 500) find("MEDIUM", "Name lookup is slow", net.dnsMs + " ms: the DNS server answers slowly, every new site waits.");
    if (net.itComputerMs != null && net.itComputerMs > 100) find("LOW", "The office network is slow", "The IT computer needed " + net.itComputerMs + " ms to answer.");
  }
  const loads = (r.pageLoads || []).map((x) => x.ms);
  { const by = {}; (r.pageLoads || []).forEach((x) => { if (x.host) (by[x.host] = by[x.host] || []).push(x.ms); });
    const slowHosts = Object.entries(by).filter(([, a]) => a.length >= 2 && median(a) >= 5000).sort((x, y) => median(y[1]) - median(x[1])).slice(0, 5);
    if (slowHosts.length) find("MEDIUM", "Slow sites", slowHosts.map(([h, a]) => h + " (median " + (median(a) / 1000).toFixed(1) + " s, " + a.length + " loads)").join("; ")); }
  (r.events || []).filter((e) => e.host).forEach((e) => find("LOW", "Site involved in " + e.kind, e.host + " at " + e.at)); 
  if (loads.length >= 3) {
    F("Page loads: " + loads.length + ", median " + (median(loads) / 1000).toFixed(1) + " s, slowest 10% over " + (pct(loads, 0.9) / 1000).toFixed(1) + " s");
    if (pct(loads, 0.9) >= 8000) find("MEDIUM", "Pages take a long time to load", "Median " + (median(loads) / 1000).toFixed(1) + " s, the slowest tenth " + (pct(loads, 0.9) / 1000).toFixed(1) + " s." + ((net && (net.internetMs == null || net.internetMs <= 400) && (!load || load.cpuPct < 80)) ? " The computer and the network look fine, so the SITE itself is probably slow." : ""));
  }

  // ── start-up and disk ──
  const ready = r.startupMs && r.startupMs.windowVisible;
  const sm = r.startupMs || {};
  if (sm.windowCreated != null) F("Start-up steps (s after launch): " + ["appReady", "windowCreated", "shellStartLoading", "shellDomReady", "shellFinishLoad", "calcReady", "windowReadyToShow", "windowVisible"].filter((k) => sm[k] != null).map((k) => k + " " + (sm[k] / 1000).toFixed(1)).join(" > "));
  if (wf.defender) F("Windows Defender: real-time protection " + (wf.defender.realTime ? "ON" : "off") + (wf.defender.scanning ? ", a SCAN IS RUNNING" : ", no scan running"));
  if (ready && ready > 8000) {
    // name the step that took the time (only when the report has the steps), and say what else was busy
    const steps = ["appReady", "windowCreated", "shellStartLoading", "shellDomReady", "shellFinishLoad", "windowReadyToShow", "windowVisible"].filter((k) => sm[k] != null);
    let worst = null; for (let i = 1; i < steps.length; i++) { const d = sm[steps[i]] - sm[steps[i - 1]]; if (!worst || d > worst.d) worst = { d, from: steps[i - 1], to: steps[i] }; }
    const busy = (others.topCpu || []).filter((p) => p.cpuOfOneCore >= 50 && !/^PBCalc$/i.test(p.name)).map((p) => p.name + " " + p.cpuOfOneCore + "%");
    find("MEDIUM", "PBCalc was slow to open", "The window was visible " + (ready / 1000).toFixed(1) + " s after launch." + (worst && worst.d >= 3000 ? " Most of it (" + (worst.d / 1000).toFixed(1) + " s) passed between '" + worst.from + "' and '" + worst.to + "'." : " (This report has no finer steps: it comes from an older PBCalc.)") + (busy.length ? " Busy at that moment: " + busy.join(", ") + "." : "") + (wf.defender && wf.defender.scanning ? " Windows Defender was scanning." : "") + " Typical causes: antivirus scanning a freshly installed / updated program, a slow disk, or Windows' own background jobs (CompatTelRunner, Windows Update, indexing).");
  }
  if (Array.isArray(st.disks) && st.disks.some((d) => /HDD/i.test(d))) find("MEDIUM", "A hard disk (HDD)", "Disks: " + st.disks.join(", ") + ". Starting and loading is slow on a hard disk compared with an SSD.");
  if (typeof st.dataFolderFreeGB === "number" && st.dataFolderFreeGB < 2) find("HIGH", "The disk is almost full", st.dataFolderFreeGB + " GB free.");
  if (Array.isArray(wf.antivirus) && wf.antivirus.some((a) => !/defender/i.test(a))) find("LOW", "A third-party antivirus is running", wf.antivirus.join(", ") + ": it may scan every file PBCalc reads or writes. Try adding the PBCalc folder to its exceptions.");
  if (hw.onBattery) find("LOW", "On battery power", "Windows may slow the processor down" + (wf.powerPlan ? " (power plan: " + wf.powerPlan + ")" : "") + ".");

  // ── problems ──
  const ev = Array.isArray(r.events) ? r.events : [];
  const crashes = ev.filter((e) => e.kind === "render-process-gone"), hangs = ev.filter((e) => e.kind === "unresponsive");
  if (crashes.length) find("HIGH", crashes.length + " page process(es) crashed", crashes.map((e) => e.reason + " at " + e.at).join("; ") + (crashes.some((e) => e.reason === "oom") ? " - out of memory." : ""));
  if (hangs.length) find("HIGH", hangs.length + " 'not responding' event(s)", hangs.map((e) => e.type + " at " + e.at).join("; "));
  const gone = ev.filter((e) => e.kind === "child-process-gone");
  if (gone.length) find("MEDIUM", gone.length + " helper process(es) ended unexpectedly", gone.map((e) => e.type + ": " + e.reason).join("; "));
  const exc = Array.isArray(r.exceptions) ? r.exceptions : [];
  if (exc.length) find("MEDIUM", exc.length + " error(s) inside PBCalc's main program", exc.slice(-3).map((e) => e.origin + ": " + e.message).join(" | "));
  (wf.pbcalcEvents || []).slice(0, 4).forEach((e) => {
    const code = String(e.code || "").replace(/^0x/i, "").toLowerCase();
    const meaning = CODES[code] ? " - " + CODES[code] : "";
    const gpuModule = /^(nv|amd|ati|ig|aticfx|d3d|dxgi|vk_|libgles|libegl)/i.test(e.module || "");
    const what = e.module ? "faulting module " + e.module + (gpuModule ? " (a graphics driver / graphics component)" : "") + (e.code ? ", exception code " + e.code + meaning : "") + "." : (e.id === 1002 ? "The program (" + (e.app || "PBCalc") + ") stopped responding to Windows and was closed or waited for." : "The program (" + (e.app || "PBCalc") + ") was stopped by Windows" + (e.code ? ", exception code " + e.code + meaning : "") + ".");
    find(e.id === 1002 ? "MEDIUM" : "HIGH", "Windows logged a PBCalc " + (e.id === 1002 ? "hang" : "crash") + " on " + e.at, what);
  });
  if (wf.unavailable) find("LOW", "Windows' own facts are missing from this report", "The memory / disk / program list and the Event Log could not be read (PowerShell blocked or too slow on that computer)." + (wf.errors ? " Reason: " + Object.entries(wf.errors).map(([k, v]) => k + " = " + v).join("; ") : "") + " The rest of the report is complete.");
  if (!out.findings.length) find("INFO", "Nothing stands out", "No memory shortage, no software drawing, no freezes, no crashes in what was recorded. If it still feels slow, ask when it happens and ask for a report at that moment (the last 10 minutes are recorded).");
  return out;
}

function print(r) {
  const a = analyse(r);
  console.log("== FACTS");
  a.facts.forEach((f) => console.log("  " + f));
  console.log("\n== FINDINGS");
  a.findings.forEach((f) => console.log("  [" + f.level + "] " + f.title + "\n         " + f.detail));
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node diagnose-report.js <report.json>"); process.exit(2); }
  print(JSON.parse(fs.readFileSync(file, "utf8")));
}
module.exports = { analyse, print };
