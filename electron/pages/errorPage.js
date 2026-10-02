// In-browser error pages (failed load, certificate problem, renderer crash). Generated as a
// data: URL so nothing is written to disk and there is no extra file to ship. The buttons are
// plain links to pbcalc://retry and pbcalc://proceed, which tabManager intercepts in
// will-navigate — and only honours while the tab really is showing one of these pages.
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const COPY = {
  ERR_NAME_NOT_RESOLVED: "The site's address could not be found. Check the spelling, or your internet connection.",
  ERR_INTERNET_DISCONNECTED: "You are offline. Check your network connection and try again.",
  ERR_CONNECTION_REFUSED: "The site refused the connection.",
  ERR_CONNECTION_TIMED_OUT: "The site took too long to respond.",
  ERR_CONNECTION_RESET: "The connection was reset.",
  ERR_ADDRESS_UNREACHABLE: "The site could not be reached from this network.",
  ERR_TOO_MANY_REDIRECTS: "The site redirected too many times.",
};

// kind: "load" | "cert" | "crash"
function buildErrorPage({ kind, url, code, description, hideUrl }) {
  let title = "This site can’t be reached";
  let detail = COPY[description] || "The page could not be loaded.";
  let extra = "";

  if (kind === "cert") {
    title = "Your connection is not private";
    detail =
      "The site’s security certificate could not be verified, so someone could be intercepting your traffic. " +
      "Only continue if you trust this site.";
    // In Restricted Mode there is no way to bypass a certificate problem.
    extra = hideUrl ? "" : '<a class="btn ghost" href="pbcalc://proceed">Proceed anyway (unsafe)</a>';
  } else if (kind === "blocked") {
    title = "This site is blocked";
    detail = "Your administrator only allows the sites on your list. This address is not one of them.";
  } else if (kind === "crash") {
    title = "This page crashed";
    detail = "The page’s process ended unexpectedly. Reloading usually fixes it.";
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#f5f6fa;color:#1b1e3d;font-family:"Segoe UI",Arial,sans-serif}
  .box{max-width:520px;padding:32px}
  h1{font-size:22px;margin:0 0 12px}
  p{font-size:14px;line-height:1.5;color:#4a4e69;margin:0 0 8px}
  .url{word-break:break-all;color:#7a7f99;font-size:12px}
  .code{font-size:12px;color:#7a7f99;margin-top:16px}
  .btn{display:inline-block;margin:16px 10px 0 0;padding:8px 18px;border-radius:6px;font-size:13px;
    text-decoration:none;background:#4a6cf7;color:#fff}
  .btn.ghost{background:none;color:#b3261e;border:1px solid #e3b5b1}
</style></head><body><div class="box">
<h1>${esc(title)}</h1>
<p>${esc(detail)}</p>
${hideUrl ? "" : `<p class="url">${esc(url)}</p>`}
<a class="btn" href="pbcalc://retry">${kind === "crash" ? "Reload" : "Try again"}</a>${extra}
<div class="code">${esc(description || (kind === "crash" ? "RENDERER_CRASHED" : ""))}${code ? " (" + esc(code) + ")" : ""}</div>
</div></body></html>`;

  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

module.exports = { buildErrorPage };
