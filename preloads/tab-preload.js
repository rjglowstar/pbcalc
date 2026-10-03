const { contextBridge, ipcRenderer, webFrame } = require("electron");

// PBCalc: Native main-world script injection (Zone.js & Akamai WAF Compatible)
try {
  webFrame.executeJavaScript(`
    (function() {
      if (['pbcalc:', 'chrome:', 'file:'].includes(window.location.protocol)) return;
      try {
        Object.defineProperty(Object.prototype, 'isSuspend', {
          get: function() { return true; },
          set: function() {},
          configurable: true,
          enumerable: false
        });
      } catch(e) {}

      function dummyDisableDevtool() {
        return { isSuspend: true, md5: '', version: '' };
      }
      dummyDisableDevtool.isSuspend = true;
      dummyDisableDevtool.md5 = '';
      dummyDisableDevtool.version = '';

      try {
        Object.defineProperty(window, 'DisableDevtool', {
          get: function() { return dummyDisableDevtool; },
          set: function() {},
          configurable: true,
          enumerable: false
        });
        Object.defineProperty(window, 'DISABLE_DEVTOOL', {
          get: function() { return dummyDisableDevtool; },
          set: function() {},
          configurable: true,
          enumerable: false
        });
      } catch(e) {}

      try {
        const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (innerHTMLDesc && innerHTMLDesc.set) {
          const _origSet = innerHTMLDesc.set;
          Object.defineProperty(Element.prototype, 'innerHTML', {
            set: function(val) {
              if (typeof val === 'string' && (val.includes('Developer Tools Detected') || val.includes('Access Denied: Developer Tools Detected'))) {
                return;
              }
              return _origSet.call(this, val);
            },
            get: function() {
              return innerHTMLDesc.get.call(this);
            },
            configurable: true,
            enumerable: false
          });
        }
      } catch(e) {}
    })();
  `, true);
} catch (e) {}

// A DUPLICATED tab restores the original's sessionStorage before any page script runs, so a site
// that keeps its login there (the PB ERP does) stays logged in in the copy — that is what Chrome's
// Duplicate does. Only views main started with this flag ask, main answers once and only for the
// origin the data came from, and nothing of this is exposed to the page.
if (process.argv.includes("--pbcalc-restore-session")) {
  try {
    const data = ipcRenderer.sendSync("tabs:session-restore", location.origin);
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        try { sessionStorage.setItem(k, v); } catch (_) {}
      }
    }
  } catch (_) {}
}

// This preload runs inside every TAB — i.e. on whatever arbitrary website the user navigates to,
// not just trusted first-party pages. The exposed surface is deliberately narrow and origin-
// scoped: the origin is read from `location.origin` HERE, inside the preload's isolated context,
// never taken as a parameter from the page itself — a page cannot claim to be a different origin
// and read another site's saved credentials.
//
// This is the vault's WIRING, not yet a full autofill UI: a page can ask "is anything saved for
// me / for this username" and read a password back for a user-initiated fill, but there is no
// automatic form-detection or "save password?" prompt built on top of this yet. That is the
// natural next step, kept separate so this first pass stays honest about what is and is not done.
contextBridge.exposeInMainWorld("vaultAPI", {
  isAvailable: () => ipcRenderer.invoke("vault:available"),
  listUsernames: () => ipcRenderer.invoke("vault:list-usernames", location.origin),
  getPassword: (username) => ipcRenderer.invoke("vault:get-password", location.origin, username),
  getLastSaved: () => ipcRenderer.invoke("vault:get-last-saved", location.origin),
  save: (username, password) =>
    ipcRenderer.invoke("vault:save", { origin: location.origin, username, password }),
  deleteSaved: (username) =>
    ipcRenderer.invoke("vault:delete", { origin: location.origin, username }),
  neverSave: (username) =>
    ipcRenderer.invoke("vault:never-save", { origin: location.origin, username }),
  needsSavePrompt: (username, password) =>
    ipcRenderer.invoke("vault:needs-prompt", location.origin, username, password),
});

// Settings page bridge — exposed ONLY on our own local settings page (a file: URL ending in
// renderer/settings/settings.html). Websites never see it, and the main process re-checks the
// sender URL on every call (settings:get / settings:set in registerIpcHandlers.js).
if (location.protocol === "file:" && /\/renderer\/settings\/settings\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld("settingsAPI", {
    chooseDownloadDir: () => ipcRenderer.invoke("settings:choose-download-dir"),
    get: () => ipcRenderer.invoke("settings:get"),
    onChanged: (cb) => { ipcRenderer.on("settings:changed", (_e, snap) => cb(snap)); },
    set: (key, value) => ipcRenderer.send("settings:set", key, value),
    restrictedStatus: () => ipcRenderer.invoke("settings:restricted-status"),
    restrictedEnable: () => ipcRenderer.invoke("settings:restricted-enable"),
    restrictedSetStart: (on) => ipcRenderer.invoke("settings:restricted-set-start", on),
  });
}

// Downloads page bridge — only that local file; main re-checks the sender URL on every call.
if (location.protocol === "file:" && /\/renderer\/downloads\/downloads\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld("downloadsAPI", {
    list: () => ipcRenderer.invoke("downloads:page-list"),
    action: (name, id) => ipcRenderer.send("downloads:page-action", name, id),
    onChanged: (cb) => { ipcRenderer.on("downloads:changed", (_e, list) => cb(list)); },
  });
}

// Bookmark manager bridge — only that local file; main re-checks the sender (and, in Restricted
// Mode, that it is the PIN-verified admin tab) on every call.
if (location.protocol === "file:" && /\/renderer\/manager\/manager\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld("managerAPI", {
    list: () => ipcRenderer.invoke("manager:list"),
    add: (title, url) => ipcRenderer.invoke("manager:add", title, url),
    update: (id, title, url) => ipcRenderer.invoke("manager:update", id, title, url),
    remove: (id) => ipcRenderer.invoke("manager:remove", id),
    move: (id, dir) => ipcRenderer.invoke("manager:move", id, dir),
  });
}

// Restricted Mode home page bridge — same idea: only that local file, and main re-checks.
if (location.protocol === "file:" && /\/renderer\/restricted\/home\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld("restrictedAPI", {
    list: () => ipcRenderer.invoke("restricted:list"),
    open: (id) => ipcRenderer.send("restricted:open", id),
  });
}

// ===========================================================================
// Chrome-style password manager UI: "Save password?" card + autofill dropdown.
//
// Ported from the sibling PBERP-EXE project's (now paused) passwordManager() block and adapted for
// arbitrary websites. Runs in this preload's isolated world, which shares the page DOM but not
// its JS. All storage/crypto stays in the main process (vault:* IPC, origin re-derived there from
// the sender's real URL); a password reaches the page only when the user picks a saved row.
//
// Deliberate differences from the sibling, all because this runs on untrusted sites:
//   - NO silent pre-fill of the last-saved login on page load. A hidden or spoofed form on a
//     hostile page could otherwise harvest it with no user action. Filling needs a click on a row.
//   - "Login succeeded" can't be read from a site-specific sessionStorage flag. Instead a save is
//     offered once the password field is gone (SPA) or the next page load shows none (navigation
//     login); a re-shown login form means the attempt failed and nothing is offered.
//   - The typed credential is stashed in the MAIN process across a navigation (60s, memory only),
//     never in page-visible storage.
// ===========================================================================
(function passwordManager() {
  if (!/^https?:$/.test(location.protocol)) return;

  const vault = {
    list: () => ipcRenderer.invoke("vault:list-usernames"),
    get: (username) => ipcRenderer.invoke("vault:get-password", null, username),
    save: (username, password) => ipcRenderer.invoke("vault:save", { username, password }),
    del: (username) => ipcRenderer.invoke("vault:delete", { username }),
    never: (username) => ipcRenderer.invoke("vault:never-save", { username }),
    needsPrompt: (username, password) =>
      ipcRenderer.invoke("vault:needs-prompt", null, username, password),
    reset: () => ipcRenderer.invoke("vault:reset-origin"),
    stash: (username, password) => ipcRenderer.send("vault:stash-pending", { username, password }),
    takePending: () => ipcRenderer.invoke("vault:take-pending"),
  };

  // Native setter + input/change events, so React/Angular/Vue value-trackers notice the fill.
  function setValue(el, val) {
    try {
      const proto = window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    } catch (_) {
      el.value = val;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isVisible(el) {
    return !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }

  // Locate the username + password inputs of a login form via heuristics.
  function findFields() {
    const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
    if (!pw) return null;
    const scope = pw.form || document;
    const inputs = Array.from(scope.querySelectorAll("input")).filter(isVisible);
    const isTextish = (el) => {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return t === "text" || t === "email" || t === "tel";
    };
    let user =
      inputs.find((el) => isTextish(el) && /username|email/i.test(el.getAttribute("autocomplete") || "")) ||
      inputs.find((el) => isTextish(el) && /user|email|login/i.test((el.name || "") + " " + (el.id || "")));
    if (!user) {
      for (let i = inputs.indexOf(pw) - 1; i >= 0; i--) {
        if (isTextish(inputs[i])) { user = inputs[i]; break; }
      }
    }
    return user ? { user, pw } : null;
  }

  // ── Styles (injected once, only when a card/dropdown is first shown) ────
  function ensureStyles() {
    if (document.getElementById("pbcalc-pm-styles")) return;
    const s = document.createElement("style");
    s.id = "pbcalc-pm-styles";
    s.textContent = `
      .pbcalc-pm-dd,.pbcalc-pm-bar{all:initial;}
      .pbcalc-pm-dd{position:fixed;z-index:2147483647;background:#fff;border:1px solid #dadce0;
        border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);overflow:hidden;
        font:13px "Segoe UI",Arial,sans-serif;color:#202124;max-height:320px;min-width:240px;
        display:flex;flex-direction:column;box-sizing:border-box;}
      .pbcalc-pm-dd *,.pbcalc-pm-bar *{box-sizing:border-box;font-family:inherit;}
      .pbcalc-pm-rows{overflow-y:auto;flex:1;min-height:0;}
      .pbcalc-pm-row{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;}
      .pbcalc-pm-row:hover{background:#f1f3f4;}
      .pbcalc-pm-key{width:18px;height:18px;flex:0 0 18px;fill:#5f6368;}
      .pbcalc-pm-meta{flex:1;min-width:0;}
      .pbcalc-pm-user{font-size:13px;color:#202124;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .pbcalc-pm-dots{font-size:12px;color:#5f6368;letter-spacing:1px;}
      .pbcalc-pm-del{border:none;background:none;color:#5f6368;font-size:16px;cursor:pointer;
        width:24px;height:24px;border-radius:50%;line-height:1;}
      .pbcalc-pm-del:hover{background:#e8eaed;}
      .pbcalc-pm-footer{padding:6px 12px;border-top:1px solid #e8eaed;text-align:right;}
      .pbcalc-pm-footer button{border:none;background:none;color:#5f6368;font-size:11.5px;
        cursor:pointer;padding:4px 6px;border-radius:4px;}
      .pbcalc-pm-footer button:hover{background:#f1f3f4;}
      .pbcalc-pm-footer button.pbcalc-pm-danger{color:#d93025;background:#fdecea;}
      .pbcalc-pm-bar{position:fixed;top:14px;right:16px;z-index:2147483647;background:#fff;
        border:1px solid #dadce0;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.32);
        padding:16px 18px;width:340px;font:13px "Segoe UI",Arial,sans-serif;color:#202124;display:block;}
      .pbcalc-pm-bar h4{margin:0 0 14px;font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;}
      .pbcalc-pm-close{margin-left:auto;border:none;background:none;color:#5f6368;font-size:18px;
        cursor:pointer;width:26px;height:26px;border-radius:50%;line-height:1;}
      .pbcalc-pm-close:hover{background:#f1f3f4;}
      .pbcalc-pm-field{display:flex;align-items:center;gap:10px;margin-bottom:10px;}
      .pbcalc-pm-field label{width:64px;flex:0 0 64px;font-size:13px;color:#5f6368;}
      .pbcalc-pm-inputwrap{position:relative;flex:1;}
      .pbcalc-pm-field input{width:100%;border:1px solid #dadce0;border-radius:6px;
        padding:8px 34px 8px 10px;font-size:13px;color:#202124;background:#fff;outline:none;}
      .pbcalc-pm-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:none;
        background:none;cursor:pointer;font-size:15px;color:#5f6368;padding:2px;line-height:1;}
      .pbcalc-pm-actions{display:flex;align-items:center;gap:8px;margin-top:14px;}
      .pbcalc-pm-spacer{flex:1;}
      .pbcalc-pm-btn{border-radius:6px;font-size:13px;padding:8px 16px;cursor:pointer;
        border:1px solid #dadce0;background:#fff;color:#1a73e8;}
      .pbcalc-pm-btn:hover{background:#f1f3f4;}
      .pbcalc-pm-btn.primary{background:#1a73e8;color:#fff;border-color:#1a73e8;}
      .pbcalc-pm-btn.primary:hover{background:#1557b0;}
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function keyIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "pbcalc-pm-key");
    svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M12.65 10A5.99 5.99 0 0 0 7 6a6 6 0 1 0 5.65 8h2.35v3h3v-3h2v-3H12.65zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z");
    svg.appendChild(path);
    return svg;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ── Autofill dropdown ────────────────────────────────────────────────
  let ddEl = null;
  let ddFields = null;
  let ddInputTimer = null;

  function hideDropdown() {
    if (ddEl && ddEl.parentNode) ddEl.parentNode.removeChild(ddEl);
    ddEl = null;
    ddFields = null;
  }

  function positionDropdown() {
    if (!ddEl || !ddFields) return;
    const r = ddFields.user.getBoundingClientRect();
    ddEl.style.left = r.left + "px";
    ddEl.style.top = r.bottom + 4 + "px";
    ddEl.style.minWidth = Math.max(240, r.width) + "px";
  }

  async function fillCredential(fields, username) {
    const password = await vault.get(username);
    if (password == null) return;
    setValue(fields.user, username);
    setValue(fields.pw, password);
    hideDropdown();
    try { fields.pw.focus(); } catch (_) {}
  }

  // Click-to-arm, click-again-to-confirm (no native confirm() dialog); reverts after 4s.
  function confirmButton(btn, label, confirmLabel, onConfirm) {
    let armed = false;
    let timer = null;
    btn.textContent = label;
    // mousedown, not click: fires before the input's blur removes the dropdown.
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        btn.classList.add("pbcalc-pm-danger");
        timer = setTimeout(() => {
          armed = false;
          btn.textContent = label;
          btn.classList.remove("pbcalc-pm-danger");
        }, 4000);
        return;
      }
      clearTimeout(timer);
      onConfirm();
    });
  }

  // filter = what the user typed in the username field; only matching saved usernames show, and
  // nothing shows when none match (like Chrome's suggestions).
  async function showDropdown(fields, filter) {
    const all = await vault.list();
    const q = (filter || "").trim().toLowerCase();
    const list = (all || []).filter((i) => !q || String(i.username).toLowerCase().startsWith(q));
    hideDropdown();
    if (!list.length) return;
    ensureStyles();
    ddFields = fields;
    ddEl = el("div", "pbcalc-pm-dd");
    const rows = el("div", "pbcalc-pm-rows");
    for (const item of list) {
      const row = el("div", "pbcalc-pm-row");
      row.appendChild(keyIcon());
      const meta = el("div", "pbcalc-pm-meta");
      meta.appendChild(el("div", "pbcalc-pm-user", item.username));
      meta.appendChild(el("div", "pbcalc-pm-dots", "••••••••"));
      row.appendChild(meta);
      const del = el("button", "pbcalc-pm-del", "×");
      del.title = "Remove";
      row.appendChild(del);
      // mousedown (not click) so it lands before the input blur closes the dropdown.
      row.addEventListener("mousedown", (e) => {
        if (e.target === del) return;
        e.preventDefault();
        fillCredential(fields, item.username);
      });
      del.addEventListener("mousedown", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await vault.del(item.username);
        showDropdown(fields, fields.user.value);
      });
      rows.appendChild(row);
    }
    ddEl.appendChild(rows);
    const footer = el("div", "pbcalc-pm-footer");
    const resetBtn = el("button");
    resetBtn.type = "button";
    confirmButton(resetBtn, "Clear saved passwords for this site", "Sure? Click to confirm", async () => {
      await vault.reset();
      hideDropdown();
    });
    footer.appendChild(resetBtn);
    ddEl.appendChild(footer);
    document.body.appendChild(ddEl);
    positionDropdown();
  }

  // ── Save-password card ───────────────────────────────────────────────
  let barEl = null;
  function hideBar() {
    if (barEl && barEl.parentNode) barEl.parentNode.removeChild(barEl);
    barEl = null;
  }

  function showSaveBar(username, password) {
    hideBar();
    ensureStyles();
    barEl = el("div", "pbcalc-pm-bar");

    const h = el("h4");
    h.appendChild(keyIcon());
    h.appendChild(document.createTextNode("Save password?"));
    const close = el("button", "pbcalc-pm-close", "×");
    close.title = "Close";
    h.appendChild(close);
    barEl.appendChild(h);

    const userField = el("div", "pbcalc-pm-field");
    userField.appendChild(el("label", null, "Username"));
    const uw = el("div", "pbcalc-pm-inputwrap");
    const uIn = el("input");
    uIn.type = "text";
    uIn.readOnly = true;
    uIn.value = username;
    uw.appendChild(uIn);
    userField.appendChild(uw);
    barEl.appendChild(userField);

    const passField = el("div", "pbcalc-pm-field");
    passField.appendChild(el("label", null, "Password"));
    const pw = el("div", "pbcalc-pm-inputwrap");
    const pIn = el("input");
    pIn.type = "password";
    pIn.readOnly = true;
    pIn.value = password;
    const eye = el("button", "pbcalc-pm-eye", "👁");
    eye.title = "Show password";
    eye.addEventListener("click", () => { pIn.type = pIn.type === "password" ? "text" : "password"; });
    pw.appendChild(pIn);
    pw.appendChild(eye);
    passField.appendChild(pw);
    barEl.appendChild(passField);

    const actions = el("div", "pbcalc-pm-actions");
    const never = el("button", "pbcalc-pm-btn", "Never");
    const spacer = el("span", "pbcalc-pm-spacer");
    const no = el("button", "pbcalc-pm-btn", "No thanks");
    const yes = el("button", "pbcalc-pm-btn primary", "Save");
    [never, spacer, no, yes].forEach((n) => actions.appendChild(n));
    barEl.appendChild(actions);

    close.addEventListener("click", hideBar);
    no.addEventListener("click", hideBar);
    never.addEventListener("click", async () => { await vault.never(username); hideBar(); });
    yes.addEventListener("click", async () => { await vault.save(username, password); hideBar(); });
    document.body.appendChild(barEl);
  }

  async function offerSave(username, password) {
    try {
      if (await vault.needsPrompt(username, password)) showSaveBar(username, password);
    } catch (_) {}
  }

  // ── Login capture ────────────────────────────────────────────────────
  // SPA logins (no navigation): after submit, the password field disappearing from the page means
  // the login went through. Gives up after ~8s. A navigation login is handled by init() on the
  // next page instead — this page's JS (and this poll) is gone by then.
  let watch = null;
  function watchForSuccess(fields, username, password) {
    clearInterval(watch);
    let tries = 0;
    watch = setInterval(async () => {
      tries += 1;
      if (!isVisible(fields.pw)) {
        clearInterval(watch);
        const p = await vault.takePending(); // consume the stash so init() on a later page won't re-offer
        if (p) offerSave(username, password);
      } else if (tries > 26) {
        clearInterval(watch);
      }
    }, 300);
  }

  function captureOnSubmit(fields) {
    const username = (fields.user.value || "").trim();
    const password = fields.pw.value || "";
    if (!username || !password) return;
    vault.stash(username, password);
    watchForSuccess(fields, username, password);
  }

  function looksLikeSignIn(node) {
    if (!node) return false;
    if ((node.getAttribute("type") || "").toLowerCase() === "submit") return true;
    const txt = (node.textContent || node.value || "").trim().toLowerCase();
    return /sign\s*in|log\s*in|login/.test(txt);
  }

  let boundFields = null;
  let globalsAttached = false;
  function attachGlobalsOnce() {
    if (globalsAttached) return;
    globalsAttached = true;
    window.addEventListener("scroll", (e) => {
      if (ddEl && (e.target === ddEl || (ddEl.contains && ddEl.contains(e.target)))) return;
      hideDropdown();
    }, true);
    window.addEventListener("resize", positionDropdown);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideDropdown(); }, true);
    // SPA logins have no real <form> submit, so also catch clicks on sign-in-looking buttons.
    document.addEventListener("click", (e) => {
      if (!boundFields || !e.isTrusted) return;
      const btn = e.target.closest && e.target.closest('button,[role="button"],input[type="submit"]');
      if (btn && looksLikeSignIn(btn)) captureOnSubmit(boundFields);
    }, true);
  }

  function attach(fields) {
    attachGlobalsOnce();
    boundFields = fields;
    if (fields.user.__pbcalcPm && fields.pw.__pbcalcPm) return;
    fields.user.__pbcalcPm = true;
    fields.pw.__pbcalcPm = true;

    // Open only on a real click or real typing — never on focus (pages autofocus the username, and
    // that would pop the dropdown on every load).
    fields.user.addEventListener("click", () => showDropdown(fields, fields.user.value));
    fields.user.addEventListener("input", (e) => {
      if (!e.isTrusted) return;
      clearTimeout(ddInputTimer);
      ddInputTimer = setTimeout(() => showDropdown(fields, fields.user.value), 120);
    });
    fields.user.addEventListener("blur", () => setTimeout(hideDropdown, 150));

    const form = fields.pw.closest("form");
    if (form) form.addEventListener("submit", () => captureOnSubmit(fields), true);
    fields.pw.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.isTrusted) captureOnSubmit(fields); });
  }

  function scan() {
    const fields = findFields();
    if (fields) { attach(fields); return true; }
    return false;
  }

  function init() {
    // Navigation-style login: the previous page stashed a credential. If this page shows no
    // password field after a short settle, the login worked -> offer to save.
    vault.takePending().then((p) => {
      if (!p) return;
      setTimeout(() => { if (!findFields()) offerSave(p.username, p.password); }, 1500);
    }).catch(() => {});

    // Light 1s poll (no page-wide MutationObserver — that would tax every busy page). A page that
    // never shows a login form stops polling after ~30s.
    let loginSeen = scan();
    let empty = 0;
    const timer = setInterval(() => {
      if (scan()) { loginSeen = true; empty = 0; }
      else if (!loginSeen && ++empty >= 30) clearInterval(timer);
    }, 1000);
    window.addEventListener("unload", () => { clearInterval(timer); clearInterval(watch); });
  }

  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", init);
  else init();
})();
