(function () {
  const api = window.restrictedAPI;
  const tiles = document.getElementById("tiles");
  const empty = document.getElementById("empty");
  if (!api) return;

  api.list().then((items) => {
    empty.hidden = !!(items && items.length);
    (items || []).forEach((b) => {
      const tile = document.createElement("div");
      tile.className = "tile";

      const ico = document.createElement("div");
      ico.className = "ico";
      const letter = (b.title || "?").trim().charAt(0) || "?";
      if (b.favicon) {
        const img = document.createElement("img");
        img.src = b.favicon;
        img.alt = "";
        img.addEventListener("error", () => { img.remove(); ico.textContent = letter; });
        ico.appendChild(img);
      } else {
        ico.textContent = letter;
      }
      tile.appendChild(ico);

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = b.title; // deliberately no address shown
      tile.appendChild(name);

      tile.addEventListener("click", () => api.open(b.id));
      tiles.appendChild(tile);
    });
  });
})();
