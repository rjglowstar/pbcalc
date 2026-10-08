// The calculator screen - a full-window diamond price calculator, shown instead of the browser when the owner chose "start on the calculator screen"
// at install. Built from the owner's iPad recording (Stone Weight, summary, one card per part with scroll wheels for Shape / Colour / Clarity /
// Fluorescence / Discount, grade chips, a price line), re-laid out to fill a Windows window: no iPad status bar, fluid width, light + dark.
// Tabs: Calculator (this), Account and Price List ("Coming soon" panels). Gear: a settings dialog. Dummy prices (pricing.js). Nothing here touches the
// browser except the gray "+" button: five quick presses are counted in the MAIN process (calcAPI.plus) and open the browser.
(function () {
  "use strict";
  const P = window.CalcPricing;
  const api = window.calcAPI;
  const root = document.getElementById("calc-root");
  if (!root || !P || !api) return;

  const NS = "http://www.w3.org/2000/svg";
  const WHEEL_H = 36;                                   // = .c-wheel-item height in calc.css
  const ICONS = {
    person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
    calc: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM7.5 18c-.83 0-1.5-.67-1.5-1.5S6.67 15 7.5 15 9 15.67 9 16.5 8.33 18 7.5 18zm0-4c-.83 0-1.5-.67-1.5-1.5S6.67 11 7.5 11 9 11.67 9 12.5 8.33 14 7.5 14zm4.5 4c-.83 0-1.5-.67-1.5-1.5S11.17 15 12 15s1.5.67 1.5 1.5S12.83 18 12 18zm0-4c-.83 0-1.5-.67-1.5-1.5S11.17 11 12 11s1.5.67 1.5 1.5S12.83 14 12 14zm4.5 4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm0-4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM18 9H6V6h12v3z",
    refresh: "M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
    scale: "M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zm0 2v14h14V5H5zm7 2.5a4.5 4.5 0 00-4.5 4.5h2a2.5 2.5 0 015 0h2A4.5 4.5 0 0012 7.5zM11 12.2l-1.6 3.3h5.2L13 12.2z",
    close: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    minusCircle: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z",
    minus: "M19 13H5v-2h14v2z",
    plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
    dollar: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.2 15.4V19h-2.3v-1.6c-1.5-.3-2.7-1.2-2.8-2.9h1.7c.1.8.7 1.4 1.9 1.4 1.3 0 1.8-.6 1.8-1.2 0-.8-.5-1.2-2.1-1.6-1.8-.5-3-1.1-3-2.7 0-1.3 1-2.2 2.5-2.5V6.1h2.3v1.6c1.5.4 2.2 1.5 2.3 2.8h-1.7c0-.9-.5-1.4-1.6-1.4-1.2 0-1.7.6-1.7 1.2 0 .7.5 1 2 1.4 1.8.5 3.1 1.1 3.1 2.9 0 1.4-1.1 2.3-2.7 2.5z",
    gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
    diamond: "M12 2L2 9l10 13L22 9 12 2zm0 3.1L17.3 9H6.7L12 5.1zM5.2 11h3.6l1.6 6.2L5.2 11zm5.7 0h2.2L12 17.5 10.9 11zm4.3 0h3.6l-5.2 6.2 1.6-6.2z",
  };

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const icon = (name) => { const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "c-icon"); const p = document.createElementNS(NS, "path"); p.setAttribute("d", ICONS[name]); s.appendChild(p); return s; };
  const money = (n) => "$" + n.toFixed(2);
  const DISCOUNTS = []; for (let v = -60; v <= 10; v++) DISCOUNTS.push(v);
  const clockText = () => { const d = new Date(); let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap; };

  // ── state: a fresh screen every time the calculator comes up ──
  let st, built = false, ui = {};
  const newPart = () => ({ weight: "", shape: "ROUND", color: "D", clarity: "FL", fluor: "NON", discount: st ? st.prefs.defaultDisc : -30, grades: P.PRESETS["3EX"].slice() });
  const fresh = () => ({ stone: "", parts: [], drift: 1, active: 0, tab: "calc", prefs: { dark: false, labs: true, defaultDisc: -30 }, updated: clockText() });
  const letter = (i) => String.fromCharCode(65 + i);

  // ── scroll wheel (iOS-style picker): scroll-snap column, drag with the mouse, one step per mouse-wheel notch ──
  function makeWheel(items, startIndex, onChange, cls) {
    const wrap = el("div", "c-wheel " + cls);
    wrap.appendChild(el("div", "c-wheel-sel"));
    const sc = el("div", "c-wheel-scroll"); sc.tabIndex = 0; wrap.appendChild(sc);
    sc.appendChild(el("div", "c-wheel-pad"));
    const nodes = items.map((t) => { const d = el("div", "c-wheel-item", String(t)); sc.appendChild(d); return d; });
    sc.appendChild(el("div", "c-wheel-pad"));
    let idx = startIndex, raf = 0, dragging = false, moved = 0, startY = 0, startTop = 0, target = startIndex, targetTimer = 0;
    const clamp = (i) => Math.max(0, Math.min(items.length - 1, i));
    const toIndex = (i, smooth) => sc.scrollTo({ top: clamp(i) * WHEEL_H, behavior: smooth ? "smooth" : "auto" });
    // the fade of the neighbours is only looks (and may wait for a frame); WHICH item is selected never waits for one:
    // requestAnimationFrame does not run while the window is covered, and the price must follow the wheel regardless
    function paint() {
      raf = 0;
      const pos = sc.scrollTop / WHEEL_H;
      for (let i = 0; i < nodes.length; i++) {
        const d = Math.abs(i - pos);
        nodes[i].style.opacity = d > 3 ? "" : String(Math.max(0.16, 1 - d * 0.4));
        nodes[i].classList.toggle("on", d < 0.5);
      }
    }
    sc.addEventListener("scroll", () => {
      const n = clamp(Math.round(sc.scrollTop / WHEEL_H));
      if (n !== idx) { idx = n; onChange(idx); }
      if (!raf) raf = requestAnimationFrame(paint);
    });
    sc.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0;
      if (!dir) return;
      target = clamp((targetTimer ? target : idx) + dir);
      clearTimeout(targetTimer); targetTimer = setTimeout(() => { targetTimer = 0; }, 260);
      toIndex(target, true);
    }, { passive: false });
    sc.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); toIndex(idx + 1, true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); toIndex(idx - 1, true); }
    });
    sc.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.button !== 0) return;
      dragging = true; moved = 0; startY = e.clientY; startTop = sc.scrollTop;
      sc.style.scrollSnapType = "none"; try { sc.setPointerCapture(e.pointerId); } catch (_) {}
    });
    sc.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      moved = Math.max(moved, Math.abs(dy));
      sc.scrollTop = startTop - dy;
    });
    const release = () => { if (!dragging) return; dragging = false; sc.style.scrollSnapType = ""; toIndex(Math.round(sc.scrollTop / WHEEL_H), true); };
    sc.addEventListener("pointerup", release);
    sc.addEventListener("pointercancel", release);
    nodes.forEach((n, i) => n.addEventListener("click", () => { if (moved < 4) toIndex(i, true); }));
    // called once the wheel is in the document (it needs layout to scroll): put it on its start item, right now
    const init = () => { sc.scrollTop = startIndex * WHEEL_H; paint(); };
    return { el: wrap, init, set: (i) => { idx = clamp(i); toIndex(idx, false); } };
  }

  // ── a chip with a radio dot ──
  function chip(text, on, onClick) {
    const b = el("button", "c-chip" + (on ? " on" : "")); b.type = "button";
    b.appendChild(el("span", "c-radio")); b.appendChild(el("span", "", text));
    b.addEventListener("click", onClick);
    return b;
  }

  const cleanNumber = (s) => { let v = String(s).replace(/[^0-9.]/g, ""); const i = v.indexOf("."); if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, ""); const m = v.match(/^(\d{0,4})(\.\d{0,3})?/); return m ? m[0] : ""; };
  function nudge(delta) {
    const p = st.parts[st.active] || st.parts[0];
    const next = Math.max(0, Math.round((P.num(p.weight) + delta) * 100) / 100);
    p.weight = next ? String(next) : "";
    renderParts();
  }

  // ── the frame: header (tabs, price update), three views, footer ──
  function buildFrame() {
    root.textContent = "";
    const stage = el("div", "c-stage"); ui.stage = stage; root.appendChild(stage);

    const head = el("header", "c-head"); stage.appendChild(head);
    const brand = el("div", "c-brand"); const bi = el("i"); bi.appendChild(icon("diamond")); brand.appendChild(bi); brand.appendChild(el("span", "", "PBC")); head.appendChild(brand);
    const tabs = el("div", "c-tabs"); tabs.setAttribute("role", "tablist"); head.appendChild(tabs);
    const mkTab = (key, label, glyph) => {
      const t = el("button", "c-tab"); t.type = "button"; t.setAttribute("role", "tab"); t.dataset.tab = key; t.title = label;
      if (glyph === "$") t.appendChild(el("span", "c-dollar", "$")); else t.appendChild(icon(glyph));
      t.appendChild(el("span", "c-tab-label", label));
      t.addEventListener("click", () => showTab(key));
      tabs.appendChild(t); return t;
    };
    ui.tabs = { account: mkTab("account", "Account", "person"), calc: mkTab("calc", "Calculator", "calc"), prices: mkTab("prices", "Price List", "$") };
    head.appendChild(el("div", "c-grow"));
    ui.upd = el("span", "c-upd-meta"); head.appendChild(ui.upd);
    const upd = el("button", "c-update"); upd.type = "button"; upd.appendChild(icon("refresh")); upd.appendChild(el("span", "", "Update Price"));
    upd.addEventListener("click", () => {
      st.drift = Math.round((1 + (Math.random() - 0.5) * 0.04) * 100) / 100;   // the list moves by up to 2 %
      st.updated = clockText(); ui.upd.textContent = "Prices updated " + st.updated;
      upd.classList.remove("spin"); void upd.offsetWidth; upd.classList.add("spin");
      refresh();
    });
    head.appendChild(upd);

    const views = el("div", "c-views"); stage.appendChild(views); ui.views = views;
    // calculator view
    const calc = el("section", "c-view calc"); calc.dataset.view = "calc"; views.appendChild(calc); ui.viewCalc = calc;
    const top = el("div", "c-top"); calc.appendChild(top);
    const stone = el("div", "c-stone"); top.appendChild(stone); ui.stoneBox = stone;
    stone.appendChild(icon("scale"));
    ui.stoneIn = el("input"); ui.stoneIn.placeholder = "Stone Weight"; ui.stoneIn.inputMode = "decimal"; ui.stoneIn.autocomplete = "off"; ui.stoneIn.maxLength = 8;
    stone.appendChild(ui.stoneIn);
    stone.appendChild(el("span", "c-unit", "Ct."));
    const clr = el("button", "c-clear"); clr.type = "button"; clr.appendChild(icon("close")); stone.appendChild(clr);
    clr.addEventListener("mousedown", (e) => e.preventDefault());
    clr.addEventListener("click", () => { ui.stoneIn.value = ""; st.stone = ""; ui.stoneIn.focus(); refresh(); });
    ui.stoneIn.addEventListener("focus", () => stone.classList.add("focus"));
    ui.stoneIn.addEventListener("blur", () => stone.classList.remove("focus"));
    ui.stoneIn.addEventListener("input", () => { ui.stoneIn.value = cleanNumber(ui.stoneIn.value); st.stone = ui.stoneIn.value; refresh(); });
    const sum = el("div", "c-sum"); top.appendChild(sum);
    ui.sum = {};
    [["polish", "Polish"], ["result", "Result"], ["total", "Total Polish"], ["rough", "Rough $/Ct."]].forEach(([k, label]) => {
      const c = el("div"); c.appendChild(el("label", "", label)); ui.sum[k] = el("b", k === "result" ? "res" : ""); c.appendChild(ui.sum[k]); sum.appendChild(c);
    });
    ui.labs = el("div", "c-labs");
    ["Loose", "GIA", "IGI", "HRD"].forEach((n) => { const d = el("div"); d.appendChild(el("b", "", n)); d.appendChild(el("span", "", "$0.00/Ct.")); ui.labs.appendChild(d); });
    top.appendChild(ui.labs);
    ui.body = el("div", "c-body"); calc.appendChild(ui.body);
    const actions = el("div", "c-actions"); calc.appendChild(actions);
    const red = el("button", "c-btn red"); red.type = "button"; red.title = "Remove the last part"; red.appendChild(icon("minusCircle"));
    red.addEventListener("click", () => { if (st.parts.length > 1) st.parts.pop(); else st.parts[0] = newPart(); st.active = Math.min(st.active, st.parts.length - 1); renderParts(); });
    const add = el("button", "c-btn blue"); add.type = "button"; add.title = "Add another part"; add.appendChild(icon("dollar")); add.appendChild(el("span", "", "Add St."));
    add.addEventListener("click", () => { if (st.parts.length < 6) { st.parts.push(newPart()); st.active = st.parts.length - 1; renderParts(); ui.body.scrollTo({ top: ui.body.scrollHeight, behavior: "smooth" }); } });
    const minus = el("button", "c-btn grey"); minus.type = "button"; minus.title = "Weight - 0.05 ct"; minus.appendChild(icon("minus"));
    minus.addEventListener("click", () => nudge(-0.05));
    const plus = el("button", "c-btn grey"); plus.type = "button"; plus.title = "Weight + 0.05 ct"; plus.appendChild(icon("plus"));
    plus.addEventListener("click", () => { api.plus(); nudge(+0.05); });   // main counts the quick presses
    actions.append(red, add, minus, plus);

    // the two "coming soon" views
    const soon = (key, title, glyph, text) => {
      const v = el("section", "c-view"); v.dataset.view = key; v.hidden = true;
      const box = el("div", "c-soon"); const ring = el("div", "c-ring"); ring.appendChild(icon(glyph)); box.appendChild(ring);
      box.appendChild(el("h2", "", title)); box.appendChild(el("p", "", text)); box.appendChild(el("span", "c-pillsoon", "Coming soon"));
      v.appendChild(box); views.appendChild(v); return v;
    };
    ui.viewAccount = soon("account", "Account", "person", "Your profile, company details and saved preferences will live here.");
    ui.viewPrices = soon("prices", "Price List", "dollar", "The full price list by shape, colour, clarity and weight will live here.");

    // footer
    const foot = el("footer", "c-foot"); stage.appendChild(foot);
    const pill = el("div", "c-pill"); pill.appendChild(icon("calc")); pill.appendChild(el("span", "", "Calculator")); foot.appendChild(pill);
    const gear = el("button", "c-gear"); gear.type = "button"; gear.title = "Settings"; gear.appendChild(icon("gear")); gear.addEventListener("click", openSettings); foot.appendChild(gear);
    built = true;
  }

  function showTab(key) {
    if (!st || !ui.tabs) return;
    st.tab = key;
    Object.keys(ui.tabs).forEach((k) => { const on = k === key; ui.tabs[k].classList.toggle("on", on); ui.tabs[k].setAttribute("aria-selected", on ? "true" : "false"); });
    ui.viewCalc.hidden = key !== "calc"; ui.viewAccount.hidden = key !== "account"; ui.viewPrices.hidden = key !== "prices";
  }

  // ── the cards (rebuilt when parts are added / removed / nudged) ──
  const cardRefs = [];
  function renderParts() {
    ui.body.textContent = ""; cardRefs.length = 0;
    st.parts.forEach((p, i) => ui.body.appendChild(buildCard(p, i)));
    cardRefs.forEach((r) => r.wheels.forEach((w) => w.init()));   // the cards are in the document now: the wheels can scroll to their start items
    refresh();
  }

  const WHEEL_HEADS = [["Shape", "w-shape"], ["Colour", "w-color"], ["Clarity", "w-clar"], ["Fluor.", "w-fluor"], ["Discount", "w-disc"]];
  function buildCard(p, i) {
    const ref = {}; cardRefs[i] = ref;
    const card = el("div", "c-card");
    card.addEventListener("pointerdown", () => { st.active = i; });
    const head = el("div", "c-cardhead"); card.appendChild(head);
    head.appendChild(el("div", "c-partbadge", letter(i)));
    const pw = el("div", "c-pw" + (p.weight ? " has" : "")); head.appendChild(pw);
    const label = el("label", "", "Enter Part '" + letter(i) + "' Weight"); pw.appendChild(label);
    const input = el("input"); input.inputMode = "decimal"; input.autocomplete = "off"; input.maxLength = 8; input.value = p.weight; pw.appendChild(input);
    pw.appendChild(el("span", "c-unit", "Ct."));
    const setLabel = () => { label.textContent = (p.weight || pw.classList.contains("focus")) ? "Part '" + letter(i) + "' Weight" : "Enter Part '" + letter(i) + "' Weight"; };
    label.addEventListener("click", () => input.focus());
    pw.addEventListener("click", () => input.focus());
    input.addEventListener("focus", () => { pw.classList.add("focus"); st.active = i; setLabel(); });
    input.addEventListener("blur", () => { pw.classList.remove("focus"); pw.classList.toggle("has", !!p.weight); setLabel(); });
    input.addEventListener("input", () => { input.value = cleanNumber(input.value); p.weight = input.value; pw.classList.toggle("has", !!p.weight); setLabel(); refresh(); });
    setLabel();

    const work = el("div", "c-work"); card.appendChild(work);
    const box = el("div", "c-wheelbox"); work.appendChild(box);
    const heads = el("div", "c-wheel-heads"); box.appendChild(heads);
    WHEEL_HEADS.forEach(([t, c]) => heads.appendChild(el("span", c, t)));
    const wheels = el("div", "c-wheels"); box.appendChild(wheels);
    ref.wheels = [];
    const mk = (items, cur, field, cls, fmt) => {
      const w = makeWheel(items.map((x) => (fmt ? fmt(x) : x)), Math.max(0, items.indexOf(cur)), (idx) => { p[field] = items[idx]; refresh(); }, cls);
      wheels.appendChild(w.el); ref.wheels.push(w);
    };
    mk(P.SHAPES, p.shape, "shape", "w-shape");
    mk(P.COLORS, p.color, "color", "w-color");
    mk(P.CLARITIES, p.clarity, "clarity", "w-clar");
    mk(P.FLUORS, p.fluor, "fluor", "w-fluor");
    mk(DISCOUNTS, p.discount, "discount", "w-disc", (v) => v + "%");

    const gr = el("div", "c-grades"); work.appendChild(gr);
    gr.appendChild(el("div", "c-sectitle", "Grade"));
    const presets = el("div", "c-chips"); gr.appendChild(presets);
    const rows = [];
    const paintGrades = () => {
      const cur = P.presetOf(p.grades);
      ref.presetChips.forEach((c, k) => c.classList.toggle("on", P.PRESET_NAMES[k] === cur));
      rows.forEach((r, k) => r.forEach((c, g) => c.classList.toggle("on", P.GRADES[g] === p.grades[k])));
    };
    ref.presetChips = P.PRESET_NAMES.map((n) => { const c = chip(n, false, () => { p.grades = P.PRESETS[n].slice(); paintGrades(); refresh(); }); presets.appendChild(c); return c; });
    gr.appendChild(el("div", "c-sectitle", "Cut · Polish · Symmetry"));
    [["C", "Cut"], ["P", "Polish"], ["S", "Symmetry"]].forEach(([l, name], k) => {
      const row = el("div", "c-row"); row.appendChild(el("span", "c-lbl", name)); row.dataset.key = l;
      const chips = P.GRADES.map((g) => { const c = chip(g, false, () => { p.grades[k] = g; paintGrades(); refresh(); }); row.appendChild(c); return c; });
      rows.push(chips); gr.appendChild(row);
    });
    p.grades = p.grades.slice();
    paintGrades();

    ref.line = el("div", "c-line"); card.appendChild(ref.line);
    ref.table = el("div", "c-table"); card.appendChild(ref.table);
    const head2 = el("div", "r h"); ["VG", "Disc.", "$/ct.", "Total"].forEach((t) => head2.appendChild(el("div", "h", t))); ref.table.appendChild(head2);
    ["Loose", "GIA", "IGI", "HRD"].forEach((n) => { const r = el("div", "r"); r.appendChild(el("div", "lab", n)); r.appendChild(el("div", "", "0.00%")); r.appendChild(el("div", "", "$0.00")); r.appendChild(el("div", "red", "$0.00")); ref.table.appendChild(r); });
    return card;
  }

  // ── numbers ──
  function numSpan(text, nonzero) { return el("b", nonzero ? "nz" : "", text); }
  function refresh() {
    if (!built || !st) return;
    const s = P.summary(st.parts, st.stone, st.drift);
    ui.sum.polish.textContent = s.polish.toFixed(2) + " Ct.";
    ui.sum.result.textContent = s.result.toFixed(2) + "%";
    ui.sum.result.classList.toggle("pos", s.result > 0);
    ui.sum.total.textContent = money(s.total);
    ui.sum.rough.textContent = money(s.rough);
    const showLabs = st.prefs.labs && P.num(st.stone) > 0;
    ui.labs.classList.toggle("show", showLabs);
    s.parts.forEach((r, i) => {
      const ref = cardRefs[i]; if (!ref) return;
      ref.line.textContent = "";
      ref.line.append("List ", numSpan(String(r.list), r.list > 0), " $/Ct. ", numSpan(String(r.net), r.net > 0), " Total ", numSpan(String(Math.round(r.total)), r.total > 0));
      ref.table.classList.toggle("show", showLabs);
    });
  }

  // ── settings dialog (the gear): theme, default discount, lab table, reset. In memory only: gone with the calculator ──
  function applyTheme() { ui.stage.classList.toggle("dark", st.prefs.dark); }
  function openSettings() {
    if (!st || ui.modal) return;
    const modal = el("div", "c-modal"); ui.modal = modal;
    const dlg = el("div", "c-dialog"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "c-set-title"); modal.appendChild(dlg);
    const h = el("h2"); h.id = "c-set-title"; h.appendChild(icon("gear")); h.appendChild(el("span", "", "Settings")); dlg.appendChild(h);
    dlg.appendChild(el("p", "c-sub", "Applies to this calculator session."));
    const row = (title, sub, control) => { const r = el("div", "c-set"); const l = el("div"); l.appendChild(el("b", "", title)); l.appendChild(el("span", "", sub)); r.appendChild(l); r.appendChild(control); dlg.appendChild(r); return r; };
    // theme
    const seg = el("div", "c-seg");
    [["light", "Light"], ["dark", "Dark"]].forEach(([k, t]) => { const b = el("button", "" + ((k === "dark") === st.prefs.dark ? "on" : ""), t); b.type = "button"; b.dataset.theme = k; b.addEventListener("click", () => { st.prefs.dark = k === "dark"; applyTheme(); seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); }); seg.appendChild(b); });
    row("Appearance", "Light or dark calculator", seg);
    // default discount
    const stepper = el("div", "c-stepper"); const dm = el("button", "", "−"), dp = el("button", "", "+"), out = el("output", "", st.prefs.defaultDisc + "%"); dm.type = dp.type = "button";
    const setDisc = (v) => { st.prefs.defaultDisc = Math.max(-60, Math.min(10, v)); out.textContent = st.prefs.defaultDisc + "%"; };
    dm.addEventListener("click", () => setDisc(st.prefs.defaultDisc - 1)); dp.addEventListener("click", () => setDisc(st.prefs.defaultDisc + 1));
    stepper.append(dm, out, dp);
    const drow = row("Default discount", "Used for new parts", stepper);
    const apply = el("button", "c-dlgbtn", "Apply to all parts"); apply.type = "button"; apply.dataset.act = "apply";
    apply.addEventListener("click", () => { st.parts.forEach((p, i) => { p.discount = st.prefs.defaultDisc; const w = cardRefs[i] && cardRefs[i].wheels[4]; if (w) w.set(DISCOUNTS.indexOf(p.discount)); }); refresh(); });
    drow.appendChild(apply); drow.style.flexWrap = "wrap";
    // lab table
    const sw = el("button", "c-switch" + (st.prefs.labs ? " on" : "")); sw.type = "button"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", String(st.prefs.labs)); sw.dataset.act = "labs";
    sw.addEventListener("click", () => { st.prefs.labs = !st.prefs.labs; sw.classList.toggle("on", st.prefs.labs); sw.setAttribute("aria-checked", String(st.prefs.labs)); refresh(); });
    row("Lab price table", "Loose · GIA · IGI · HRD under each part", sw);
    // bottom
    const foot = el("div", "c-foot2"); dlg.appendChild(foot);
    const reset = el("button", "c-dlgbtn danger", "Reset calculator"); reset.type = "button"; reset.dataset.act = "reset";
    reset.addEventListener("click", () => { st.stone = ""; ui.stoneIn.value = ""; st.parts = [newPart()]; st.active = 0; st.drift = 1; renderParts(); closeSettings(); });
    const done = el("button", "c-dlgbtn primary", "Done"); done.type = "button"; done.dataset.act = "done"; done.addEventListener("click", closeSettings);
    foot.append(reset, done);
    modal.addEventListener("pointerdown", (e) => { if (e.target === modal) closeSettings(); });
    ui.stage.appendChild(modal);
    done.focus();
  }
  function closeSettings() { if (ui.modal) { ui.modal.remove(); ui.modal = null; } }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.modal) { e.preventDefault(); closeSettings(); } });

  // ── show / hide ──
  function show() {
    st = fresh(); st.parts = [newPart()];
    document.body.classList.add("calc-mode");      // FIRST: a hidden (display:none) wheel cannot scroll, so its start item would not stick
    buildFrame(); applyTheme(); showTab("calc"); ui.upd.textContent = "Prices updated " + st.updated; renderParts();
  }
  function hide() {
    document.body.classList.remove("calc-mode");
    root.textContent = ""; ui = {}; built = false; st = null;   // nothing of the screen is kept while the browser is in use
  }
  api.onMode((on) => (on ? (st ? null : show()) : hide()));          // (never rebuild a screen that is already up: it would drop what was typed)
  api.getMode().then((on) => { if (on && !st) show(); }).catch(() => {});
})();
