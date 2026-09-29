// Non-intrusive end-to-end self-test. Run only via `PBCALC_VERIFY=1 electron .`.
// Keeps the window hidden (show:false, never shown) so it never steals real focus/input, and
// exits the process itself with a pass/fail code plus a JSON result line on stdout.
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const { portableDataDir } = require("../electron/constants");

app.setPath("userData", portableDataDir());

const results = [];
function check(name, cond) {
  results.push({ name, pass: !!cond });
}

app.whenReady().then(async () => {
  const state = require("../electron/state");
  const tabManager = require("../electron/tabs/tabManager");
  const vault = require("../electron/vault/passwordVault");

  const userDataDir = app.getPath("userData");
  check("userData is portable (.dev-userdata, not AppData)", /\.dev-userdata$/.test(userDataDir) && !/AppData/i.test(userDataDir));

  state.mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // --- Tab lifecycle ---
  const s1 = tabManager.createTab();
  check("createTab() creates first tab", s1.tabs.length === 1);
  const firstId = s1.tabs[0].id;

  const s2 = tabManager.createTab("https://example.com");
  check("createTab(url) creates second tab", s2.tabs.length === 2);
  check("second tab is active after creation", s2.activeTabId === s2.tabs[1].id);

  const s3 = tabManager.switchTab(firstId);
  check("switchTab() switches active tab", s3.activeTabId === firstId);

  await new Promise((r) => setTimeout(r, 400)); // let example.com navigation land
  const active = tabManager.getActiveTab();
  check("getActiveTab() returns a live tab", !!active && !active.view.webContents.isDestroyed());

  const beforeClose = tabManager.getTabState().tabs.length;
  const s4 = tabManager.closeTab(s2.tabs[1].id);
  check("closeTab() removes a tab", s4.tabs.length === beforeClose - 1);

  // Close the very last tab -> should auto-reopen a fresh one, never leave zero tabs.
  const remaining = tabManager.getTabState().tabs;
  for (const t of remaining) tabManager.closeTab(t.id);
  const afterAllClosed = tabManager.getTabState();
  check("closing the last tab reopens a fresh one", afterAllClosed.tabs.length === 1);

  // --- Vault round-trip ---
  const origin = "https://verify-test.example";
  vault.resetOrigin(origin);
  check("vault.isAvailable()", vault.isAvailable());

  const saveOk = vault.saveCredential({ origin, username: "tester", password: "s3cr3t-P@ss" });
  check("vault.saveCredential() succeeds", saveOk === true);

  const listed = vault.listUsernames(origin);
  check("vault.listUsernames() finds saved user", listed.some((u) => u.username === "tester"));

  const pw = vault.getPassword(origin, "tester");
  check("vault.getPassword() round-trips plaintext", pw === "s3cr3t-P@ss");

  const last = vault.getLastSaved(origin);
  check("vault.getLastSaved() matches", !!last && last.username === "tester" && last.password === "s3cr3t-P@ss");

  const needsPrompt = vault.needsSavePrompt(origin, "tester", "s3cr3t-P@ss");
  check("vault.needsSavePrompt() false for identical saved password", needsPrompt === false);

  const delOk = vault.deleteCredential({ origin, username: "tester" });
  check("vault.deleteCredential() succeeds", delOk === true);
  check("vault.getPassword() returns null after delete", vault.getPassword(origin, "tester") === null);

  // --- Vault file on disk is actually encrypted (not human-readable JSON of the secret) ---
  vault.saveCredential({ origin, username: "disktest", password: "on-disk-secret-XYZ" });
  const vaultFile = path.join(userDataDir, "password-vault.json");
  const raw = fs.existsSync(vaultFile) ? fs.readFileSync(vaultFile, "utf8") : "";
  check("vault file exists on disk in portable folder", fs.existsSync(vaultFile));
  check("vault file does NOT contain the plaintext password", raw.length > 0 && !raw.includes("on-disk-secret-XYZ"));
  vault.resetOrigin(origin);

  // --- No history file/array anywhere ---
  const files = fs.existsSync(userDataDir) ? fs.readdirSync(userDataDir) : [];
  check("no history-named file in userData dir", !files.some((f) => /history/i.test(f)));

  const failed = results.filter((r) => !r.pass);
  console.log("PBCALC_VERIFY_RESULT " + JSON.stringify({ total: results.length, failed: failed.length, results }));

  try { if (state.mainWindow && !state.mainWindow.isDestroyed()) state.mainWindow.destroy(); } catch (_) {}
  app.exit(failed.length === 0 ? 0 : 1);
});
