// The password asked before a SAVED login is filled (owner's rule: whoever sits at the browser and does not know it must not be
// able to auto-fill saved passwords). Default 1234, digits 0-9 only (4-8), changed in Settings with old/new/confirm, 5 wrong tries
// = 30s lockout (doubling), no recovery, ASKED EVERY TIME a saved login is picked from the dropdown.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/verify-vault-lock.js
const { app } = require("electron");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
setTimeout(() => { console.log("WATCHDOG"); app.exit(2); }, 240000).unref();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-vl-"));
const UD = path.join(tmp, "UserData");
require("../electron/constants").dataDir = () => UD;
const errors = [];
process.on("uncaughtException", (e) => errors.push(e && e.message));
require("../electron/main.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name); };

(async () => {
  try {
    await app.whenReady(); await sleep(3500);
    const state = require("../electron/state");
    const tm = require("../electron/tabs/tabManager");
    const popup = require("../electron/popup");
    const lock = require("../electron/vault/vaultLock");
    const grants = require("../electron/vault/fillGrants");
    const vault = require("../electron/vault/passwordVault");
    const lockFile = lock.FILE();

    console.log("-- the password (vaultLock)");
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}
    check("a fresh install: the default password is 1234", lock.isDefault() === true && lock.verify("1234").ok === true);
    check("a wrong password is refused and says how many tries are left", (() => { const r = lock.verify("1111"); return !r.ok && r.error === "wrong" && r.left === 4; })());
    check("letters / too short / too long are never accepted, even if they would 'match'", !lock.verify("12a4").ok && !lock.verify("123").ok && !lock.verify("123456789").ok);
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}
    for (let i = 0; i < 4; i++) lock.verify("0000");
    const fifth = lock.verify("0000");
    check("the 5th wrong try starts a 30 second lockout", !fifth.ok && fifth.secs >= 29 && fifth.secs <= 30 && lock.lockedSecs() >= 29);
    check("while locked even the RIGHT password is refused", (() => { const r = lock.verify("1234"); return !r.ok && r.error === "locked" && r.secs >= 1; })());
    lock._reset();
    check("the lockout survives closing and re-opening the browser (it is in the file)", lock.lockedSecs() >= 28);
    const f = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    f.state.lockedUntil = Date.now() - 1000; fs.writeFileSync(lockFile, JSON.stringify(f)); lock._reset();
    check("after the lockout the right password works again and the counters reset", lock.verify("1234").ok === true && lock.lockedSecs() === 0);
    for (let i = 0; i < 5; i++) lock.verify("0000");
    const f2 = JSON.parse(fs.readFileSync(lockFile, "utf8")); f2.state.lockedUntil = Date.now() - 1; fs.writeFileSync(lockFile, JSON.stringify(f2)); lock._reset();
    for (let i = 0; i < 5; i++) lock.verify("0000");
    check("a second round of 5 wrong tries (without a success between) locks for 60 seconds", lock.lockedSecs() > 55 && lock.lockedSecs() <= 60);
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}

    console.log("\n-- changing it (old / new / confirm)");
    check("new password with a letter is refused", lock.change("1234", "12a4", "12a4").error === "bad-format");
    check("3 digits / 9 digits are refused (4 to 8 only)", lock.change("1234", "123", "123").error === "bad-format" && lock.change("1234", "123456789", "123456789").error === "bad-format");
    check("new and confirm that differ are refused", lock.change("1234", "5678", "5679").error === "mismatch");
    check("the same password again is refused", lock.change("1234", "1234", "1234").error === "same");
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}
    check("a wrong OLD password is refused (and counts as a wrong try)", (() => { const r = lock.change("9999", "5678", "5678"); return r.error === "wrong-old" && r.left === 4; })());
    check("a correct change works", lock.change("1234", "5678", "5678").ok === true && lock.isDefault() === false);
    check("the old password no longer works, the new one does", lock.verify("1234").ok === false && lock.verify("5678").ok === true);
    const raw = fs.readFileSync(lockFile, "utf8");
    check("the file holds neither password in clear, nor a plain hash (DPAPI-encrypted record)", !raw.includes("5678") && !raw.includes("1234") && /"enc"/.test(raw) && !/"hash"/.test(raw));
    lock._reset();
    check("a new password is remembered after a restart", lock.verify("5678").ok === true && lock.verify("1234").ok === false);
    check("the lock file is on the keep list (not wiped at exit)", require("../electron/privacy").KEEP.has("vault-lock.json"));
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}

    console.log("\n-- one-time grants");
    grants.grant(7, "https://a.test", "u");
    check("a grant works once, for exactly that page + origin + username", grants.take(7, "https://a.test", "u") === true && grants.take(7, "https://a.test", "u") === false);
    grants.grant(7, "https://a.test", "u");
    check("another origin / username / page does not use it up wrongly", grants.take(8, "https://a.test", "u") === false && grants.take(7, "https://b.test", "u") === false && grants.take(7, "https://a.test", "x") === false);

    // ── a login page on a local server, with a saved login ───────────────
    const srv = http.createServer((q, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<title>login</title><body style="margin:0"><form style="padding:60px"><input id=u name=username type=text style="width:300px;height:30px"><br><br><input id=p name=password type=password style="width:300px;height:30px"></form>');
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    const origin = "http://127.0.0.1:" + srv.address().port;
    check("the vault is available (DPAPI) for this test", vault.isAvailable() === true);
    vault.saveCredential({ origin, username: "sw001", password: "secret-pw" });
    tm.createTab(origin + "/login"); await sleep(2200);
    const tab = () => state.tabs.find((t) => t.id === state.activeTabId), page = () => tab().view.webContents;
    const val = (id) => page().executeJavaScript('document.getElementById("' + id + '").value');
    const clickAt = async (x, y) => { page().sendInputEvent({ type: "mouseMove", x, y }); page().sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 }); page().sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 }); await sleep(500); };
    const rect = (sel) => page().executeJavaScript('(() => { const e = document.querySelector("' + sel + '"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    const popupWc = () => state.mainWindow.getBrowserViews().pop().webContents;
    const typeInDialog = async (digits) => { await popupWc().executeJavaScript('(() => { const i = document.querySelector(".vu input"); i.value = "' + digits + '"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()'); };
    const dialogClick = async (label) => { await popupWc().executeJavaScript('[...document.querySelectorAll(".vu button")].find((b) => b.textContent === "' + label + '").click()'); await sleep(500); };
    const dialogMsg = () => popupWc().executeJavaScript('document.querySelector(".vu .bm-msg").textContent');
    const openDropdown = async () => { const u = await rect("#u"); await clickAt(u.x, u.y); return rect(".pbcalc-pm-row"); };

    console.log("\n-- a page cannot read a saved password by itself");
    check("window.vaultAPI.getPassword(...) from the page returns nothing (no grant)", (await page().executeJavaScript('window.vaultAPI.getPassword("sw001")')) === null);
    check("window.vaultAPI.getLastSaved() gives the username but NO password", JSON.stringify(await page().executeJavaScript("window.vaultAPI.getLastSaved()")) === '{"username":"sw001"}');
    check("the usernames list is still there for the dropdown", (await page().executeJavaScript("window.vaultAPI.listUsernames()")).some((i) => i.username === "sw001"));

    console.log("\n-- picking a saved login asks for the password first");
    let row = await openDropdown();
    check("clicking the username field still opens the dropdown (usernames visible, like Chrome)", !!row);
    await clickAt(row.x, row.y);
    check("picking the row opens the password dialog", popup.isOpen("vault-unlock") === true);
    check("...and NOTHING is filled yet", (await val("u")) === "" && (await val("p")) === "");
    await dialogClick("Fill");
    const failedTries = () => (fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, "utf8")).state.failed : 0);
    check("Fill with an EMPTY box asks for the password and does not count as a wrong try", popup.isOpen("vault-unlock") && /Enter your password/.test(await dialogMsg()) && failedTries() === 0);
    await typeInDialog("12"); await dialogClick("Fill");
    check("too few digits: 'Enter 4 to 8 digits.', still not a try", /Enter 4 to 8 digits/.test(await dialogMsg()) && failedTries() === 0);
    check("main refuses an empty / invalid password without counting it", (() => { const r = lock.verify(""); return r.ok === false && r.error === "format" && failedTries() === 0; })());
    await typeInDialog("1111"); await dialogClick("Fill");
    check("a wrong password: the dialog stays, says so, and nothing is filled", popup.isOpen("vault-unlock") && /Wrong password\. 4 tries left/.test(await dialogMsg()) && (await val("u")) === "" && (await val("p")) === "");
    await typeInDialog("12a4");
    check("letters cannot be typed (only digits are kept)", (await popupWc().executeJavaScript('document.querySelector(".vu input").value')) === "124");
    await typeInDialog("1234"); await dialogClick("Fill"); await sleep(400);
    check("the right password closes the dialog and fills username AND password", !popup.isOpen("vault-unlock") && (await val("u")) === "sw001" && (await val("p")) === "secret-pw");
    check("that permission was for ONE fill: the page still cannot read the password afterwards", (await page().executeJavaScript('window.vaultAPI.getPassword("sw001")')) === null);

    console.log("\n-- asked EVERY time");
    await page().executeJavaScript('document.getElementById("u").value = ""; document.getElementById("p").value = ""; 1');
    row = await openDropdown(); await clickAt(row.x, row.y);
    check("the next pick asks again (even right after a correct entry)", popup.isOpen("vault-unlock") === true);
    await dialogClick("Cancel");
    check("Cancel: no dialog, nothing filled", !popup.isOpen("vault-unlock") && (await val("u")) === "" && (await val("p")) === "");
    row = await openDropdown(); await clickAt(row.x, row.y);
    popupWc().sendInputEvent({ type: "keyDown", keyCode: "Escape" }); popupWc().sendInputEvent({ type: "keyUp", keyCode: "Escape" }); await sleep(500);
    check("Esc: no dialog, nothing filled", !popup.isOpen("vault-unlock") && (await val("p")) === "");
    row = await openDropdown(); await clickAt(row.x, row.y);
    state.mainWindow.webContents.executeJavaScript("1"); popup.close(); await sleep(300);
    check("the dialog being closed any other way also fills nothing", (await val("p")) === "");

    console.log("\n-- a page script cannot raise the dialog or fill by itself");
    row = await openDropdown();
    await page().executeJavaScript('(() => { const r = document.querySelector(".pbcalc-pm-row"); r.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); return 1; })()'); await sleep(500);
    check("a synthetic (script) click on the saved-login row does nothing", !popup.isOpen("vault-unlock") && (await val("p")) === "");
    const bg = tab();
    tm.createTab("about:blank"); await sleep(600);
    check("a request from a page that is NOT the active tab is refused", (await bg.view.webContents.executeJavaScript('window.vaultAPI.getPassword("sw001")')) === null && !popup.isOpen("vault-unlock"));
    tm.switchTab(bg.id); await sleep(600);

    console.log("\n-- lockout inside the dialog");
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}
    row = await openDropdown(); await clickAt(row.x, row.y);
    for (let i = 0; i < 5; i++) { await typeInDialog("0000"); await dialogClick("Fill"); }
    const msg = await dialogMsg();
    check("5 wrong tries: 'Too many wrong tries', input and Fill disabled", /Too many wrong tries\. Try again in \d+ second/.test(msg) && (await popupWc().executeJavaScript('document.querySelector(".vu input").disabled && [...document.querySelectorAll(".vu button")].find((b) => b.textContent === "Fill").disabled')) === true);
    check("...and the right password does not get in while locked (main refuses)", popup.verifyVaultPassword("1234").ok === false && (await val("p")) === "");
    popup.close(); await sleep(300);
    row = await openDropdown(); await clickAt(row.x, row.y);
    check("a new dialog during the lockout opens already locked", popup.isOpen("vault-unlock") && /Too many wrong tries/.test(await dialogMsg()));
    popup.close(); await sleep(300);
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}

    console.log("\n-- Settings > Saved passwords");
    tm.openSettings(); await sleep(2000);
    const sp = () => state.tabs.find((t) => t.id === state.activeTabId).view.webContents;
    const sjs = (js) => sp().executeJavaScript(js);
    const setv = (id, v) => sjs('(() => { const i = document.getElementById("' + id + '"); i.value = "' + v + '"; i.dispatchEvent(new Event("input", { bubbles: true })); return i.value; })()');
    check("the card says the password is still the default 1234", /still the default, 1234/.test(await sjs('document.getElementById("vault-desc").textContent')));
    await sjs('document.getElementById("vault-open").click()'); await sleep(200);
    check("Change password opens old / new / confirm", (await sjs('!document.getElementById("vault-form").hidden && ["vault-old","vault-new","vault-confirm"].every((i) => document.getElementById(i).type === "password")')) === true);
    check("letters typed into those boxes are dropped (digits only)", (await setv("vault-new", "5a6b7")) === "567");
    const save = async (o, n, c) => { await setv("vault-old", o); await setv("vault-new", n); await setv("vault-confirm", c); await sjs('document.getElementById("vault-save").click()'); await sleep(500); return sjs('(() => { const t = [...document.querySelectorAll(".pb-toast")].pop(); return t ? t.textContent.replace(/×$/, "") : ""; })()'); };
    const toastKind = () => sjs('(() => { const t = [...document.querySelectorAll(".pb-toast")].pop(); return t ? t.className : ""; })()');
    const nToasts = () => sjs('document.querySelectorAll(".pb-toast").length');
    const t0 = await nToasts();
    await save("", "5678", "5678");
    check("Save with the OLD password empty: no notification, the field is marked, nothing counted", (await nToasts()) === t0 && (await sjs('document.getElementById("vault-old").classList.contains("invalid")')) === true && (!fs.existsSync(lockFile) || JSON.parse(fs.readFileSync(lockFile, "utf8")).state.failed === 0));
    await setv("vault-old", "1"); check("typing in the field clears the mark", (await sjs('document.getElementById("vault-old").classList.contains("invalid")')) === false);
    await save("9999", "5678", "5678"); await save("9999", "5678", "5678"); await save("9999", "5678", "5678");
    check("the same error three times shows ONE notification (not a stack)", (await sjs('[...document.querySelectorAll(".pb-toast.error")].filter((t) => /old password is wrong/.test(t.textContent)).length')) === 1);
    lock._reset(); try { fs.unlinkSync(lockFile); } catch (_) {}
    check("wrong old password: refused with a message", /old password is wrong/i.test(await save("9999", "5678", "5678")));
    check("mismatching confirmation: refused with a message", /not the same/.test(await save("1234", "5678", "5679")));
    check("too short new password: refused with a message", /4 to 8 digits/.test(await save("1234", "567", "567")));
    check("an error is a RED notification (not part of the form)", /pb-toast.* error|error/.test(await toastKind()) && !(await sjs('document.getElementById("vault-form").hidden')));
    check("correct old + new + confirm: 'Password changed.' in a GREEN notification", (await save("1234", "5678", "5678")) === "Password changed." && /success/.test(await toastKind()) && !lock.isDefault());
    check("...and it is still on screen although the password form has closed", (await sjs('document.getElementById("vault-form").hidden')) === true && (await sjs('document.querySelectorAll(".pb-toast.success").length')) >= 1);
    await sleep(4600);
    check("...and it closes by itself after a few seconds", (await sjs('document.querySelectorAll(".pb-toast.success").length')) === 0);
    check("the 'still the default' notice is gone", !/still the default/.test(await sjs('document.getElementById("vault-desc").textContent')));
    // use the new one in the dialog
    tm.switchTab(bg.id); await sleep(600);
    row = await openDropdown(); await clickAt(row.x, row.y);
    await typeInDialog("1234"); await dialogClick("Fill");
    check("the OLD password is now refused by the dialog", popup.isOpen("vault-unlock") && /Wrong password/.test(await dialogMsg()));
    await typeInDialog("5678"); await dialogClick("Fill"); await sleep(400);
    check("the NEW password fills the login", !popup.isOpen("vault-unlock") && (await val("p")) === "secret-pw");

    console.log("\n-- Restricted Mode");
    tm.secretToggle(); await sleep(2800);
    check("Restricted Mode is on", state.restricted === true);
    const asked = popup.askVaultPassword(page(), origin, "sw001");
    await sleep(800);
    check("the password dialog works in Restricted Mode too", popup.isOpen("vault-unlock") === true);
    await typeInDialog("5678"); await dialogClick("Fill");
    check("...and a correct password grants the fill there as well", (await asked) === true);
    check("(the grant is for one read only)", grants.take(page().id, origin, "sw001") === true && grants.take(page().id, origin, "sw001") === false);
    tm.leaveRestricted(); await sleep(600);
    srv.close();
    check("no uncaught error", errors.length === 0);
  } catch (e) { check("no crash: " + (e && e.stack), false); }
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_VAULTLOCK total=" + results.length + " failed=" + failed);
  app.exit(failed ? 1 : 0);
})();
