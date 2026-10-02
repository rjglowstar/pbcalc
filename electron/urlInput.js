// Turns what was typed into the address bar into a URL to load: a real address, or a Google
// search. Follows Chrome's habits:
//   - "https://x", "file:..." etc. are used as they are
//   - localhost, IP addresses and "host:port" / "host/path" with a single-word host (an intranet
//     name like http://pb/ or localhost:4200) are addresses, and load over http://
//   - "name.tld" style text is an address, and loads over https://
//   - anything else — words, or text with spaces — is a search
// (Mirrored in renderer/newtab/newtab.js, which cannot require this file.)
const SEARCH = "https://www.google.com/search?q=";

function resolveInput(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(file|about|data):/i.test(t)) return t;
  if (/\s/.test(t)) return SEARCH + encodeURIComponent(t);

  const m = /^([^\/:?#]+)(:\d{1,5})?([\/?#].*)?$/.exec(t);
  if (m) {
    const host = m[1];
    const hasPortOrPath = !!m[2] || !!m[3];
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (host.toLowerCase() === "localhost" || isIp) return "http://" + t;
    if (!host.includes(".") && hasPortOrPath) return "http://" + t; // intranet name
    if (/^[^.]+(\.[^.]+)*\.[^.]{2,}$/.test(host)) return "https://" + t;
  }
  return SEARCH + encodeURIComponent(t);
}

// The Google search address for a piece of text (what the "<text> - Google Search" row opens).
function searchUrl(text) {
  return SEARCH + encodeURIComponent(String(text == null ? "" : text).trim());
}

module.exports = { resolveInput, searchUrl };
