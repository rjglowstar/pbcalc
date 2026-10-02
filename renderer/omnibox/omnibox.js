(function () {
  const api = window.omniboxAPI;
  const I = window.PBIcons;
  const card = document.getElementById("card");
  if (!api) return;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // "youtube" typed, "youtube video" suggested -> youtube + <b> video</b>, like Chrome
  function withBoldCompletion(typed, text) {
    const span = el("span");
    const t = typed.trim();
    if (t && text.toLowerCase().startsWith(t.toLowerCase()) && text.length > t.length) {
      span.appendChild(document.createTextNode(text.slice(0, t.length)));
      span.appendChild(el("b", null, text.slice(t.length)));
    } else {
      span.appendChild(document.createTextNode(text));
    }
    return span;
  }

  function hostOf(url) {
    try { return new URL(url).host.replace(/^www\./, ""); } catch (_) { return url; }
  }

  function icon(row) {
    const box = el("span", "ico");
    if (row.kind === "bookmark") {
      if (row.favicon) {
        const img = el("img");
        img.src = row.favicon;
        img.alt = "";
        img.addEventListener("error", () => { box.textContent = ""; box.appendChild(I.icon("starFilled")); });
        box.appendChild(img);
      } else {
        box.appendChild(I.icon("starFilled"));
      }
    } else if (row.kind === "tab") box.appendChild(I.icon("tab"));
    else if (row.kind === "nav" || row.kind === "url") box.appendChild(I.icon("globe"));
    else box.appendChild(I.icon("search"));
    return box;
  }

  function render(d) {
    card.textContent = "";
    card.hidden = !d.rows.length;
    d.rows.forEach((row, i) => {
      const r = el("div", "row" + (i === d.selected ? " selected" : ""));
      r.appendChild(icon(row));
      const txt = el("div", "txt");
      if (row.kind === "search") {
        txt.appendChild(document.createTextNode(row.text));
        txt.appendChild(el("span", "muted", "  -  Google Search"));
      } else if (row.kind === "url") {
        txt.appendChild(el("span", "url", row.text));
        txt.appendChild(el("span", "muted", "  -  Open"));
      } else if (row.kind === "query") {
        txt.appendChild(withBoldCompletion(d.typed, row.text));
      } else if (row.kind === "nav") {
        if (row.title) { txt.appendChild(el("b", null, row.title)); txt.appendChild(el("span", "muted", "  -  ")); }
        txt.appendChild(el("span", "url", hostOf(row.url)));
      } else if (row.kind === "bookmark") {
        txt.appendChild(document.createTextNode(row.title + "  -  "));
        txt.appendChild(el("span", "url", hostOf(row.url)));
      } else if (row.kind === "tab") {
        txt.appendChild(document.createTextNode(row.title + "  -  "));
        txt.appendChild(el("span", "url", hostOf(row.url)));
      }
      r.appendChild(txt);
      if (row.kind === "tab") r.appendChild(el("span", "action", "Switch to this tab"));
      // mousedown, not click: focus is leaving the address bar at this moment
      r.addEventListener("mousedown", (e) => { e.preventDefault(); api.pick(i); });
      card.appendChild(r);
    });
  }

  api.onData(render);
})();
