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
    panel.appendChild(menuItem("Downloads", "Ctrl+Shift+J", () => act("downloads")));
    if (!data.restricted) {
      // Like the star: adds the page and opens the bubble, or on a bookmarked page opens it to edit/remove. It never
      // removes by itself, so the label must not promise that.
      panel.appendChild(menuItem("Bookmark this tab…", "Ctrl+D",
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
    val.addEventListener("click", () => act("zoom-reset"));
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
      // only a FINISHED download opens when you click its row, so only that row gets the pointer
      if (done) { row.classList.add("openable"); row.addEventListener("click", () => act("dl-open", d.id)); }
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

  // ── edit bookmark (Chrome's "Edit bookmark": Name, URL, Cancel / Save; normal mode only) ──────────
  function renderBookmarkEdit() {
    panel.textContent = "";
    const b = data.bookmark;
    if (!b) { act("close"); return; }
    if (data.bubble) return renderBookmarkBubble(b);
    place(380);
    panel.appendChild(el("div", "head", "Edit bookmark"));
    const form = el("div", "bm-edit");
    const field = (label, value, type) => {
      const wrap = el("label", "bm-field");
      wrap.appendChild(el("span", "bm-label", label));
      const input = el("input");
      input.type = type; input.value = value; input.spellcheck = false;
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    };
    const name = field("Name", b.title, "text");
    const url = field("URL", b.url, "text");
    const msg = el("div", "bm-msg");
    form.appendChild(msg);
    const row = el("div", "bm-buttons");
    const cancel = el("button", "secondary", "Cancel");
    const save = el("button", "primary", "Save");
    row.appendChild(cancel);
    row.appendChild(save);
    form.appendChild(row);
    panel.appendChild(form);
    const ERR = { "bad-url": "Enter a valid web address (http or https).", duplicate: "That address is already bookmarked.", "not-found": "This bookmark no longer exists.", unavailable: "Editing bookmarks is not available." };
    let busy = false;
    const submit = async () => {
      if (busy) return;
      busy = true; save.disabled = true;
      const r = await api.saveBookmark(name.value, url.value).catch(() => ({ ok: false, error: "unavailable" }));
      busy = false; save.disabled = false;
      if (r && r.ok) return;   // main closes the box
      msg.textContent = ERR[r && r.error] || ERR.unavailable;
      url.focus(); url.select();
    };
    cancel.addEventListener("click", () => act("close"));
    save.addEventListener("click", submit);
    form.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    name.focus(); name.select();
  }

  // Chrome's star bubble: "Bookmark added" (or "Edit bookmark" on a page that already is), page tile, Name,
  // Folder, Done / Remove. Every bookmark lives on the bookmarks bar here, so the folder list has that one entry.
  function renderBookmarkBubble(b) {
    panel.textContent = "";
    place(450, { alignRight: true });
    const head = el("div", "bmb-head");
    head.appendChild(el("div", "bmb-title", data.bubble.added ? "Bookmark added" : "Edit bookmark"));
    const x = el("button", "bmb-x");
    x.title = "Close";
    x.appendChild(I.icon("close"));
    head.appendChild(x);
    panel.appendChild(head);
    const body = el("div", "bmb-body");
    const tile = el("div", "bmb-tile");
    tile.appendChild(favIcon(b.favicon));
    body.appendChild(tile);
    const form = el("div", "bmb-form");
    const nameRow = el("label", "bmb-row");
    nameRow.appendChild(el("span", "bmb-label", "Name"));
    const name = el("input");
    name.type = "text"; name.value = b.title; name.spellcheck = false;
    nameRow.appendChild(name);
    const folderRow = el("label", "bmb-row");
    folderRow.appendChild(el("span", "bmb-label", "Folder"));
    const folder = el("select");
    folder.appendChild(el("option", "", "Bookmarks bar"));
    folderRow.appendChild(folder);
    form.appendChild(nameRow);
    form.appendChild(folderRow);
    body.appendChild(form);
    panel.appendChild(body);
    const buttons = el("div", "bmb-buttons");
    const done = el("button", "primary", "Done");
    const remove = el("button", "secondary", "Remove");
    buttons.appendChild(done);
    buttons.appendChild(remove);
    panel.appendChild(buttons);
    // Done, the X and Enter keep the name (Chrome applies it when the bubble closes)
    const finish = async () => { await api.saveBookmark(name.value).catch(() => null); act("close"); };
    done.addEventListener("click", finish);
    x.addEventListener("click", finish);
    remove.addEventListener("click", () => api.removeBookmark());
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(); } });
    name.focus(); name.select();
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

  // The password asked before a saved login is filled. Digits only (0-9, 4 to 8). The answer comes from the main process; this page
  // never sees the password it checks against. Built once: main re-sends data on every tab change and a rebuild would wipe the box.
  let vaultTimer = null;
  function renderVaultUnlock() {
    if (!data.vault) { act("close"); return; }
    if (panel.querySelector(".vu")) return;
    panel.textContent = "";
    panel.classList.add("vu-panel");
    panel.style.width = "360px";
    panel.style.top = data.anchor.bottom + 8 + "px";
    panel.style.left = Math.max(8, Math.round((window.innerWidth - 360) / 2)) + "px";
    const box = el("div", "vu");
    const top = el("div", "vu-top");
    const badge = el("span", "vu-badge");
    badge.appendChild(I.icon("lock"));
    top.appendChild(badge);
    const heads = el("div", "vu-heads");
    heads.appendChild(el("div", "vu-title", "Enter your auto-fill password"));
    heads.appendChild(el("div", "vu-sub", "to fill the saved login for " + data.vault.host));
    top.appendChild(heads);
    box.appendChild(top);
    box.appendChild(el("div", "vu-user", data.vault.username));
    const field = el("div", "vu-field");
    const fi = el("span", "vu-fi");
    fi.appendChild(I.icon("lock"));
    field.appendChild(fi);
    const input = el("input");
    input.type = "password"; input.inputMode = "numeric"; input.maxLength = 8; input.autocomplete = "off"; input.spellcheck = false;
    input.placeholder = "Password";
    input.addEventListener("input", () => { input.value = input.value.replace(/[^0-9]/g, ""); });
    field.appendChild(input);
    box.appendChild(field);
    const msg = el("div", "bm-msg vu-msg");
    box.appendChild(msg);
    const row = el("div", "vu-buttons");
    const cancel = el("button", "secondary", "Cancel");
    const ok = el("button", "primary", "Fill");
    row.appendChild(cancel); row.appendChild(ok);
    box.appendChild(row);
    panel.appendChild(box);
    const lock = (secs) => {
      clearInterval(vaultTimer);
      let left = secs;
      const tick = () => {
        if (left <= 0) { clearInterval(vaultTimer); input.disabled = false; ok.disabled = false; msg.textContent = ""; input.focus(); return; }
        input.disabled = true; ok.disabled = true;
        msg.textContent = "Too many wrong tries. Try again in " + left + (left === 1 ? " second." : " seconds.");
        left--;
      };
      tick(); vaultTimer = setInterval(tick, 1000);
    };
    let busy = false;
    const submit = async () => {
      if (busy || input.disabled) return;
      if (!/^[0-9]{4,8}$/.test(input.value)) {   // nothing / too short: say so, do not even ask (and never count it as a wrong try)
        msg.textContent = input.value ? "Enter 4 to 8 digits." : "Enter your password.";
        input.focus();
        return;
      }
      busy = true; ok.disabled = true;
      const r = await api.vaultVerify(input.value).catch(() => ({ ok: false, error: "unavailable" }));
      busy = false; ok.disabled = false;
      if (r && r.ok) return;   // main closes the box and the page is filled
      input.value = "";
      if (r && (r.error === "locked" || r.secs)) return lock(r.secs || 30);
      msg.textContent = r && r.error === "format" ? "Enter 4 to 8 digits." : r && r.error === "wrong" ? "Wrong password." + (r.left ? " " + r.left + (r.left === 1 ? " try left." : " tries left.") : "") : "Not available.";
      input.focus();
    };
    cancel.addEventListener("click", () => act("close"));
    ok.addEventListener("click", submit);
    box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
    if (data.vault.secs) lock(data.vault.secs); else input.focus();
  }

  function render() {
    if (!data) return;
    if (data.kind === "tabsearch") renderTabSearch();
    else if (data.kind === "menu") renderMenu();
    else if (data.kind === "downloads") renderDownloads();
    else if (data.kind === "siteinfo") renderSiteInfo();
    else if (data.kind === "find") renderFind();
    else if (data.kind === "unlock") renderUnlock();
    else if (data.kind === "vault-unlock") renderVaultUnlock();
    else if (data.kind === "bookmark-edit") {
      // Main re-sends data on every tab/title/download change (popup.refresh). The box is a FORM: rebuilding it from the
      // stored values threw away what was being typed (measured: Name went back to the old title after the page changed
      // its own title). Build it once per bookmark; a bookmark that is gone still closes it.
      if (data.bookmark && panel.querySelector(".bm-edit, .bmb-body") && panel.dataset.bookmarkId === data.bookmark.id) return;
      renderBookmarkEdit();
      if (data.bookmark) panel.dataset.bookmarkId = data.bookmark.id;
    }
  }

  backdrop.addEventListener("mousedown", () => act("close"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && data && data.kind !== "find") act("close");
  });
  api.onData((d) => { data = d; render(); });
  api.getData().then((d) => { data = d; render(); });
})();
