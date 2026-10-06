// Audit of PBCalc's own UI: cursor, hover feedback and hover contrast, in light AND dark, on every surface.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/audit-ui-states.js
//   (add PBCALC_AUDIT_JSON=<file> to also write the raw findings)
//
// "Interactive" = semantic controls (button, a[href], inputs, select, role=...) PLUS anything a stylesheet gives a
// :hover rule (hover styling means somebody meant it to be clicked). For each one, per theme:
//   cursor    : must be `pointer` (disabled controls and text fields are exempt)
//   feedback  : moving the pointer onto it must change SOMETHING visible (its own or a nearby ancestor's/descendant's
//               background, colour, border, shadow, opacity, filter, decoration, outline, transform)
//   contrast  : text colour vs the effective background IN THE HOVER STATE must stay >= 3:1
//   direction : hover must not wash the element out (contrast must not drop by more than a third)
//   visible   : the change must be big enough to see (a background nudge of a few RGB steps is not feedback)
// Hover is driven with synthetic mouse events (webContents.sendInputEvent), so it is safe while the PC is in use.
const { app, nativeTheme, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-audit-ui-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 900000).unref();
// executeJavaScript with a deadline: a view that never answers must not hang the whole audit
const ex = (wc, code, ms = 4000) => Promise.race([wc.executeJavaScript(code), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    if (req.url.startsWith("/dl")) {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="audit.bin"');
      res.setHeader("content-length", "2048");
      return res.end(Buffer.alloc(2048, 1));
    }
    if (req.url.startsWith("/complete")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(["a", ["a one", "a two", "a three"], [], [], {}])); }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Audit page</title>page " + req.url);
  });
  srv.listen(0, "127.0.0.1", () => {
    base = "http://127.0.0.1:" + srv.address().port;
    process.env.PBCALC_SUGGEST_URL = base + "/complete/search";
    resolve();
  });
});

require("../electron/main.js");

// ── code that runs INSIDE each page ─────────────────────────────────────────────────────────────────────────
const PAGE_COLLECT = (extra) => `(() => {
  // the shell is the SAME document for every pass (normal, then Restricted Mode, light, then dark): clear the stamps
  // of the previous pass, or a stale one on a now-hidden element answers for a new element with the same number
  document.querySelectorAll("[data-audit-id]").forEach((n) => n.removeAttribute("data-audit-id"));
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
  document.head.appendChild(style);
  // anything a stylesheet gives a :hover rule is meant to be clicked
  const hoverSel = [];
  const walk = (rules) => { for (const r of rules) {
    if (r.cssRules && !r.selectorText) walk(r.cssRules);
    else if (r.selectorText && r.selectorText.includes(":hover")) for (const part of r.selectorText.split(",")) {
      if (!part.includes(":hover") || /:not\\(\\s*:hover/.test(part)) continue;
      // the element that is hovered is the compound holding :hover; whatever follows it is only RESTYLED by the
      // hover (".tab:hover .tab-sep"), and is not itself something to click
      let depth = 0, j = part.indexOf(":hover");
      for (; j < part.length; j++) { const ch = part[j]; if (ch === "(") depth++; else if (ch === ")") depth--; else if (depth === 0 && /[\\s>+~]/.test(ch)) break; }
      hoverSel.push(part.slice(0, j).replace(/:hover/g, "").trim());
    }
  } };
  for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (_) { continue; } walk(rules); }
  const semantic = 'button, a[href], input[type=checkbox], input[type=radio], input[type=button], input[type=submit], select, summary, [role=button], [role=menuitem], [role=switch], [role=tab], [onclick], [tabindex]:not([tabindex="-1"])';
  const set = new Set(document.querySelectorAll(semantic));
  for (const s of ${JSON.stringify(extra || [])}) document.querySelectorAll(s).forEach((e) => set.add(e));
  for (const s of hoverSel) { if (!s) continue; try { document.querySelectorAll(s).forEach((e) => set.add(e)); } catch (_) {} }
  const out = []; let id = 0;
  const label = (e) => { const t = (e.getAttribute("title") || e.getAttribute("aria-label") || e.innerText || e.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 28); return e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + (t ? ' "' + t + '"' : ""); };
  for (const e of set) {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    if (r.width < 2 || r.height < 2 || cs.visibility === "hidden" || cs.display === "none" || e.closest("[hidden]")) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    e.setAttribute("data-audit-id", String(id));
    out.push({ aid: id++, label: label(e), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), cursor: cs.cursor, disabled: !!e.disabled || e.getAttribute("aria-disabled") === "true", tag: e.tagName.toLowerCase(), type: e.type || "", domId: e.id || "", cls: typeof e.className === "string" ? e.className : "", textContainer: !!e.querySelector("input:not([type=checkbox]):not([type=radio]),textarea,select"), selected: e.matches('.active,.selected,.on,.current,.checked,[aria-pressed="true"],[aria-selected="true"],[aria-checked="true"]'), pe: cs.pointerEvents });
  }
  return out;
})()`;

// snapshot of the visual properties of an element and its neighbours (3 ancestors, up to 6 descendants)
const PAGE_SNAPSHOT = (id) => `(() => {
  const el = document.querySelector('[data-audit-id="${id}"]'); if (!el) return null;
  const props = ["backgroundColor", "color", "borderTopColor", "boxShadow", "opacity", "filter", "textDecorationLine", "outlineColor", "transform", "fill", "stroke"];
  const grab = (e) => { const cs = getComputedStyle(e); const o = {}; for (const p of props) o[p] = cs[p]; return o; };
  const near = []; let a = el; for (let i = 0; i < 4 && a && a !== document.documentElement; i++, a = a.parentElement) near.push(a);
  const kids = [...el.querySelectorAll("*")].slice(0, 6);
  const parse = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ""); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  // effective background: composite ancestors down to the first (nearly) opaque one
  const effBg = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; } } let base = { r: 255, g: 255, b: 255 }; if (!layers.length || layers[layers.length - 1].a < 0.99) { const dark = matchMedia("(prefers-color-scheme: dark)").matches; base = dark ? { r: 32, g: 32, b: 32 } : { r: 255, g: 255, b: 255 }; } let cur = base; for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; cur = { r: l.r * l.a + cur.r * (1 - l.a), g: l.g * l.a + cur.g * (1 - l.a), b: l.b * l.a + cur.b * (1 - l.a) }; } return cur; };
  const hasText = (el.innerText || "").trim().length > 0 || el.tagName === "INPUT" || el.tagName === "SELECT";
  const rc = el.getBoundingClientRect(); const topEl = document.elementFromPoint(Math.round(rc.left + rc.width / 2), Math.round(rc.top + rc.height / 2)); const topDesc = topEl ? topEl.tagName.toLowerCase() + (topEl.id ? '#' + topEl.id : '') + (typeof topEl.className === 'string' && topEl.className ? '.' + topEl.className.trim().split(/\s+/)[0] : '') : 'nothing (outside the viewport?)'; return { hovered: el.matches(":hover"), covered: topEl && !(topEl === el || el.contains(topEl)) ? topDesc : null, box: Math.round(rc.width) + 'x' + Math.round(rc.height), hiddenBy: (() => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n); if (c.display === 'none') return (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/)[0] : '')) + ' has display:none'; if (c.visibility === 'hidden') return n.tagName.toLowerCase() + ' has visibility:hidden'; } return null; })(), self: grab(el), near: near.map(grab), kids: kids.map(grab), bg: effBg(el), fg: parse(getComputedStyle(el).color), hasText, svg: !!el.querySelector("svg") || el.tagName === "svg" };
})()`;

const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const parseC = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ""); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };

function diffSnap(a, b) {
  // list the properties that changed between the idle and hover snapshots (own, ancestors, descendants)
  const changed = []; let bgDelta = 0;
  const cmp = (x, y, where) => { for (const k of Object.keys(x)) if (x[k] !== y[k]) {
    changed.push(where + "." + k);
    if (k === "backgroundColor") { const p = parseC(x[k]), q = parseC(y[k]); if (p && q) bgDelta = Math.max(bgDelta, Math.abs(p.r - q.r) + Math.abs(p.g - q.g) + Math.abs(p.b - q.b) + Math.abs(p.a - q.a) * 255); }
  } };
  cmp(a.self, b.self, "self");
  a.near.forEach((x, i) => b.near[i] && cmp(x, b.near[i], "up" + i));
  a.kids.forEach((x, i) => b.kids[i] && cmp(x, b.kids[i], "kid" + i));
  return { changed, bgDelta };
}

// Has this element got class `c`? (the audit sees class lists as plain strings)
const hasCls = (list, c) => (" " + list + " ").includes(" " + c + " ");

async function auditSurface(name, wc, theme, findings, stats, extra, onlyDomId) {
  if (process.env.PBCALC_AUDIT_ONLY && !name.includes(process.env.PBCALC_AUDIT_ONLY)) return;   // focus on one surface
  console.log("   ... " + name + " [" + theme + "]");
  const collect = () => ex(wc, PAGE_COLLECT(extra)).catch((e) => { console.log("   (could not collect " + name + ": " + e.message + ")"); return []; });
  let els = await collect();
  // a 0x0 viewport means the window was minimised/hidden (the PC is in use): bring it back and look again, never judge it
  for (let k = 0; k < 3 && !els.length; k++) {
    const area = await ex(wc, "innerWidth * innerHeight").catch(() => 0);
    if (area > 0) break;
    const w = require("../electron/state").mainWindow;
    if (w.isMinimized()) w.restore();
    w.show(); w.focus(); await sleep(1200);
    els = await collect();
  }
  if (onlyDomId) { for (let i = els.length - 1; i >= 0; i--) if (els[i].domId !== onlyDomId) els.splice(i, 1); }
  if (!els.length) {
    const why = await ex(wc, "document.readyState + ' | ' + location.href.replace(/^file:.*[/]/, '') + ' | buttons=' + document.querySelectorAll('button').length + ' | body=' + (document.body ? document.body.innerText.length : 'none') + ' | viewport=' + innerWidth + 'x' + innerHeight").catch((e) => "(" + e.message + ")");
    console.log("   " + name.padEnd(30) + theme.padEnd(6) + " 0 interactive elements found  [" + why + "]");
    return;
  }
  // where the element is NOW (layout moves: tabs animate, bookmarks re-render, the window can resize)
  const centre = (aid) => ex(wc, `(() => { const e = document.querySelector('[data-audit-id="${aid}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`).catch(() => null);
  const snap0 = (aid) => ex(wc, PAGE_SNAPSHOT(aid)).catch(() => null);
  // A snapshot of a SETTLED state: hover colours fade in over ~175ms, and a reading taken halfway is neither the
  // idle nor the hover look (it made the downloads button's real, clearly visible hover read as "barely visible").
  // Read until two consecutive readings agree.
  const sig = (x) => x && JSON.stringify([x.self, x.kids, x.near, x.hovered]);
  const snap = async (aid) => {
    let prev = await snap0(aid);
    for (let i = 0; i < 8 && prev; i++) {
      await sleep(50);
      const cur = await snap0(aid);
      if (!cur) return prev;
      if (sig(cur) === sig(prev)) return cur;
      prev = cur;
    }
    return prev;
  };
  const away = async () => { wc.sendInputEvent({ type: "mouseLeave", x: 0, y: 0 }); await sleep(90); };

  // One trial: idle snapshot (pointer away), then hover it, re-reading its position first.
  //   -> { status: "ok" | "inconclusive" | "unreachable" | "gone", idle, hov }
  const trial = async (e) => {
    await away();
    const idle = await snap(e.aid);
    if (!idle) return { status: "gone" };
    // the REAL mouse can be sitting on this element even after our mouseLeave; then idle == hover and nothing
    // can be judged. That is not a defect in the UI, so say "inconclusive" and let the caller retry.
    if (idle.hovered) return { status: "inconclusive" };
    const c = await centre(e.aid);
    if (!c) return { status: "gone" };
    wc.sendInputEvent({ type: "mouseMove", x: c.x, y: c.y });
    await sleep(45);
    let hov = await snap(e.aid);
    if (hov && !hov.hovered) for (const [dx, dy] of [[1, 0], [-1, 1], [0, -1]]) { wc.sendInputEvent({ type: "mouseMove", x: c.x + dx, y: c.y + dy }); await sleep(50); hov = await snap(e.aid); if (hov && hov.hovered) break; }
    if (!hov) return { status: "gone" };
    if (!hov.hovered) return { status: "unreachable", idle, hov, covered: hov.covered, box: hov.box, hiddenBy: hov.hiddenBy, c };
    return { status: "ok", idle, hov };
  };

  let nCursor = 0, nFeedback = 0, nContrast = 0, nDirection = 0, nFaint = 0, nUnreach = 0, nInconclusive = 0;
  for (const e of els) {
    const tag = `[${theme}] ${name}: ${e.label} (${e.w}x${e.h})`;
    const textField = e.tag === "input" && /^(text|search|url|email|password|number)$/.test(e.type);
    // NOT clickable, whatever its hover rules say: clicking the Restricted-Mode lock does nothing, so a pointer and a
    // hover would lie; a text field's wrapper is not a button (the field keeps its own cursor).
    const indicator = e.domId === "unlock";
    // a row that only HOSTS clickable things does nothing itself: the zoom row (its buttons act) and a download row that
    // is not finished yet (only a finished one opens when clicked)
    const hostRow = hasCls(e.cls, "zoom-row") || (hasCls(e.cls, "dl-row") && !hasCls(e.cls, "openable"));
    // 1. cursor
    if (!(e.disabled || textField || e.textContainer || indicator || hostRow || e.pe === "none") && e.cursor !== "pointer") { nCursor++; findings.push({ rule: "cursor", where: tag, detail: "cursor is `" + e.cursor + "`, not pointer" }); }
    if (e.disabled || indicator || e.pe === "none") continue;

    // 2..5. hover. A problem is only REPORTED when three fresh trials all show it (a stolen focus, a moving layout or
    // the owner's real pointer can spoil one); a trial that cannot be judged is retried, then counted as inconclusive.
    const feedbackExempt = e.selected || hostRow || hasCls(e.cls, "switch") || (e.domId === "omnibox" && theme === "dark");
    let verdict = null, keep = null, tries = 0, inconclusiveRuns = 0;
    while (tries < 3 && !(verdict === "ok")) {
      tries++;
      const t = await trial(e);
      if (t.status === "inconclusive") { inconclusiveRuns++; await sleep(150); continue; }
      if (t.status === "gone") { verdict = "gone"; break; }
      if (t.status === "unreachable") { verdict = "unreachable"; keep = t; continue; }
      const { changed, bgDelta } = diffSnap(t.idle, t.hov);
      const noFeedback = !changed.length && !feedbackExempt;
      const faint = !noFeedback && changed.length > 0 && changed.every((c) => c.endsWith(".backgroundColor")) && bgDelta > 0 && bgDelta < 14;
      let contrastBad = false, washed = false, cH = 0, cI = 0;
      if (t.hov.hasText && t.hov.fg) {
        const fg = t.hov.fg; cH = contrast({ r: fg.r, g: fg.g, b: fg.b }, t.hov.bg);
        const fb = t.idle.fg || fg; cI = contrast({ r: fb.r, g: fb.g, b: fb.b }, t.idle.bg);
        contrastBad = cH < 3; washed = !contrastBad && cH < 4.5 && cH < cI * 0.67;
      }
      if (process.env.PBCALC_AUDIT_VERBOSE && e.label.includes(process.env.PBCALC_AUDIT_VERBOSE)) console.log("      VERBOSE " + tag + " try " + tries + ": bg " + t.idle.self.backgroundColor + " -> " + t.hov.self.backgroundColor + " | changed=" + changed.join(",") + " bgDelta=" + bgDelta.toFixed(0) + " contrast " + cI.toFixed(2) + " -> " + cH.toFixed(2));
      keep = { noFeedback, faint, contrastBad, washed, cH, cI, changed, bgDelta };
      verdict = (noFeedback || faint || contrastBad || washed) ? "problem" : "ok";
    }
    if (verdict === "ok" || verdict === "gone") continue;
    if (!verdict) { nInconclusive++; findings.push({ rule: "inconclusive", where: tag, detail: "the real mouse pointer was over it every time (not a UI defect; run again with the mouse elsewhere)" }); continue; }
    if (verdict === "unreachable") { nUnreach++; findings.push({ rule: "unreachable", where: tag, detail: "the pointer on its centre does not hover it in 3 tries; at that point the page has: " + (keep.covered || "the element itself (so the hover just did not register)") + " | box " + keep.box + (keep.hiddenBy ? " | " + keep.hiddenBy : "") + " [centre " + (keep.c ? keep.c.x + "," + keep.c.y : "?") + "]" }); continue; }
    if (keep.noFeedback) { nFeedback++; findings.push({ rule: "feedback", where: tag, detail: "no visible change when hovered (3 trials)" }); }
    if (keep.faint) { nFaint++; findings.push({ rule: "visible", where: tag, detail: "hover only nudges the background by " + keep.bgDelta.toFixed(0) + " (barely visible); changed " + keep.changed.join(",") }); }
    if (keep.contrastBad) { nContrast++; findings.push({ rule: "contrast", where: tag, detail: "hover contrast " + keep.cH.toFixed(2) + ":1 (idle " + keep.cI.toFixed(2) + ":1)" }); }
    if (keep.washed) { nDirection++; findings.push({ rule: "direction", where: tag, detail: "hover washes it out: contrast " + keep.cI.toFixed(2) + " -> " + keep.cH.toFixed(2) }); }
  }
  wc.sendInputEvent({ type: "mouseLeave", x: 0, y: 0 });
  stats.push({ name, theme, n: els.length, nCursor, nFeedback, nContrast, nDirection, nFaint, nUnreach, nInconclusive });
  console.log("   " + name.padEnd(30) + theme.padEnd(6) + String(els.length).padStart(4) + " elements | cursor:" + nCursor + "  no-feedback:" + nFeedback + "  low-contrast:" + nContrast + "  washed-out:" + nDirection + "  faint:" + nFaint + "  unreachable:" + nUnreach + "  inconclusive:" + nInconclusive);
}

app.whenReady().then(async () => {
  await ready;
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const popup = require("../electron/popup");
  const dm = require("../electron/downloads/downloadManager");
  const bm = require("../electron/bookmarks/bookmarkStore");
  const win = state.mainWindow;
  win.show(); win.focus(); await sleep(400);
  session.fromPartition(constants.TAB_PARTITION).on("will-download", (_e, item) => item.setSavePath(path.join(tmp, "dl-" + Date.now() + "-" + item.getFilename())));
  const findings = [], stats = [];
  const activeWc = () => state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
  const popupWc = () => win.getBrowserViews().pop().webContents;
  // a page can only be hovered once its view is attached and sized (a 0x0 viewport = still being shown)
  const pageReady = async () => { for (let i = 0; i < 60; i++) { const w = await ex(activeWc(), "innerWidth * innerHeight").catch(() => 0); if (w > 0) break; await sleep(100); } win.show(); win.focus(); await sleep(400); };
  const closeAll = async () => { popup.close(); await sleep(250); while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id); await sleep(300); };

  // set the app up so every surface has something in it
  for (const [t, u] of [["Example", "https://example.com/"], ["Docs", "https://docs.example.org/"], ["Mail", "https://mail.example.net/"]]) bm.toggle({ url: u, title: t, favicon: "" });
  // the bookmarks bar must really be showing the items (toggling blindly can HIDE it)
  const barItems = () => win.webContents.executeJavaScript('document.querySelectorAll(".bookmark").length').catch(() => 0);
  win.webContents.send("bookmarks:changed", bm.list());   // adding through the store does not notify the shell
  await sleep(700);
  if ((await barItems()) === 0 && !state.bookmarksBarVisible) { tm.toggleBookmarksBar(); await sleep(700); }
  console.log("bookmarks bar items in the shell: " + (await barItems()));
  const twoTabs = async () => { while (state.tabs.length < 3) { tm.createTab(base + "/page" + state.tabs.length); await sleep(700); } };
  await twoTabs();
  activeWc().downloadURL(base + "/dl"); await sleep(1500);   // one finished download for the bubble and the page
  popup.close(); await sleep(300);

  // SELF-TEST. This auditor reported "all clear" twice while testing nothing (an overwritten id; stale stamps), so a clean
  // result means nothing unless it can be shown to FAIL. Plant a button that is wrong on purpose (arrow cursor; on hover
  // its fill turns pale under white text) and require the audit to catch both.
  nativeTheme.themeSource = "light"; await sleep(900);
  await win.webContents.executeJavaScript(`(() => { const b = document.createElement("button"); b.id = "__audit_selftest"; b.textContent = "Self-test"; b.style.cssText = "position:fixed;left:1200px;top:44px;width:120px;height:34px;z-index:99999;cursor:default;background:#1a73e8;color:#fff;border:0"; document.body.append(b); return 0; })()`);
  // insertCSS, not a <style> tag: the shell's CSP would drop an inline stylesheet and the planted hover would never apply
  const plantedCss = await win.webContents.insertCSS("#__audit_selftest:hover{background:rgba(32,33,36,.08)!important}");
  const selfFindings = [], selfStats = [];
  await auditSurface("self-test", win.webContents, "light", selfFindings, selfStats, undefined, "__audit_selftest");
  await win.webContents.executeJavaScript('document.getElementById("__audit_selftest").remove(); 0'); await win.webContents.removeInsertedCSS(plantedCss);
  const selfCaught = { cursor: selfFindings.some((f) => f.rule === "cursor"), contrast: selfFindings.some((f) => f.rule === "contrast") };
  console.log("   self-test: planted bad button -> caught cursor: " + selfCaught.cursor + ", caught hover contrast: " + selfCaught.contrast);
  findings.length = 0; stats.length = 0;

  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    await sleep(900);
    win.show(); win.focus(); await sleep(300);
    await twoTabs();                       // the same tab strip in both themes
    tm.switchTab(state.tabs[state.tabs.length - 1].id); await sleep(500);
    console.log("\n=== " + theme.toUpperCase() + " ===");
    // the shell: tab strip, toolbar, omnibox, bookmarks bar
    await auditSurface("shell (toolbar + tabs + bar)", win.webContents, theme, findings, stats);
    // popups
    for (const kind of ["menu", "tabsearch", "siteinfo", "downloads"]) {
      popup.open(kind, null); await sleep(900);
      await auditSurface("popup: " + kind, popupWc(), theme, findings, stats);
      popup.close(); await sleep(300);
    }
    popup.open("find", null); await sleep(800);
    await auditSurface("popup: find", popupWc(), theme, findings, stats);
    popup.close(); await sleep(300);
    // bookmark edit: the right-click "Edit..." dialog and the star's "Bookmark added" bubble
    for (const [label, rect, opts] of [["popup: bookmark edit dialog", null, {}], ["popup: bookmark star bubble", { left: 1300, right: 1330, top: 44, bottom: 76 }, { bubble: true, added: true }]]) {
      popup.open("bookmark-edit", rect, Object.assign({ bookmarkId: bm.list()[0].id }, opts)); await sleep(1000);
      await auditSurface(label, popupWc(), theme, findings, stats);
      popup.close(); await sleep(300);
    }
    // our own pages
    for (const [label, open] of [["page: Settings", () => tm.openSettings()], ["page: Downloads", () => tm.openDownloadsPage()], ["page: Bookmark manager", () => tm.openManager()]]) {
      open(); await sleep(1500); await pageReady();
      await auditSurface(label, activeWc(), theme, findings, stats);
    }
    tm.createTab(); await sleep(1200); await pageReady();
    await auditSurface("page: New Tab", activeWc(), theme, findings, stats);
    await closeAll();
    // the address-bar dropdown (retry: it must really be open WITH rows before it is audited)
    for (let attempt = 0; attempt < 3; attempt++) {
      win.show(); win.focus(); await sleep(200);
      await win.webContents.executeJavaScript('document.getElementById("url-input").focus(); document.getElementById("url-input").value=""; 0');
      win.webContents.insertText("a");
      let rows = 0;
      for (let i = 0; i < 30 && rows === 0; i++) { await sleep(100); try { rows = await ex(popupWc(), 'document.querySelectorAll(".row").length'); } catch (_) { rows = 0; } }
      if (rows > 0) break;
      await win.webContents.executeJavaScript('document.getElementById("url-input").blur(); 0'); await sleep(500);
    }
    await sleep(300);
    try { await auditSurface("omnibox dropdown", popupWc(), theme, findings, stats, [".row"]); } catch (_) {}
    await win.webContents.executeJavaScript('document.getElementById("url-input").blur(); 0'); await sleep(500);

    // Restricted Mode: its own home page, shell and admin panel
    tm.secretToggle(); await sleep(2500);
    if (state.restricted) {
      await auditSurface("restricted: shell", win.webContents, theme, findings, stats);
      await auditSurface("restricted: Your sites", activeWc(), theme, findings, stats);
      popup.open("menu", null); await sleep(900);
      await auditSurface("restricted: menu", popupWc(), theme, findings, stats);
      popup.close(); await sleep(300);
      popup.open("unlock", null); await sleep(900);
      await auditSurface("restricted: admin panel", popupWc(), theme, findings, stats);
      popup.close(); await sleep(300);
      tm.leaveRestricted(); await sleep(1500);
    } else console.log("   (could not enter Restricted Mode for the audit)");
  }

  // ── report ──
  const byRule = {};
  for (const f of findings) (byRule[f.rule] = byRule[f.rule] || []).push(f);
  console.log("\n================ FINDINGS ================");
  for (const rule of ["cursor", "feedback", "contrast", "direction", "visible", "unreachable", "inconclusive"]) {
    const list = byRule[rule] || [];
    console.log("\n[" + rule + "] " + list.length + " issue(s)");
    // one line per distinct element label+detail (light and dark often repeat)
    const seen = new Set();
    for (const f of list) { const key = f.where.replace(/^\[(light|dark)\] /, "") + " | " + f.detail; if (seen.has(key)) continue; seen.add(key); const themes = list.filter((g) => g.where.replace(/^\[(light|dark)\] /, "") + " | " + g.detail === key).map((g) => /^\[(light|dark)\]/.exec(g.where)[1]).join("+"); console.log("   (" + themes + ") " + f.where.replace(/^\[(light|dark)\] /, "") + " -> " + f.detail); }
  }
  console.log("\nTOTAL issues: " + findings.length + " (cursor " + (byRule.cursor || []).length + ", feedback " + (byRule.feedback || []).length + ", contrast " + (byRule.contrast || []).length + ", direction " + (byRule.direction || []).length + ", visible " + (byRule.visible || []).length + ", unreachable " + (byRule.unreachable || []).length + ")");
  if (process.env.PBCALC_AUDIT_JSON) fs.writeFileSync(process.env.PBCALC_AUDIT_JSON, JSON.stringify({ findings, stats }, null, 1));
  let exitCode = 0;
  if (process.env.PBCALC_AUDIT_ASSERT) {
    const results = [];
    const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
    console.log("================ ASSERTIONS ================");
    check("the auditor catches a planted wrong cursor (self-test)", selfCaught.cursor);
    check("the auditor catches a planted unreadable hover (self-test)", selfCaught.contrast);
    // coverage: a surface that silently yields no elements would make "0 issues" meaningless
    const MIN = { "shell (toolbar + tabs + bar)": 18, "popup: menu": 12, "popup: tabsearch": 2, "popup: downloads": 3, "popup: find": 3, "popup: bookmark edit dialog": 2, "popup: bookmark star bubble": 4, "page: Settings": 7, "page: Downloads": 4, "page: Bookmark manager": 10, "page: New Tab": 1, "omnibox dropdown": 4, "restricted: shell": 8, "restricted: Your sites": 3, "restricted: menu": 8, "restricted: admin panel": 2 };
    for (const [surface, min] of Object.entries(MIN)) for (const theme of ["light", "dark"]) {
      const st = stats.find((x) => x.name === surface && x.theme === theme);
      check("[" + theme + "] " + surface + ": audited at least " + min + " interactive elements (got " + (st ? st.n : 0) + ")", st && st.n >= min);
    }
    for (const rule of ["cursor", "feedback", "contrast", "direction", "visible", "unreachable"]) {
      const list = byRule[rule] || [];
      check("no " + rule + " issues in any surface, light or dark" + (list.length ? "  (first: " + list[0].where + " -> " + list[0].detail + ")" : ""), list.length === 0);
    }
    const failed = results.filter((r) => !r.pass);
    console.log("PBCALC_UISTATES total=" + results.length + " failed=" + failed.length);
    exitCode = failed.length ? 1 : 0;
  }
  nativeTheme.themeSource = "system";
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(exitCode);
});
