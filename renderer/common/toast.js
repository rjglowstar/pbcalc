// Common notification ("toast") for PBCalc's own pages: PBToast.show("Password changed.", { type: "success" }).
// Types: success (green), error (red), warning (amber), info (blue). Slides in at the top right, closes by itself after a few seconds
// (errors stay a little longer; hovering pauses the countdown), has a close button, and several can stack. The page must load
// theme.css (the look) and this file; nothing is inline, so it works under the pages' strict CSP.
(function () {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PATHS = {
    success: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.4-1.4L10 14.2l7.6-7.6L19 8l-9 9z",
    error: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
    warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
    info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  };
  const MAX = 4;
  const DEFAULT_MS = { success: 4000, info: 4000, warning: 6000, error: 6000 };
  let host = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.className = "pb-toasts";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
    return host;
  }

  function icon(type) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "pb-toast-icon");
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", PATHS[type]);
    svg.appendChild(p);
    return svg;
  }

  // Shows a notification and returns a function that closes it. Unknown types count as info.
  function show(message, opts) {
    const o = opts || {};
    const type = PATHS[o.type] ? o.type : "info";
    const box = ensureHost();
    // The same message, or a newer one with the same opts.key (e.g. each result of one form), replaces the old one instead of stacking.
    for (const old of Array.from(box.children)) {
      const same = old.querySelector(".pb-toast-text").textContent === String(message) && old.classList.contains(type);
      if (same || (o.key && old.dataset.key === o.key)) box.removeChild(old);
    }
    while (box.children.length >= MAX) box.removeChild(box.firstChild);
    const t = document.createElement("div");
    t.className = "pb-toast " + type;
    if (o.key) t.dataset.key = o.key;
    t.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
    t.appendChild(icon(type));
    const text = document.createElement("div");
    text.className = "pb-toast-text";
    text.textContent = String(message);
    t.appendChild(text);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "pb-toast-x";
    x.setAttribute("aria-label", "Close");
    x.textContent = "×";
    t.appendChild(x);
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));

    let timer = null, left = o.ms > 0 ? o.ms : DEFAULT_MS[type], started = 0, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      t.classList.remove("in");
      t.classList.add("out");
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 220);   // after the slide-out
    };
    const start = () => { started = Date.now(); timer = setTimeout(close, left); };
    const pause = () => { clearTimeout(timer); left = Math.max(1200, left - (Date.now() - started)); };
    t.addEventListener("mouseenter", pause);
    t.addEventListener("mouseleave", () => { if (!closed) start(); });
    x.addEventListener("click", close);
    start();
    return close;
  }

  window.PBToast = { show, success: (m, o) => show(m, { ...o, type: "success" }), error: (m, o) => show(m, { ...o, type: "error" }),
    warning: (m, o) => show(m, { ...o, type: "warning" }), info: (m, o) => show(m, { ...o, type: "info" }) };
})();
