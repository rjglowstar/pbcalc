# How Chrome's tab strip degrades with MANY tabs: the inactive pitch, the active tab's width, and
# whether it keeps shrinking. Windows only. Steals focus for ~20s per count.
#   powershell -File capture-manytabs.ps1 [-Counts 20,40,60]
param([int[]]$Counts = @(20, 40, 60))
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CM {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[CM]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }

foreach ($n in $Counts) {
  $ud = Join-Path $env:TEMP ("chrome-many-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
  $a = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--window-position=100,100", "--window-size=1200,700", "--new-window")
  for ($i = 0; $i -lt $n; $i++) { $a += "about:blank" }
  Start-Process $exe -ArgumentList $a
  Start-Sleep -Seconds 9
  $proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if (-not $proc) { Write-Output "$n : NO_CHROME"; continue }
  $h = (Get-Process -Id $proc.ProcessId).MainWindowHandle
  [CM]::ShowWindow($h, 9) | Out-Null
  [CM]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
  [CM]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 700
  [CM]::SetCursorPos(700, 500) | Out-Null
  [CM]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CM]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 1200

  $bmp = New-Object System.Drawing.Bitmap 1200, 44
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(100, 100, 0, 0, $bmp.Size); $g.Dispose()
  # the active tab is white; the 2px separators between inactive tabs are the strip's accent colour
  $white = 0; $seps = New-Object System.Collections.ArrayList; $lastSep = -9
  $firstWhite = -1; $lastWhite = -1
  for ($x = 0; $x -lt 1200; $x++) {
    $c = $bmp.GetPixel($x, 10)
    if ($c.R -gt 250 -and $c.G -gt 250 -and $c.B -gt 250) { $white++; if ($firstWhite -lt 0) { $firstWhite = $x }; $lastWhite = $x }
    $c2 = $bmp.GetPixel($x, 20)
    if ($c2.R -ge 160 -and $c2.R -le 180 -and $c2.B -ge 243 -and $c2.G -ge 190 -and $c2.G -le 210) {
      if ($x - $lastSep -gt 3) { [void]$seps.Add($x) }
      $lastSep = $x
    }
  }
  $pitches = @()
  for ($i = 1; $i -lt $seps.Count; $i++) { $pitches += ($seps[$i] - $seps[$i - 1]) }
  $common = ($pitches | Group-Object | Sort-Object Count -Descending | Select-Object -First 1)
  Write-Output ("tabs=$n activeWidth=$white (x$firstWhite..$lastWhite) separators=" + $seps.Count + " pitch(mode)=" + $(if ($common) { "$($common.Name) x$($common.Count)" } else { "n/a" }) + " pitches=" + (($pitches | Select-Object -First 12) -join ","))
  $bmp.Dispose()
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}
Write-Output "DONE"
