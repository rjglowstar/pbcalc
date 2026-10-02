# At what tab width does Chrome stop drawing the separators between tabs?
# Launches Chrome with a few tab counts and counts the 2px separator bars in the strip.
# Windows only. Steals focus for ~15s per count.
#   powershell -File capture-seps.ps1 [-Counts 4,6,8,10,14]
param([int[]]$Counts = @(4, 6, 8, 10, 14), [switch]$NoFocus, [int]$Width = 1200)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CS2 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[CS2]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }

foreach ($n in $Counts) {
  $ud = Join-Path $env:TEMP ("chrome-seps-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
  $args = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--window-position=100,100", "--window-size=$Width,700", "--new-window")
  for ($i = 0; $i -lt $n; $i++) { $args += "about:blank" }
  Start-Process $exe -ArgumentList $args
  Start-Sleep -Seconds 7
  $proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if (-not $proc) { Write-Output "tabs=$n NO_CHROME"; continue }
  $h = (Get-Process -Id $proc.ProcessId).MainWindowHandle
  [CS2]::ShowWindow($h, 9) | Out-Null
  [CS2]::SetWindowPos($h, [IntPtr](-1), 100, 100, $Width, 700, 0x0040) | Out-Null
  if (-not $NoFocus) {
    [CS2]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 600
    [CS2]::SetCursorPos(100 + [int]($Width / 2), 500) | Out-Null
    [CS2]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CS2]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    # leave the window unfocused on purpose: an inactive Chrome window paints the strip differently
    Start-Sleep -Milliseconds 600
  }
  Start-Sleep -Milliseconds 1000

  $bmp = New-Object System.Drawing.Bitmap $Width, 44
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(100, 100, 0, 0, $bmp.Size); $g.Dispose()
  # separators: pixels that are the strip accent at BOTH y=14 and y=26 (the bar spans y12..28)
  $bars = 0; $inBar = $false; $first = -1
  for ($x = 40; $x -lt ($Width - 50); $x++) {
    $a = $bmp.GetPixel($x, 14); $b = $bmp.GetPixel($x, 26)
    $isSep = ($a.R -ge 150 -and $a.R -le 190 -and $a.B -ge 235 -and $b.R -ge 150 -and $b.R -le 190 -and $b.B -ge 235)
    if ($isSep -and -not $inBar) { $bars++; if ($first -lt 0) { $first = $x } }
    $inBar = $isSep
  }
  # active (white) tab width, as the width yardstick
  $w = 0
  for ($x = 0; $x -lt $Width; $x++) { $c = $bmp.GetPixel($x, 10); if ($c.R -gt 250 -and $c.G -gt 250 -and $c.B -gt 250) { $w++ } }
  $frame = $bmp.GetPixel($Width - 60, 20)
  Write-Output ("tabs=$n activeTabWidth=$w separatorBars=$bars firstBarX=$first frame=" + $frame.R + "," + $frame.G + "," + $frame.B)
  $out = Join-Path $env:TEMP ("chrome-seps-" + $n + "-" + $Width + ".png")
  $bmp.Save($out); Write-Output ("   saved " + $out)
  $bmp.Dispose()
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
}
Write-Output "DONE"
