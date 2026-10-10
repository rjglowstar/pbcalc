const { execFile } = require("child_process");

// A temporary Windows connection to the IT share, made ONLY to deliver a support report to a PC that is on the company network but not signed in to the file server
// (owner, 2026-10-10: "some users cannot put the report in the Software department folder - they are not logged in to this file server"; the owner approved embedding the account).
// Rules (security):
//  - the connection is TEMPORARY (WNetAddConnection2 + CONNECT_TEMPORARY): Windows does not remember it after sign-out and nothing is written to Credential Manager
//    (no `cmdkey`, no `net use /savecred`, no /persistent);
//  - the password never appears on a command line (visible to other programs of the same user): it travels in the environment of the one PowerShell child, which
//    reads and clears it, and is never written to a file or a log;
//  - it is removed again right after the upload, but ONLY the connection WE made: when Windows already has a connection to that server (the user's own, with their own
//    saved sign-in) we do not touch it, do not replace it and do not remove it;
//  - it is tried once, and only after a normal write was refused. Limit: the account name and password are in the program (obfuscated, not secret) - the account must only
//    be able to write into the pbcalc-report folder.
const SHARE_USER = "it@pbc.local";
const SHARE_PASSWORD = "11511151";

// reads PBC_ACTION (connect | disconnect), PBC_REMOTE (\\server\share), PBC_U, PBC_P; prints one JSON line {state, code}
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$u = $env:PBC_U; $p = $env:PBC_P; $env:PBC_P = $null
$remote = $env:PBC_REMOTE; $action = $env:PBC_ACTION
$sig = @'
[DllImport("mpr.dll", CharSet=CharSet.Unicode)] public static extern int WNetAddConnection2(ref NETRESOURCE r, string pw, string user, int flags);
[DllImport("mpr.dll", CharSet=CharSet.Unicode)] public static extern int WNetCancelConnection2(string name, int flags, bool force);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct NETRESOURCE { public int dwScope; public int dwType; public int dwDisplayType; public int dwUsage; public string lpLocalName; public string lpRemoteName; public string lpComment; public string lpProvider; }
'@
Add-Type -MemberDefinition $sig -Name PbcNet -Namespace W
$server = ($remote -split '\\')[2]
if ($action -eq 'connect') {
  # a connection to this server already exists (the user's own sign-in): leave it alone
  $have = (& net use 2>$null | Out-String)
  if ($have -match [regex]::Escape($server)) { '{"state":"existing","code":0}'; exit }
  $r = New-Object W.PbcNet+NETRESOURCE
  $r.dwType = 1; $r.lpRemoteName = $remote
  $code = [W.PbcNet]::WNetAddConnection2([ref]$r, $p, $u, 4)
  if ($code -eq 0) { '{"state":"created","code":0}' } else { '{"state":"failed","code":' + $code + '}' }
} else {
  $code = [W.PbcNet]::WNetCancelConnection2($remote, 0, $true)
  # also the server-level entries Windows may have made for our sign-in (they would keep the IT account's session for later opens of the server); errors ignored - they usually do not exist
  [void][W.PbcNet]::WNetCancelConnection2(('\\' + $server + '\IPC$'), 0, $true)
  [void][W.PbcNet]::WNetCancelConnection2(('\\' + $server), 0, $true)
  '{"state":"removed","code":' + $code + '}'
}
`;

function run(action, remote, opts = {}) {
  return new Promise((resolve) => {
    try {
      const enc = Buffer.from(SCRIPT, "utf16le").toString("base64");
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], {
        windowsHide: true, timeout: opts.timeoutMs || 15000, maxBuffer: 1 << 20, encoding: "utf8",
        env: { ...process.env, PBC_ACTION: action, PBC_REMOTE: remote, PBC_U: opts.user || SHARE_USER, PBC_P: opts.password || SHARE_PASSWORD },
      }, (err, stdout) => {
        if (err) return resolve({ state: "failed", code: -1 });
        try { const t = String(stdout).trim(); resolve(JSON.parse(t.slice(t.indexOf("{")))); } catch (_) { resolve({ state: "failed", code: -2 }); }
      });
    } catch (_) { resolve({ state: "failed", code: -3 }); }
  });
}

// "\\192.168.0.3\it\Ravi\browser\pbcalc-report" -> "\\192.168.0.3\it"
const shareRoot = (dir) => { const m = /^(\\\\[^\\/]+\\[^\\/]+)/.exec(String(dir || "")); return m ? m[1] : null; };

// -> { connected: boolean, disconnect(): Promise } - never throws
async function login(dir, opts = {}) {
  const none = { connected: false, disconnect: async () => {} };
  if (process.platform !== "win32") return none;
  const remote = shareRoot(dir);
  if (!remote) return none;
  const r = await run("connect", remote, opts);
  if (r.state !== "created") return none;                       // existing (not ours) or failed: nothing to undo
  return { connected: true, disconnect: () => run("disconnect", remote, opts).catch(() => ({})) };
}

module.exports = { login, shareRoot, SHARE_USER };
