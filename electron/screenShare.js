const { desktopCapturer, webContents } = require("electron");
const state = require("./state");

// Screen sharing (Google Meet "Present now", Teams, Zoom web ...): a page calls navigator.mediaDevices.getDisplayMedia(). Electron
// REJECTS that call (NotSupportedError: Not supported - measured) unless the app installs a display-media handler and supplies the
// picked source itself; PBCalc never did, so every site said "Can't share your screen". Now:
//   1. Chromium first asks the PERMISSION ("display-capture", or "media" with no camera / microphone in it) -> permissions.js hands it to
//      pick() below: Chrome's "Choose what to share with <site>" dialog with its three tabs - Chrome Tab (this browser's other tabs, with
//      a preview and the "Share with tab audio" switch), Window and Entire Screen. That dialog IS the consent: nothing is shared until the
//      user picks something and presses Share, and nothing is remembered. Closing it refuses the request through the PERMISSION path,
//      which is what makes the page see NotAllowedError (Chrome's answer to a cancelled picker; Meet then stays quiet) - refusing inside
//      the display handler would give the page "AbortError: Invalid capture constraints" (measured for every way of saying no) and Meet
//      shows "Can't share your screen".
//   2. Chromium then calls the display-media handler: it hands over exactly the source that was picked (a tab = that tab's page frame).
const chosen = new WeakMap();   // requesting webContents -> { kind: "tab" | "source", id, audio, at }
const FRESH_MS = 30 * 1000;

const hostOf = (origin) => { try { return new URL(origin).host; } catch (_) { return origin; } };

// The other tabs of this window, for the "Chrome Tab" tab (none in Restricted Mode: tab titles are addresses' worth of information there).
function tabList(requester) {
  if (state.restricted) return [];
  return state.tabs
    .filter((t) => t.view && t.view.webContents && !t.view.webContents.isDestroyed() && t.view.webContents !== requester)
    .map((t) => ({ id: t.id, title: t.title || t.view.webContents.getURL() || "New Tab", favicon: typeof t.favicon === "string" ? t.favicon : "", thumb: typeof t.thumb === "string" ? t.thumb : "" }));
}

const jpeg = (img) => (img && !img.isEmpty() ? "data:image/jpeg;base64," + img.toJPEG(70).toString("base64") : "");

// Called by permissions.request for a screen-capture request. callback(true) only after the user pressed Share.
async function pick(wc, callback) {
  try {
    const tm = require("./tabs/tabManager");
    const active = tm.getActiveTab();
    if (!wc || wc.isDestroyed() || !active || active.view.webContents !== wc) return callback(false);   // only the tab you are looking at can ask
    let origin = "";
    try { origin = new URL(wc.getURL()).origin; } catch (_) {}
    if (!/^https?:/.test(origin)) return callback(false);
    const found = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true });
    const sources = found.map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith("screen:"), thumb: jpeg(s.thumbnail), icon: s.appIcon && !s.appIcon.isEmpty() ? "data:image/png;base64," + s.appIcon.resize({ width: 16, height: 16 }).toPNG().toString("base64") : "" }));
    const tabs = tabList(wc);
    if (!sources.length && !tabs.length) return callback(false);
    const choice = await require("./popup").askScreenShare(wc, origin, { host: hostOf(origin), tabs, sources });
    if (!choice) return callback(false);
    chosen.set(wc, { kind: choice.kind, id: choice.id, audio: choice.audio === true, at: Date.now() });
    callback(true);
  } catch (_) { try { callback(false); } catch (__) {} }
}

// session.setDisplayMediaRequestHandler: gives the page the source that was picked a moment ago - and nothing else.
async function handler(request, callback) {
  const deny = () => { try { callback(null); } catch (_) {} };
  try {
    const wc = request.frame ? webContents.fromFrame(request.frame) : null;
    const c = wc ? chosen.get(wc) : null;
    if (wc) chosen.delete(wc);                                   // one pick, one stream
    if (!c || Date.now() - c.at > FRESH_MS) return deny();       // nobody picked: never share by default
    if (c.kind === "tab") {
      const tab = state.tabs.find((t) => t.id === c.id);
      if (!tab || tab.view.webContents.isDestroyed()) return deny();
      // Electron can capture a tab's page only while that tab is on screen (measured: a background tab's frame never delivers a stream -
      // the request just hangs). Chrome switches to the shared tab the moment you press Share as well, so do the same, then capture.
      require("./tabs/tabManager").switchTab(tab.id);
      await new Promise((r) => setTimeout(r, 450));
      if (tab.view.webContents.isDestroyed()) return deny();
      const frame = tab.view.webContents.mainFrame;
      // "Share with tab audio": the tab's own sound goes to the page AND keeps playing here (enableLocalEcho), like Chrome
      const streams = { video: frame, enableLocalEcho: true };
      if (request.audioRequested && c.audio) streams.audio = frame;
      return callback(streams);
    }
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((s) => s.id === c.id);
    if (!source) return deny();
    callback({ video: source });      // a window / screen carries no audio here: Chrome says "To share audio, share a tab instead"
  } catch (_) { deny(); }
}

function install(ses) { ses.setDisplayMediaRequestHandler(handler, { useSystemPicker: false }); }

module.exports = { install, pick };
