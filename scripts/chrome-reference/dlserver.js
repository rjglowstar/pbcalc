// Tiny server for capture-dlanim.ps1: a blank white page that starts a download by itself a few
// seconds after it loads (like a click on a Download link), so the screen capture is already running.
//   node dlserver.js            (port 8126)
//   /dlpage?delay=3500          white page; navigates to the file after `delay` ms
//   /dl.bin                     a small attachment
const http = require("http");
http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/dl.bin") {
    const b = Buffer.alloc(200 * 1024, 7);
    r.setHeader("content-type", "application/octet-stream");
    r.setHeader("content-disposition", 'attachment; filename="anim-test.bin"');
    r.setHeader("content-length", b.length);
    return r.end(b);
  }
  const delay = Number(u.searchParams.get("delay") || 3500);
  // optional: a SECOND download `delay2` ms after the first (the Downloads button already exists then,
  // which is the situation the owner's screenshot shows)
  const delay2 = Number(u.searchParams.get("delay2") || 0);
  r.setHeader("content-type", "text/html");
  // plain white, nothing but a tiny label far from the top-right where the animation travels
  r.end(`<!doctype html><title>dl</title><body style="margin:0;background:#fff;font:12px sans-serif;overflow:hidden"><div style="padding:300px 20px">white page - download starts in ${delay}ms${delay2 ? `, again ${delay2}ms later` : ""}</div><script>setTimeout(()=>{ location.href = "/dl.bin?n=1"; }, ${delay});${delay2 ? `setTimeout(()=>{ location.href = "/dl.bin?n=2"; }, ${delay + delay2});` : ""}</script>`);
}).listen(8126, "127.0.0.1", () => console.log("listening 8126"));
