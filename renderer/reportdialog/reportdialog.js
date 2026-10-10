(function () {
  "use strict";
  const api = window.reportDialogAPI;
  const $ = (id) => document.getElementById(id);
  let busy = false, done = false;

  const REASONS = {
    crash: "A page stopped working and had to be closed. A report helps us fix it.",
    hang: "A page stopped responding. A report helps us find out why.",
  };

  function setStatus(text, kind) {
    $("rd-status").hidden = false;
    $("rd-msg").textContent = text;
    $("rd-status").className = "status " + (kind || "");
    $("rd-spin").hidden = kind !== "busy";
  }

  const lock = (on) => { $("rd-send").disabled = on; $("rd-cancel").disabled = on; $("rd-note").disabled = on; $("rd-save").disabled = on; };

  async function send() {
    if (busy || done) return;
    busy = true; lock(true);
    setStatus("Sending the report...", "busy");
    let r;
    try { r = await api.send($("rd-note").value); } catch (_) { r = { ok: false, offline: false }; }
    busy = false;
    if (r && r.ok) {
      done = true;
      $("rd-form").hidden = true;
      setStatus("The report was sent to the Software department. Thank you.", "ok");
      $("rd-send").hidden = true; $("rd-save").hidden = true; $("rd-cancel").disabled = false; $("rd-cancel").textContent = "Close";
      setTimeout(() => api.close(), 2500);
    } else {
      // not a technical error: either this computer is away from the company network, or the IT folder would not take the file. Either way: tell the IT department / save the file.
      setStatus(r && r.offline
        ? "This computer is not connected to the company network, so the report could not be sent. Please tell the IT department - press \"Save as file\" and give them the file - or try again when you are in the office."
        : "The report could not be put in the Software department's folder. Please tell the Software department - press \"Save as file\" and give them the file.", "warn");
      lock(false);
      $("rd-send-label").textContent = "Try again";
    }
  }

  async function saveFile() {
    if (busy || done) return;
    busy = true; lock(true);
    let r;
    try { r = await api.saveFile($("rd-note").value); } catch (_) { r = { ok: false }; }
    busy = false; lock(false);
    if (r && r.ok) setStatus("The file \"" + r.name + "\" was saved. Please give it to the Software department (e-mail, WhatsApp or a USB stick).", "ok");
    else if (r && r.canceled) { /* nothing chosen: nothing to say */ }
    else setStatus("The file could not be saved. Please tell the Software department.", "warn");
  }

  $("rd-send").addEventListener("click", send);
  $("rd-save").addEventListener("click", saveFile);
  $("rd-cancel").addEventListener("click", () => { if (!busy) api.close(); });
  // Esc closes (it never sends). Enter in the note is a new line; only the Send button sends.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !busy) { e.preventDefault(); api.close(); } });
  // the window must always be as tall as the box: the status message appears AFTER the window was sized (it used to push the buttons out of sight)
  const dlg = document.querySelector(".dlg");
  if (typeof ResizeObserver === "function") new ResizeObserver(() => api.fit(Math.ceil(dlg.getBoundingClientRect().height))).observe(dlg);
  api.onInit((info) => {
    info = info || {};
    $("rd-computer").textContent = info.computer || "";
    $("rd-version").textContent = info.version ? "v" + info.version : "";
    if (info.noteMax) $("rd-note").maxLength = info.noteMax;
    if (REASONS[info.trigger]) { $("rd-reason").textContent = REASONS[info.trigger]; $("rd-reason").hidden = false; $("rd-title").textContent = "PBCalc had a problem"; }
    $("rd-note").focus();
  });
})();
