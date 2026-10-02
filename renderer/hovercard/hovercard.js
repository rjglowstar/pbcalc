(function () {
  const api = window.cardAPI;
  if (!api) return;
  const card = document.getElementById("card");
  const title = document.getElementById("title");
  const host = document.getElementById("host");
  const thumb = document.getElementById("thumb");

  api.onData((d) => {
    title.textContent = d.title || "New Tab";
    host.textContent = d.host || ""; // empty in Restricted Mode (no addresses are ever shown)
    if (d.thumb) {
      thumb.src = d.thumb;
      thumb.hidden = false;
    } else {
      thumb.removeAttribute("src");
      thumb.hidden = true;
    }
    card.hidden = false;
  });
})();
