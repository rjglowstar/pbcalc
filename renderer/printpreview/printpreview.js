// Print preview dialog (electron/printPreview.js does the work: preview PDF, printing, saving). WHICH rows show comes from rules.js - Chrome's
// measured rules, shared with main. Every setting change asks main for a new preview, except Color (a grayscale filter on the preview), Copies,
// Collate and Two-sided (only the sheet count changes) - as in Chrome, they do not re-render.
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.printAPI, R = window.PrintRules;
  let init = null, s = null, timer = null, blobUrl = null, lastPages = 0, total = 1, busy = false, moreOpen = false, invalid = false;
  const DEFAULT_MARGIN_IN = 0.39;   // ~1cm, Chromium's own "Default" margin (PDF_MARGINS comment, electron/printPreview.js) - seeds Custom the first time, never overwrites a value the user already typed (including 0)
  const clampMargin = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? Math.max(0, Math.min(5, x)) : 0; };

  const dest = () => init.dests.find((d) => d.id === s.dest) || init.dests[0];
  const avail = () => R.avail(dest(), init.doc, s, total, init.restricted);

  function opt(sel, value, text) { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); }
  function fill(sel, items, value) { sel.textContent = ""; for (const [v, t] of items) opt(sel, v, t); if (value !== undefined) sel.value = value; }

  function read() {
    s.dest = $("dest").value;
    s.pages = $("pages").value;
    s.custom = $("custom").value;
    s.copies = Math.max(1, Math.min(999, parseInt($("copies").value, 10) || 1));
    s.collate = $("collate").checked;
    s.landscape = $("layout").value === "landscape";
    s.color = $("color").value === "color";
    s.paper = $("paper").value;
    s.pps = Number($("pps").value) || 1;
    s.margins = $("margins").value;
    s.marginTop = clampMargin($("margin-top").value);
    s.marginLeft = clampMargin($("margin-left").value);
    s.marginRight = clampMargin($("margin-right").value);
    s.marginBottom = clampMargin($("margin-bottom").value);
    s.dpi = $("dpi").value;
    s.scaleMode = $("scale-mode").value;
    s.scale = Math.max(10, Math.min(200, parseInt($("scale").value, 10) || 100));
    s.duplex = $("duplex").checked;
    s.duplexEdge = $("duplex-edge").value;
    s.headers = $("headers").checked;
    s.background = $("background").checked;
  }

  // the lists that depend on the destination (paper sizes, resolutions) and on the page count (odd / even)
  function lists() {
    const d = dest(), c = d.caps;
    if (!c.papers.some((p) => p.name === s.paper)) s.paper = c.papers.some((p) => p.name === c.defPaper) ? c.defPaper : (c.papers[0] || {}).name || "";
    fill($("paper"), c.papers.map((p) => [p.name, p.name]), s.paper);
    if (!c.dpis.includes(s.dpi)) s.dpi = c.dpis.includes(c.defDpi) ? c.defDpi : (c.dpis[0] || "");
    fill($("dpi"), c.dpis.map((v) => { const [h, w] = v.split("x"); return [v, (h === w ? h : v) + " dpi"]; }), s.dpi);
    const a = avail();
    if (!a.oddEven && (s.pages === "odd" || s.pages === "even")) s.pages = "all";
    fill($("pages"), [["all", "All"], ...(a.oddEven ? [["odd", "Odd pages only"], ["even", "Even pages only"]] : []), ["custom", "Custom"]], s.pages);
    $("ico-printer").toggleAttribute("hidden", d.kind === "pdf");   // an <svg> has no .hidden property: the attribute must be set
    $("ico-pdf").toggleAttribute("hidden", d.kind !== "pdf");
  }

  function write() {
    $("dest").value = s.dest;
    lists();
    $("custom").value = s.custom;
    $("copies").value = s.copies;
    $("copies").max = String(Math.min(999, dest().caps.copies || 1));
    $("collate").checked = s.collate;
    $("layout").value = s.landscape ? "landscape" : "portrait";
    $("color").value = s.color ? "color" : "bw";
    $("pps").value = String(s.pps);
    $("margins").value = s.margins;
    $("margin-top").value = s.marginTop;
    $("margin-left").value = s.marginLeft;
    $("margin-right").value = s.marginRight;
    $("margin-bottom").value = s.marginBottom;
    $("scale-mode").value = s.scaleMode;
    $("scale").value = s.scale;
    $("duplex").checked = s.duplex;
    $("duplex-edge").value = s.duplexEdge;
    $("headers").checked = s.headers;
    $("background").checked = s.background;
  }

  // show exactly the rows Chrome would show for this destination, document and settings
  function layout() {
    const a = avail(), d = dest();
    const show = (id, on) => { $(id).hidden = !on; };
    show("copies-row", a.copies);
    show("collate-row", a.collate);
    show("layout-row", a.layout);
    show("color-row", a.color);
    show("paper-row", a.paper);
    show("pps-row", a.pps);
    show("margins-row", a.margins);
    show("dpi-row", a.dpi);
    show("scale-row", a.scale);
    show("duplex-row", a.duplex);
    show("duplex-edge", a.duplex && s.duplex);
    show("options-row", a.options);
    show("headers-row", a.headers);
    show("background-row", a.background);
    show("custom", s.pages === "custom");
    show("scale", s.scaleMode === "custom");
    show("margins-custom", s.margins === "custom");
    show("more", a.moreToggle);
    show("more-box", !a.moreToggle || moreOpen);
    $("more").setAttribute("aria-expanded", String(moreOpen));
    if (s.pages !== "custom") setInvalid(false);
    $("go").textContent = d.kind === "pdf" ? "Save" : "Print";
    $("pdf").classList.toggle("bw", a.color && !s.color);
    sheets();
  }

  function sheets() {
    if (!lastPages) { $("sheets").textContent = ""; return; }
    const a = avail();
    if (dest().kind === "pdf") { const n = Math.ceil(lastPages / (a.pps ? s.pps : 1)); $("sheets").textContent = n + (n === 1 ? " page" : " pages"); return; }
    let n = Math.ceil(lastPages / (a.pps ? s.pps : 1));
    if (a.duplex && s.duplex) n = Math.ceil(n / 2);
    n *= a.copies ? s.copies : 1;
    $("sheets").textContent = n + (n === 1 ? " sheet of paper" : " sheets of paper");
  }

  function bytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  function setInvalid(on) {
    invalid = on;
    $("custom-err").hidden = !on;
    $("custom").classList.toggle("invalid", on);
    $("go").disabled = on || busy || !lastPages;
  }

  async function render() {
    clearTimeout(timer); timer = null;
    $("loading").classList.add("show");
    $("pdf").classList.add("busy");
    $("bad").classList.remove("show");
    const r = await api.preview(s);
    if (!r || r.stale) return;
    $("loading").classList.remove("show");
    $("pdf").classList.remove("busy");
    if (r.total && r.total !== total) {   // the page count decides Odd / Even (and so the Pages list)
      const had = total > 1; total = r.total;
      if ((total > 1) !== had) { lists(); }
    }
    if (r.invalid) { setInvalid(true); layout(); return; }
    if (r.error) { $("bad").textContent = "The preview could not be made."; $("bad").classList.add("show"); return; }
    lastPages = r.pages;
    setInvalid(false);
    const old = blobUrl;
    blobUrl = URL.createObjectURL(new Blob([bytes(r.pdf)], { type: "application/pdf" }));
    $("pdf").src = blobUrl + "#toolbar=0&navpanes=0&view=Fit";
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    layout();
    if (document.activeElement === document.body) $("go").focus();   // Print has the keyboard once there is something to print
  }
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(render, ms); };

  const MARGIN_FIELD = { "margin-top": "marginTop", "margin-left": "marginLeft", "margin-right": "marginRight", "margin-bottom": "marginBottom" };

  function changed(e) {
    const id = e && e.target && e.target.id;
    read();
    if (id === "dest") { lists(); write(); }
    // a number input does NOT clamp an out-of-range typed value on its own (only the up/down arrows do) - show the clamped
    // value back, or the field would read "999" while 5 is what actually gets printed
    if (MARGIN_FIELD[id]) $(id).value = s[MARGIN_FIELD[id]];
    layout();
    api.sticky(s, moreOpen);   // remembered the moment it is picked, like Chrome - not only after Print/Save (measured against real Chrome)
    if (["color", "copies", "collate", "duplex", "duplex-edge", "dpi"].includes(id)) return;   // the preview does not change
    const typed = ["custom", "scale", "copies", "margin-top", "margin-left", "margin-right", "margin-bottom"];
    later(typed.includes(id) ? 600 : 150);
  }

  async function go() {
    if ($("go").disabled) return;
    read();
    busy = true; $("go").disabled = true; $("status").textContent = "";
    const r = await api.go(s, moreOpen);
    busy = false;
    if (!r) return;
    if (r.invalid) { setInvalid(true); return; }
    $("go").disabled = invalid;
    if (r.error) $("status").textContent = r.error;
  }

  async function start() {
    init = await api.init();
    if (!init) return;
    for (const d of init.dests) opt($("dest"), d.id, d.label);
    for (const n of init.pps) opt($("pps"), String(n), String(n));
    s = init.settings;
    moreOpen = !!init.moreOpen;
    write(); layout();
    $("rows").hidden = false;
    for (const el of document.querySelectorAll("select, input")) {
      el.addEventListener("change", changed);
      if (el.type === "text" || el.type === "number") el.addEventListener("input", changed);
    }
    $("custom").addEventListener("keydown", (e) => { if (e.key === "Enter") { read(); render(); } });
    $("more").addEventListener("click", () => { moreOpen = !moreOpen; layout(); api.sticky(s, moreOpen); });
    $("go").addEventListener("click", go);
    $("cancel").addEventListener("click", () => api.close());
    $("system").addEventListener("click", () => api.system());
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); api.close(); } });
    $("go").focus();
    render();
    // the real per-printer caps land a moment later (never blocking the panel above - see the BUG
    // comment on print:init, electron/printPreview.js): the destination ids/order never change (same
    // printer names, just better data attached), so the user's own choice of `s.dest` always survives;
    // re-run write()/layout() to pick up the corrected paper/dpi/margins lists, and only re-render the
    // preview if that correction actually changed something that affects the printed page (the paper
    // size, most likely - a cold cache meant the dialog briefly assumed a fallback default paper).
    if (api.onCapsUpdated) {
      api.onCapsUpdated(({ dests }) => {
        if (!init) return;
        init.dests = dests;
        const prevPaper = s.paper;
        write(); layout();
        if (s.paper !== prevPaper) later(150);
      });
    }
    if (api.onPageScroll) api.onPageScroll(({ page, frac }) => showPageBadge(page, frac));
  }

  // Chrome's scroll-time "page N" badge, replicated here from measurements against a real Chrome print
  // preview (owner 2026-10-21) since Chromium's own never appears in PBCalc's embedded viewer at all
  // (confirmed directly, even with real OS mouse-wheel scrolling - see the big comment above
  // startBadgePoll in electron/printPreview.js, which is what actually drives this via print:page-scroll).
  // Measured: a dark rgba(0,0,0,.5) rounded box (CSS here), vertically tracking the scroll position,
  // visible while scrolling and for ~2-2.5s after it stops before fading - timing and position below
  // match that, not guessed. `frac` is the SAME continuous scroll fraction Chromium's own scrollbar
  // thumb is drawn from (not a page/total stand-in - that version moved only on a page-number change
  // and visibly lagged the real thumb whenever further scrolling stayed within one page, caught by the
  // owner's own screenshots: two shots of the same page number showed the real thumb in two different
  // spots - see the BUG comment on startBadgePoll in electron/printPreview.js).
  let badgeFadeTimer = null;
  function showPageBadge(page, frac) {
    if (!total || total <= 1) return;   // Chrome shows nothing when there is nothing to scroll
    const el = $("page-badge");
    el.textContent = String(page);
    const area = $("preview").clientHeight;
    const h = el.offsetHeight || 38;   // matches the CSS #page-badge height, read live rather than duplicating the number
    const y = Math.round(Math.max(0, Math.min(area - h, frac * (area - h))));
    el.style.top = y + "px";
    el.classList.add("show");
    clearTimeout(badgeFadeTimer);
    badgeFadeTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }
  start();
})();
