(function () {
  const api = window.browserAPI;
  if (!api) return;

  const tabStrip = document.getElementById("tab-strip");
  const urlInput = document.getElementById("url-input");
  const backBtn = document.getElementById("back");
  const forwardBtn = document.getElementById("forward");
  const reloadBtn = document.getElementById("reload");
  const newTabBtn = document.getElementById("new-tab");

  const starBtn = document.getElementById("bookmark");
  const bookmarkBar = document.getElementById("bookmark-bar");
  const shelf = document.getElementById("download-shelf");

  let urlInputFocused = false;
  let bookmarks = [];
  let activeUrl = "";

  function render(state) {
    if (!state) return;

    tabStrip.textContent = "";
    state.tabs.forEach((tab) => {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
      el.setAttribute("role", "tab");

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.loading ? "Loading…" : (tab.title || "New Tab");
      el.appendChild(title);

      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "✕";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        api.closeTab(tab.id);
      });
      el.appendChild(close);

      el.addEventListener("click", () => api.switchTab(tab.id));
      tabStrip.appendChild(el);
    });

    const active = state.tabs.find((t) => t.id === state.activeTabId);
    if (active) {
      // Do not stomp on what the user is currently typing.
      if (!urlInputFocused) urlInput.value = active.url || "";
      activeUrl = active.url || "";
      renderStar();
      backBtn.disabled = !active.canGoBack;
      forwardBtn.disabled = !active.canGoForward;
    }
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────
  function renderStar() {
    const on = bookmarks.some((b) => b.url === activeUrl);
    starBtn.classList.toggle("on", on);
    starBtn.innerHTML = on ? "&#9733;" : "&#9734;";
    starBtn.disabled = !/^https?:\/\//i.test(activeUrl);
  }

  function renderBookmarks(list) {
    bookmarks = list || [];
    bookmarkBar.textContent = "";
    if (!bookmarks.length) {
      const hint = document.createElement("span");
      hint.className = "bookmark-empty";
      hint.textContent = "Bookmarks appear here — click the star to add this page";
      bookmarkBar.appendChild(hint);
    }
    bookmarks.forEach((b) => {
      const el = document.createElement("div");
      el.className = "bookmark";
      el.title = b.title + " - " + b.url;

      const title = document.createElement("span");
      title.className = "bookmark-title";
      title.textContent = b.title;
      el.appendChild(title);

      const x = document.createElement("span");
      x.className = "bookmark-x";
      x.textContent = "✕";
      x.title = "Remove bookmark";
      x.addEventListener("click", (event) => {
        event.stopPropagation();
        api.removeBookmark(b.id);
      });
      el.appendChild(x);

      el.addEventListener("click", () => api.navigate(b.url));
      // Middle-click opens it in a new tab, like every mainstream browser.
      el.addEventListener("auxclick", (event) => {
        if (event.button === 1) api.newTab(b.url);
      });
      bookmarkBar.appendChild(el);
    });
    renderStar();
  }

  starBtn.addEventListener("click", () => api.toggleBookmark());
  api.onBookmarksChanged(renderBookmarks);
  api.getBookmarks().then(renderBookmarks);

  // ── Downloads shelf ───────────────────────────────────────────────────
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function button(label, onClick) {
    const b = document.createElement("button");
    b.className = "dl-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderDownloads(list) {
    shelf.textContent = "";
    shelf.hidden = !list || !list.length;
    (list || []).forEach((d) => {
      const el = document.createElement("div");
      el.className = "dl";

      const info = document.createElement("div");
      info.className = "dl-info";
      const name = document.createElement("div");
      name.className = "dl-name";
      name.textContent = d.filename;
      name.title = d.filename;
      const status = document.createElement("div");
      status.className = "dl-status";
      if (d.state === "completed") status.textContent = "Done · " + fmtBytes(d.received);
      else if (d.state === "cancelled") status.textContent = "Cancelled";
      else if (d.state === "interrupted") status.textContent = "Failed";
      else status.textContent = d.total > 0
        ? fmtBytes(d.received) + " / " + fmtBytes(d.total)
        : fmtBytes(d.received);
      info.appendChild(name);
      info.appendChild(status);
      el.appendChild(info);

      if (d.state === "progressing") {
        el.appendChild(button("Cancel", () => api.cancelDownload(d.id)));
        if (d.total > 0) {
          const bar = document.createElement("div");
          bar.className = "dl-bar";
          bar.style.width = Math.min(100, (d.received / d.total) * 100) + "%";
          el.appendChild(bar);
        }
      } else if (d.state === "completed") {
        el.appendChild(button("Open", () => api.openDownload(d.id)));
        el.appendChild(button("Folder", () => api.showDownload(d.id)));
      }
      el.appendChild(button("✕", () => api.dismissDownload(d.id)));
      shelf.appendChild(el);
    });
  }

  api.onDownloadsChanged(renderDownloads);
  api.getDownloads().then(renderDownloads);

  api.onTabsChanged(render);
  api.getState().then(render);

  newTabBtn.addEventListener("click", () => api.newTab());

  backBtn.addEventListener("click", () => api.back());
  forwardBtn.addEventListener("click", () => api.forward());
  reloadBtn.addEventListener("click", () => api.reload());

  urlInput.addEventListener("focus", () => { urlInputFocused = true; });
  urlInput.addEventListener("blur", () => { urlInputFocused = false; });
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      api.navigate(urlInput.value);
      urlInput.blur();
    }
  });
})();
