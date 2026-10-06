# Drives a REAL Chrome with REAL keystrokes and records what it does, so PBCalc's keyboard behaviour
# can be copied from measurements instead of memory:
#   * Ctrl+J         -> which page opens, and does a second press reuse that tab?
#   * Ctrl+W         -> which tab becomes active, and does KEYBOARD FOCUS land in its page?
#   * Ctrl+Shift+T   -> same questions for a restored tab
#   * landing on a New Tab page after Ctrl+W -> is the omnibox focused (blue ring) or the page?
# Focus is observable without screenshots: -Base serves pages (keyserver.js (this folder)) whose input
# echoes typed text into the TAB TITLE, so after a key we type a letter and read the window title.
#
# Usage: node keyserver.js   (port 8125), then
#        powershell -File capture-keys.ps1 -Base http://127.0.0.1:8125
#   -> prints "STEP | window title" lines and saves $env:TEMP\chromeref\keys_*.png
#
# SAFETY: this sends real keystrokes, so before EVERY key it checks that the foreground window is the
# Chrome it launched and that the mouse is still where it was parked. If not (you touched something)
# it kills that Chrome and stops, so Ctrl+W / Ctrl+J can never land in one of your own windows.
param([string]$Base = "http://127.0.0.1:8125")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CK {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cb; public uint t; }
}
"@
[CK]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
$out = Join-Path $env:TEMP "chromeref"; New-Item -ItemType Directory -Force $out | Out-Null

# do not start while the user is typing / moving the mouse
function IdleSeconds { $l = New-Object CK+LII; $l.cb = [Runtime.InteropServices.Marshal]::SizeOf($l); [CK]::GetLastInputInfo([ref]$l) | Out-Null; return ([Environment]::TickCount - $l.t) / 1000 }
$waited = 0
while ((IdleSeconds) -lt 8 -and $waited -lt 90) { Start-Sleep -Seconds 2; $waited += 2 }
if ((IdleSeconds) -lt 8) { "ABORTED: the machine is in use (no 8s of idle within 90s)"; exit 2 }

$ud = Join-Path $env:TEMP ("chrome-keys-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$args2 = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-position=100,100", "--window-size=1200,700", "--new-window", "$Base/p1", "$Base/p2", "$Base/p3")
Start-Process $exe -ArgumentList $args2
Start-Sleep -Seconds 9
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
$pid2 = $proc.ProcessId
function Cleanup { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function Hwnd { return (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).MainWindowHandle }
$h = Hwnd
[CK]::ShowWindow($h, 9) | Out-Null
[CK]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
[CK]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
$parkX = 700; $parkY = 600
[CK]::SetCursorPos($parkX, $parkY) | Out-Null
# one click into the page so the window is active (an inactive window ignores shortcuts)
[CK]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CK]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900

function Safe {
  $p = New-Object CK+P; [CK]::GetCursorPos([ref]$p) | Out-Null
  $fg = [CK]::GetForegroundWindow(); $want = Hwnd
  if ($fg -ne $want -or [Math]::Abs($p.x - $parkX) -gt 2 -or [Math]::Abs($p.y - $parkY) -gt 2) {
    "ABORTED: foreground window or mouse changed - no further keys sent"
    "  foreground=$fg expected=$want | mouse=($($p.x),$($p.y)) parked=($parkX,$parkY)"
    Cleanup; exit 3
  }
}
$VK = @{ ctrl = 0x11; shift = 0x10; Tab = 0x09; W = 0x57; J = 0x4A; T = 0x54; '9' = 0x39; A = 0x41; B = 0x42; C = 0x43; D = 0x44; E = 0x45; F = 0x46; G = 0x47 }
function Key([string]$k, [string[]]$mods = @()) {
  Safe
  foreach ($m in $mods) { [CK]::keybd_event([byte]$VK[$m], 0, 0, [UIntPtr]::Zero) }
  [CK]::keybd_event([byte]$VK[$k], 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [CK]::keybd_event([byte]$VK[$k], 0, 2, [UIntPtr]::Zero)
  foreach ($m in $mods[($mods.Count - 1)..0]) { if ($m) { [CK]::keybd_event([byte]$VK[$m], 0, 2, [UIntPtr]::Zero) } }
  Start-Sleep -Milliseconds 900
}
function Title { return ((Get-Process -Id $pid2 -ErrorAction SilentlyContinue).MainWindowTitle -replace ' - Google Chrome$', '') }
function Step($label) { "{0,-52} | {1}" -f $label, (Title) }
function Shot($name) { Safe; $r = New-Object System.Drawing.Bitmap 1200, 130; $g = [System.Drawing.Graphics]::FromImage($r); $g.CopyFromScreen(100, 100, 0, 0, $r.Size); $g.Dispose(); $r.Save((Join-Path $out "keys_$name.png")); $r.Dispose() }

Step "start (3 tabs from the command line)"
Key '9' @('ctrl');            Step "Ctrl+9  (last tab)"
Key 'A';                      Step "type 'a'  -> page focused? (want P3:a)"
Key 'W' @('ctrl');            Step "Ctrl+W    (closes P3)"
Key 'B';                      Step "type 'b'  -> focus in NEW active page?"
Key 'W' @('ctrl');            Step "Ctrl+W    (closes P2)"
Key 'C';                      Step "type 'c'  -> focus in NEW active page?"
Key 'T' @('ctrl', 'shift');   Step "Ctrl+Shift+T (restores a closed tab)"
Key 'D';                      Step "type 'd'  -> focus in RESTORED page?"
Key 'T' @('ctrl', 'shift');   Step "Ctrl+Shift+T again"
Key 'E';                      Step "type 'e'  -> focus in RESTORED page?"

# ---- Ctrl+J: page, and does a second press reuse the tab? ----
Key 'J' @('ctrl');            Step "Ctrl+J    (want: Downloads page)"
Key 'J' @('ctrl');            Step "Ctrl+J again"
Key 'W' @('ctrl');            Step "Ctrl+W    (one Downloads tab => a page title; two => still Downloads)"

# ---- landing on a New Tab page after Ctrl+W: is the omnibox focused (blue ring) or the page? ----
# Chrome appends a Ctrl+T tab at the END; close the tab to its left and its right neighbour (the New
# Tab page) becomes active.
Key 'T' @('ctrl');            Step "Ctrl+T    (new tab, appended at the end)"
Shot "ntp_created"
Key 'Tab' @('ctrl', 'shift'); Step "Ctrl+Shift+Tab (the tab to its left)"
Key 'W' @('ctrl');            Step "Ctrl+W    (closes it -> lands on the New Tab page)"
Shot "ntp_landed"
Key 'G';                      Step "type 'g'  (omnibox shows it if the omnibox has focus)"
Shot "ntp_after_typing"
Cleanup
"done"
