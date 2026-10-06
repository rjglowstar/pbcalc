// Focused test of the address-bar suggestion dropdown (Chrome's dropdown minus history).
// Fast: one window, one tab, a local stand-in for Google's suggestion endpoint.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-suggestions.js
// Add PBCALC_LIVE=1 to ALSO ask the real Google endpoint and print what comes back.
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-verify-sugg-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");

const results = [];
process.on("unhandledRejection", (e) => console.log("  .. UNHANDLED " + (e && e.message)));
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log("WATCHDOG: stuck after " + results.length + " checks"); app.exit(2); }, 120000).unref();

// Suggestions are served by this process; the address the app asks is set before main.js runs.
const hits = [];
let srv;
const serverReady = new Promise((resolve) => {
  srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/landing") { res.setHeader("content-type", "text/html"); return res.end("<title>Landing Page</title>landed"); }
    const q = u.searchParams.get("q") || "";
    hits.push({ q, cookie: req.headers.cookie });
    const reply = () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([q, [q + " videos", `http://127.0.0.1:${srv.address().port}/landing`, q + " studio", q + " app"], ["", "Landing Page", "", ""], [], { "google:suggesttype": ["QUERY", "NAVIGATION", "QUERY", "QUERY"] }]));
    };
    if (q === "slow") setTimeout(reply, 700); else reply();
  });
  srv.listen(0, "127.0.0.1", () => {
    process.env.PBCALC_SUGGEST_URL = `http://127.0.0.1:${srv.address().port}/complete/search`;
    resolve();
  });
});

require("../electron/main.js");

app.whenReady().then(async () => {
  await serverReady;
  await sleep(3500);
  const state = require("../electron/state");
  const tm = require("../electron/tabs/tabManager");
  const omnibox = require("../electron/omnibox");
  const bmStore = require("../electron/bookmarks/bookmarkStore");
  bmStore.setMode("real");   // these tests are about the owner's real list; a fresh launch starts on the dummy one
  const win = state.mainWindow;
  const sh = win.webContents;
  const js = (c) => sh.executeJavaScript(c);
  bmStore.toggle({ url: "https://www.youtube.com/", title: "YouTube", favicon: "" });

  const dropdownWc = () => win.getBrowserViews().pop().webContents;
  const rows = () => dropdownWc().executeJavaScript(`[...document.querySelectorAll(".row")].map(r=>({sel:r.classList.contains("selected"),text:r.innerText.replace(/\\s+/g," ").trim()}))`);
  const key = (k) => { sh.sendInputEvent({ type: "keyDown", keyCode: k }); sh.sendInputEvent({ type: "keyUp", keyCode: k }); };
  const typeInBar = async (text, wait = 700) => {
    win.focus();
    await js('document.getElementById("url-input").focus(); document.getElementById("url-input").value=""; 0');
    sh.insertText(text);
    for (let i = 0; i < 30 && !omnibox.isOpen(); i++) await sleep(100);
    // wait for the page to have drawn the rows, and then for the (local) "Google" answer
    for (let i = 0; i < 40; i++) {
      const n = omnibox.isOpen() ? await dropdownWc().executeJavaScript('document.querySelectorAll(".row").length').catch(() => 0) : 0;
      if (n >= 2) break;
      await sleep(100);
    }
    await sleep(wait);
  };
  const blur = async () => { await js('document.getElementById("url-input").blur(); 0'); await sleep(500); };

  // ── the dropdown ──
  await typeInBar("you");
  let r = await rows();
  check("typing opens the suggestion dropdown under the address bar", omnibox.isOpen() && r.length >= 4);
  check("first row = what you typed, as a Google search, highlighted", r[0] && r[0].sel && /^you\s+-\s+Google Search$/.test(r[0].text));
  check("your matching bookmark is suggested", r.some((x) => /^YouTube\s+-\s+youtube\.com$/.test(x.text)));
  check("Google's suggestions: typed part plain, the rest bold", r.some((x) => x.text === "you videos") && (await dropdownWc().executeJavaScript('!!document.querySelector(".txt b")')) === true);
  check("a navigation suggestion shows its title and site", r.some((x) => /^Landing Page\s+-\s+127\.0\.0\.1/.test(x.text)));
  check("the request carried no cookies and exactly the typed text", hits.length >= 1 && hits.every((h) => h.cookie === undefined) && hits[hits.length - 1].q === "you");
  const b = win.getBrowserViews().pop().getBounds();
  check("dropdown sits just below the address bar and is as wide as it", b.y >= 74 && b.y <= 84 && b.width > 300);
  if (process.env.PBCALC_SHOTS) {
    fs.mkdirSync(process.env.PBCALC_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.PBCALC_SHOTS, "suggest_dropdown.png"), (await dropdownWc().capturePage()).toPNG());
    fs.writeFileSync(path.join(process.env.PBCALC_SHOTS, "suggest_shell.png"), (await win.webContents.capturePage({ x: 0, y: 0, width: 1000, height: 110 })).toPNG());
  }
  check("the dropdown never takes keyboard focus (typing continues in the bar)", (await js("document.activeElement.id")) === "url-input");

  // ── keyboard ──
  key("Down");
  await sleep(400);
  r = await rows();
  check("ArrowDown highlights the next row and fills the bar with it", r[1].sel && !r[0].sel && (await js('document.getElementById("url-input").value')) === "https://www.youtube.com/");
  key("Up");
  await sleep(400);
  check("ArrowUp above the first row gives back exactly what was typed", (await js('document.getElementById("url-input").value')) === "you" && (await rows())[0].sel);
  for (let i = 0; i < 3; i++) { key("Down"); await sleep(150); }
  const navRow = (await rows()).findIndex((x) => x.sel);
  key("Return");
  await sleep(1800);
  const landed = state.tabs.find((t) => t.id === state.activeTabId).view.webContents.getURL();
  check(`Enter opens the highlighted navigation suggestion (row ${navRow})`, /\/landing$/.test(landed));
  check("Enter closes the dropdown", !omnibox.isOpen());

  // ── mouse ──
  await typeInBar("abc");
  await dropdownWc().executeJavaScript('document.querySelectorAll(".row")[1].dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true})); 0');
  await sleep(1200);
  check("clicking a suggestion closes the dropdown and opens a search", !omnibox.isOpen() && /^https?:/.test(tm.getTabState().tabs.find((t) => t.id === state.activeTabId).url));

  // ── closing ──
  await typeInBar("esc");
  key("Escape");
  await sleep(500);
  check("Escape closes the dropdown", !omnibox.isOpen());
  await typeInBar("blur");
  await blur();
  await sleep(300);
  check("leaving the address bar closes the dropdown", !omnibox.isOpen());

  // ── stale answers ──
  hits.length = 0;
  await js('document.getElementById("url-input").focus(); document.getElementById("url-input").value=""; 0');
  sh.insertText("slow");
  await sleep(250);
  sh.insertText("er");
  await sleep(1600);
  const last = await rows();
  check("a slow answer for older text is dropped (rows follow the newest text)", last.length > 0 && !last.some((x) => /^slow (videos|studio|app)$/.test(x.text)) && last.some((x) => x.text === "slower videos"));
  await blur();

  // ── Settings switch ──
  tm.setSearchSuggestions(false);
  hits.length = 0;
  await typeInBar("you");
  r = await rows();
  check("with the Settings switch off no request is made", hits.length === 0);
  check("...but your bookmarks are still suggested", r.some((x) => /^YouTube\s+-/.test(x.text)) && !r.some((x) => x.text === "you videos"));
  await blur();
  tm.setSearchSuggestions(true);

  // ── Restricted Mode ──
  tm.enableRestricted();
  await sleep(1500);
  omnibox.query("site", { left: 100, right: 500, top: 46, bottom: 78, width: 400 });
  await sleep(500);
  check("no suggestions (and no request) in Restricted Mode", !omnibox.isOpen() && hits.length === 0);
  tm.leaveRestricted();
  await sleep(500);

  // ── optional: the REAL Google endpoint ──
  if (process.env.PBCALC_LIVE) {
    delete process.env.PBCALC_SUGGEST_URL;
    await typeInBar("youtube", 2500);
    const live = await rows();
    console.log("  LIVE rows for 'youtube':");
    live.forEach((x) => console.log("     " + (x.sel ? "> " : "  ") + x.text));
    check("live: Google's suggestions arrived alongside the bookmark", live.length >= 6 && live.some((x) => /^YouTube\s+-/.test(x.text)));
    await blur();
  }

  const failed = results.filter((x) => !x.pass);
  console.log("PBCALC_SUGGEST total=" + results.length + " failed=" + failed.length);
  srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(failed.length ? 1 : 0);
});
