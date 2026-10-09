(function () {
  const form = document.getElementById("form");
  const q = document.getElementById("q");

  // Same rules as the address bar (electron/urlInput.js, kept in step by hand): addresses load,
  // localhost / IPs / "host:port" / single-word "host/path" load over http, name.tld over https,
  // everything else is a Google search.
  function resolve(t) {
    const SEARCH = "https://www.google.com/search?q=";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(file|about|data):/i.test(t)) return t;
    if (/\s/.test(t)) return SEARCH + encodeURIComponent(t);
    if (/^\[[0-9a-f:.]+\](:\d{1,5})?([\/?#].*)?$/i.test(t)) return "http://" + t;
    const m = /^([^\/:?#]+)(:\d{1,5})?([\/?#].*)?$/.exec(t);
    if (m) {
      const host = m[1];
      const hasPortOrPath = !!m[2] || !!m[3];
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      if (host.toLowerCase() === "localhost" || isIp) return "http://" + t;
      if (host.indexOf(".") === -1 && hasPortOrPath) return "http://" + t;
      if (/^[^.]+(\.[^.]+)*\.[^.]{2,}$/.test(host)) return "https://" + t;
    }
    return SEARCH + encodeURIComponent(t);
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    let target = q.value.trim();
    if (!target) return;
    location.href = resolve(target);
  });
})();
