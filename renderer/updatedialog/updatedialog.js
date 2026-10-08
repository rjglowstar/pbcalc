(function () {
  "use strict";
  const api = window.updateDialogAPI;
  const $ = (id) => document.getElementById(id);
  let answered = false;
  const answer = (yes) => {
    if (answered) return;
    answered = true;
    $("ud-update").disabled = true; $("ud-cancel").disabled = true;
    api.answer(!!yes);
  };
  $("ud-update").addEventListener("click", () => answer(true));
  $("ud-cancel").addEventListener("click", () => answer(false));
  // Esc = Cancel (never an update). Enter does nothing until a button is focused (Tab): a stray Enter while typing elsewhere must not decide anything.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); answer(false); } });
  api.onInit((info) => {
    if (info && info.version) {
      $("ud-to").textContent = "v" + info.version;
      $("ud-to2").textContent = "v" + info.version;
      if (info.current) { $("ud-from").textContent = "v" + info.current; $("ud-versions").hidden = false; }
    }
    document.querySelector(".dlg").focus();
  });
})();
