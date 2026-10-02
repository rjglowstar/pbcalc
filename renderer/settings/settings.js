(function () {
  const api = window.settingsAPI;
  if (!api) return;

  const modeButtons = Array.from(document.querySelectorAll("#mode button"));
  const barSwitch = document.getElementById("bookmarks-bar");
  const suggestSwitch = document.getElementById("suggest-switch");
  const dlAsk = document.getElementById("dl-ask");

  function render(s) {
    if (!s) return;
    // In Restricted Mode people get the ordinary settings; the restriction controls are hidden.
    document.getElementById("restricted-card").hidden = !!s.restricted;
    // The bookmarks-bar switch stays available in Restricted Mode (it only shows/hides the bar),
    // but the address-bar card does not: there is no address bar to type in there, so a switch
    // about what typing sends to Google has nothing to act on.
    document.getElementById("address-bar-card").hidden = !!s.restricted;
    modeButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === s.themeMode)));
    barSwitch.setAttribute("aria-checked", String(!!s.showBookmarksBar));
    suggestSwitch.setAttribute("aria-checked", String(!!s.searchSuggestions));
    if (s.downloads) {
      document.getElementById("dl-dir").textContent = s.downloads.dir;
      dlAsk.setAttribute("aria-checked", String(!!s.downloads.ask));
    }
    // choosing a folder opens a native dialog: not in Restricted Mode
    document.getElementById("dl-change").hidden = !!s.restricted;
    if (s.version) document.getElementById("app-version").textContent = s.version;
  }

  modeButtons.forEach((b) => b.addEventListener("click", () => {
    api.set("themeMode", b.dataset.mode);
    modeButtons.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));

  barSwitch.addEventListener("click", () => {
    const next = barSwitch.getAttribute("aria-checked") !== "true";
    api.set("showBookmarksBar", next);
    barSwitch.setAttribute("aria-checked", String(next));
  });

  dlAsk.addEventListener("click", () => {
    const next = dlAsk.getAttribute("aria-checked") !== "true";
    api.set("downloadsAsk", next);
    dlAsk.setAttribute("aria-checked", String(next));
  });

  document.getElementById("dl-change").addEventListener("click", async () => {
    const s = await api.chooseDownloadDir();
    if (s) render(s);
  });

  suggestSwitch.addEventListener("click", () => {
    const next = suggestSwitch.getAttribute("aria-checked") !== "true";
    api.set("searchSuggestions", next);
    suggestSwitch.setAttribute("aria-checked", String(next));
  });

  api.get().then(render);
  // Stay in step when a setting is changed elsewhere (Ctrl+Shift+B, the menu, Restricted Mode...).
  api.onChanged((snap) => { render(snap); refreshRestricted(); });

  // ── Restricted Mode ──
  const $ = (id) => document.getElementById(id);
  const ERR = {
    "no-bookmarks": "Add at least one bookmark first. Those are the only sites people will be able to open.",
    unavailable: "Not available right now.",
  };

  async function refreshRestricted() {
    const st = await api.restrictedStatus();
    if (!st) return;
    $("rm-start").setAttribute("aria-checked", String(st.startRestricted));
    $("rm-enable").disabled = st.bookmarks === 0;
    $("rm-msg").textContent = st.bookmarks === 0
      ? "Add at least one bookmark first."
      : st.bookmarks + (st.bookmarks === 1 ? " site" : " sites") + " will be allowed.";
  }

  $("rm-start").addEventListener("click", async () => {
    const next = $("rm-start").getAttribute("aria-checked") !== "true";
    const r = await api.restrictedSetStart(next);
    if (!r.ok) $("rm-msg").textContent = ERR[r.error] || "Could not change that.";
    refreshRestricted();
  });

  $("rm-enable").addEventListener("click", async () => {
    const r = await api.restrictedEnable();
    if (!r.ok) $("rm-msg").textContent = ERR[r.error] || "Could not turn on Restricted Mode.";
    // on success the browser switches modes and closes this page
  });

  refreshRestricted();
})();
