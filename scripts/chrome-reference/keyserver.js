// Tiny page server for the Chrome keyboard-behaviour capture. Each page has an autofocused input
// that echoes what is typed into the TAB TITLE, so the window title reveals which tab is active AND
// whether keyboard focus is in the page (typed text shows up) or elsewhere (it does not).
const http = require("http");
http.createServer((q, r) => {
  const m = /^\/p(\d)/.exec(q.url);
  r.setHeader("content-type", "text/html");
  if (!m) return r.end("<title>other</title>");
  const n = m[1];
  r.end(`<!doctype html><title>P${n}</title><body><input id=i autofocus oninput="document.title='P${n}:'+this.value"></body>`);
}).listen(8125, "127.0.0.1", () => console.log("listening 8125"));
