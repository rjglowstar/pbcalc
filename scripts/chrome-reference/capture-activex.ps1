# Does Chrome's ACTIVE tab still show its close X when the strip is compressed?
# Launches Chrome with N tabs, finds the active (white) tab and reports the dark ink inside it:
# a favicon sits in the left half, the close X in the right half.
# Windows only; steals focus ~15s per count.   powershell -File capture-activex.ps1 -Counts 8,14,20,30
param([int[]]$Counts = @(8, 14, 20, 30), [int]$Width = 1200)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CX {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[CX]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
foreach ($n in $Counts) {
  $ud = Join-Path $env:TEMP ("chrome-ax-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
  $a = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--window-position=100,100", "--window-size=$Width,700", "--new-window")
  # real pages so the tabs have favicons, like a normal session
  for ($i = 0; $i -lt $n; $i++) { $a += "https://example.com/" }
  Start-Process $exe -ArgumentList $a
  Start-Sleep -Seconds 9
  $proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if (-not $proc) { Write-Output "tabs=$n NO_CHROME"; continue }
  $h = (Get-Process -Id $proc.ProcessId).MainWindowHandle
  [CX]::ShowWindow($h, 9) | Out-Null
  [CX]::SetWindowPos($h, [IntPtr](-1), 100, 100, $Width, 700, 0x0040) | Out-Null
  [CX]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 600
  [CX]::SetCursorPos(100 + [int]($Width / 2), 500) | Out-Null
  [CX]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CX]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 1500

  $bmp = New-Object System.Drawing.Bitmap $Width, 44
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(100, 100, 0, 0, $bmp.Size); $g.Dispose()
  # the active tab = the longest run of near-white on row 10
  $bestLen = 0; $bestAt = -1; $len = 0; $start = -1
  for ($x = 0; $x -lt $Width; $x++) {
    $c = $bmp.GetPixel($x, 10)
    if ($c.R -gt 248 -and $c.G -gt 248 -and $c.B -gt 248) { if ($len -eq 0) { $start = $x }; $len++; if ($len -gt $bestLen) { $bestLen = $len; $bestAt = $start } }
    else { $len = 0 }
  }
  # ink inside it, split into halves (favicon left, close X right)
  $leftInk = 0; $rightInk = 0; $mid = $bestAt + [int]($bestLen / 2)
  for ($x = $bestAt; $x -lt ($bestAt + $bestLen); $x++) {
    for ($y = 12; $y -le 28; $y++) {
      $c = $bmp.GetPixel($x, $y)
      if (($c.R + $c.G + $c.B) -lt 520) { if ($x -lt $mid) { $leftInk++ } else { $rightInk++ } }
    }
  }
  Write-Output ("tabs=$n activeTabWidth=$bestLen leftInk=$leftInk rightInk=$rightInk")
  $bmp.Save((Join-Path $env:TEMP ("chrome-ax-" + $n + ".png")))
  $bmp.Dispose()
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}
Write-Output "DONE"
