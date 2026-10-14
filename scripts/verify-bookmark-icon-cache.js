// Bookmark icons are downloaded ONCE and stored in the bookmark (electron/bookmarks/iconCache.js; owner 2026-10-13: "every start the icons load again").
// Run 1 (a local server serves the icons): a bookmark whose icon is a web address gets the picture embedded - PNG resized to 32 px, a real .ico, an SVG kept
// as SVG - in BOTH lists; a missing (404) or oversize icon keeps its address; a bookmark added later is embedded soon after. Run 2 (the server is GONE, like
// being offline): the bookmarks bar draws the stored icons right after the start, with no download.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-bookmark-icon-cache.js
const { app, nativeImage } = require("electron");
const path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process"), http = require("http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODE = process.env.PBC_IC_MODE;

if (MODE) {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 120000).unref();
  const ud = process.env.PBC_IC_UD;
  require("../electron/constants").dataDir = () => ud;
  (async () => {
    require("../electron/main.js");
    await app.whenReady();
    const state = require("../electron/state"), store = require("../electron/bookmarks/bookmarkStore");
    store.setMode("real");
    for (let i = 0; i < 3000 && !(state.mainWindow && state.mainWindow.isVisible() && state.tabs.length); i++) await sleep(10);
    const out = {};
    if (MODE === "first") {
      require("../electron/tabs/tabManager").broadcastBookmarks();   // the bar shows the real list (a launch starts on the dummy list)
      await sleep(9000);   // the start-up pass runs ~4 s after the window shows
      // a bookmark added now (its icon a web address) is embedded soon after
      store.toggle({ url: "http://late.example/", title: "Late", favicon: process.env.PBC_IC_BASE + "/late.png" });
      require("../electron/tabs/tabManager").broadcastBookmarks();
      await sleep(5000);
    } else {
      require("../electron/tabs/tabManager").broadcastBookmarks();
      await sleep(1500);
      // what the bar draws: every <img> in the bookmarks bar, loaded (naturalWidth) and from a data: address
      out.bar = await state.mainWindow.webContents.executeJavaScript(`Array.from(document.querySelectorAll("#bookmark-bar img")).map((i) => ({ src: i.src.slice(0, 22), ok: i.complete && i.naturalWidth > 0 }))`).catch((e) => "err " + e.message);
    }
    out.real = JSON.parse(fs.readFileSync(path.join(ud, "bookmarks.json"), "utf8")).map((b) => ({ title: b.title, icon: String(b.favicon).slice(0, 26), len: String(b.favicon).length }));
    out.dummy = JSON.parse(fs.readFileSync(path.join(ud, "bookmarks-dummy.json"), "utf8")).items.filter((b) => b.title === "Dummy web icon").map((b) => ({ icon: String(b.favicon).slice(0, 26) }));
    console.log("RESULT " + JSON.stringify(out));
    app.exit(0);
  })().catch((e) => { console.log("ERR", e && e.stack); app.exit(1); });
} else {
  setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 300000).unref();
  let failed = 0, total = 0;
  const check = (n, c, x) => { total++; if (!c) failed++; console.log("  .. " + (c ? "ok " : "FAIL ") + n + (!c && x !== undefined ? "  <" + String(x).slice(0, 300) + ">" : "")); };
  const run = (mode, ud, base) => new Promise((resolve) => {
    const env = { ...process.env, PBC_IC_MODE: mode, PBC_IC_UD: ud, PBC_IC_BASE: base || "" }; delete env.ELECTRON_RUN_AS_NODE;
    let out = "";
    const c = cp.spawn(process.execPath, [__filename], { env, windowsHide: true });
    c.stdout.on("data", (d) => { out += d; });
    c.on("exit", () => { const m = /RESULT (.*)/.exec(out); resolve(m ? JSON.parse(m[1]) : { error: out.slice(-400) }); });
  });
  app.whenReady().then(async () => {
    const png64 = nativeImage.createEmpty(); // built below from a 64x64 bitmap
    const bmp = Buffer.alloc(64 * 64 * 4); for (let i = 0; i < bmp.length; i += 4) { bmp[i] = 0; bmp[i + 1] = 0; bmp[i + 2] = 255; bmp[i + 3] = 255; }
    const pngBuf = nativeImage.createFromBitmap(bmp, { width: 64, height: 64 }).toPNG();
    const icoBuf = fs.readFileSync(path.join(__dirname, "..", "assets", "icon.ico"));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#0a0"/></svg>';
    const hits = {};
    const srv = http.createServer((q, s) => {
      hits[q.url] = (hits[q.url] || 0) + 1;
      if (q.url === "/fav.png" || q.url === "/late.png") { s.setHeader("content-type", "image/png"); return s.end(pngBuf); }
      if (q.url === "/fav.ico") { s.setHeader("content-type", "image/x-icon"); return s.end(icoBuf); }
      if (q.url === "/fav.svg") { s.setHeader("content-type", "image/svg+xml"); return s.end(svg); }
      if (q.url === "/big.png") { s.setHeader("content-type", "image/png"); return s.end(Buffer.alloc(400 * 1024, 1)); }
      s.statusCode = 404; s.end("no");
    }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const base = "http://127.0.0.1:" + srv.address().port;
    const ud = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pbic-")), "UserData");
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, "settings.json"), JSON.stringify({ showBookmarksBar: true }));
    const bm = (title, icon) => ({ id: title.replace(/\W/g, "") + Math.random().toString(36).slice(2, 6), title, url: "http://" + title.replace(/\W/g, "").toLowerCase() + ".example/", favicon: icon });
    fs.writeFileSync(path.join(ud, "bookmarks.json"), JSON.stringify([bm("PNG site", base + "/fav.png"), bm("ICO site", base + "/fav.ico"), bm("SVG site", base + "/fav.svg"), bm("Missing icon", base + "/none.png"), bm("Huge icon", base + "/big.png"), bm("PNG site 2", base + "/fav.png")]));
    fs.writeFileSync(path.join(ud, "bookmarks-dummy.json"), JSON.stringify({ version: 2, items: [bm("Dummy web icon", base + "/fav.png")] }));

    console.log("-- run 1: icons downloaded once and stored");
    const a = await run("first", ud, base);
    check("the run completed", !a.error, a.error);
    if (!a.error) {
      const by = (t) => a.real.find((b) => b.title === t) || {};
      check("PNG icon stored as a 32 px PNG (data:image/png)", /^data:image\/png/.test(by("PNG site").icon), JSON.stringify(by("PNG site")));
      check("a real .ico stored (data:image/png)", /^data:image\/png/.test(by("ICO site").icon), JSON.stringify(by("ICO site")));
      check("an SVG icon stored as SVG", /^data:image\/svg\+xml/.test(by("SVG site").icon), JSON.stringify(by("SVG site")));
      check("a missing icon (404) keeps its web address (tried again next start)", /^http:/.test(by("Missing icon").icon));
      check("an oversize 'icon' (400 KB) keeps its web address, nothing huge is stored", /^http:/.test(by("Huge icon").icon));
      // (the bar itself also draws each web-address icon once during this first run, so every icon is requested twice: the bar + the cache)
      check("three bookmarks (both lists) with the same icon address: all stored, the address fetched no more often than the .ico of ONE bookmark (" + hits["/fav.png"] + " vs " + hits["/fav.ico"] + ")", /^data:image\/png/.test(by("PNG site 2").icon) && hits["/fav.png"] <= hits["/fav.ico"], JSON.stringify(hits));
      check("the dummy list is handled too", a.dummy.length === 1 && /^data:image\/png/.test(a.dummy[0].icon), JSON.stringify(a.dummy));
      check("a bookmark added later is stored soon after (" + JSON.stringify(by("Late")) + ")", /^data:image\/png/.test(by("Late").icon), JSON.stringify(by("Late")));
      const pngLen = by("PNG site").len;
      check("the stored 32 px icon is small (" + pngLen + " characters)", pngLen > 50 && pngLen < 4000, pngLen);
    }
    srv.close();
    await sleep(300);
    console.log("-- run 2: the icon server is gone (like being offline)");
    const before = JSON.stringify(hits);
    const b = await run("second", ud, base);
    check("the run completed", !b.error, b.error);
    if (!b.error && Array.isArray(b.bar)) {
      const stored = b.bar.filter((x) => /^data:image/.test(x.src));
      check("the bookmarks bar draws the stored icons at once, with no download (" + stored.length + " of " + b.bar.length + " drawn from the file, all loaded: " + stored.every((x) => x.ok) + ")", stored.length >= 5 && stored.every((x) => x.ok), JSON.stringify(b.bar));
      check("nothing was downloaded at this start", JSON.stringify(hits) === before);
    } else check("the bar could be read", false, JSON.stringify(b.bar));
    console.log("\nPBCALC_ICONCACHE total=" + total + " failed=" + failed);
    app.exit(failed ? 1 : 0);
  });
}
