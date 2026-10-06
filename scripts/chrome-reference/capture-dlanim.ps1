# Records Chrome's "download started" animation (the circled arrow that flies to the toolbar Downloads
# button) frame by frame, so its path, size, opacity and timing can be MEASURED and copied.
# Needs: node dlserver.js running (port 8126). Sends NO keys and NO mouse input.
# Usage: powershell -File capture-dlanim.ps1 [-DelayMs 9000] [-Seconds 9]
#   -> $env:TEMP\chromeref\dlanim\f_<index>_<ms>.png   (ms = time since recording started)
#
# WHAT WENT WRONG BEFORE (so it is not repeated), each measured:
#  * A fixed screen rectangle at (100,100) recorded the user's OWN window: Chrome had put its window on
#    the other monitor, and SetWindowPos(TOPMOST) does not take for a background process.
#  * PrintWindow (window-only capture) returned false for this browser window; not worth fighting.
#  * MainWindowHandle returned a hidden helper window.
# SO: wait for the browser window to settle, read ITS real rectangle, screen-grab exactly that, put the
# window on the non-primary monitor when there is one (nothing of the user's is usually there), and
# VERIFY the recording is Chrome: the tab-strip pixel must be Chrome's frame blue (D3E3FD) on every
# frame, else abort - a capture that silently records something else is worse than none.
param([string]$Base = "http://127.0.0.1:8126", [int]$DelayMs = 9000, [int]$Seconds = 9, [int]$Delay2Ms = 0, [int]$PreWaitSeconds = 0, [int]$PostSeconds = 3, [int]$ArmAfterMs = 0)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class DA {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  // the visible, browser-sized top-level window of a process
  public static IntPtr FindBrowserWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) { R r; GetWindowRect(h, out r); if (r.r - r.l >= 800 && r.b - r.t >= 400) { found = h; return false; } }
      return true; }, IntPtr.Zero);
    return found;
  }
  [StructLayout(LayoutKind.Sequential)] public struct R { public int l, t, r, b; }
}
"@
[DA]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
$out = Join-Path $env:TEMP "chromeref\dlanim"; New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -Filter *.png -ErrorAction SilentlyContinue | Remove-Item -Force

$scr = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1
if (-not $scr) { $scr = [System.Windows.Forms.Screen]::PrimaryScreen; "(only one monitor: your windows may cover the test browser; the verification below will say so)" }
$wx = $scr.Bounds.X + 100; $wy = $scr.Bounds.Y + 100
"test browser goes to monitor $($scr.DeviceName) at $wx,$wy"
$ud = Join-Path $env:TEMP ("chrome-dla-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
Start-Process $exe -ArgumentList @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows",
  "--window-position=$wx,$wy", "--window-size=1200,700", "--new-window", "$Base/dlpage?delay=$DelayMs&delay2=$Delay2Ms")
function Cleanup { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
function Pixel($x, $y) { $b = New-Object System.Drawing.Bitmap 1, 1; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($x, $y, 0, 0, $b.Size); $g.Dispose(); $c = $b.GetPixel(0, 0); $b.Dispose(); return $c }
# Chrome tab-strip colour in either state: active D3E3FD (211,227,253), inactive greyer (measured 221,227,233).
# Both are light and bluish; the user's white or dark windows are not.
function IsFrameBlue($c) { return ($c.R -ge 200 -and $c.B -ge 225 -and ($c.B - $c.R) -ge 8) }

# 1. wait for the window to exist AND SETTLE (it is moved after creation): same rectangle twice in a row
$h = [IntPtr]::Zero; $last = ""; $stable = 0; $r = New-Object DA+R; $sw = [Diagnostics.Stopwatch]::StartNew()
while ($stable -lt 8 -and $sw.Elapsed.TotalSeconds -lt 30) {
  $p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  $nh = [IntPtr]::Zero; if ($p) { $nh = [DA]::FindBrowserWindow([uint32]$p.ProcessId) }
  if ($nh -ne [IntPtr]::Zero) {
    $h = $nh; [DA]::GetWindowRect($h, [ref]$r) | Out-Null
    $now = "$($r.l),$($r.t),$($r.r),$($r.b)"
    if ($now -eq $last) { $stable++ } else { $stable = 0; $last = $now }
  }
  Start-Sleep -Milliseconds 150
}
if ($h -eq [IntPtr]::Zero -or $stable -lt 8) { "ABORTED: the Chrome window never settled"; Cleanup; exit 2 }
$W = $r.r - $r.l; $H = $r.b - $r.t
"window settled at ($($r.l),$($r.t)) ${W}x${H}"
# 2. wait until the screen at that rectangle really shows Chrome (frame blue in the tab strip, white page)
$ready = $false; $warm = [Diagnostics.Stopwatch]::StartNew()
while (-not $ready -and $warm.Elapsed.TotalSeconds -lt 15) {
  $strip = Pixel ($r.l + $W - 200) ($r.t + 12); $page = Pixel ($r.l + 600) ($r.t + 300)
  if ((IsFrameBlue $strip) -and $page.R -gt 240 -and $page.G -gt 240) { $ready = $true } else { Start-Sleep -Milliseconds 150 }
}
if (-not $ready) {
  "ABORTED: the screen at the window's rectangle does not show Chrome (tab strip=$($strip.R),$($strip.G),$($strip.B) page=$($page.R),$($page.G),$($page.B)); something covers it"
  Cleanup; exit 3
}
"verified: the rectangle shows Chrome (tab-strip frame blue + white page)"

# 2b. optionally let time pass first (e.g. to record only the SECOND download), then verify again
if ($PreWaitSeconds -gt 0) {
  "waiting $PreWaitSeconds s before recording"
  Start-Sleep -Seconds $PreWaitSeconds
  $strip = Pixel ($r.l + $W - 200) ($r.t + 12)
  if (-not ($strip.R -ge 200 -and $strip.B -ge 225 -and ($strip.B - $strip.R) -ge 8)) { "ABORTED: after the wait the window no longer shows Chrome (tab-strip pixel is now $($strip.R),$($strip.G),$($strip.B))"; Cleanup; exit 3 }
}
# NOTE: PowerShell variables are case-insensitive. This used to be named $base, which collided with the typed
# [string]$Base URL parameter: assigning $null to it gives "" (not null), so the trigger fired on the very first
# frame and indexed the URL string for its baseline. Hence $baseline.
# 3. record, TRIGGERED BY THE EVENT. A fixed schedule kept missing the second download (startup and page
# load vary run to run), so: keep a rolling ~1 s ring buffer of frames, watch a few pixels in the column
# the flight travels (the Downloads button's column, below the toolbar), and when they change keep the ring
# plus the next $PostSeconds. $Seconds is only how long to wait for the event.
$rx = 900; $ry = 0; $rw = 200; $rh = 640     # tall and narrow: the flight starts well below the toolbar
$probe = @(@(73, 200), @(73, 280), @(73, 360), @(73, 440), @(73, 520), @(73, 600))
$ring = New-Object System.Collections.Queue
$post = New-Object System.Collections.ArrayList
$baseline = $null; $trigger = -1
$t0 = [Diagnostics.Stopwatch]::StartNew(); $bad = 0
while ($t0.Elapsed.TotalSeconds -lt $Seconds) {
  $b = New-Object System.Drawing.Bitmap $rw, $rh
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($r.l + $rx, $r.t + $ry, 0, 0, $b.Size); $g.Dispose()
  # every frame must still be Chrome: the tab strip (crop x=60 is window x=960, plain strip)
  if (IsFrameBlue ($b.GetPixel(60, 12))) { $bad = 0 } else { $bad++ }
  if ($bad -ge 5) { $b.Dispose(); Cleanup; "ABORTED at $([int]$t0.Elapsed.TotalMilliseconds) ms: the tab strip stopped looking like Chrome (something covered the window); discard"; exit 4 }
  $ms = [int]$t0.Elapsed.TotalMilliseconds
  # the first download (icon appears, ring starts) shifts the toolbar and must not fire the trigger: only
  # arm after $ArmAfterMs, taking the baseline then
  if ($null -eq $baseline -and $ms -ge $ArmAfterMs) { $baseline = @(); foreach ($p in $probe) { $baseline += $b.GetPixel($p[0], $p[1]) } }
  if ($trigger -lt 0) {
    [void]$ring.Enqueue(@{ ms = $ms; bmp = $b })
    if ($ring.Count -gt 60) { $old = $ring.Dequeue(); $old.bmp.Dispose() }
    if ($null -ne $baseline) {
      for ($k = 0; $k -lt $probe.Count; $k++) {
        $c = $b.GetPixel($probe[$k][0], $probe[$k][1]); $d = $baseline[$k]
        if ([math]::Abs($c.R - $d.R) + [math]::Abs($c.G - $d.G) + [math]::Abs($c.B - $d.B) -gt 30) { $trigger = $ms; "trigger detail: probe=($($probe[$k][0]),$($probe[$k][1])) now=$($c.R),$($c.G),$($c.B) baseline=$($d.R),$($d.G),$($d.B) armAfter=$ArmAfterMs at ms=$ms"; break }
      }
    }
  } else {
    [void]$post.Add(@{ ms = $ms; bmp = $b })
    if ($ms - $trigger -ge ($PostSeconds * 1000)) { break }
  }
}
Cleanup
if ($trigger -lt 0) { foreach ($f in $ring) { $f.bmp.Dispose() }; "no animation seen in $Seconds s (the probe column never changed)"; exit 5 }
$all = New-Object System.Collections.ArrayList; foreach ($f in $ring) { [void]$all.Add($f) }; foreach ($f in $post) { [void]$all.Add($f) }
$first = $all[0].ms
"triggered at $trigger ms; saving $($all.Count) frames ($([int]($trigger - $first)) ms before the trigger, $([int]($all[$all.Count - 1].ms - $trigger)) ms after); crop x=$rx y=$ry ${rw}x${rh} of the window"
$i = 0
foreach ($f in $all) { $f.bmp.Save((Join-Path $out ("f_{0:D4}_{1}.png" -f $i, ($f.ms - $first)))); $f.bmp.Dispose(); $i++ }
"saved to $out"
