(function () {
  const api = window.browserAPI;
  const I = window.PBIcons;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const tabsEl = $("tabs");
  const urlInput = $("url-input");
  const backBtn = $("back");
  const forwardBtn = $("forward");
  const reloadBtn = $("reload");
  const siteInfoBtn = $("site-info");
  const starBtn = $("bookmark");
  const zoomBtn = $("zoom");
  const unlockBtn = $("unlock");
  const downloadsBtn = $("downloads");
  const bookmarkBar = $("bookmark-bar");

  let tabState = { tabs: [], activeTabId: null, bookmarksBarVisible: true };
  let bookmarks = [];
  let urlFocused = false;
  let dragId = null;
  let bmDragId = null;   // bookmark being dragged on the bar
  let cardShowTimer = null;
  let cardHideTimer = null;
  let cardVisible = false;
  // A native context menu takes the mouse away from Chromium, so when it closes the renderer has
  // never seen the pointer leave: CSS :hover stays stuck on the tab that was right-clicked (very
  // visible after "Duplicate", where that tab also stops being the active one). Suppress the hover
  // styling until the mouse genuinely moves again, which is when :hover becomes trustworthy.
  const suppressHover = () => {
    document.body.classList.add("no-hover");
    const clear = () => { document.body.classList.remove("no-hover"); window.removeEventListener("mousemove", clear, true); };
    window.addEventListener("mousemove", clear, true);
  };

  const hideCardNow = () => {
    clearTimeout(cardShowTimer);
    clearTimeout(cardHideTimer);
    if (cardVisible) api.hideHoverCard();
    cardVisible = false;
  };

  // ── static icons ────────────────────────────────────────────────────────
  I.set($("tab-search"), "chevronDown");
  I.set($("new-tab"), "plus");
  I.set(backBtn, "back");
  I.set(forwardBtn, "forward");
  I.set(reloadBtn, "reload");
  I.set(downloadsBtn, "download");
  I.set($("menu"), "moreVert");
  I.set(unlockBtn, "lock");

  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };

  // Chrome shows the address without scheme / "www." / trailing slash until the box is focused.
  function displayUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return url;
      const host = u.host.replace(/^www\./, "");
      const rest = (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
      return host + rest;
    } catch (_) {
      return url;
    }
  }

  // ── tabs ────────────────────────────────────────────────────────────────
  // Chrome's tab animations, MEASURED from Chrome 153 (see scripts/chrome-reference/README.md):
  // a new tab grows from nothing over 200ms ease-out while the others make room, and a closing one
  // shrinks away the same way. An animation can only run on an element that SURVIVES, so the strip
  // is patched in place and never rebuilt. That is also what fixes favicons: a rebuilt <img> starts
  // empty and re-decodes, so with the old "wipe and redraw on every update" the icon was blank most
  // of the time on a busy page (and on a freshly duplicated tab).
  const TAB_ANIM_MS = 200;
  const tabEls = new Map(); // tab id -> its element, for as long as the tab exists
  let firstTabRender = true;

  function fillTabIcon(box, tab) {
    box.textContent = "";
    if (tab.loading) {
      const sp = document.createElement("span");
      sp.className = "spinner";
      box.appendChild(sp);
    } else if (tab.favicon) {
      const img = document.createElement("img");
      img.src = tab.favicon;
      img.alt = "";
      img.addEventListener("error", () => { box.textContent = ""; box.appendChild(I.icon("globe")); });
      box.appendChild(img);
    } else {
      box.appendChild(I.icon("globe"));
    }
  }

  // Built once per tab. Every handler reads the CURRENT state, so the element stays valid as the
  // tab's title, favicon or position change.
  function createTabEl(id) {
    const el = document.createElement("div");
    el.className = "tab";
    el.setAttribute("role", "tab");

    const body = document.createElement("div");
    body.className = "tab-body";
    el.appendChild(body);

    const icon = document.createElement("span");
    icon.className = "tab-icon";
    body.appendChild(icon);

    const title = document.createElement("span");
    title.className = "tab-title";
    body.appendChild(title);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.title = "Close";
    close.appendChild(I.icon("close"));
    // Acts on mousedown, not click: historically a mousedown re-rendered the strip and destroyed
    // this button before "click" fired. The strip is patched now, but mousedown also matches Chrome.
    close.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      api.closeTab(id);
    });
    close.addEventListener("click", (e) => e.stopPropagation());
    close.draggable = false;
    body.appendChild(close);

    const sep = document.createElement("span");
    sep.className = "tab-sep";
    el.appendChild(sep);

    // Hover card (title, site, preview). The first card waits 500ms like Chrome; while moving
    // across neighbouring tabs the next one shows at once. Leaving hides it after a short grace.
    el.addEventListener("mouseenter", () => {
      clearTimeout(cardHideTimer);
      clearTimeout(cardShowTimer);
      const show = () => { cardVisible = true; api.showHoverCard(id, rectOf(el)); };
      if (cardVisible) show();
      else cardShowTimer = setTimeout(show, 500);
    });
    el.addEventListener("mouseleave", () => {
      clearTimeout(cardShowTimer);
      clearTimeout(cardHideTimer);
      cardHideTimer = setTimeout(() => { cardVisible = false; api.hideHoverCard(); }, 120);
    });

    // mousedown (not click) activates instantly, like Chrome.
    el.addEventListener("mousedown", (e) => {
      hideCardNow();
      if (e.button === 0 && !e.target.closest(".tab-close") && id !== tabState.activeTabId) api.switchTab(id);
    });
    el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); api.closeTab(id); } });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      hideCardNow();   // the card must not hang around behind the menu
      suppressHover(); // ...nor the hover fill once the menu closes
      api.tabContextMenu(id);
    });

    // drag to reorder
    el.addEventListener("dragstart", (e) => {
      hideCardNow();
      dragId = id;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(id));
    });
    el.addEventListener("dragend", () => { dragId = null; el.classList.remove("dragging"); renderTabs(); });
    el.addEventListener("dragover", (e) => {
      if (dragId == null || dragId === id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      el.classList.toggle("drop-before", before);
      el.classList.toggle("drop-after", !before);
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-before", "drop-after");
      if (dragId == null || dragId === id) return;
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      const ids = tabState.tabs.map((t) => t.id).filter((x) => x !== dragId);
      let idx = ids.indexOf(id);
      if (!before) idx += 1;
      api.moveTab(dragId, idx);
      dragId = null;
    });

    el._icon = icon;
    el._title = title;
    return el;
  }

  // Only touches what actually changed, so nothing is destroyed under the pointer and the favicon
  // <img> is never re-created while it is already showing the right icon.
  function patchTabEl(el, tab, index) {
    el.classList.toggle("active", tab.id === tabState.activeTabId);
    el.draggable = !tabState.restricted;
    if (el.style.order !== String(index)) el.style.order = String(index); // reorder without moving nodes
    const title = tab.title || "New Tab";
    if (el._title.textContent !== title) el._title.textContent = title;
    const iconKey = tab.loading ? "\u0000loading" : tab.favicon || "";
    if (el._iconKey !== iconKey) {
      el._iconKey = iconKey;
      fillTabIcon(el._icon, tab);
    }
  }

  // Chrome does NOT re-widen the remaining tabs while the pointer is still in the strip — it keeps
  // the slots exactly as wide as they were so the next tab's X stays under the mouse, and only
  // expands once the pointer leaves. MEASURED: widths held for as long as the pointer stayed, then
  // a ~330ms pause after it left, then the 200ms ease-out expansion.
  const TAB_RELAYOUT_DELAY_MS = 330;
  const strip = document.querySelector(".strip");
  let pointerInStrip = false;
  let widthsLocked = false;
  let unlockTimer = null;
  // The expansion below animates by pinning every tab to an explicit width for its duration. That
  // pin MUST be dropped the moment anything else changes the strip, or tabs opened meanwhile keep
  // the old frozen widths (it showed up as tab pitches lagging a step behind).
  let flipTimer = null;
  let flipEls = [];

  function clearWidthFlip(keepStyles) {
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
    if (!keepStyles) flipEls.forEach((el) => { el.style.flexBasis = ""; el.style.flexShrink = ""; });
    flipEls = [];
  }

  function lockTabWidths() {
    if (widthsLocked) return;
    clearWidthFlip(true); // freeze what is on screen right now, mid-expansion included
    // Measure EVERYTHING first, then write. Measuring and setting in the same loop makes each
    // read see the previous tab's new style, and the row ends up with a staircase of widths
    // (measured: 113, 81, 59, 39...). Read all, then apply.
    const measured = [];
    tabEls.forEach((el) => measured.push([el, Math.round(el.getBoundingClientRect().width)]));
    // Freezing must be INSTANT. Writing flex-basis would otherwise animate it from the CSS value
    // (238px) down to the real width, so every tab visibly jumped to full width and slid back.
    measured.forEach(([el, w]) => {
      el.style.transition = "none";
      el.style.flexBasis = w + "px";
      el.style.flexShrink = "0"; // a fixed basis alone is not enough: .tab may still shrink to fit
    });
    void tabsEl.offsetWidth; // flush the frozen layout before transitions are allowed again
    measured.forEach(([el]) => { el.style.transition = ""; });
    widthsLocked = true;
  }

  function unlockTabWidths() {
    clearTimeout(unlockTimer);
    unlockTimer = null;
    if (!widthsLocked) return;
    widthsLocked = false;
    clearWidthFlip();
    // Just clearing the inline width would SNAP: a compressed tab's size comes from flex-shrink,
    // not from its basis, so there is nothing for the transition to animate. Measure where the
    // tabs end up, put them back where they were, and animate between the two (FLIP) — that is the
    // 330ms-later expansion Chrome was measured doing over 200ms.
    const els = [...tabEls.values()];
    if (!els.length) return;
    const from = els.map((el) => Math.round(el.getBoundingClientRect().width));
    els.forEach((el) => { el.style.transition = "none"; el.style.flexBasis = ""; el.style.flexShrink = ""; });
    void tabsEl.offsetWidth;
    const to = els.map((el) => Math.round(el.getBoundingClientRect().width));
    els.forEach((el, i) => { el.style.flexBasis = from[i] + "px"; el.style.flexShrink = "0"; });
    void tabsEl.offsetWidth;
    els.forEach((el, i) => { el.style.transition = ""; el.style.flexBasis = to[i] + "px"; });
    flipEls = els;
    flipTimer = setTimeout(() => { flipTimer = null; clearWidthFlip(); }, TAB_ANIM_MS + 40);
  }

  if (strip) {
    strip.addEventListener("mouseenter", () => { pointerInStrip = true; clearTimeout(unlockTimer); unlockTimer = null; });
    strip.addEventListener("mouseleave", () => {
      pointerInStrip = false;
      if (!widthsLocked) return;
      clearTimeout(unlockTimer);
      unlockTimer = setTimeout(unlockTabWidths, TAB_RELAYOUT_DELAY_MS);
    });
  }

  function growIn(el) {
    el.style.flexBasis = "0px";
    el.style.minWidth = "0px";
    const release = () => { el.style.flexBasis = ""; el.style.minWidth = ""; };
    // two frames: the collapsed size must be painted before the transition to the real one starts
    requestAnimationFrame(() => requestAnimationFrame(release));
    // ...but rAF does not run while the window is occluded or minimised, and a tab left pinned at
    // 0px would stay invisible. Release it anyway shortly after (harmless if the frames did run).
    setTimeout(release, 300);
  }

  function collapseAway(el) {
    el.classList.add("closing"); // no longer clickable, no hover, no separator
    el.classList.remove("active"); // a shrinking ghost must not count as the active tab
    el.style.flexBasis = "0px";
    el.style.minWidth = "0px";
    el.style.flexShrink = "";
    setTimeout(() => { el.remove(); sizeStrip(); }, TAB_ANIM_MS + 50);
  }

  // The row's own width budget is "one slot per tab" (--n). A tab that is closing still occupies a
  // slot while it shrinks, so it has to be counted: dropping --n the instant the tab closed made
  // the row too narrow for its own contents and every remaining tab was SQUEEZED (measured: 225 ->
  // 190px in one frame) before growing back. Chrome never does that — the others only grow, and
  // only as the closing tab gives up its space.
  function sizeStrip() {
    const ghosts = tabsEl.querySelectorAll(".tab.closing").length;
    tabsEl.style.setProperty("--n", String(tabEls.size + ghosts));
  }

  function renderTabs() {
    const live = new Set(tabState.tabs.map((t) => t.id));
    const gone = [...tabEls.keys()].filter((id) => !live.has(id));
    // freeze the widths FIRST, while the closed tab's slot is still part of the layout
    if (gone.length && pointerInStrip) lockTabWidths();
    gone.forEach((id) => {
      const el = tabEls.get(id);
      tabEls.delete(id);
      collapseAway(el); // it shrinks away; the others only widen if the widths are not frozen
    });

    tabState.tabs.forEach((tab, i) => {
      let el = tabEls.get(tab.id);
      if (!el) {
        clearWidthFlip();  // a tab appearing mid-expansion must not leave the others pinned
        unlockTabWidths(); // a new tab always re-lays the strip out, frozen or not
        el = createTabEl(tab.id);
        tabEls.set(tab.id, el);
        tabsEl.appendChild(el);
        if (!firstTabRender) growIn(el); // the window's very first tabs just appear
      }
      patchTabEl(el, tab, i);
    });

    sizeStrip();
    firstTabRender = false;
    // With many tabs the strip scrolls; keep the active one visible.
    const activeEl = tabsEl.querySelector(".tab.active:not(.closing)");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ── toolbar state ───────────────────────────────────────────────────────
  function activeTab() {
    return tabState.tabs.find((t) => t.id === tabState.activeTabId) || null;
  }

  function renderSiteInfo(tab) {
    siteInfoBtn.className = "site-info";
    siteInfoBtn.textContent = "";
    if (!tab || tab.siteKind === "internal") {
      siteInfoBtn.appendChild(I.icon("search"));
      siteInfoBtn.disabled = true;
      siteInfoBtn.title = "";
      return;
    }
    siteInfoBtn.disabled = false;
    siteInfoBtn.title = "View site information";
    if (tab.siteKind === "secure") {
      siteInfoBtn.appendChild(I.icon("tune"));
    } else if (tab.siteKind === "insecure") {
      siteInfoBtn.classList.add("insecure");
      siteInfoBtn.appendChild(I.icon("warning"));
      const label = document.createElement("span");
      label.textContent = "Not secure";
      siteInfoBtn.appendChild(label);
    } else {
      siteInfoBtn.appendChild(I.icon("info"));
    }
  }

  function renderToolbar() {
    const tab = activeTab();
    backBtn.disabled = !tab || !tab.canGoBack;
    forwardBtn.disabled = !tab || !tab.canGoForward;
    // Chrome swaps reload for stop while a page is loading.
    I.set(reloadBtn, tab && tab.loading ? "close" : "reload");
    reloadBtn.title = tab && tab.loading ? "Stop loading this page" : "Reload (Ctrl+R)";
    renderSiteInfo(tab);
    if (!urlFocused) urlInput.value = tab ? displayUrl(tab.url) : "";

    const z = tab ? tab.zoom : 100;
    zoomBtn.hidden = !tab || z === 100;
    zoomBtn.textContent = "";
    if (!zoomBtn.hidden) {
      zoomBtn.appendChild(I.icon("search"));
      const t = document.createElement("span");
      t.textContent = z + "%";
      zoomBtn.appendChild(t);
    }

    const bookmarkable = !!tab && /^https?:\/\//i.test(tab.url || "");
    starBtn.disabled = !bookmarkable;
    const on = bookmarkable && bookmarks.some((b) => b.url === tab.url);
    starBtn.classList.toggle("on", on);
    I.set(starBtn, on ? "starFilled" : "starOutline");
    starBtn.title = on ? "Edit bookmark (Ctrl+D)" : "Bookmark this tab (Ctrl+D)";

    bookmarkBar.hidden = !tabState.bookmarksBarVisible;
    // Restricted Mode: the CSS hides the address bar, + button, menu, tab search...; the admin
    // unlock button appears instead.
    document.body.classList.toggle("restricted", !!tabState.restricted);
    unlockBtn.hidden = !tabState.restricted;
  }

  function clearBmDrop() {
    bookmarkBar.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
  }

  // Dropping on the empty part of the bar puts the bookmark last, like Chrome.
  bookmarkBar.addEventListener("dragover", (e) => { if (bmDragId != null) e.preventDefault(); });
  bookmarkBar.addEventListener("drop", (e) => {
    e.preventDefault();
    clearBmDrop();
    if (bmDragId == null) return;
    api.moveBookmark(bmDragId, bookmarks.length - 1);
    bmDragId = null;
  });

  function renderBookmarks() {
    bookmarkBar.textContent = "";
    if (!bookmarks.length) {
      const hint = document.createElement("span");
      hint.className = "bookmark-empty";
      hint.textContent = tabState.restricted
        ? "No sites have been added. Ask your administrator."
        : "For quick access, place your bookmarks here on the bookmarks bar.";
      bookmarkBar.appendChild(hint);
    }
    bookmarks.forEach((b) => {
      const el = document.createElement("div");
      el.className = "bookmark";
      el.title = b.title + "\n" + b.url;
      if (b.favicon) {
        const img = document.createElement("img");
        img.src = b.favicon;
        img.alt = "";
        img.draggable = false;   // the whole bookmark is what drags, not its icon
        img.addEventListener("error", () => img.replaceWith(I.icon("globe")));
        el.appendChild(img);
      } else {
        el.appendChild(I.icon("globe"));
      }
      const t = document.createElement("span");
      t.className = "bookmark-title";
      t.textContent = b.title;
      el.appendChild(t);
      // Main decides what opening means: current tab (normal) or a confined tab (Restricted).
      el.addEventListener("click", (e) => {
        const newTab = e.ctrlKey || e.metaKey;
        api.openBookmark(b.id, newTab);
      });
      el.addEventListener("auxclick", (e) => { if (e.button === 1 && !tabState.restricted) api.newTab(b.url); });
      // drag to reorder (Chrome): a line shows where it will land. Normal mode only - main refuses it in Restricted Mode too.
      el.draggable = !tabState.restricted;
      el.addEventListener("dragstart", (e) => {
        bmDragId = b.id;
        el.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", b.url);
      });
      el.addEventListener("dragend", () => { bmDragId = null; clearBmDrop(); el.classList.remove("dragging"); });
      el.addEventListener("dragover", (e) => {
        if (bmDragId == null || bmDragId === b.id) return;
        e.preventDefault();
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        el.classList.toggle("drop-before", before);
        el.classList.toggle("drop-after", !before);
      });
      el.addEventListener("dragleave", () => el.classList.remove("drop-before", "drop-after"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        clearBmDrop();
        if (bmDragId == null || bmDragId === b.id) return;
        const ids = bookmarks.map((x) => x.id).filter((x) => x !== bmDragId);
        let idx = ids.indexOf(b.id);
        if (!before) idx += 1;
        api.moveBookmark(bmDragId, idx);
        bmDragId = null;
      });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!tabState.restricted) { suppressHover(); api.bookmarkContextMenu(b.id); } });
      bookmarkBar.appendChild(el);
    });
  }

  function render(state) {
    if (!state) return;
    const flipped = !!tabState.restricted !== !!state.restricted;
    tabState = state;
    renderTabs();
    renderToolbar();
    if (flipped) renderBookmarks();
  }

  // ── wiring ──────────────────────────────────────────────────────────────
  // A re-render replaces the tab elements, so a hovered tab can vanish without a mouseleave:
  // leaving the whole row always hides the card.
  tabsEl.addEventListener("mouseleave", () => {
    clearTimeout(cardShowTimer);
    clearTimeout(cardHideTimer);
    cardHideTimer = setTimeout(() => { cardVisible = false; api.hideHoverCard(); }, 120);
  });

  api.onTabsChanged(render);
  api.getState().then(render);
  api.onBookmarksChanged((list) => { bookmarks = list || []; renderBookmarks(); renderToolbar(); });
  api.getBookmarks().then((list) => { bookmarks = list || []; renderBookmarks(); renderToolbar(); });
  api.onFocusUrl(() => { urlInput.focus(); urlInput.select(); });

  backBtn.addEventListener("click", () => api.back());
  forwardBtn.addEventListener("click", () => api.forward());
  reloadBtn.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.loading) api.stop(); else api.reload();
  });
  // Right-click on Reload: Chrome shows Normal / Hard / Empty Cache and Hard Reload, but only while DevTools is open.
  // Main decides (it knows about DevTools); the native menu takes the pointer away from the page, so hover is
  // suppressed afterwards like for the other native menus.
  reloadBtn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const tab = activeTab();
    if (tabState.restricted || (tab && tab.loading)) return;
    const r = reloadBtn.getBoundingClientRect();
    api.reloadMenu({ left: r.left, bottom: r.bottom }).then((shown) => { if (shown) suppressHover(); }).catch(() => {});
  });
  $("new-tab").addEventListener("click", () => api.newTab());
  starBtn.addEventListener("click", () => api.toggleBookmark());
  zoomBtn.addEventListener("click", () => api.resetZoom());

  $("tab-search").addEventListener("click", () => api.openPopup("tabsearch", rectOf($("tab-search"))));
  $("menu").addEventListener("click", () => api.openPopup("menu", rectOf($("menu"))));
  // Chrome's download button: a ring fills around the arrow while something is downloading, and
  // the button stays accented ("new download") until the bubble is opened.
  let dlSeen = 0;
  function renderDownloadsBtn(list) {
    const items = list || [];
    const running = items.filter((d) => d.state === "progressing");
    const total = running.reduce((n, d) => n + (d.total || 0), 0);
    const got = running.reduce((n, d) => n + (d.received || 0), 0);
    downloadsBtn.classList.toggle("busy", running.length > 0);
    downloadsBtn.style.setProperty("--p", running.length && total > 0 ? Math.min(1, got / total) : 0);
    // indeterminate (server sent no length): let the ring spin instead of sitting at zero
    downloadsBtn.classList.toggle("spin", running.length > 0 && total === 0);
    const done = items.filter((d) => d.state === "completed").length;
    if (done > dlSeen) downloadsBtn.classList.add("fresh");
    dlSeen = done;
    downloadsBtn.title = running.length ? "Downloads in progress (Ctrl+Shift+J)" : "Downloads (Ctrl+Shift+J)";
  }
  api.onDownloadsChanged(renderDownloadsBtn);
  api.getDownloads().then(renderDownloadsBtn);

  downloadsBtn.addEventListener("click", () => {
    downloadsBtn.classList.remove("fresh"); // opening it acknowledges the new download, as in Chrome
    api.openPopup("downloads", rectOf(downloadsBtn));
  });
  siteInfoBtn.addEventListener("click", () => api.openPopup("siteinfo", rectOf(siteInfoBtn)));

  // Omnibox: a click or focus selects the whole address and reveals the full URL, like Chrome.
  urlInput.addEventListener("focus", () => {
    urlFocused = true;
    api.omniboxWarm(); // load the suggestion dropdown now so the first keystroke already has it
    const tab = activeTab();
    if (tab && tab.url) urlInput.value = tab.url;
    setTimeout(() => urlInput.select(), 0);
  });
  // Without this the mouseup that follows the focusing click drops the select-all.
  let justFocused = false;
  urlInput.addEventListener("mousedown", () => { justFocused = document.activeElement !== urlInput; });
  urlInput.addEventListener("mouseup", (e) => { if (justFocused) { e.preventDefault(); justFocused = false; } });
  // The grace period lets a click on a suggestion register before the dropdown goes away (the click
  // moves focus out of this box first).
  urlInput.addEventListener("blur", () => {
    urlFocused = false;
    renderToolbar();
    setTimeout(() => { if (!urlFocused) api.omniboxClose(); }, 200);
  });

  // Suggestions while typing: one query per pause in typing (the main process adds bookmarks, open
  // tabs and Google's suggestions; there is no history to add).
  let suggestTimer = null;
  urlInput.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => api.omniboxQuery(urlInput.value, rectOf($("omnibox"))), 70);
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(suggestTimer);
      api.omniboxAccept(urlInput.value); // the highlighted suggestion, or the text as typed
      urlInput.blur();
    } else if (e.key === "Escape") {
      clearTimeout(suggestTimer);
      api.omniboxClose();
      urlInput.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // fills the bar with the highlighted row; above the first row it gives back what was typed
      api.omniboxMove(e.key === "ArrowDown" ? 1 : -1).then((r) => { if (r) urlInput.value = r.text; });
    }
  });

  if (api.onFullscreenChanged) {
    api.onFullscreenChanged((isFullscreen) => {
      document.documentElement.classList.toggle("fullscreen", !!isFullscreen);
    });
  }
})();
