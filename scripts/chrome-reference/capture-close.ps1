# Measures what Chrome does to the OTHER tabs when one is closed with the mouse: do they widen at
# once, or stay put until the pointer leaves the strip? Needs many tabs so they are compressed.
# Windows only. Steals focus and moves the cursor for ~30s: do not use the machine meanwhile.
#   powershell -File capture-close.ps1
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CC {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[CC]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
$ud = Join-Path $env:TEMP ("chrome-close-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$chromeArgs = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--window-position=100,100", "--window-size=1200,700", "--new-window")
for ($i = 0; $i -lt 8; $i++) { $chromeArgs += "about:blank" }
Start-Process $exe -ArgumentList $chromeArgs
Start-Sleep -Seconds 8
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
if (-not $proc) { Write-Output "NO_CHROME"; exit 1 }
$h = (Get-Process -Id $proc.ProcessId).MainWindowHandle
[CC]::ShowWindow($h, 9) | Out-Null
[CC]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
[CC]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800
[CC]::SetCursorPos(700, 500) | Out-Null
[CC]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CC]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 1200

$bmp = New-Object System.Drawing.Bitmap 1200, 44
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
function Grab() { $gfx.CopyFromScreen(100, 100, 0, 0, $bmp.Size) }
# the ACTIVE tab (white) is the first one here; its width tells us the per-tab width
# the active tab is white: report where it starts and how wide it is
function ActiveRun() {
  $start = -1; $n = 0
  for ($x = 0; $x -lt 1200; $x++) {
    $c = $bmp.GetPixel($x, 10)
    if ($c.R -gt 250 -and $c.G -gt 250 -and $c.B -gt 250) { if ($start -lt 0) { $start = $x }; $n++ }
  }
  return "$start/$n"
}
function ActiveWidth() { return [int](ActiveRun).Split("/")[1] }
# make the LAST tab active (Ctrl+9): where it sits afterwards tells us exactly what happened —
# unchanged = nothing closed, shifted by a whole slot at the same width = Chrome froze the widths,
# shifted less and wider = the strip re-flowed at once.
[System.Windows.Forms.SendKeys]::SendWait("^9")
Start-Sleep -Milliseconds 900
Grab
$w0 = ActiveWidth
$run0 = ActiveRun
Write-Output "tabs=8 lastTabActive start/width=$run0 (pitch=$($w0 + 6))"

# hover tab 3 and click its close X. Slots are (stripWidth / 12) wide; the X sits ~14px from the
# slot's right edge, vertically centred at y=20.
$pitch = $w0 + 6                    # the white run is the BODY: the slot is 6px wider
$x3 = 48 + [int](2.5 * $pitch)      # middle of tab 3
$xClose = 48 + (3 * $pitch) - 14    # its close X sits ~14px from the slot's right edge
[CC]::SetCursorPos(100 + $x3, 100 + 20) | Out-Null
Start-Sleep -Milliseconds 400
[CC]::SetCursorPos(100 + $xClose, 100 + 20) | Out-Null
Start-Sleep -Milliseconds 400
[CC]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CC]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)

# cursor STAYS in the strip: sample for 1.2s
$sw = [Diagnostics.Stopwatch]::StartNew()
Write-Output "== closed tab 3 with the mouse; pointer STAYS in the strip (t_ms,start/width)"
$a = New-Object System.Collections.ArrayList
while ($sw.Elapsed.TotalMilliseconds -lt 1200) { Grab; [void]$a.Add("" + [int]$sw.Elapsed.TotalMilliseconds + "," + (ActiveRun)) }
$a | Select-Object -First 22 | ForEach-Object { Write-Output $_ }
Write-Output ("last=" + $a[$a.Count-1])

# now move the pointer OUT of the strip and sample again
[CC]::SetCursorPos(700, 500) | Out-Null
[CC]::SetCursorPos(701, 500) | Out-Null
$sw2 = [Diagnostics.Stopwatch]::StartNew()
Write-Output "== pointer leaves the strip (t_ms,start/width)"
$b = New-Object System.Collections.ArrayList
while ($sw2.Elapsed.TotalMilliseconds -lt 900) { Grab; [void]$b.Add("" + [int]$sw2.Elapsed.TotalMilliseconds + "," + (ActiveRun)) }
$b | ForEach-Object { Write-Output $_ }
Write-Output ("last=" + $b[$b.Count-1])

$gfx.Dispose(); $bmp.Dispose()
Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
Write-Output "DONE"
