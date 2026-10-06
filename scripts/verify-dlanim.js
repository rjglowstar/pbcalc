// Chrome's "download started" flight: a circled download arrow rises to the toolbar Downloads button.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-dlanim.js
//
// Reported: with no Save As dialog and no sign of progress, nothing told you a download had started;
// Chrome flies a circled arrow up to its Downloads button. Numbers (size, path, opacity, timing) come
// from a frame-by-frame recording of Chrome — see scripts/chrome-reference/README.md.
const { app, session, nativeTheme } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-dlanim-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (let i = 0; i < ms / 25; i++) { if (await fn()) return true; await sleep(25); } return false; };
setTimeout(() => { console.log("WATCHDOG after " + results.length); app.exit(2); }, 120000).unref();

let srv, base;
const ready = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/dl.bin") {
      res.setHeader("content-type", "application/octet-stream");
      res.setHeader("content-disposition", 'attachment; filename="fly.bin"');
      res.setHeader("content-length", "2048");
      return res.end(Buffer.alloc(2048, 3));
    }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><title>Site</title><body>' +
      '<a id=same href="/dl.bin">same-tab link</a> ' +
      '<a id=blank href="/dl.bin" target="_blank">_blank link</a> ' +
      '<button id=later onclick="setTimeout(()=>{location.href=\'/dl.bin\'},600)">later</button></body>');
  });
  srv.listen(0, "127.0.0.1", () => { base = "http://127.0.0.1:" + srv.address().port; resolve(); });
});

require("../electron/main.js");

app.whenReady().then(async () => {
  await ready;
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const dm = require("../electron/downloads/downloadManager");
  const dlanim = require("../electron/dlanimation");
  const win = state.mainWindow;
  win.show(); win.focus(); await sleep(400);
  // keep every file out of the real Downloads folder (registered after the manager's handler, so it wins)
  session.fromPartition(constants.TAB_PARTITION).on("will-download", (_e, item) => item.setSavePath(path.join(tmp, "dl-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "-" + item.getFilename())));

  const active = () => state.tabs.find((t) => t.id === state.activeTabId);
  const overlay = () => win.getBrowserViews().find((v) => { try { return String(v.webContents.getURL()).endsWith("dlanim.html"); } catch (_) { return false; } });
  const fresh = async () => {
    while (state.tabs.length > 1) tm.closeTab(state.tabs[state.tabs.length - 1].id);
    await sleep(400);
    tm.createTab(base + "/"); await sleep(900);
    return active();
  };
  const click = (tab, id) => tab.view.webContents.executeJavaScript(`document.getElementById("${id}").click()`, true);
  const waitIdle = () => until(() => !dlanim.isPlaying(), 3000);
  // the real Downloads button, from the shell's DOM (what the module aims for)
  const btn = await win.webContents.executeJavaScript('(() => { const r = document.getElementById("downloads").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()');
  const [W, H] = win.getContentSize();
  const chromeH = tm.chromeHeight();

  // ── 1. a download from the page you are looking at flies ──
  {
    const site = await fresh();
    await click(site, "same");
    check("a download from the visible page starts the flight", await until(() => dlanim.isPlaying(), 3000));
    const v = overlay();
    check("...in a transparent overlay attached to the window", !!v);
    const b = v && v.getBounds();
    check("the overlay is 80px wide and centred on the REAL Downloads button (±1px)", !!b && b.width === 80 && Math.abs(b.x + 40 - btn.x) <= 1);
    check("...and starts above the button's centre and reaches below the page's middle", !!b && b.y <= btn.y - 39 && b.y + b.height >= chromeH + 0.465 * (H - chromeH));
    check("the flight ends, and the overlay is taken off the window again (nothing left on top of the page)", await waitIdle() && !overlay());
    check("the download itself was not disturbed by the animation", await until(() => dm.publicList().length >= 1 && dm.publicList().every((d) => d.state === "completed"), 5000));
  }

  // ── 2. the circle looks and moves like Chrome: sample the rendered pixels at moments we measured ──
  // Chrome (light theme, recording): at t=134ms the circle centre was 28.3% of the way up the path and the
  // glyph 39% opaque; at t=220: 49% / 67%; at t=300: 70% / 93%. The circle is 64px.
  const measured = [{ t: 134, f: 0.283, o: 0.39 }, { t: 220, f: 0.490, o: 0.67 }, { t: 300, f: 0.700, o: 0.93 }];
  for (const theme of ["light", "dark"]) {
    nativeTheme.themeSource = theme;
    await sleep(500);
    for (const m of measured) {
      const site = await fresh();
      // read the shell's geometry NOW (not once at the start): the module aims at wherever the toolbar
      // button is at this moment, and a one-time reading went stale when the layout shifted between runs
      const nowBtn = await win.webContents.executeJavaScript('(() => { const r = document.getElementById("downloads").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
      const [nowW, nowH] = win.getContentSize();
      const nowChrome = tm.chromeHeight();
      await click(site, "same");
      await until(() => dlanim.isPlaying(), 3000);
      const v = overlay();
      if (!v) { check(`[${theme} t=${m.t}] the overlay exists`, false); continue; }
      const geo = dlanim.lastGeometry();
      check(`[${theme} t=${m.t}ms] the flight was aimed at the real button and page (geometry: ${JSON.stringify(geo && { startY: Math.round(geo.startY), endY: Math.round(geo.endY), H: geo.contentH, chrome: geo.chromeH })})`,
        !!geo && geo.contentH === nowH && geo.chromeH === nowChrome && Math.abs(geo.btnX - nowBtn.x) <= 1 && Math.abs(geo.btnY - nowBtn.y) <= 1
        && Math.abs(geo.startY - (nowChrome + 0.465 * (nowH - nowChrome))) <= 1);
      // freeze the animation at the moment under test; the overlay stays attached ~640ms, so be quick
      await v.webContents.executeJavaScript(`(() => { window.__anim.pause(); window.__anim.currentTime = ${m.t}; return 0; })()`);
      await sleep(60);
      const [css, img] = await Promise.all([
        v.webContents.executeJavaScript('(() => { const c = document.getElementById("c"); const m = new DOMMatrix(getComputedStyle(c).transform); return { ty: m.m42, op: parseFloat(getComputedStyle(c).opacity) }; })()'),
        v.webContents.capturePage(),
      ]);
      const vb = v.getBounds();
      const centreWin = vb.y + css.ty + 32;                       // circle centre in window coordinates
      const fAct = (geo.startY - centreWin) / (geo.startY - geo.endY);
      check(`[${theme} t=${m.t}ms] the circle is ${(m.f * 100).toFixed(0)}% of the way up (±2%): got ${(fAct * 100).toFixed(1)}%`, Math.abs(fAct - m.f) <= 0.02);
      check(`[${theme} t=${m.t}ms] its opacity is ${m.o} (±0.03): got ${css.op.toFixed(2)}`, Math.abs(css.op - m.o) <= 0.03);
      // what was actually RENDERED: find the circle in the captured pixels
      const { width, height } = img.getSize(); const bm = img.toBitmap();
      let minX = width, maxX = -1, minY = height, maxY = -1, n = 0, fill = null;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const a = bm[(y * width + x) * 4 + 3]; if (a > 20) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } }
      const rw = maxX - minX + 1, rh = maxY - minY + 1;
      check(`[${theme} t=${m.t}ms] rendered as a 64px circle (got ${rw}x${rh})`, n > 0 && Math.abs(rw - 64) <= 2 && Math.abs(rh - 64) <= 2);
      const cyRender = vb.y + (minY + maxY) / 2;
      check(`[${theme} t=${m.t}ms] ...at the position the animation reports (±2px)`, n > 0 && Math.abs(cyRender - centreWin) <= 2);
      const px = (x, y) => { const i = (y * width + x) * 4; return [bm[i + 2], bm[i + 1], bm[i], bm[i + 3]]; };
      fill = px(Math.round((minX + maxX) / 2) - 24, Math.round((minY + maxY) / 2));
      // capturePage returns PREMULTIPLIED colour: at 93% opacity every channel reads 7% darker than the
      // real fill (light 236,241,250 -> 219,224,232). Undo that before comparing with the intended colours.
      if (fill[3] > 0) fill = fill.slice(0, 3).map((c) => Math.min(255, Math.round(c * 255 / fill[3])));
      if (m.t === 300) {
        if (theme === "light") check(`[light] the circle fill is Chrome's pale blue (got ${fill.slice(0, 3)})`, fill[0] > 215 && fill[2] > 235 && fill[2] >= fill[0]);
        else check(`[dark] the circle fill is Chrome's dark grey (got ${fill.slice(0, 3)})`, fill[0] < 110 && fill[1] < 110 && fill[2] < 120);
      }
      await waitIdle();
    }
  }
  nativeTheme.themeSource = "system";
  await sleep(400);

  // ── 3. when it must NOT fly ──
  {
    const site = await fresh();
    // a download started by a tab you are not looking at: Chrome shows nothing
    tm.createTab(base + "/", { background: true }); await sleep(1000);
    const bg = state.tabs[state.tabs.length - 1];
    await click(bg, "same");
    const flew = await until(() => dlanim.isPlaying(), 1500);
    check("a download started by a BACKGROUND tab does not fly", !flew);
    await waitIdle();
    check("(setup) the visible tab is still the original one", active().id === site.id);
  }
  check("a download the app itself starts (no initiating page, e.g. Retry) does not fly", (await dlanim.playFor(null)) === false && !dlanim.isPlaying());
  {
    const orig = win.isFullScreen;
    win.isFullScreen = () => true;
    const r = await dlanim.play();
    win.isFullScreen = orig;
    check("no flight in full screen (the toolbar is not there to fly to)", r === false && !dlanim.isPlaying());
  }

  // ── 4. a download that opens its own tab: the tab closes AND the flight still plays ──
  {
    const site = await fresh();
    const tabsBefore = state.tabs.length;
    await click(site, "blank");
    check("a download opened in a new tab flies too", await until(() => dlanim.isPlaying(), 3000));
    await until(() => state.tabs.length === tabsBefore, 3000);
    check("...while that tab closes itself and you are back on the page", state.tabs.length === tabsBefore && active().id === site.id);
    await waitIdle();
  }

  // ── 5. two downloads close together: the second restarts the flight, never stacks a second overlay ──
  {
    const site = await fresh();
    await click(site, "same");
    await until(() => dlanim.isPlaying(), 3000);
    await sleep(150);
    await click(site, "same");
    await sleep(250);
    const views = win.getBrowserViews().filter((v) => String(v.webContents.getURL()).endsWith("dlanim.html"));
    check("two downloads in quick succession: one overlay, restarted (not two stacked)", views.length === 1);
    check("...and it is still taken off afterwards", await waitIdle() && !overlay());
  }

  // ── 6. the rest of the window is untouched: no overlay, the page view keeps its geometry ──
  {
    const site = await fresh();
    const before = site.view.getBounds();
    await click(site, "same");
    await until(() => dlanim.isPlaying(), 3000);
    await waitIdle();
    const after = site.view.getBounds();
    check("the page view's bounds are unchanged by a flight", before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height);
  }

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_DLANIM total=" + results.length + " failed=" + failed.length);
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
