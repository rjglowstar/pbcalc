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
  // main loaded this page with ?calc=1 when PBCalc starts on the calculator: hide the browser's own chrome from the first moment (the calculator itself is
  // built a few milliseconds later, when its data has arrived), so the tab strip / address bar are never seen
  if (/[?&]calc=1(&|$)/.test(location.search)) document.body.classList.add("calc-mode");

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
  const ADDISC = []; for (let v = 0; v <= 20; v++) ADDISC.push(v);          // the ERP's "Additional Discount" wheel: 0 .. 20 %
  const clockText = () => { const d = new Date(); let h = d.getHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return h + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap; };

  // ── state: a fresh screen every time the calculator comes up ──
  let st, built = false, ui = {};
  // a part starts on the first value of every list in calc-data.json (shape, colour, clarity, fluorescence), the default CPS and lab, and the default depth / ratio
  const newPart = () => {
    const d = P.data(), shape = P.shapes()[0].code, grades = P.cpsTriple(d.defaultCps), subs = P.subCutsFor(shape, grades[0]);
    return { weight: "", shape, color: P.colors()[0], clarity: P.clarities()[0], fluor: P.fluorescence()[0], adDisc: st ? st.prefs.defaultAdDisc : 0, grades,
      subCut: subs.length ? subs[0].code : null, lab: d.defaultLab, depth: String(d.defaultDepth), ratio: String(d.defaultRatio) };
  };
  const fresh = () => ({ stone: "", parts: [], drift: 1, active: 0, tab: "calc", prefs: { dark: false, labs: true, defaultAdDisc: 0 }, updated: clockText() });
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

  // ── a row of chips that scrolls SIDEWAYS in one line (iOS style: no scrollbar, the mouse wheel / a touchpad moves it, a soft fade shows there is more) ──
  // The page still scrolls up and down: the wheel is only taken while the row can move that way; at either end (or when everything fits) it goes on to the page.
  function hscroll(sc) {
    const edges = () => { const max = sc.scrollWidth - sc.clientWidth; sc.classList.toggle("more-l", sc.scrollLeft > 1); sc.classList.toggle("more-r", max > 1 && sc.scrollLeft < max - 1); };
    sc.addEventListener("scroll", edges, { passive: true });
    sc.addEventListener("wheel", (e) => {
      const max = sc.scrollWidth - sc.clientWidth;
      if (max <= 1) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d || (d < 0 && sc.scrollLeft <= 0) || (d > 0 && sc.scrollLeft >= max - 1)) return;
      e.preventDefault(); sc.scrollLeft = Math.max(0, Math.min(max, sc.scrollLeft + d));
    }, { passive: false });
    if (typeof ResizeObserver === "function") new ResizeObserver(edges).observe(sc);
    edges();
    return sc;
  }

  // ── a chip with a radio dot ──
  function chip(text, on, onClick) {
    const b = el("button", "c-chip" + (on ? " on" : "")); b.type = "button";
    b.appendChild(el("span", "c-radio")); b.appendChild(el("span", "", text));
    b.addEventListener("click", onClick);
    return b;
  }

  const cleanNumber = (s) => { let v = String(s).replace(/[^0-9.]/g, ""); const i = v.indexOf("."); if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, ""); const m = v.match(/^(\d{0,4})(\.\d{0,3})?/); return m ? m[0] : ""; };
  // "Add St." and the grey + add a part; the grey - takes the LAST added part away again (the first part stays: nothing was added, so nothing to take away).
  // (The grey buttons used to change the weight by 0.05 ct; the owner asked for this instead.)
  function addPart() {
    if (!st || st.parts.length >= 6) return;
    st.parts.push(newPart()); st.active = st.parts.length - 1; renderParts();
    if (ui.body.lastElementChild) ui.body.lastElementChild.classList.add("enter");
    ui.body.scrollTo({ top: ui.body.scrollHeight, behavior: "smooth" });
  }
  function removeLastPart() {
    if (!st || st.parts.length <= 1) return;
    st.parts.pop(); st.active = Math.min(st.active, st.parts.length - 1); renderParts();
  }

  // ── the frame: header (tabs, price update), three views, footer ──
  function buildFrame() {
    root.textContent = "";
    const stage = el("div", "c-stage"); ui.stage = stage; root.appendChild(stage);

    const head = el("header", "c-head"); stage.appendChild(head); ui.head = head;
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
    // Enter or Tab in the stone weight moves on to Part A's weight (its input is hidden until the box is opened, so Tab alone would skip it)
    ui.stoneIn.addEventListener("keydown", (e) => {
      if ((e.key !== "Enter" && e.key !== "Tab") || e.shiftKey) return;
      const pw = ui.body && ui.body.querySelector(".c-pw");
      if (!pw) return;
      e.preventDefault(); pw.click();
      const inp = pw.querySelector("input"); if (inp) inp.select();
    });
    ui.stoneIn.addEventListener("input", () => { ui.stoneIn.value = cleanNumber(ui.stoneIn.value); st.stone = ui.stoneIn.value; refresh(); });
    const sum = el("div", "c-sum"); top.appendChild(sum);
    ui.sum = {};
    [["polish", "Polish"], ["result", "Result"], ["total", "Total Polish"], ["rough", "Rough $/Ct."]].forEach(([k, label]) => {
      const c = el("div"); c.appendChild(el("label", "", label)); ui.sum[k] = el("b", k === "result" ? "res" : ""); c.appendChild(ui.sum[k]); sum.appendChild(c);
    });
    ui.labs = el("div", "c-labs");
    ui.labSpans = [];
    P.labs().forEach((name) => { const d = el("div"); d.appendChild(el("b", "", name)); const sp = el("span", "", "$0.00/Ct."); d.appendChild(sp); ui.labSpans.push(sp); ui.labs.appendChild(d); });
    top.appendChild(ui.labs);
    ui.body = el("div", "c-body"); calc.appendChild(ui.body);
    const actions = el("div", "c-actions"); calc.appendChild(actions);
    const red = el("button", "c-btn red"); red.type = "button"; red.title = "Remove all parts"; red.appendChild(icon("minusCircle"));
    // the red button clears EVERY part (owner's change; it used to remove only the last one). The screen always keeps one part to work on, so "all removed" = one fresh,
    // empty part A. The stone weight is not touched (Settings > Reset calculator clears that too).
    red.addEventListener("click", () => { st.parts = [newPart()]; st.active = 0; renderParts(); });
    // the blue button used to be "Add St." (the grey + does that now): it calculates and shows the result (owner's choice)
    const add = el("button", "c-btn blue"); add.type = "button"; add.title = "Calculate and show the result"; add.appendChild(icon("calc")); add.appendChild(el("span", "", "Calculate"));
    add.addEventListener("click", showResult);
    const minus = el("button", "c-btn grey"); minus.type = "button"; minus.title = "Remove the last added part"; minus.appendChild(icon("minus"));
    minus.addEventListener("click", removeLastPart);
    const plus = el("button", "c-btn grey"); plus.type = "button"; plus.title = "Add another part"; plus.appendChild(icon("plus"));
    plus.addEventListener("click", () => { api.plus(); addPart(); });   // main counts the quick presses (five of them open the browser)
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
    ui.body.classList.toggle("one", st.parts.length === 1);   // one part: no scrollbar (it only showed because the lab table made the card a few px too tall)
    st.parts.forEach((p, i) => ui.body.appendChild(buildCard(p, i)));
    cardRefs.forEach((r) => r.wheels.forEach((w) => w.init()));   // the cards are in the document now: the wheels can scroll to their start items
    refresh();
  }

  const WHEEL_HEADS = [["Shape", "w-shape"], ["Colour", "w-color"], ["Clarity", "w-clar"], ["Fluor.", "w-fluor"], ["Add. Disc.", "w-disc"]];
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
    // The input is display:none until the box has the "focus" / "has" class, and a hidden input cannot take focus - so a click on the box (or its label) first
    // shows the input, THEN focuses it. (Clicking did nothing at all before: typing into the part weight only worked from a script.)
    const openInput = () => { pw.classList.add("focus"); input.focus(); };
    label.addEventListener("click", openInput);
    pw.addEventListener("click", openInput);
    input.addEventListener("focus", () => { pw.classList.add("focus"); st.active = i; setLabel(); });
    // like the ERP's validateWeight(): a weight is shown with three decimals once the box is left
    input.addEventListener("blur", () => { const f = parseFloat(p.weight); if (Number.isFinite(f) && f > 0) { p.weight = f.toFixed(3); input.value = p.weight; refresh(); } pw.classList.remove("focus"); pw.classList.toggle("has", !!p.weight); setLabel(); });
    input.addEventListener("input", () => { input.value = cleanNumber(input.value); p.weight = input.value; pw.classList.toggle("has", !!p.weight); setLabel(); refresh(); });
    setLabel();

    const work = el("div", "c-work"); card.appendChild(work);
    const box = el("div", "c-wheelbox"); work.appendChild(box);
    const heads = el("div", "c-wheel-heads"); box.appendChild(heads);
    WHEEL_HEADS.forEach(([t, c]) => heads.appendChild(el("span", c, t)));
    const wheels = el("div", "c-wheels"); box.appendChild(wheels);
    ref.wheels = [];
    // a wheel shows `labels` and writes the matching value into p[field]
    const mk = (values, labels, cur, field, cls, after) => {
      const w = makeWheel(labels, Math.max(0, values.indexOf(cur)), (idx) => { p[field] = values[idx]; if (after) after(); refresh(); }, cls);
      wheels.appendChild(w.el); ref.wheels.push(w);
    };
    mk(P.shapes().map((x) => x.code), P.shapes().map((x) => x.name), p.shape, "shape", "w-shape", () => paintGrades());   // a new shape can change the sub-cuts
    mk(P.colors(), P.colors(), p.color, "color", "w-color");
    mk(P.clarities(), P.clarities(), p.clarity, "clarity", "w-clar");
    mk(P.fluorescence(), P.fluorescence(), p.fluor, "fluor", "w-fluor");
    mk(ADDISC, ADDISC.map((v) => v + "%"), p.adDisc, "adDisc", "w-disc");

    const gr = el("div", "c-grades"); work.appendChild(gr);
    gr.appendChild(el("div", "c-sectitle", "CPS"));
    const presets = hscroll(el("div", "c-chips")); gr.appendChild(presets);
    // the Lab row and the Depth / Ratio boxes sit UNDER THE WHEELS (the .c-under block, grid row 2 of the left column): the right column alone was much taller than the
    // wheels and left an empty block below them
    const under = el("div", "c-under"); work.appendChild(under);
    const mkRow = (name, key, parent) => { const row = el("div", "c-row"); row.appendChild(el("span", "c-lbl", name)); row.dataset.key = key; row.chips = hscroll(el("div", "c-rowscroll")); row.appendChild(row.chips); (parent || gr).appendChild(row); return row; };
    const rowCut = mkRow("Cut", "C"), rowSub = mkRow("SubCut", "SC"), rowPol = mkRow("Polish", "P"), rowSym = mkRow("Symmetry", "S"), rowLab = mkRow("Lab", "L", under);
    const cuts = P.cuts(), gradeRows = [];
    [[rowCut, 0], [rowPol, 1], [rowSym, 2]].forEach(([row, k]) => {
      gradeRows[k] = cuts.map((g) => { const c = chip(g, false, () => { p.grades[k] = g; paintGrades(); refresh(); }); row.chips.appendChild(c); return c; });
    });
    // the sub-cuts on offer depend on the shape and the cut grade (the ERP's getSubCut); none for FR / PR, then the row is hidden
    let subChips = [];
    const buildSubCuts = () => {
      const list = P.subCutsFor(p.shape, p.grades[0]);
      if (!list.some((x) => x.code === p.subCut)) p.subCut = list.length ? list[0].code : null;
      subChips.forEach((c) => c.remove()); subChips = [];
      rowSub.hidden = list.length === 0;
      list.forEach((x) => { const c = chip(x.code, x.code === p.subCut, () => { p.subCut = x.code; subChips.forEach((o) => o.classList.toggle("on", o.dataset.code === p.subCut)); refresh(); }); c.dataset.code = x.code; rowSub.chips.appendChild(c); subChips.push(c); });
      rowSub.chips.scrollLeft = 0;
    };
    const paintGrades = () => {
      const cur = P.presetOf(p.grades);
      ref.presetChips.forEach((c) => c.classList.toggle("on", c.dataset.code === cur));
      gradeRows.forEach((r, k) => r.forEach((c, g) => c.classList.toggle("on", cuts[g] === p.grades[k])));
      buildSubCuts();
    };
    ref.presetChips = P.cpsNames().map((n) => { const c = chip(n, false, () => { p.grades = P.cpsTriple(n); paintGrades(); refresh(); }); c.dataset.code = n; presets.appendChild(c); return c; });
    const labChips = P.labsAll().map((l) => { const c = chip(l, false, () => { p.lab = l; paintLab(); refresh(); }); c.dataset.code = l; rowLab.chips.appendChild(c); return c; });
    // the Additional Discount only counts for the labs the data names (the ERP: NONE and FC; AUTO may pick NONE): the wheel is dimmed otherwise
    const paintLab = () => {
      labChips.forEach((c) => c.classList.toggle("on", c.dataset.code === p.lab));
      const applies = p.lab === "AUTO" || P.adDiscApplies(p.lab), wd = ref.wheels[4];
      wd.el.classList.toggle("na", !applies);
      wd.el.title = applies ? "Additional discount: used instead of the lab's discount" : "Additional discount: only used with the labs " + P.data().adDiscLabs.join(" / ") + " (and AUTO)";
    };
    // depth and ratio (they move the discount a little when they are far from ideal)
    const meas = el("div", "c-meas"); under.appendChild(meas);
    [["Depth", "depth", ""], ["Ratio", "ratio", ""]].forEach(([title, key, unit]) => {
      const f = el("label", "c-mini"); f.appendChild(el("span", "", title));
      const inp = el("input"); inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.maxLength = 6; inp.value = p[key]; inp.dataset.key = key;
      inp.addEventListener("input", () => { inp.value = cleanNumber(inp.value); p[key] = inp.value; refresh(); });
      f.appendChild(inp); if (unit) f.appendChild(el("em", "", unit)); meas.appendChild(f);
    });
    p.grades = p.grades.slice();
    paintGrades(); paintLab();

    ref.line = el("div", "c-line"); card.appendChild(ref.line);
    ref.table = el("div", "c-table"); card.appendChild(ref.table);
    const head2 = el("div", "r h"); ["Lab", "Disc.", "$/ct.", "Total"].forEach((t) => head2.appendChild(el("div", "h", t))); ref.table.appendChild(head2);
    ref.labRows = [];
    P.labs().forEach((name) => {
      const r = el("div", "r"); const cells = [el("div", "", "0.00%"), el("div", "", "$0.00"), el("div", "red", "$0.00")];
      r.appendChild(el("div", "lab", name)); cells.forEach((c) => r.appendChild(c)); ref.table.appendChild(r); ref.labRows.push(cells);
    });
    return card;
  }

  // ── numbers ──
  function numSpan(text, nonzero) { return el("b", nonzero ? "nz" : "", text); }
  function refresh() {
    if (!built || !st) return;
    const s = P.summary(st.parts, st.stone, st.drift);
    // a number that CHANGED pulses once (decorative: the text is set at once, the class only adds a short flourish)
    const put = (node, text) => { if (node.textContent === text) return; node.textContent = text; if (ui.stage.classList.contains("intro")) return; node.classList.remove("bump"); void node.offsetWidth; node.classList.add("bump"); };
    put(ui.sum.polish, s.polish.toFixed(2) + " Ct.");
    put(ui.sum.result, s.result.toFixed(2) + "%");
    ui.sum.result.classList.toggle("pos", s.result > 0);
    put(ui.sum.total, money(s.total));
    put(ui.sum.rough, money(s.rough));
    s.labs.forEach((l, k) => { if (ui.labSpans[k]) ui.labSpans[k].textContent = money(l.rough) + "/Ct."; });   // each lab's rough $/Ct.
    const showLabs = st.prefs.labs;   // shown from the start (zeros until a weight is entered), so the screen never opens half empty
    ui.labs.classList.toggle("show", showLabs);
    s.parts.forEach((r, i) => {
      const ref = cardRefs[i]; if (!ref) return;
      ref.line.textContent = "";
      ref.line.append("List ", numSpan(String(r.rate), r.rate > 0), " Disc ", numSpan(r.discount.toFixed(2) + "%", r.discount > 0), " $/Ct. ", numSpan(r.pcAvg.toFixed(2), r.pcAvg > 0), " Total ", numSpan(r.amount.toFixed(2), r.amount > 0));
      ref.table.classList.toggle("show", showLabs);
      r.labs.forEach((l, k) => { const c = ref.labRows && ref.labRows[k]; if (!c) return; c[0].textContent = l.discount.toFixed(2) + "%"; c[1].textContent = money(l.pcAvg); c[2].textContent = money(l.amount); });
    });
  }

  // ── the "Calculate" button: works everything out and shows it in one place - the four totals and one row per part. In memory only, like the settings dialog ──
  function showResult() {
    if (!st || ui.modal) return;
    refresh();
    const s = P.summary(st.parts, st.stone, st.drift);
    const stone = P.num(st.stone);
    const modal = el("div", "c-modal"); ui.modal = modal;
    // (wide for the table, compact for a one-line message)
    const dlg = el("div", "c-dialog " + (s.polish > 0 ? "wide" : "narrow")); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "c-res-title"); modal.appendChild(dlg);
    const h = el("h2"); h.id = "c-res-title"; h.appendChild(icon("calc")); h.appendChild(el("span", "", "Result")); dlg.appendChild(h);
    dlg.appendChild(el("p", "c-sub", stone ? "Stone weight " + stone.toFixed(2) + " Ct." : "No stone weight entered: the result % and the rough price need it."));
    if (!(s.polish > 0)) {
      dlg.appendChild(el("p", "c-res-empty", "Enter at least one part weight to calculate."));
    } else {
      const tiles = el("div", "c-res-sum"); dlg.appendChild(tiles);
      [["Polish", s.polish.toFixed(2) + " Ct.", ""], ["Result", s.result.toFixed(2) + "%", s.result > 0 ? "pos" : "res"], ["Total Polish", money(s.total), ""], ["Rough $/Ct.", money(s.rough), ""]]
        .forEach(([label, value, cls]) => { const d = el("div"); d.appendChild(el("span", "", label)); d.appendChild(el("b", cls, value)); tiles.appendChild(d); });
      const table = el("div", "c-res-table"); dlg.appendChild(table);
      const row = (cells, cls) => { const r = el("div", "r" + (cls ? " " + cls : "")); cells.forEach((c) => r.appendChild(el("span", "", c))); table.appendChild(r); };
      row(["Part", "Weight", "Stone", "Grade", "Lab", "Disc.", "List $/Ct.", "$/Ct.", "Net"], "h");
      st.parts.forEach((p, i) => {
        const r = s.parts[i];
        row([letter(i), r.weight ? r.weight.toFixed(3) + " Ct." : "-", P.shapeOf(p.shape).name + " " + p.color + " " + p.clarity + " " + p.fluor, (P.presetOf(p.grades) || p.grades.join("/")) + (p.subCut ? " " + p.subCut : ""),
          r.weight ? r.lab : "-", r.weight ? r.discount.toFixed(2) + "%" : "-", r.weight ? String(r.rate) : "-", r.weight ? r.pcAvg.toFixed(2) : "-", r.weight ? money(r.amount) : "-"]);
      });
    }
    const foot = el("div", "c-foot2"); dlg.appendChild(foot);
    foot.appendChild(el("span"));
    const done = el("button", "c-dlgbtn primary", "Done"); done.type = "button"; done.dataset.act = "done"; done.addEventListener("click", closeSettings);
    foot.appendChild(done);
    modal.addEventListener("pointerdown", (e) => { if (e.target === modal) closeSettings(); });
    ui.stage.appendChild(modal);
    done.focus();
  }

  // ── settings dialog (the gear): theme, default discount, lab table, reset. In memory only: gone with the calculator ──
  // the system's window buttons take the header's colour and height (electron/theme.js setCalcChrome); the header's height follows the window width, so it is read, not assumed
  function syncChrome() { try { if (ui && ui.head && st) api.chrome({ dark: st.prefs.dark, height: Math.round(ui.head.getBoundingClientRect().height) }); } catch (_) {} }
  window.addEventListener("resize", () => { clearTimeout(syncChrome.t); syncChrome.t = setTimeout(syncChrome, 120); });
  // main (mainWindow.js) calls this while the window is still invisible and already maximized: the header has its final height by now, so the window buttons are
  // given it (twice: the second time after the layout has settled) BEFORE anything is seen
  window.__calcSettle = () => new Promise((resolve) => { syncChrome(); setTimeout(() => { syncChrome(); setTimeout(resolve, 60); }, 140); });
  function applyTheme() { ui.stage.classList.toggle("dark", st.prefs.dark); syncChrome(); }
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
    // default additional discount
    const stepper = el("div", "c-stepper"); const dm = el("button", "", "−"), dp = el("button", "", "+"), out = el("output", "", st.prefs.defaultAdDisc + "%"); dm.type = dp.type = "button";
    const setDisc = (v) => { st.prefs.defaultAdDisc = Math.max(0, Math.min(20, v)); out.textContent = st.prefs.defaultAdDisc + "%"; };
    dm.addEventListener("click", () => setDisc(st.prefs.defaultAdDisc - 1)); dp.addEventListener("click", () => setDisc(st.prefs.defaultAdDisc + 1));
    stepper.append(dm, out, dp);
    const drow = row("Default additional discount", "Used for new parts (labs NONE / FC)", stepper);
    const apply = el("button", "c-dlgbtn", "Apply to all parts"); apply.type = "button"; apply.dataset.act = "apply";
    apply.addEventListener("click", () => { st.parts.forEach((p, i) => { p.adDisc = st.prefs.defaultAdDisc; const w = cardRefs[i] && cardRefs[i].wheels[4]; if (w) w.set(ADDISC.indexOf(p.adDisc)); }); refresh(); });
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
    buildFrame(); applyTheme(); showTab("calc"); ui.upd.textContent = "Prices updated " + st.updated;
    ui.stage.classList.add("intro");               // the entrance animation (decorative; removed again so later changes do not replay it)
    renderParts();
    setTimeout(() => { if (ui && ui.stage) ui.stage.classList.remove("intro"); }, 1500);
    syncChrome(); setTimeout(syncChrome, 200);
  }
  function hide() {
    document.body.classList.remove("calc-mode");
    closeSettings();
    root.textContent = ""; ui = {}; built = false; st = null;   // nothing of the screen is kept while the browser is in use
    cardRefs.length = 0;                                         // (the cards' elements and handlers can be collected)
    try { P.configure(null); } catch (_) {}                      // ...and so is the price data: the calculator never comes back in this run
  }
  // The screen needs the data (calc-data.json, read by the main process each time) before it can be built. begin() fetches it, then shows - once, and only if the
  // calculator is still wanted by then.
  let wanted = false, starting = false;
  async function begin() {
    if (st || starting) return;
    starting = true;
    try { const d = await api.getData(); if (d) P.configure(d); } catch (_) {}
    starting = false;
    if (wanted && !st) { show(); setTimeout(() => { try { api.ready(); } catch (_) {} }, 60); }   // (main shows the window once this arrives)
  }
  api.onMode((on) => { wanted = !!on; if (on) begin(); else hide(); });         // (never rebuild a screen that is already up: it would drop what was typed)
  api.getMode().then((on) => { if (on) { wanted = true; begin(); } else if (!st) { document.body.classList.remove("calc-mode"); try { api.ready(); } catch (_) {} } }).catch(() => { document.body.classList.remove("calc-mode"); });
})();
