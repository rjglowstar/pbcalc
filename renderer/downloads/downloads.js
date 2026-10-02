(function () {
  const api = window.downloadsAPI;
  const I = window.PBIcons;
  const $ = (id) => document.getElementById(id);
  if (!api) return;

  let items = [];
  I.set($("search-icon"), "search");

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fmt(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(1) + " GB";
  }

  // Chrome groups by day: "Today - Wednesday, September 30, 2026", "Yesterday - ...", or the date.
  function dayLabel(t) {
    const d = new Date(t);
    const full = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(new Date()) - start(d)) / 86400000);
    if (diff === 0) return "Today - " + full;
    if (diff === 1) return "Yesterday - " + full;
    return full;
  }

  function speedLine(d) {
    const got = fmt(d.received);
    const of = d.total > 0 ? " of " + fmt(d.total) : "";
    if (d.paused) return "Paused - " + got + of;
    if (d.stalled) return "Stalled - " + got + of;
    if (d.resuming) return "Resuming... - " + got + of;
    if (!d.received) return "Starting…";
    return fmt(d.speed || 0) + "/s - " + got + of;
  }

  function actionBtn(icon, title, name, id) {
    const b = el("button");
    b.title = title;
    b.appendChild(I.icon(icon));
    b.addEventListener("click", () => api.action(name, id));
    return b;
  }

  // Chrome's ⋮ on a row: Pause/Resume + Cancel while running, Retry + Remove once it failed.
  function closeMenu() {
    const m = document.querySelector(".rowmenu");
    if (m) m.remove();
  }
  document.addEventListener("click", (e) => { if (!e.target.closest(".rowmenu, .more")) closeMenu(); });

  function moreBtn(d) {
    const b = el("button", "more");
    b.title = "More actions";
    b.appendChild(I.icon("moreVert"));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = document.querySelector(".rowmenu");
      closeMenu();
      if (open && open.dataset.id === String(d.id)) return;
      const m = el("div", "rowmenu");
      m.dataset.id = String(d.id);
      const entries = d.state === "progressing"
        ? (d.stalled
            ? [["Retry", "retry"], ["Cancel", "cancel"]]
            : [[d.paused ? "Resume" : "Pause", "pause"], ["Cancel", "cancel"]])
        : [["Remove from list", "remove"], ["Retry", "retry"]];
      entries.forEach(([label, name]) => {
        const it = el("div", "mi", label);
        it.addEventListener("click", () => { closeMenu(); api.action(name, d.id); });
        m.appendChild(it);
      });
      const r = b.getBoundingClientRect();
      m.style.top = window.scrollY + r.bottom + 4 + "px";
      m.style.left = Math.max(8, r.right - 170) + "px";
      document.body.appendChild(m);
    });
    return b;
  }

  function row(d) {
    const dead = d.deleted || d.state === "cancelled" || d.state === "interrupted";
    const r = el("div", "item" + (dead ? " dead" : ""));
    // The page keeps the file-type icon even for a cancelled row (Chrome does); only the bubble
    // swaps in the "cancelled" glyph.
    const ico = el("span", "ico");
    if (d.icon) {
      const img = el("img");
      img.src = d.icon;
      img.alt = "";
      ico.appendChild(img);
    } else {
      ico.appendChild(I.icon(d.state === "cancelled" || d.state === "interrupted" ? "cancelled" : "download"));
    }
    r.appendChild(ico);

    const meta = el("div", "meta");
    const name = el("div", "name");
    if (d.state === "completed" && !d.deleted) {
      const a = el("a", null, d.filename);
      a.addEventListener("click", () => api.action("open", d.id));
      name.appendChild(a);
    } else {
      // only a cancelled / failed / deleted name is struck through; a running one is just bold
      name.appendChild(el("span", dead ? "struck" : "running", d.filename));
      if (d.state === "cancelled") name.appendChild(el("span", "tag", "Canceled"));
      else if (d.state === "interrupted") name.appendChild(el("span", "tag", "Failed"));
      else if (d.deleted) name.appendChild(el("span", "tag", "Deleted"));
    }
    meta.appendChild(name);
    if (d.from) meta.appendChild(el("div", "sub", "From " + d.from));
    if (d.state === "progressing") {
      const status = el("div", "status", speedLine(d));
      meta.appendChild(status);
      const bar = el("div", "bar" + (d.total > 0 ? "" : " indet"));
      const fill = el("div");
      if (d.total > 0) fill.style.width = Math.min(100, (d.received / d.total) * 100) + "%";
      bar.appendChild(fill);
      meta.appendChild(bar);
      r._status = status; // patched in place on every progress tick (see render)
      r._fill = fill;
    }
    r.appendChild(meta);

    const acts = el("div", "acts");
    if (d.from) acts.appendChild(actionBtn("link", "Copy link address", "copy-link", d.id));
    if (d.state === "completed" && !d.deleted) acts.appendChild(actionBtn("folder", "Show in folder", "show", d.id));
    else acts.appendChild(moreBtn(d));
    // Chrome offers "remove from the list" only once the download is over. A running or paused one
    // is ended through Cancel in the ⋮ menu, never by quietly dropping the row.
    if (d.state !== "progressing") acts.appendChild(actionBtn("close", "Remove from list", "remove", d.id));
    r.appendChild(acts);
    return r;
  }

  // Downloads tick several times a second. Rebuilding the list on every tick tears the row out
  // from under the pointer and the click never lands, so a tick that only moved the byte counter
  // patches the existing rows instead; the DOM is rebuilt only when a row really changes shape.
  const shapeOf = (d) => [d.id, d.state, d.paused, d.stalled, d.deleted, !!d.icon, !!d.from].join("|");
  let shape = null;
  const rowEls = new Map();

  function render() {
    const q = $("search").value.trim().toLowerCase();
    const shown = items.filter((d) => !q || (d.filename + " " + (d.from || "")).toLowerCase().includes(q)).reverse();
    const next = shown.map(shapeOf).join(",") + "::" + q;

    if (next === shape) {
      shown.forEach((d) => {
        const r = rowEls.get(d.id);
        if (!r) return;
        if (r._status) r._status.textContent = speedLine(d);
        if (r._fill && d.total > 0) r._fill.style.width = Math.min(100, (d.received / d.total) * 100) + "%";
      });
      return;
    }
    shape = next;
    closeMenu();
    rowEls.clear();

    const groups = $("groups");
    groups.textContent = "";
    let lastLabel = null;
    let card = null;
    shown.forEach((d) => {
      const label = dayLabel(d.startedAt);
      if (label !== lastLabel) {
        groups.appendChild(el("div", "day", label));
        card = el("div", "card");
        groups.appendChild(card);
        lastLabel = label;
      }
      const r = row(d);
      rowEls.set(d.id, r);
      card.appendChild(r);
    });
    $("empty").hidden = shown.length > 0;
    $("empty").textContent = items.length ? "No search results found" : "No downloads";
    $("clear-all").disabled = !items.length;
  }

  $("search").addEventListener("input", render);
  $("clear-all").addEventListener("click", () => api.action("clear-all"));
  api.onChanged((list) => { items = list || []; render(); });
  // a file deleted outside the browser shows up as "Deleted" when the page is looked at again
  window.addEventListener("focus", () => api.list().then((l) => { items = l || []; render(); }));
  api.list().then((l) => { items = l || []; render(); });
})();
