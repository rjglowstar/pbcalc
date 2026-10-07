# Measures Chrome's ZOOM BUBBLE ("25%  -  +  [Reset]" under the address bar) on a real Chrome so PBCalc can copy it:
#   frames after Ctrl+= (when it appears, how long it stays: auto-close), after Ctrl+0, at the 25% and 500% ends (disabled - / +),
#   after Ctrl+wheel, light and dark (-Dark). Frames are full-resolution crops of the window top: $env:TEMP\chromeref\zoom_<mode>_<step>_<ms>.png
# Usage: powershell -File capture-zoom.ps1 [-Dark]
# SAFETY: same as capture-keys.ps1 - it sends real keys, so it waits for 8s of idle, checks before EVERY key that the foreground window
# is the Chrome it launched and the mouse is where it was parked, and otherwise kills that Chrome and stops.
param([switch]$Dark)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CZ {
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
[CZ]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
$out = Join-Path $env:TEMP "chromeref"; New-Item -ItemType Directory -Force $out | Out-Null
$mode = if ($Dark) { "dark" } else { "light" }
function IdleSeconds { $l = New-Object CZ+LII; $l.cb = [Runtime.InteropServices.Marshal]::SizeOf($l); [CZ]::GetLastInputInfo([ref]$l) | Out-Null; return ([Environment]::TickCount - $l.t) / 1000 }
$waited = 0
while ((IdleSeconds) -lt 8 -and $waited -lt 90) { Start-Sleep -Seconds 2; $waited += 2 }
if ((IdleSeconds) -lt 8) { "ABORTED: the machine is in use (no 8s of idle within 90s)"; exit 2 }
$ud = Join-Path $env:TEMP ("chrome-zoom-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$a = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-position=100,100", "--window-size=1200,700", "--new-window", "data:text/html,<title>zoomtest</title><body style='font:20px sans-serif'>zoom test page")
if ($Dark) { $a += "--force-dark-mode" }
Start-Process $exe -ArgumentList $a
Start-Sleep -Seconds 9
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
$pid2 = $proc.ProcessId
function Cleanup { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function Hwnd { return (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).MainWindowHandle }
$h = Hwnd
[CZ]::ShowWindow($h, 9) | Out-Null
[CZ]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
[CZ]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
$parkX = 700; $parkY = 600
[CZ]::SetCursorPos($parkX, $parkY) | Out-Null
[CZ]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CZ]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
function Safe {
  $p = New-Object CZ+P; [CZ]::GetCursorPos([ref]$p) | Out-Null
  if ([CZ]::GetForegroundWindow() -ne (Hwnd) -or [Math]::Abs($p.x - $parkX) -gt 2 -or [Math]::Abs($p.y - $parkY) -gt 2) { "ABORTED: foreground window or mouse changed - no further keys sent"; Cleanup; exit 3 }
}
$VK = @{ ctrl = 0x11; plus = 0xBB; minus = 0xBD; zero = 0x30 }
function Key([string]$k, [string[]]$mods = @()) {
  Safe
  foreach ($m in $mods) { [CZ]::keybd_event([byte]$VK[$m], 0, 0, [UIntPtr]::Zero) }
  [CZ]::keybd_event([byte]$VK[$k], 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [CZ]::keybd_event([byte]$VK[$k], 0, 2, [UIntPtr]::Zero)
  foreach ($m in $mods[($mods.Count - 1)..0]) { if ($m) { [CZ]::keybd_event([byte]$VK[$m], 0, 2, [UIntPtr]::Zero) } }
}
function Frame($step, $ms) { Safe; $r = New-Object System.Drawing.Bitmap 1200, 160; $g = [System.Drawing.Graphics]::FromImage($r); $g.CopyFromScreen(100, 100, 0, 0, $r.Size); $g.Dispose(); $r.Save((Join-Path $out ("zoom_{0}_{1}_{2:0000}.png" -f $mode, $step, $ms))); $r.Dispose() }
# frames every ~250ms for $total ms from the moment the key was sent
function Burst($step, $total) { $t0 = [Environment]::TickCount; while (([Environment]::TickCount - $t0) -lt $total) { Frame $step ([Environment]::TickCount - $t0); Start-Sleep -Milliseconds 120 } }
Frame "00idle" 0
Key 'plus' @('ctrl'); Burst "01in110" 7000
Key 'plus' @('ctrl'); Burst "02in125" 1500            # a second press: does the timer restart?
Key 'zero' @('ctrl'); Burst "03reset" 1500
Key 'zero' @('ctrl'); Burst "04reset_at_100" 1500      # reset when already 100%: bubble?
for ($i = 0; $i -lt 9; $i++) { Key 'minus' @('ctrl'); Start-Sleep -Milliseconds 300 }   # 100 -> 25
Burst "05at25" 1500
for ($i = 0; $i -lt 17; $i++) { Key 'plus' @('ctrl'); Start-Sleep -Milliseconds 300 }   # 25 -> 500
Burst "06at500" 1500
Key 'zero' @('ctrl'); Start-Sleep -Milliseconds 800
# Ctrl+wheel up
Safe
[CZ]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero); [CZ]::mouse_event(0x800, 0, 0, 120, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [CZ]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
Burst "07wheel_up" 1500
Cleanup
"done -> $out (zoom_${mode}_*.png)"
