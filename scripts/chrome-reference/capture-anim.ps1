# Measures Chrome's TAB STRIP ANIMATIONS (open, close, hover fade) by capturing frames.
# Windows only; needs Chrome installed. Steals focus and moves the cursor for ~40s: do not use the
# machine meanwhile.   Usage: powershell -File capture-anim.ps1 [-Dark]
# Prints one "t_ms,value" sample per frame per phase; measure.js / the README turn that into the
# duration and easing used by renderer/shell/shell.css.
param([switch]$Dark)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CA {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[CA]::SetProcessDPIAware() | Out-Null

$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
$ud = Join-Path $env:TEMP ("chrome-anim-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$chromeArgs = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-position=100,100", "--window-size=1200,700", "--new-window", "about:blank", "about:blank", "about:blank")
if ($Dark) { $chromeArgs += "--force-dark-mode" }
Start-Process $exe -ArgumentList $chromeArgs
Start-Sleep -Seconds 7
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
if (-not $proc) { Write-Output "NO_CHROME"; exit 1 }
$h = (Get-Process -Id $proc.ProcessId).MainWindowHandle
[CA]::ShowWindow($h, 9) | Out-Null
[CA]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
[CA]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
[CA]::SetCursorPos(700, 500) | Out-Null
[CA]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CA]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 900

$W = 1200
$bmp = New-Object System.Drawing.Bitmap $W, 44
$gfx = [System.Drawing.Graphics]::FromImage($bmp)

# width of the ACTIVE tab = the run of near-white (light mode) / #3C3C3C (dark) pixels on row $row,
# which is above the title text so the run is unbroken.
$row = 10
function Grab() { $gfx.CopyFromScreen(100, 100, 0, 0, $bmp.Size) }
function ActiveWidth() {
  $n = 0
  for ($x = 0; $x -lt $W; $x++) {
    $c = $bmp.GetPixel($x, $row)
    $isActive = if ($Dark) { $c.R -eq 60 -and $c.G -eq 60 -and $c.B -eq 60 } else { $c.R -gt 250 -and $c.G -gt 250 -and $c.B -gt 250 }
    if ($isActive) { $n++ }
  }
  return $n
}
function PixelAt($x, $y) { $c = $bmp.GetPixel($x, $y); return "$($c.R)-$($c.G)-$($c.B)" }

function Phase($name, $ms, $probe) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = New-Object System.Collections.ArrayList
  while ($sw.Elapsed.TotalMilliseconds -lt $ms) {
    Grab
    $t = [int]$sw.Elapsed.TotalMilliseconds
    $v = & $probe
    [void]$out.Add("$t,$v")
  }
  Write-Output "== $name"
  $out | ForEach-Object { Write-Output $_ }
}

# ── 1. opening a tab (Ctrl+T): the new tab grows from nothing ──
Grab
Write-Output "== baseline active width"
Write-Output (ActiveWidth)
[System.Windows.Forms.SendKeys]::SendWait("^t")
Phase "open (t_ms,activeTabWidthPx)" 1200 { ActiveWidth }

Start-Sleep -Milliseconds 900

# ── 2. closing that tab (Ctrl+W): it shrinks away ──
[System.Windows.Forms.SendKeys]::SendWait("^w")
Phase "close (t_ms,activeTabWidthPx)" 1200 { ActiveWidth }

Start-Sleep -Milliseconds 900

# ── 3. hover fade on an inactive tab: the pill colour fades in, then out ──
# tab 2 sits around x=300 in a 3-tab window; sample the middle of its body.
$hx = 400; $hy = 20
[CA]::SetCursorPos(100 + $hx, 100 + $hy) | Out-Null
[CA]::SetCursorPos(100 + $hx + 1, 100 + $hy) | Out-Null
Phase "hover-in (t_ms,R-G-B at tab2)" 700 { PixelAt $hx $hy }
[CA]::SetCursorPos(700, 500) | Out-Null
[CA]::SetCursorPos(701, 500) | Out-Null
Phase "hover-out (t_ms,R-G-B at tab2)" 700 { PixelAt $hx $hy }

$gfx.Dispose(); $bmp.Dispose()
Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
Write-Output "DONE"
