// Bookmark right-click menu + "Edit bookmark" box (normal mode) and the guarantee that Restricted Mode stays read/open only.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-bookmark-edit.js
// Uses synthetic input / direct calls only (the real mouse is never moved).
const { app, Menu, ipcMain } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-bme-"));
const constants = require("../electron/constants");
constants.dataDir = () => path.join(tmp, "UserData");
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const popup = require("../electron/popup");
    const bm = require("../electron/bookmarks/bookmarkStore");
    bm.setMode("real");   // these tests are about the owner's real list; a fresh launch starts on the dummy one
    const win = state.mainWindow; win.setAlwaysOnTop(true); win.show(); win.focus(); await sleep(300);   // stay in front: a popup closes on blur, and the PC may be in use
    const shell = win.webContents;
    const file = path.join(tmp, "UserData", "bookmarks.json");
    const onDisk = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; } };
    const popupWc = () => win.getBrowserViews().pop().webContents;
    const barTitles = () => shell.executeJavaScript('[...document.querySelectorAll(".bookmark .bookmark-title")].map(e => e.textContent)');

    for (const [t, u] of [["Example", "https://example.com/"], ["Docs", "https://docs.example.org/"], ["Mail", "https://mail.example.net/"]]) bm.toggle({ url: u, title: t, favicon: "" });
    tm.broadcastBookmarks(); await sleep(600);
    if (!state.bookmarksBarVisible) { tm.toggleBookmarksBar(); await sleep(500); }
    const ids = bm.list().map((b) => b.id);
    check("setup: 3 bookmarks shown in the bar", (await barTitles()).join() === "Example,Docs,Mail");

    // A popup closes when the window loses focus (intended, like Chrome). If the PC's owner clicks elsewhere mid-test,
    // refocus and open it again rather than report a false failure. `reset` undoes the first attempt's side effects.
    const retryOpen = async (fn, reset) => {
      for (let i = 0; i < 3; i++) {
        if (i && reset) reset();
        win.show(); win.focus(); await sleep(250);
        fn(); await sleep(1300);
        if (popup.isOpen("bookmark-edit")) {
          // the popup page renders a moment after it opens: wait for its form before anyone reads it
          for (let k = 0; k < 50; k++) { const ready = await popupWc().executeJavaScript('!!document.querySelector(".bm-field input, .bmb-row input")').catch(() => false); if (ready) return; await sleep(100); }
          return;
        }
        popup.close();
      }
    };

    // capture the native menu instead of showing it
    let menus = [];
    const realBuild = Menu.buildFromTemplate;
    Menu.buildFromTemplate = (tpl) => { const m = { tpl, popup() {} }; menus.push(m); return m; };
    const item = (m, label) => m.tpl.find((x) => x.label === label);

    console.log("\n-- right-click menu (normal mode)");
    tm.bookmarkContextMenu(ids[1]);
    const menu = menus.pop();
    const labels = menu ? menu.tpl.filter((x) => x.label).map((x) => x.label) : [];
    check("menu has Open in new tab, Edit..., Delete, Copy link address, Add page..., Bookmark manager, Show bookmarks bar", ["Open in new tab", "Edit...", "Delete", "Copy link address", "Add page...", "Bookmark manager", "Show bookmarks bar"].every((l) => labels.includes(l)));
    check("Edit... comes before Delete (Chrome order)", labels.indexOf("Edit...") < labels.indexOf("Delete"));
    check("'Show bookmarks bar' is a checkbox, checked while the bar is showing", item(menu, "Show bookmarks bar").type === "checkbox" && item(menu, "Show bookmarks bar").checked === true);

    // the context-menu IPC is for the shell only
    menus = [];
    const tabWc = state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
    ipcMain.emit("bookmarks:context-menu", { sender: tabWc }, ids[0]);
    check("a web page cannot open the bookmark menu over IPC", menus.length === 0);
    ipcMain.emit("bookmarks:context-menu", { sender: shell }, ids[0]);
    check("the shell can", menus.length === 1);

    console.log("\n-- Edit... opens the box with the bookmark's values");
    await retryOpen(() => item(menu, "Edit...").click());
    check("the 'bookmark-edit' popup is open", popup.isOpen("bookmark-edit"));
    const read = () => popupWc().executeJavaScript('({ head: (document.querySelector(".head")||{}).textContent, name: document.querySelectorAll(".bm-field input")[0].value, url: document.querySelectorAll(".bm-field input")[1].value, msg: document.querySelector(".bm-msg").textContent, active: document.activeElement && document.activeElement.parentElement.querySelector(".bm-label") && document.activeElement.parentElement.querySelector(".bm-label").textContent })');
    let v = await read();
    check("title is 'Edit bookmark', Name and URL are prefilled, Name has the focus", v.head === "Edit bookmark" && v.name === "Docs" && v.url === "https://docs.example.org/" && v.active === "Name");

    // main re-sends the popup its data on every tab / title / download change; the form must not be rebuilt under the
    // user's hands (it went back to the stored name, losing what they had typed)
    await popupWc().executeJavaScript('document.querySelectorAll(".bm-field input")[0].value = "half typed"; 0');
    await state.tabs.find((t) => t.id === state.activeTabId).view.webContents.executeJavaScript('document.title = "a page that changes its own title"; 0');
    await sleep(900);
    check("a title change in the page does not wipe what is being typed", popup.isOpen("bookmark-edit") && (await read()).name === "half typed");
    await popupWc().executeJavaScript('document.querySelectorAll(".bm-field input")[0].value = "Docs"; 0');

    console.log("\n-- validation");
    const typeAndSave = (n, u) => popupWc().executeJavaScript(`(() => { const i = document.querySelectorAll(".bm-field input"); i[0].value = ${JSON.stringify(n)}; i[1].value = ${JSON.stringify(u)}; document.querySelector(".bm-buttons .primary").click(); return 0; })()`);
    await typeAndSave("Docs2", "not a url at all :::"); await sleep(500);
    v = await read();
    check("a bad address keeps the box open and says why", popup.isOpen("bookmark-edit") && /valid web address/i.test(v.msg));
    check("...and changes nothing", bm.list().find((b) => b.id === ids[1]).title === "Docs");
    await typeAndSave("Docs2", "https://example.com/"); await sleep(500);
    v = await read();
    check("an address that is already bookmarked is refused", popup.isOpen("bookmark-edit") && /already bookmarked/i.test(v.msg) && bm.list().find((b) => b.id === ids[1]).url === "https://docs.example.org/");

    console.log("\n-- Save");
    await typeAndSave("Docs renamed", "docs.example.org/new"); await sleep(900);
    check("a valid edit closes the box", !popup.isOpen());
    const b1 = bm.list().find((b) => b.id === ids[1]);
    check("the store has the new name and a normalised https address", b1.title === "Docs renamed" && b1.url === "https://docs.example.org/new");
    check("it is saved to bookmarks.json", !!onDisk() && onDisk().some((b) => b.id === ids[1] && b.title === "Docs renamed"));
    check("the bookmarks bar shows the new name, order unchanged", (await barTitles()).join() === "Example,Docs renamed,Mail");

    console.log("\n-- Cancel / Esc leave it alone");
    await retryOpen(() => tm.openBookmarkEdit(ids[0]));
    await popupWc().executeJavaScript('(() => { document.querySelectorAll(".bm-field input")[0].value = "changed"; document.querySelector(".bm-buttons .secondary").click(); return 0; })()'); await sleep(500);
    check("Cancel closes without saving", !popup.isOpen() && bm.list().find((b) => b.id === ids[0]).title === "Example");
    await retryOpen(() => tm.openBookmarkEdit(ids[0]));
    popupWc().sendInputEvent({ type: "keyDown", keyCode: "Escape" }); popupWc().sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await sleep(500);
    check("Esc closes without saving", !popup.isOpen());

    console.log("\n-- Delete");
    menus = []; tm.bookmarkContextMenu(ids[2]); item(menus.pop(), "Delete").click(); await sleep(600);
    check("Delete removes it from the store and from bookmarks.json", !bm.list().some((b) => b.id === ids[2]) && !(onDisk() || []).some((b) => b.id === ids[2]));
    check("...and from the bar at once", (await barTitles()).join() === "Example,Docs renamed");

    console.log("\n-- the star (Chrome's \"Bookmark added\" bubble)");
    // the page's icon is a HUGE svg: an unconstrained favicon once spilled over the whole bubble (WhatsApp's)
    const srv = http.createServer((q, res) => {
      if (q.url === "/big.svg") { res.setHeader("content-type", "image/svg+xml"); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"><circle cx="450" cy="450" r="440" fill="#1a9d54"/></svg>'); }
      res.setHeader("content-type", "text/html");
      if (q.url.startsWith("/inline")) return res.end('<title>Inline</title><link rel="icon" href="data:image/png;base64,' + TINY_PNG + '">hello');
      res.end('<title>Star page</title><link rel="icon" href="/big.svg">hello');
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const pageUrl = "http://127.0.0.1:" + srv.address().port + "/star";
    tm.createTab(pageUrl); await sleep(1500);
    const n0 = bm.list().length;
    await retryOpen(() => tm.toggleBookmarkActive(), () => { const b = bm.list().find((x) => x.url === pageUrl); if (b) bm.remove(b.id); });
    check("starring a new page adds it", bm.list().length === n0 + 1 && bm.list().some((b) => b.url === pageUrl));
    check("...and opens the bubble", popup.isOpen("bookmark-edit"));
    const bub = () => popupWc().executeJavaScript('(() => { const p = document.getElementById("panel").getBoundingClientRect(); const star = null; return { title: (document.querySelector(".bmb-title")||{}).textContent, name: (document.querySelector(".bmb-row input")||{}).value, folder: (document.querySelector(".bmb-row select")||{}).value, buttons: [...document.querySelectorAll(".bmb-buttons button")].map(b => b.textContent), hasX: !!document.querySelector(".bmb-x"), hasTile: !!document.querySelector(".bmb-tile"), right: Math.round(p.right), top: Math.round(p.top), focus: document.activeElement && document.activeElement.tagName }; })()');
    let bv = await bub();
    check("title 'Bookmark added', Name = page title (focused), Folder = Bookmarks bar, Done + Remove, X, page tile", bv.title === "Bookmark added" && bv.name === "Star page" && bv.folder === "Bookmarks bar" && bv.buttons.join() === "Done,Remove" && bv.hasX && bv.hasTile && bv.focus === "INPUT");
    const geo = await popupWc().executeJavaScript('(() => { const t = document.querySelector(".bmb-tile").getBoundingClientRect(); const i = document.querySelector(".bmb-tile img, .bmb-tile .icon"); const ir = i ? i.getBoundingClientRect() : null; const h = document.querySelector(".bmb-title").getBoundingClientRect(); return { tile: [t.left, t.top, t.right, t.bottom], img: ir ? [ir.left, ir.top, ir.right, ir.bottom, ir.width] : null, titleBottom: h.bottom, tileTop: t.top }; })()');
    check("the page icon stays inside its 100px tile (a huge favicon cannot spill over the bubble)", !!geo.img && geo.img[4] <= 48 && geo.img[0] >= geo.tile[0] && geo.img[2] <= geo.tile[2] && geo.img[1] >= geo.tile[1] && geo.img[3] <= geo.tile[3] && geo.tileTop >= geo.titleBottom);
    const starRect = await shell.executeJavaScript('(() => { const r = document.getElementById("bookmark").getBoundingClientRect(); return { right: Math.round(r.right), bottom: Math.round(r.bottom) }; })()');
    check("it hangs under the star, right edges lined up (star right " + starRect.right + ", bubble right " + bv.right + ", top " + bv.top + ")", Math.abs(bv.right - starRect.right) <= 12 && bv.top >= starRect.bottom);
    await popupWc().executeJavaScript('(() => { const i = document.querySelector(".bmb-row input"); i.value = "My star"; document.querySelector(".bmb-buttons .primary").click(); return 0; })()'); await sleep(900);
    check("Done keeps the new name and closes", !popup.isOpen() && bm.list().find((b) => b.url === pageUrl).title === "My star");
    await retryOpen(() => tm.toggleBookmarkActive());
    bv = await bub();
    check("starring it again opens 'Edit bookmark' and removes nothing", popup.isOpen("bookmark-edit") && bv.title === "Edit bookmark" && bv.name === "My star" && bm.list().some((b) => b.url === pageUrl));
    await popupWc().executeJavaScript('document.querySelector(".bmb-buttons .secondary").click(); 0'); await sleep(900);
    check("Remove deletes it, closes the bubble and updates the bar", !popup.isOpen() && !bm.list().some((b) => b.url === pageUrl) && !(await barTitles()).includes("My star"));
    await retryOpen(() => tm.toggleBookmarkActive());
    await popupWc().executeJavaScript('document.querySelector(".bmb-x").click(); 0'); await sleep(900);
    check("the X closes it (the bookmark stays)", !popup.isOpen() && bm.list().some((b) => b.url === pageUrl));
    bm.remove(bm.list().find((b) => b.url === pageUrl).id); tm.broadcastBookmarks();

    console.log("\n-- the bookmark keeps the page's icon, also an inline (data:) one");
    // a site that declares its icon inline showed a globe on the bar: the store used to refuse anything but http(s)
    const inlineUrl = pageUrl.replace("/star", "/inline");
    tm.createTab(inlineUrl); await sleep(1800);
    await retryOpen(() => tm.toggleBookmarkActive());
    popup.close(); await sleep(300);
    const sb = bm.list().find((b) => b.url === inlineUrl);
    check("a page with an inline icon is bookmarked WITH that icon", !!sb && sb.favicon.startsWith("data:image/png"));
    check("...and the bar shows it as an image, not the globe", await shell.executeJavaScript('[...document.querySelectorAll(".bookmark")].some(e => { const i = e.querySelector("img"); return i && i.src.startsWith("data:image/png") && e.textContent.includes("Inline"); })'));
    check("an oversize inline icon is not stored (keeps bookmarks.json small)", (() => { const big = "data:image/png;base64," + "A".repeat(40000); bm.toggle({ url: "https://big.example/", title: "Big", favicon: big }); const b = bm.list().find((x) => x.url === "https://big.example/"); const ok = b && b.favicon === ""; if (b) bm.remove(b.id); return ok; })());
    // a bookmark saved with NO icon (older ones, or added in the manager) learns it when that address shows one
    bm.remove(sb.id);
    const legacy = bm.add({ title: "Legacy", url: inlineUrl });
    check("setup: a bookmark with no icon", legacy.ok && bm.list().find((b) => b.url === inlineUrl).favicon === "");
    tm.createTab(inlineUrl); await sleep(2000);
    check("opening that page gives the bookmark its icon", bm.list().find((b) => b.url === inlineUrl).favicon.startsWith("data:image/png"));
    check("an address that is NOT bookmarked is never recorded", bm.list().every((b) => b.url !== pageUrl));
    // the SAME SITE, another page: a bookmark added/edited to a page of the site that is open gets the site's icon at once
    // (it used to stay a globe for ever: only an identical address matched)
    const otherPage = inlineUrl.replace("/inline", "/some-other-page"), elsewhere = inlineUrl.replace("/inline", "/elsewhere");
    bm.add({ title: "Same site", url: otherPage }); tm.broadcastBookmarks(); await sleep(300);
    check("a bookmark for ANOTHER page of the open site gets the site's icon at once", bm.list().find((b) => b.url === otherPage).favicon !== "");   // (this test server's pages have different icons, so only "has one")
    bm.add({ title: "Far away", url: "https://example.invalid/" }); tm.broadcastBookmarks(); await sleep(300);
    const far = bm.list().find((b) => b.url === "https://example.invalid/");
    check("a bookmark of a DIFFERENT site is not given it", far.favicon === "");
    bm.update(far.id, { url: elsewhere }); tm.broadcastBookmarks(); await sleep(300);
    check("editing that bookmark to a page of the open site gives it the icon right away (no reload)", bm.list().find((b) => b.id === far.id).favicon !== "");
    for (const u of [otherPage, elsewhere]) { const x = bm.list().find((b) => b.url === u); if (x) bm.remove(x.id); }
    bm.remove(bm.list().find((b) => b.url === inlineUrl).id); tm.broadcastBookmarks();
    srv.close();

    console.log("\n-- Restricted Mode stays read/open only");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    const before = JSON.stringify(bm.list());
    menus = []; tm.bookmarkContextMenu(ids[0]);
    check("no right-click menu at all", menus.length === 0);
    ipcMain.emit("bookmarks:context-menu", { sender: shell }, ids[0]);
    check("...also not through the IPC", menus.length === 0);
    tm.openBookmarkEdit(ids[0]); await sleep(500);
    check("the Edit box cannot be opened", !popup.isOpen("bookmark-edit"));
    popup.open("bookmark-edit", null, { bookmarkId: ids[0] }); await sleep(500);
    check("...not even by asking the popup module directly", !popup.isOpen("bookmark-edit"));
    check("saving is refused", popup.saveBookmark("hacked", "https://evil.example/").ok === false);
    popup.handleAction("bookmark-active");   // the star / menu "bookmark this page" path
    tm.toggleBookmarkActive(); await sleep(600);   // ...and Ctrl+D / the star itself
    check("the star adds nothing and opens no bubble", !popup.isOpen("bookmark-edit") && JSON.stringify(bm.list()) === before);
    check("the bookmark list is exactly as before", JSON.stringify(bm.list()) === before);
    check("the bar still lists them (read) ", (await barTitles()).length === bm.list().length);

    tm.leaveRestricted(); await sleep(800);
    Menu.buildFromTemplate = realBuild;
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_BOOKMARKEDIT total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
