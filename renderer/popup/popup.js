(function () {
  const api = window.popupAPI;
  const I = window.PBIcons;
  const panel = document.getElementById("panel");
  const backdrop = document.getElementById("backdrop");
  if (!api) return;

  let data = null;
  let filter = "";
  let findInput = null;
  let findCount = null;

  const act = (name, arg) => api.action(name, arg);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function place(width, opts = {}) {
    const a = data.anchor;
    const vw = window.innerWidth;
    panel.style.width = width + "px";
    let left = opts.alignRight ? a.right - width : a.left;
    left = Math.max(8, Math.min(left, vw - width - 8));
    panel.style.left = left + "px";
    panel.style.top = a.bottom + 4 + "px";
    panel.style.maxHeight = window.innerHeight - a.bottom - 16 + "px";
  }

  function favIcon(src) {
    const box = el("span", "ico");
    if (src) {
      const img = el("img");
      img.src = src;
      img.alt = "";
      img.addEventListener("error", () => { box.textContent = ""; box.appendChild(I.icon("globe")); });
      box.appendChild(img);
    } else {
      box.appendChild(I.icon("globe"));
    }
    return box;
  }

  // ── tab search ────────────────────────────────────────────────────────
  function renderTabSearch() {
    const keep = panel.querySelector("input");
    const hadFocus = keep && document.activeElement === keep;
    panel.textContent = "";
    place(320);

    const search = el("div", "search");
    search.appendChild(I.icon("search"));
    const input = el("input");
    input.type = "text";
    input.placeholder = "Search Tabs";
    input.value = filter;
    input.addEventListener("input", () => { filter = input.value; renderTabSearch(); });
    search.appendChild(input);
    search.appendChild(el("span", "hint", "Ctrl+Shift+A"));
    panel.appendChild(search);

    panel.appendChild(el("div", "section", "Open Tabs"));
    const list = el("div", "list");
    const q = filter.trim().toLowerCase();
    const tabs = data.tabs.filter((t) => !q || (t.title + " " + t.host).toLowerCase().includes(q));
    if (!tabs.length) list.appendChild(el("div", "empty", "No matching tabs"));
    tabs.forEach((t) => {
      const row = el("div", "row" + (t.active ? " active" : ""));
      row.appendChild(favIcon(t.favicon));
      const meta = el("div", "meta");
      meta.appendChild(el("div", "title", t.title || "New Tab"));
      meta.appendChild(el("div", "sub", t.host));
      row.appendChild(meta);
      const x = el("button", "x");
      x.title = "Close tab";
      x.appendChild(I.icon("close"));
      x.addEventListener("click", (e) => { e.stopPropagation(); act("close-tab", t.id); });
      row.appendChild(x);
      row.addEventListener("click", () => act("activate-tab", t.id));
      list.appendChild(row);
    });
    panel.appendChild(list);
    if (!keep || hadFocus) input.focus();
    if (keep) input.setSelectionRange(input.value.length, input.value.length);
  }

  // ── ⋮ menu ────────────────────────────────────────────────────────────
  function menuItem(label, hint, onClick, opts = {}) {
    const row = el("div", "item");
    if (opts.check) row.appendChild(el("span", "check", "✓")); // sits in the left gutter, label stays aligned
    row.appendChild(el("span", "label", label));
    if (hint) row.appendChild(el("span", "hint", hint));
    if (opts.disabled) { row.style.opacity = "0.4"; return row; }
    row.addEventListener("click", onClick);
    return row;
  }

  function renderMenu() {
    panel.textContent = "";
    place(300, { alignRight: true });
    panel.appendChild(menuItem("New tab", "Ctrl+T", () => act("new-tab")));
    panel.appendChild(el("div", "sep"));
    panel.appendChild(menuItem("Downloads", "Ctrl+J", () => act("downloads")));
    if (!data.restricted) {
      panel.appendChild(menuItem(data.bookmarked ? "Remove this bookmark" : "Bookmark this tab…", "Ctrl+D",
        () => act("bookmark-active"), { disabled: !data.canBookmark }));
    }
    // Hiding/showing the bar is allowed in Restricted Mode; EDITING bookmarks is not.
    panel.appendChild(menuItem("Show bookmarks bar", "Ctrl+Shift+B", () => act("toggle-bookmarks-bar"), { check: data.bookmarksBar }));
    panel.appendChild(el("div", "sep"));

    const zoom = el("div", "item zoom-row");
    zoom.appendChild(el("span", "label", "Zoom"));
    const minus = el("button", "zbtn", "−");
    minus.addEventListener("click", () => act("zoom", -1));
    const val = el("span", "zval", data.zoom + "%");
    val.title = "Reset zoom";
    val.addEventListener("click", () => act("zoom", 0));
    const plus = el("button", "zbtn", "+");
    plus.addEventListener("click", () => act("zoom", 1));
    const full = el("button", "zbtn");
    full.title = "Full screen (F11)";
    full.appendChild(I.icon("fullscreen"));
    full.addEventListener("click", () => act("fullscreen"));
    [minus, val, plus, full].forEach((n) => zoom.appendChild(n));
    panel.appendChild(zoom);
    panel.appendChild(el("div", "sep"));

    panel.appendChild(menuItem("Print…", "Ctrl+P", () => act("print")));
    panel.appendChild(menuItem("Find…", "Ctrl+F", () => act("find")));
    if (!data.restricted) {
      panel.appendChild(menuItem("Bookmark manager", "Ctrl+Shift+O", () => act("bookmark-manager")));
      panel.appendChild(menuItem("Developer tools", "Ctrl+Shift+I", () => act("devtools")));
    }
    panel.appendChild(el("div", "sep"));
    panel.appendChild(menuItem("Settings", "", () => act("settings")));
    panel.appendChild(el("div", "sep"));
    panel.appendChild(menuItem("Exit", "", () => act("exit")));
  }

  // ── downloads ─────────────────────────────────────────────────────────
  function fmt(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function ago(t) {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return m + (m === 1 ? " minute ago" : " minutes ago");
    const h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    const d = Math.floor(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }

  // Chrome's "34 seconds left" / "2 minutes left".
  function eta(sec) {
    if (sec < 60) return Math.max(1, Math.round(sec)) + " seconds left";
    const m = Math.round(sec / 60);
    if (m < 60) return m + (m === 1 ? " minute left" : " minutes left");
    const h = Math.round(m / 60);
    return h + (h === 1 ? " hour left" : " hours left");
  }

  // The second line of a bubble row, word for word as Chrome writes it.
  function dlStatus(d) {
    if (d.state === "cancelled") return "Canceled";
    if (d.state === "interrupted") return "Failed";
    if (d.state === "progressing") {
      const size = d.total > 0 ? fmt(d.received) + "/" + fmt(d.total) : fmt(d.received);
      if (d.paused) return size + " • Paused";
      if (d.stalled) return size + " • Stalled";       // nothing has arrived for a while
      if (d.resuming) return size + " • Resuming...";  // only after an actual Resume
      if (!d.received) return "Starting…";
      if (!d.speed) return size;                            // moving, speed not sampled yet
      if (d.total > 0) return size + " • " + eta((d.total - d.received) / d.speed);
      return size + " • " + fmt(d.speed) + "/s";
    }
    if (d.deleted) return "File deleted";
    return fmt(d.received) + " • " + (Date.now() - d.startedAt < 60000 ? "Done" : ago(d.startedAt));
  }

  // Chrome has two bubbles: the compact one that pops up by itself when a download starts or
  // finishes (just the rows), and the full one you get by clicking the toolbar button (title,
  // every recent row, and the link to the whole page).
  function partialItems(items) {
    const fresh = items.filter((d) => d.state === "progressing" || Date.now() - d.startedAt < 60000);
    const pick = (fresh.length ? fresh : items.slice(-1)).slice(-3);
    return pick.reverse();
  }

  // Same rule as the Downloads page: a tick that only moved the byte counter patches the rows it
  // already drew, so a button is never torn out from under the pointer mid-click.
  const dlShape = (d) => [d.id, d.state, d.paused, d.stalled, d.deleted, !!d.icon].join("|");
  let dlShapeNow = null;
  const dlRows = new Map();

  function renderDownloads() {
    const compact = !!data.partial;
    const shown = compact ? partialItems(data.items) : data.items.slice().reverse().slice(0, 5);
    const next = shown.map(dlShape).join(",") + "::" + compact;
    if (next === dlShapeNow && dlRows.size) {
      shown.forEach((d) => {
        const r = dlRows.get(d.id);
        if (!r) return;
        if (r._sub) r._sub.textContent = dlStatus(d);
        if (r._fill && d.total > 0) r._fill.style.width = Math.min(100, (d.received / d.total) * 100) + "%";
      });
      return;
    }
    dlShapeNow = next;
    dlRows.clear();

    panel.textContent = "";
    place(400, { alignRight: true });
    const head = el("div", "dl-head");
    head.appendChild(el("span", "dl-title", "Recent download history"));
    const close = el("button", "dl-close");
    close.title = "Close";
    close.appendChild(I.icon("close"));
    close.addEventListener("click", () => act("close"));
    head.appendChild(close);
    if (!compact) panel.appendChild(head);

    const list = el("div", "list");
    if (!data.items.length) list.appendChild(el("div", "empty", "No recent downloads"));
    shown.forEach((d) => {
      const done = d.state === "completed" && !d.deleted;
      const row = el("div", "row dl-row" + (d.deleted ? " deleted" : ""));
      const ico = el("span", "ico dl-ico");
      if (d.state === "cancelled" || d.state === "interrupted") ico.appendChild(I.icon("cancelled"));
      else if (d.icon) {
        const img = el("img");
        img.src = d.icon;
        img.alt = "";
        ico.appendChild(img);
      } else {
        ico.appendChild(I.icon("download"));
      }
      row.appendChild(ico);

      const meta = el("div", "meta");
      meta.appendChild(el("div", "title dl-name", d.filename));
      const sub = el("div", "sub", dlStatus(d));
      meta.appendChild(sub);
      row._sub = sub;
      if (d.state === "progressing") {
        const bar = el("div", "bar" + (d.total > 0 ? "" : " indet"));
        const fill = el("div");
        if (d.total > 0) fill.style.width = Math.min(100, (d.received / d.total) * 100) + "%";
        bar.appendChild(fill);
        meta.appendChild(bar);
        row._fill = fill;
      }
      dlRows.set(d.id, row);
      row.appendChild(meta);

      const actions = el("div", "dl-actions");
      const iconBtn = (icon, title, name) => {
        const b = el("button", "dl-btn");
        b.title = title;
        b.appendChild(I.icon(icon));
        b.addEventListener("click", (e) => { e.stopPropagation(); act(name, d.id); });
        return b;
      };
      if (d.state === "progressing") {
        if (d.stalled) actions.appendChild(iconBtn("reload", "Retry", "dl-retry"));
        else actions.appendChild(iconBtn(d.paused ? "play" : "pause", d.paused ? "Resume" : "Pause", "dl-pause"));
        actions.appendChild(iconBtn("close", "Cancel", "dl-cancel"));
      } else if (done) {
        actions.appendChild(iconBtn("folder", "Show in folder", "dl-show"));
        actions.appendChild(iconBtn("openNew", "Open file", "dl-open"));
      } else {
        actions.appendChild(iconBtn("reload", "Retry", "dl-retry"));
        actions.appendChild(iconBtn("close", "Remove from list", "dl-dismiss"));
      }
      row.appendChild(actions);
      if (done) row.addEventListener("click", () => act("dl-open", d.id));
      list.appendChild(row);
    });
    panel.appendChild(list);

    if (compact) {
      panel.addEventListener("mouseenter", () => act("hover"), { once: true });
      return;
    }

    const foot = el("div", "dl-foot");
    const all = el("button", "dl-all", "Full download history");
    all.addEventListener("click", () => act("downloads-page"));
    foot.appendChild(all);
    const openIcon = el("span", "dl-foot-ico");
    openIcon.appendChild(I.icon("openNew"));
    foot.appendChild(openIcon);
    panel.appendChild(foot);
    panel.addEventListener("mouseenter", () => act("hover"), { once: true });
  }

  // ── site info ─────────────────────────────────────────────────────────
  function renderSiteInfo() {
    panel.textContent = "";
    place(320);
    const site = data.site || { host: "", siteKind: "internal" };
    panel.appendChild(el("div", "head", site.host));
    const line = el("div", "site-line");
    const secure = site.siteKind === "secure";
    const insecure = site.siteKind === "insecure";
    line.appendChild(I.icon(secure ? "lock" : insecure ? "warning" : "info", insecure ? "bad" : ""));
    const text = el("div");
    text.appendChild(el("div", "", secure ? "Connection is secure" : insecure ? "Connection is not secure" : "Local page"));
    text.appendChild(el("div", "desc", secure
      ? "Information sent to this site, such as passwords, is private while it is sent."
      : insecure
        ? "Do not enter sensitive information (passwords, card numbers) on this site."
        : "This page is stored on your device."));
    line.appendChild(text);
    panel.appendChild(line);
  }

  // ── admin panel (Restricted Mode; opened only by the hidden shortcut) ──────────────────────────
  function renderUnlock() {
    panel.textContent = "";
    place(300, { alignRight: true });
    panel.appendChild(el("div", "head", "Administrator"));
    const body = el("div", "unlock");
    body.appendChild(el("div", "desc", "Restricted Mode is on. Leave it, or manage the list of allowed sites."));
    const manage = el("button", "secondary", "Manage sites");
    const leave = el("button", "primary", "Leave Restricted Mode");
    manage.addEventListener("click", () => api.admin("manage"));
    leave.addEventListener("click", () => api.admin("leave"));
    body.appendChild(manage);
    body.appendChild(leave);
    panel.appendChild(body);
  }

  // ── find bubble ───────────────────────────────────────────────────────
  function renderFind() {
    document.body.classList.add("bubble");
    panel.textContent = "";
    const box = el("div", "findbox");
    findInput = el("input");
    findInput.type = "text";
    findInput.placeholder = "Find in page";
    findInput.spellcheck = false;
    findCount = el("span", "count");
    const btn = (icon, title, fn) => {
      const b = el("button", "fbtn");
      b.title = title;
      b.appendChild(I.icon(icon));
      b.addEventListener("click", fn);
      return b;
    };
    const next = (forward) => act("find-text", { text: findInput.value, opts: { findNext: true, forward } });
    findInput.addEventListener("input", () => act("find-text", { text: findInput.value }));
    findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); next(!e.shiftKey); }
      else if (e.key === "Escape") act("find-close");
    });
    box.appendChild(findInput);
    box.appendChild(findCount);
    box.appendChild(el("span", "div"));
    box.appendChild(btn("arrowUp", "Previous (Shift+Enter)", () => next(false)));
    box.appendChild(btn("arrowDown", "Next (Enter)", () => next(true)));
    box.appendChild(btn("close", "Close (Esc)", () => act("find-close")));
    panel.appendChild(box);
    findInput.focus();
  }

  api.onFindResult((r) => {
    if (!findCount) return;
    findCount.textContent = findInput.value ? (r.total ? r.active + "/" + r.total : "0/0") : "";
  });
  api.onFindFocus(() => { if (findInput) { findInput.focus(); findInput.select(); } });

  function render() {
    if (!data) return;
    if (data.kind === "tabsearch") renderTabSearch();
    else if (data.kind === "menu") renderMenu();
    else if (data.kind === "downloads") renderDownloads();
    else if (data.kind === "siteinfo") renderSiteInfo();
    else if (data.kind === "find") renderFind();
    else if (data.kind === "unlock") renderUnlock();
  }

  backdrop.addEventListener("mousedown", () => act("close"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && data && data.kind !== "find") act("close");
  });
  api.onData((d) => { data = d; render(); });
  api.getData().then((d) => { data = d; render(); });
})();
