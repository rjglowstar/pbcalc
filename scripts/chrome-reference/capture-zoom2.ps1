# Second pass on Chrome's ZOOM BUBBLE (see capture-zoom.ps1 for the first): what the buttons do and how they look on HOVER, what the
# bubble does when the mouse is inside / leaves, what clicking the zoom icon in the address bar does (opens the bubble, stays open?),
# what closes it (a click on the page, Esc). Light and dark (-Dark). Frames: $env:TEMP\chromeref\zoom2_<mode>_<step>_<ms>.png
# SAFETY: same rules as capture-keys.ps1 (waits for 8s of idle, checks the foreground window and that the mouse is where THIS script
# last put it before every key/click, kills its own Chrome and stops otherwise).
param([switch]$Dark)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CY {
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
[CY]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
$out = Join-Path $env:TEMP "chromeref"; New-Item -ItemType Directory -Force $out | Out-Null
$mode = if ($Dark) { "dark" } else { "light" }
function IdleSeconds { $l = New-Object CY+LII; $l.cb = [Runtime.InteropServices.Marshal]::SizeOf($l); [CY]::GetLastInputInfo([ref]$l) | Out-Null; return ([Environment]::TickCount - $l.t) / 1000 }
$waited = 0
while ((IdleSeconds) -lt 8 -and $waited -lt 90) { Start-Sleep -Seconds 2; $waited += 2 }
if ((IdleSeconds) -lt 8) { "ABORTED: the machine is in use (no 8s of idle within 90s)"; exit 2 }
$ud = Join-Path $env:TEMP ("chrome-zoom2-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$a = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-position=100,100", "--window-size=1200,700", "--new-window", "data:text/html,<title>zoomtest</title><body style='font:20px sans-serif'>zoom test page")
if ($Dark) { $a += "--force-dark-mode" }
Start-Process $exe -ArgumentList $a
Start-Sleep -Seconds 9
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
$pid2 = $proc.ProcessId
function Cleanup { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function Hwnd { return (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).MainWindowHandle }
$h = Hwnd
[CY]::ShowWindow($h, 9) | Out-Null
[CY]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
[CY]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
$script:mx = 700; $script:my = 600
[CY]::SetCursorPos($script:mx, $script:my) | Out-Null
[CY]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CY]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900
function Safe {
  $p = New-Object CY+P; [CY]::GetCursorPos([ref]$p) | Out-Null
  if ([CY]::GetForegroundWindow() -ne (Hwnd) -or [Math]::Abs($p.x - $script:mx) -gt 2 -or [Math]::Abs($p.y - $script:my) -gt 2) { "ABORTED: foreground window or mouse changed - no further input sent"; Cleanup; exit 3 }
}
function Move($x, $y) { Safe; [CY]::SetCursorPos($x, $y) | Out-Null; $script:mx = $x; $script:my = $y; Start-Sleep -Milliseconds 120 }
function Click { Safe; [CY]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [CY]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
$VK = @{ ctrl = 0x11; plus = 0xBB; minus = 0xBD; zero = 0x30; esc = 0x1B }
function Key([string]$k, [string[]]$mods = @()) {
  Safe
  foreach ($m in $mods) { [CY]::keybd_event([byte]$VK[$m], 0, 0, [UIntPtr]::Zero) }
  [CY]::keybd_event([byte]$VK[$k], 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
  [CY]::keybd_event([byte]$VK[$k], 0, 2, [UIntPtr]::Zero)
  foreach ($m in $mods[($mods.Count - 1)..0]) { if ($m) { [CY]::keybd_event([byte]$VK[$m], 0, 2, [UIntPtr]::Zero) } }
}
function Frame($step, $ms) { Safe; $r = New-Object System.Drawing.Bitmap 1200, 200; $g = [System.Drawing.Graphics]::FromImage($r); $g.CopyFromScreen(100, 100, 0, 0, $r.Size); $g.Dispose(); $r.Save((Join-Path $out ("zoom2_{0}_{1}_{2:0000}.png" -f $mode, $step, $ms))); $r.Dispose() }
function Burst($step, $total) { $t0 = [Environment]::TickCount; while (([Environment]::TickCount - $t0) -lt $total) { Frame $step ([Environment]::TickCount - $t0); Start-Sleep -Milliseconds 120 } }

# the 110% bubble sits at window x 732..987, y 80..131 (capture-zoom.ps1): minus (851,105), plus (883,105), Reset (938,105); the zoom icon is at (932,62)
$ox = 100; $oy = 100
Frame "00idle" 0
Key 'plus' @('ctrl'); Start-Sleep -Milliseconds 400
Move ($ox + 851) ($oy + 105); Burst "11hover_minus" 700     # mouse INSIDE the bubble: does it stay open?
Move ($ox + 883) ($oy + 105); Burst "12hover_plus" 500
Move ($ox + 938) ($oy + 105); Burst "13hover_reset" 500
Move ($ox + 760) ($oy + 105); Burst "13b_hover_text" 3000  # still inside after > 1.5s?
Move ($ox + 851) ($oy + 105); Click; Burst "14click_minus" 800   # -> 100%
Move ($ox + 883) ($oy + 105); Click; Burst "15click_plus" 800    # -> 110%
Move ($ox + 938) ($oy + 105); Click; Burst "16click_reset" 800   # Reset -> 100%: does the bubble stay or close?
Key 'plus' @('ctrl'); Start-Sleep -Milliseconds 400
Move $script:mx ($oy + 400); Move 700 600; Burst "17leave" 3500    # mouse leaves: closes after how long?
# the zoom icon in the address bar: click it
Start-Sleep -Milliseconds 2500
Move ($ox + 932) ($oy + 62); Burst "20icon_hover" 800
Click; Burst "21icon_click" 4000                           # opens the bubble - and does it stay?
Move 700 600; Burst "22move_away" 3000
Move ($ox + 932) ($oy + 62); Click; Burst "23icon_click2" 700
Move 700 600; Click; Burst "24click_page" 1000             # a click on the page: closes it?
Move ($ox + 932) ($oy + 62); Click; Start-Sleep -Milliseconds 500
Key 'esc'; Burst "25esc" 1000
Cleanup
"done -> $out (zoom2_${mode}_*.png)"
