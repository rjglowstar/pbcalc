(function () {
  const api = window.managerAPI;
  if (!api) return;

  const listEl = document.getElementById("list");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("count");
  const addMsg = document.getElementById("add-msg");
  let items = [];
  let editing = null; // id being edited

  const ERR = {
    "bad-url": "Enter a valid web address (http or https).",
    duplicate: "That address is already in the list.",
    "not-found": "That site no longer exists.",
    unavailable: "Not allowed.",
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(label, cls, fn) {
    const b = el("button", "btn " + cls, label);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  }

  function icon(b) {
    const box = el("div", "ico");
    if (b.favicon) {
      const img = el("img");
      img.src = b.favicon;
      img.alt = "";
      img.addEventListener("error", () => { img.remove(); box.appendChild(el("span", "", (b.title || "?").charAt(0).toUpperCase())); });
      box.appendChild(img);
    } else {
      box.appendChild(el("span", "", (b.title || "?").charAt(0).toUpperCase()));
    }
    return box;
  }

  function render() {
    listEl.textContent = "";
    countEl.textContent = items.length ? "(" + items.length + ")" : "";
    emptyEl.hidden = items.length > 0;
    items.forEach((b, i) => {
      const row = el("div", "row");
      row.appendChild(icon(b));
      if (editing === b.id) {
        const t = el("input", "title");
        t.value = b.title;
        t.placeholder = "Name";
        const u = el("input", "url");
        u.value = b.url;
        u.spellcheck = false;
        const msg = el("span", "msg");
        const save = async () => {
          const r = await api.update(b.id, t.value, u.value);
          if (r.ok) { items = r.list; editing = null; render(); }
          else { msg.textContent = ERR[r.error] || "Could not save."; }
        };
        [t, u].forEach((inp) => inp.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { editing = null; render(); } }));
        row.appendChild(t);
        row.appendChild(u);
        const actions = el("div", "actions");
        actions.appendChild(button("Save", "small primary", save));
        actions.appendChild(button("Cancel", "small", () => { editing = null; render(); }));
        row.appendChild(actions);
        listEl.appendChild(row);
        if (msg.textContent === "") { /* placeholder for messages */ }
        row.appendChild(msg);
        setTimeout(() => t.focus(), 0);
        return;
      }
      const info = el("div", "static");
      info.appendChild(el("div", "t", b.title));
      info.appendChild(el("div", "u", b.url));
      row.appendChild(info);
      const actions = el("div", "actions");
      const up = button("↑", "small", async () => { items = await api.move(b.id, -1); render(); });
      const down = button("↓", "small", async () => { items = await api.move(b.id, 1); render(); });
      up.title = "Move up";
      down.title = "Move down";
      up.disabled = i === 0;
      down.disabled = i === items.length - 1;
      actions.appendChild(up);
      actions.appendChild(down);
      actions.appendChild(button("Edit", "small", () => { editing = b.id; render(); }));
      // two clicks to delete (no native confirm() dialog)
      const del = button("Delete", "small danger", async () => {
        if (del.dataset.armed !== "1") {
          del.dataset.armed = "1";
          del.textContent = "Sure?";
          setTimeout(() => { del.dataset.armed = ""; del.textContent = "Delete"; }, 3000);
          return;
        }
        items = await api.remove(b.id);
        render();
      });
      actions.appendChild(del);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  document.getElementById("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const titleIn = document.getElementById("add-title");
    const urlIn = document.getElementById("add-url");
    const r = await api.add(titleIn.value, urlIn.value);
    if (r.ok) {
      items = r.list;
      titleIn.value = "";
      urlIn.value = "";
      addMsg.textContent = "";
      render();
    } else {
      addMsg.textContent = ERR[r.error] || "Could not add.";
    }
  });

  api.list().then((l) => { items = l || []; render(); });
})();
