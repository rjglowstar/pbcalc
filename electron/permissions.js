const state = require("./state");

// Site permissions, like Chrome: a page that wants your camera, microphone, location, notifications, clipboard (read) or MIDI devices
// has to ASK, and a bubble under the address bar lets the user answer. Until now every such request was granted silently (Electron's
// default) - measured with a hostile test page: geolocation, camera, microphone, notifications, clipboard-read and MIDI were all
// handed out without a question (scripts/verify-security.js).
//
//   * Allowed without asking: things a page needs just to work and that expose nothing (fullscreen, pointer lock, DRM playback,
//     clipboard write, storage access, the file picker the user themselves opened).
//   * Asked: the sensitive list below (PROMPT).
//   * Everything else (unknown / new permission names): refused.
// Answers (the owner's rule "nothing about visited sites is kept": memory only, gone when the browser closes):
//   "Allow while visiting the site" -> allowed for that site (origin) until PBCalc is closed
//   "Allow this time"               -> allowed for this page only, until it is left or the tab is closed
//   "Never allow"                   -> refused for that site until PBCalc is closed
//   closing the bubble              -> refused this time, asked again next time
const ALLOW = new Set(["fullscreen", "pointerLock", "keyboardLock", "clipboard-sanitized-write", "mediaKeySystem", "storage-access", "top-level-storage-access", "fileSystem"]);

// permission -> what the bubble says. "media" is split by what it asks for (camera / microphone) in itemsFor().
const PROMPT = {
  geolocation: "Know your location",
  notifications: "Show notifications",
  "clipboard-read": "See text and images copied to the clipboard",
  midi: "Use your MIDI devices",
  midiSysex: "Use your MIDI devices",
  "idle-detection": "Know when you are actively using this device",
  "window-management": "Manage windows on all your displays",
  "display-capture": "Share your screen",
  media: null,
};

const remembered = new Map();      // "origin|key" -> true | false          (session)
const onceByPage = new WeakMap();  // webContents -> Map("origin|key" -> true)   (this page only)
const queue = [];                  // pending asks, shown one at a time
let showing = null;

const originOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch (_) { return null; } };

// [{ key, text }] for a request: one entry per thing asked (a camera + microphone request lists both).
function itemsFor(permission, details) {
  if (permission === "media") {
    // a request lists mediaTypes (plural); the synchronous CHECK Chromium makes to decide whether device names may be shown
    // (enumerateDevices labels) carries one mediaType (singular) - ignoring it made every check "not granted": no names, no devices
    const types = (details && details.mediaTypes) || (details && details.mediaType && details.mediaType !== "unknown" ? [details.mediaType] : []);
    const out = [];
    if (types.includes("video")) out.push({ key: "media:video", text: "Use your camera" });
    if (types.includes("audio")) out.push({ key: "media:audio", text: "Use your microphone" });
    return out.length ? out : [{ key: "media:video", text: "Use your camera or microphone" }];
  }
  const text = PROMPT[permission];
  return text ? [{ key: permission === "midiSysex" ? "midi" : permission, text }] : [];
}

function decided(wc, origin, items) {
  const per = onceByPage.get(wc);
  let allAllowed = true;
  for (const it of items) {
    const k = origin + "|" + it.key;
    if (remembered.get(k) === false) return false;
    if (!(remembered.get(k) === true || (per && per.get(k) === true))) allAllowed = false;
  }
  return allAllowed ? true : undefined;   // undefined = nobody has answered yet
}

// Electron's request handler (session.setPermissionRequestHandler) calls this for everything except openExternal.
function request(wc, permission, callback, details) {
  if (ALLOW.has(permission)) return callback(true);
  // getDisplayMedia (screen sharing) arrives as "display-capture" or as "media" with NO camera / microphone in it: the "Choose what to
  // share" dialog (electron/screenShare.js) is the question the user answers, so no second bubble.
  if (permission === "display-capture" || (permission === "media" && !((details && details.mediaTypes) || []).length)) return require("./screenShare").pick(wc, callback);
  const items = itemsFor(permission, details);
  const origin = originOf((details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : ""));
  if (!items.length || !origin) return callback(false);          // unknown permission / a local page / about:blank
  const known = decided(wc, origin, items);
  if (known !== undefined) return callback(known);
  // Only the tab the user is looking at may ask (a background tab cannot put a bubble over another page).
  const tm = require("./tabs/tabManager");
  const active = tm.getActiveTab();
  if (!active || active.view.webContents !== wc) return callback(false);
  queue.push({ wc, origin, items, callback });
  next();
}

async function next() {
  if (showing || !queue.length) return;
  const ask = queue.shift();
  const { wc } = ask;
  if (!wc || wc.isDestroyed()) { ask.callback(false); return next(); }
  const known = decided(wc, ask.origin, ask.items);      // answered meanwhile by an earlier bubble for the same thing
  if (known !== undefined) { ask.callback(known); return next(); }
  showing = ask;
  let rect = null;
  try {
    rect = await state.mainWindow.webContents.executeJavaScript('(() => { const e = document.getElementById("site-info"); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()');
  } catch (_) {}
  const choice = await require("./popup").askPermission(wc, ask.origin, ask.items.map((i) => i.text), rect);
  showing = null;
  finish(ask, choice);
  next();
}

function finish(ask, choice) {
  const { wc, origin, items, callback } = ask;
  if (choice === "visit") items.forEach((i) => remembered.set(origin + "|" + i.key, true));
  else if (choice === "never") items.forEach((i) => remembered.set(origin + "|" + i.key, false));
  else if (choice === "once" && wc && !wc.isDestroyed()) {
    const per = onceByPage.get(wc) || new Map();
    items.forEach((i) => per.set(origin + "|" + i.key, true));
    onceByPage.set(wc, per);
  }
  callback(choice === "visit" || choice === "once");
  for (const t of state.tabs) if (t.view && t.view.webContents) pushStates(t.view.webContents);   // every page of that site sees the new answer
  // the same page asking the same thing again while the bubble was up is answered the same way
  for (let i = queue.length - 1; i >= 0; i--) {
    const q = queue[i];
    const known = decided(q.wc, q.origin, q.items);
    if (known !== undefined) { queue.splice(i, 1); q.callback(known); }
  }
}

// session.setPermissionCheckHandler: the synchronous questions ("is it granted?" - Notification.permission, permissions.query,
// and every notification a page tries to SHOW). Granted only for what was really allowed; without this handler Electron answers
// "yes" to everything, so a page could show notifications without ever asking.
function check(wc, permission, requestingOrigin, details) {
  if (ALLOW.has(permission)) return true;
  if (permission === "display-capture") return true;   // the share dialog (screenShare.js) is the consent, a check must not pre-empt it
  const items = itemsFor(permission, details);
  const origin = originOf(requestingOrigin) || originOf(details && details.requestingUrl);
  if (!items.length || !origin) return false;
  // a page whose bubble is still waiting is "not decided" (= prompt), which for a check is the same as not granted
  return decided(wc, origin, items) === true;
}

// What Chrome tells a page that has not been asked yet is "default" / "prompt" - NOT "denied". The check handler above can only say yes or
// no, so Chromium reports "denied" for every undecided permission (measured: Notification.permission and permissions.query were "denied"
// on a fresh page). A page such as Google Meet reads that as "blocked" and sends the user to a help page instead of asking. The page
// preload (tab-preload.js) therefore patches what the page SEES using this table: granted / denied / prompt.
const QUERY = { notifications: "notifications", geolocation: "geolocation", camera: "media:video", microphone: "media:audio", midi: "midi", "clipboard-read": "clipboard-read" };
function statesFor(wc, url) {
  const out = {};
  const origin = originOf(url || (wc && !wc.isDestroyed() ? wc.getURL() : ""));
  for (const name of Object.keys(QUERY)) {
    const d = origin ? decided(wc, origin, [{ key: QUERY[name] }]) : false;
    out[name] = d === true ? "granted" : d === false ? "denied" : "prompt";
  }
  return out;
}
function pushStates(wc) { try { if (wc && !wc.isDestroyed()) wc.send("perm:states", statesFor(wc)); } catch (_) {} }

// A page was left or closed: "Allow this time" ends with it.
function forgetPage(wc) { onceByPage.delete(wc); }

// the bubble's pending ask is dropped when its tab goes away (popup.close resolves "dismiss")
function _reset() { remembered.clear(); queue.length = 0; showing = null; }

module.exports = { request, check, statesFor, forgetPage, _reset, _state: () => ({ remembered, queue, showing }) };
