# Does Chrome's DARK UI change what a web page sees (prefers-color-scheme) and how an unstyled
# page is painted? The test page writes its answers into the window TITLE, which we read back.
# Windows only. Steals focus for ~10s per case.   powershell -File capture-darkmode.ps1
param([string]$Url = "")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class DM {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[DM]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }

# A page with no styling at all: its canvas colour is whatever the UA decides.
# Chrome blocks top-level data: URLs, so the probe page is served over HTTP (see -Url).
$page = $Url

foreach ($case in @(@{name = "default (OS appearance)"; args = @() }, @{name = "--force-dark-mode (dark UI)"; args = @("--force-dark-mode") })) {
  $ud = Join-Path $env:TEMP ("chrome-dm-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
  $a = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--window-position=100,100", "--window-size=900,600", "--new-window") + $case.args + @($page)
  Start-Process $exe -ArgumentList $a
  Start-Sleep -Seconds 7
  $proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
  if (-not $proc) { Write-Output ($case.name + " : NO_CHROME"); continue }
  $p = Get-Process -Id $proc.ProcessId
  [DM]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
  [DM]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Seconds 2
  $p.Refresh()
  Write-Output ($case.name + " -> " + $p.MainWindowTitle)
  # also sample the page's painted background (below the toolbar)
  $bmp = New-Object System.Drawing.Bitmap 10, 10
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(500, 400, 0, 0, $bmp.Size); $g.Dispose()
  $c = $bmp.GetPixel(5, 5)
  Write-Output ("   painted page pixel: " + $c.R + "," + $c.G + "," + $c.B)
  $bmp.Dispose()
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}
Write-Output "DONE"
