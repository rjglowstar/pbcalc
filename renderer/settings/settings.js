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

  // ── Saved passwords: change the password asked before a saved login is filled ──
  const vaultErr = {
    "wrong-old": "The old password is wrong.",
    "bad-format": "The new password must be 4 to 8 digits (0-9 only).",
    mismatch: "The new password and the confirmation are not the same.",
    same: "The new password must be different from the old one.",
    "save-failed": "Could not save the new password.",
    unavailable: "Not available right now.",
  };
  const digits = (id) => { const i = $(id); i.addEventListener("input", () => { i.value = i.value.replace(/[^0-9]/g, ""); }); return i; };
  const vOld = digits("vault-old"), vNew = digits("vault-new"), vConfirm = digits("vault-confirm");
  const vMsg = $("vault-msg");
  const vSay = (text, cls) => { vMsg.textContent = text; vMsg.className = "msg" + (cls ? " " + cls : ""); };
  function vReset() { $("vault-form").hidden = true; $("vault-open").hidden = false; vOld.value = vNew.value = vConfirm.value = ""; vSay(""); }
  $("vault-open").addEventListener("click", () => { $("vault-form").hidden = false; $("vault-open").hidden = true; vOld.focus(); });
  $("vault-cancel").addEventListener("click", vReset);
  async function vSave() {
    const r = await api.changeVaultPassword(vOld.value, vNew.value, vConfirm.value).catch(() => ({ ok: false, error: "unavailable" }));
    if (r && r.ok) { vReset(); vSay("Password changed.", "ok"); return; }
    if (r && (r.error === "locked" || r.secs)) { vSay("Too many wrong tries. Try again in " + (r.secs || 30) + " seconds.", "err"); }
    else vSay((vaultErr[r && r.error] || vaultErr.unavailable) + (r && r.error === "wrong-old" && r.left ? " " + r.left + (r.left === 1 ? " try left." : " tries left.") : ""), "err");
    vOld.value = vNew.value = vConfirm.value = "";
    vOld.focus();
  }
  $("vault-save").addEventListener("click", vSave);
  [vOld, vNew, vConfirm].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); vSave(); } }));
  function vRender(s) {
    $("vault-desc").textContent = (s.vaultPasswordIsDefault
      ? "The password is still the default, 1234 - change it. "
      : "") + "Before a saved login is filled into a page, PBCalc asks for this password. Only the digits 0 to 9, 4 to 8 of them.";
  }
  api.get().then((s) => { if (s) vRender(s); });
  api.onChanged((s) => vRender(s));

  refreshRestricted();
})();
