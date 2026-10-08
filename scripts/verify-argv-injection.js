// Command-line injection through a link handed to PBCalc by another program (the "CVE-2018-1000006" class).
// Windows starts   PBCalc.exe "<address>"   for a clicked link. If another program does not escape quotes in the address, an attacker's
// link  http://x/" --remote-debugging-port=9333 "  becomes extra Chromium SWITCHES (remote debugging = full control of the browser and
// every logged-in session; --gpu-launcher / --utility-cmd-prefix = run any program). Chromium stops reading switches at a lone  --  ,
// so the registered command is   "PBCalc.exe" -- "%1"   (electron/defaultBrowser.js, REG_VERSION 5).
// This test starts the real browser both ways with a hostile switch and looks at whether the debugging port opens.
// Run: node scripts/verify-argv-injection.js        (starts two short-lived PBCalc processes; the port is 127.0.0.1 only)
const { spawn } = require("child_process");
const http = require("http");
const path = require("path"), fs = require("fs"), os = require("os");
const root = path.join(__dirname, "..");
const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const results = [];
const check = (name, cond, extra) => { results.push({ name, pass: !!cond }); console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (port) => new Promise((res) => { const q = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 1500 }, (r) => { r.resume(); res(r.statusCode === 200); }); q.on("error", () => res(false)); q.on("timeout", () => { q.destroy(); res(false); }); });

async function run(label, args, port) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "pbcalc-argv-"));
  // a throw-away data folder for the child (the browser reads PBCALC_USERDATA only in tests: see main.js? no - use the dev folder switch)
  const child = spawn(electron, [root, ...args], { env, stdio: "ignore", windowsHide: true });
  let open = false;
  for (let i = 0; i < 30 && !open; i++) { await sleep(700); open = await probe(port); }
  try { process.kill(child.pid); } catch (_) {}
  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await sleep(1500);
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) {}
  console.log("   " + label + ": debugging port " + (open ? "OPEN (the hostile switch was obeyed)" : "closed"));
  return open;
}

(async () => {
  console.log("-- a hostile switch riding on a link");
  const bare = await run("without  --  (what a quote-injected link would produce)", ["http://127.0.0.1/", "--remote-debugging-port=9391"], 9391);
  check("(control) without the terminator the switch IS obeyed - this is what the registered command must prevent", bare === true);
  const guarded = await run("with  --  before the address", ["--", "http://127.0.0.1/", "--remote-debugging-port=9392"], 9392);
  check("with  --  nothing after it can be a switch: the debugging port stays closed", guarded === false);

  console.log("\n-- what is registered");
  const src = fs.readFileSync(path.join(root, "electron", "defaultBrowser.js"), "utf8");
  check("the registered open command puts  --  in front of the address", /const command = \(exe\) => '"' \+ exe \+ '" -- "%1"'/.test(src));
  const { targetFromArgv } = require("../electron/externalOpen");
  check("the argv parser still finds the address after  --", targetFromArgv(["PBCalc.exe", "--", "http://example.com/a"]) === "http://example.com/a");
  check("...and never takes a switch for a file or address", targetFromArgv(["PBCalc.exe", "--", "--remote-debugging-port=9", "-x"]) === null);
  const failed = results.filter((r) => !r.pass).length;
  console.log("PBCALC_ARGV total=" + results.length + " failed=" + failed);
  process.exit(failed ? 1 : 0);
})();
