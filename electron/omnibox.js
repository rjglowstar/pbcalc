const { BrowserView, net } = require("electron");
const path = require("path");
const state = require("./state");
const settings = require("./settings");
const { resolveInput, searchUrl } = require("./urlInput");

// Address-bar suggestions, like Chrome's dropdown — minus everything that would need a browsing
// history. What it offers, in Chrome's order:
//   1. what you typed (as a search, or as an address when it looks like one)
//   2. your BOOKMARKS that match           (explicitly saved by you)
//   3. your currently OPEN TABS that match (in memory, "switch to tab")
//   4. Google's search suggestions         (network; can be switched off in Settings)
// Chrome also mixes in pages you visited before ("youtube video to typescript" with the history
// icon); PBCalc has no history, so those rows simply never exist.
//
// Privacy: the typed text goes to Google's suggestion endpoint exactly as in Chrome, but with NO
// cookies (credentials omitted), nothing is stored, stale requests are aborted, and it is skipped
// for anything that looks like an address with credentials. Restricted Mode never asks.
const LIMIT = 10;
const SUGGEST_URL = () => process.env.PBCALC_SUGGEST_URL || "https://suggestqueries.google.com/complete/search";

const CARD_W_MARGIN = 12; // room around the card for its shadow
const ROW_H = 40;
const PAD_V = 8;

let view = null;
let shown = false;
let st = null; // { typed, rows, selected, rect, seq }
let seqCounter = 0;
let abort = null;
let idleTimer = null;

const tabManager = () => require("./tabs/tabManager");
const bookmarks = () => require("./bookmarks/bookmarkStore");

// ── pure row building (unit-tested) ─────────────────────────────────────────
function norm(s) {
  return String(s || "").toLowerCase();
}

// remote = parsed suggestion response ([query, suggestions, descriptions, , {types}]) or null
function buildRows(typed, { bookmarks: bms = [], tabs = [], remote = null } = {}) {
  const t = String(typed || "").trim();
  if (!t) return [];
  const rows = [];
  const resolved = resolveInput(t);
  const isSearch = resolved === searchUrl(t);
  const seenUrls = new Set();

  if (isSearch) {
    rows.push({ kind: "search", text: t });
  } else {
    rows.push({ kind: "url", text: t, url: resolved });
    seenUrls.add(resolved);
    rows.push({ kind: "search", text: t });
  }

  const q = norm(t);
  let n = 0;
  for (const b of bms) {
    if (n >= 3) break;
    if (!norm(b.title).includes(q) && !norm(b.url).includes(q)) continue;
    if (seenUrls.has(b.url)) continue;
    seenUrls.add(b.url);
    rows.push({ kind: "bookmark", title: b.title, url: b.url, favicon: b.favicon || "" });
    n++;
  }
  n = 0;
  for (const tab of tabs) {
    if (n >= 2) break;
    if (!norm(tab.title).includes(q) && !norm(tab.url).includes(q)) continue;
    rows.push({ kind: "tab", id: tab.id, title: tab.title, url: tab.url });
    n++;
  }

  if (Array.isArray(remote) && Array.isArray(remote[1])) {
    const sugg = remote[1];
    const desc = Array.isArray(remote[2]) ? remote[2] : [];
    const meta = remote[4] && typeof remote[4] === "object" ? remote[4] : {};
    const types = Array.isArray(meta["google:suggesttype"]) ? meta["google:suggesttype"] : [];
    const seenText = new Set(rows.filter((r) => r.kind === "search" || r.kind === "query").map((r) => norm(r.text)));
    for (let i = 0; i < sugg.length && rows.length < LIMIT; i++) {
      const s = String(sugg[i] || "").trim();
      if (!s) continue;
      const type = types[i] || "QUERY";
      if (type === "NAVIGATION") {
        if (!/^https?:\/\//i.test(s) || seenUrls.has(s)) continue;
        seenUrls.add(s);
        rows.push({ kind: "nav", title: String(desc[i] || "").trim(), url: s });
      } else {
        if (seenText.has(norm(s))) continue;
        seenText.add(norm(s));
        rows.push({ kind: "query", text: s });
      }
    }
  }
  return rows.slice(0, LIMIT);
}

// What goes into the address bar when a row is selected with the arrow keys.
function rowText(row) {
  return row.kind === "search" || row.kind === "query" || row.kind === "url" ? row.text : row.url;
}

// ── view ────────────────────────────────────────────────────────────────────
function alive() {
  return !!view && !view.webContents.isDestroyed();
}

function ensureView() {
  if (alive()) return;
  view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "preloads", "omnibox-preload.js"),
    },
  });
  require("./lockdown").lock(view.webContents);
  view.setBackgroundColor("#00000000");
  view.webContents.loadFile(path.join(__dirname, "..", "renderer", "omnibox", "omnibox.html"));
  view.webContents.on("did-finish-load", () => push());
}

function destroyView() {
  clearTimeout(idleTimer);
  if (!view) return;
  const v = view;
  view = null;
  shown = false;
  try { if (state.mainWindow && !state.mainWindow.isDestroyed()) require("./viewHost").detach(state.mainWindow, v); } catch (_) {}
  try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch (_) {}
}

function push() {
  if (!alive() || !st || view.webContents.isLoading()) return;
  try { view.webContents.send("omnibox:data", { typed: st.typed, rows: st.rows, selected: st.selected }); } catch (_) {}
}

function layout() {
  if (!alive() || !st) return;
  const h = PAD_V * 2 + st.rows.length * ROW_H + CARD_W_MARGIN;
  view.setBounds({
    x: Math.max(0, Math.round(st.rect.left) - CARD_W_MARGIN / 2),
    y: Math.round(st.rect.bottom) + 1,
    width: Math.round(st.rect.width) + CARD_W_MARGIN,
    height: h,
  });
}

function show() {
  if (!state.mainWindow || state.mainWindow.isDestroyed() || !st || !st.rows.length) return hide();
  clearTimeout(idleTimer);
  ensureView();
  layout();
  if (!shown) {
    require("./viewHost").attach(state.mainWindow, view); // on top of the page view; NEVER focused (typing stays in the address bar)
    shown = true;
  }
  push();
}

function hide() {
  if (abort) { try { abort.abort(); } catch (_) {} abort = null; }
  st = null;
  seqCounter++;
  clearTimeout(idleTimer);
  if (alive() && shown) { try { require("./viewHost").detach(state.mainWindow, view); } catch (_) {} }
  shown = false;
  if (alive()) idleTimer = setTimeout(destroyView, 30000);
}

// Focusing the address bar loads the (hidden) dropdown page ahead of time, so the first suggestions
// show up as soon as the first key is typed instead of after the page has started up.
function warm() {
  if (state.restricted || !state.mainWindow || state.mainWindow.isDestroyed()) return;
  ensureView();
  clearTimeout(idleTimer);
  if (!shown) idleTimer = setTimeout(destroyView, 30000);
}

function isOpen() {
  return alive() && shown;
}

// ── querying ────────────────────────────────────────────────────────────────
function localSources() {
  const s = tabManager().getTabState();
  const tabs = s.tabs
    .filter((t) => t.id !== s.activeTabId && /^https?:\/\//i.test(t.url || ""))
    .map((t) => ({ id: t.id, title: t.title, url: t.url }));
  return { bookmarks: bookmarks().list(), tabs };
}

function shouldAskRemote(text) {
  if (!settings.get("searchSuggestions")) return false;
  if (text.length > 200) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && /@/.test(text)) return false; // an address with credentials
  if (/^(pbcalc|file|data|javascript|about):/i.test(text)) return false;
  // An ADDRESS (or the start of one) is not a search and is never sent: an internal / intranet address (http://192.168.0.8:9995/assets, the ERP), a path with
  // ids, a link with a token in it - every keystroke of it would have gone to Google. (Words and phrases are sent, as in Chrome.)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return false;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([\/?#]|$)/i.test(text)) return false;
  if (!/\s/.test(text) && /[\/?#]/.test(text)) return false;
  if (/^\[[0-9a-f:.]+\]/i.test(text)) return false;   // an IPv6 address
  return true;
}

async function fetchRemote(text, signal) {
  const url = SUGGEST_URL() + (SUGGEST_URL().includes("?") ? "&" : "?") + "client=chrome&q=" + encodeURIComponent(text);
  const res = await net.fetch(url, { signal, credentials: "omit", headers: { "Accept-Language": require("electron").app.getLocale() } });
  if (!res.ok) return null;
  return await res.json();
}

// Called on every keystroke (debounced by the shell). rect = the address bar's box, window coords.
function query(text, rect) {
  if (state.restricted) return hide();
  const typed = String(text || "");
  if (!typed.trim() || !rect) return hide();
  const my = ++seqCounter;
  if (abort) { try { abort.abort(); } catch (_) {} abort = null; }

  const local = localSources();
  st = { typed, rect, rows: buildRows(typed, local), selected: 0, seq: my };
  show();

  if (!shouldAskRemote(typed.trim())) return;
  const ac = new AbortController();
  abort = ac;
  const timer = setTimeout(() => ac.abort(), 2500);
  fetchRemote(typed.trim(), ac.signal)
    .then((remote) => {
      clearTimeout(timer);
      if (!remote || !st || st.seq !== my) return; // typed on, or closed: drop the stale answer
      const keep = st.selected;
      st.rows = buildRows(typed, { ...local, remote });
      st.selected = Math.min(keep, st.rows.length - 1);
      show();
    })
    .catch(() => clearTimeout(timer)); // offline / blocked / aborted: local rows stay
}

// ArrowDown / ArrowUp from the address bar. Returns the text to put in it (Chrome fills the bar
// with the highlighted row; going back above the first row restores what was typed).
function move(dir) {
  if (!st || !st.rows.length) return null;
  const count = st.rows.length;
  st.selected = (st.selected + (dir < 0 ? -1 : 1) + count) % count;
  push();
  return { text: st.selected === 0 ? st.typed : rowText(st.rows[st.selected]), selected: st.selected };
}

function pickRow(row) {
  const tm = tabManager();
  if (row.kind === "tab") return tm.switchTab(row.id);
  if (row.kind === "search" || row.kind === "query") return tm.navigate(searchUrl(row.text));
  if (row.kind === "url") return tm.navigate(row.url);
  return tm.navigate(row.url); // bookmark / nav
}

// Enter in the address bar: the highlighted row if one other than the default is selected,
// otherwise the text exactly as it stands (same rules as before).
function accept(inputText) {
  const sel = st && st.selected > 0 ? st.rows[st.selected] : null;
  hide();
  if (sel) pickRow(sel);
  else tabManager().navigate(inputText);
}

// A click on a row in the dropdown page.
function pick(index) {
  const row = st && st.rows[Number(index)];
  hide();
  if (row) pickRow(row);
}

function isSender(wc) {
  return alive() && wc === view.webContents;
}

module.exports = { query, move, accept, pick, hide, warm, isOpen, isSender, buildRows, shouldAskRemote };
