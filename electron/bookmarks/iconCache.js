// Bookmark icons, downloaded ONCE and kept (owner 2026-10-13: "every start the bookmark icons load again - store them").
// A bookmark's icon used to be kept as a web address. PBCalc wipes the browser cache when it closes (privacy.js), so every start downloaded every icon
// again and the bookmarks bar showed a globe / nothing until it arrived. Now each such icon is fetched once, made a 32x32 PNG (an SVG icon is kept as
// it is) and stored IN the bookmark (data:image/..., the same as the built-in dummy sites' icons): from then on it is drawn at once, also offline.
// Runs a few seconds after the start for whatever is still a web address (both lists, both modes - nothing visible changes but the speed), and soon
// after a bookmark gets a new icon (broadcastBookmarks). A failed download changes nothing; it is tried again at the next start. Nothing is recorded
// about pages: only the icon of a page the user bookmarked, which the bar downloads anyway.
const { nativeImage, session } = require("electron");
const fs = require("fs"), os = require("os"), path = require("path");

const MAX_BYTES = 256 * 1024;      // an icon larger than this is not an icon
const MAX_DATA = 32 * 1024;        // = bookmarkStore's limit for an embedded icon
const TIMEOUT_MS = 8000;
let running = false;
let again = false;
let soonTimer = null;

async function fetchBytes(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const { TAB_PARTITION } = require("../constants");
    const res = await session.fromPartition(TAB_PARTITION).fetch(url, { signal: ctl.signal, credentials: "omit", redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { buf, type: String(res.headers.get("content-type") || "").toLowerCase() };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// bytes -> data:image/... (32x32 PNG; an SVG stays SVG). null when it is not a picture PBCalc can read.
function toDataUrl(buf, type, url) {
  const head = buf.slice(0, 256).toString("utf8").trimStart().toLowerCase();
  if (type.includes("svg") || /\.svg(\?|#|$)/i.test(url) || head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    const d = "data:image/svg+xml;base64," + buf.toString("base64");
    return d.length <= MAX_DATA ? d : null;
  }
  let img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty() && buf.length > 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
    // .ico: Windows reads it from a file
    const f = path.join(os.tmpdir(), "pbc-icon-" + process.pid + "-" + Date.now() + ".ico");
    try { fs.writeFileSync(f, buf); img = nativeImage.createFromPath(f); } catch (_) {} finally { try { fs.unlinkSync(f); } catch (_) {} }
  }
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (!width || !height) return null;
  const small = width > 32 || height > 32 ? img.resize(width >= height ? { width: 32, quality: "best" } : { height: 32, quality: "best" }) : img;
  const d = small.toDataURL();
  return d.length <= MAX_DATA ? d : null;
}

// Embeds every icon that is still a web address. Returns how many were stored.
async function embedAll() {
  if (running) { again = true; return 0; }
  running = true;
  let stored = 0;
  try {
    const store = require("./bookmarkStore");
    const todo = store.webIconBookmarks();
    const byUrl = new Map();   // one download per address (two bookmarks of one site share it)
    for (const b of todo) {
      if (!byUrl.has(b.favicon)) {
        const got = await fetchBytes(b.favicon);
        byUrl.set(b.favicon, got ? toDataUrl(got.buf, got.type, b.favicon) : null);
      }
      const data = byUrl.get(b.favicon);
      if (data && store.embedIcon(b.kind, b.id, b.favicon, data)) stored++;
    }
    if (stored) { try { require("../tabs/tabManager").broadcastBookmarks(); } catch (_) {} }
  } catch (_) {
  } finally {
    running = false;
  }
  if (again) { again = false; return stored + (await embedAll()); }
  return stored;
}

// After a bookmark got a new (web-address) icon: embed it a moment later (several changes in a row are one pass).
function embedSoon(ms = 1500) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    try { if (require("./bookmarkStore").webIconBookmarks().length) embedAll(); } catch (_) {}
  }, ms);
  if (soonTimer.unref) soonTimer.unref();
}

module.exports = { embedAll, embedSoon, toDataUrl };
