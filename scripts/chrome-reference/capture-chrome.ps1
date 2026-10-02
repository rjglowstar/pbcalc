# Re-captures the Chrome reference (tab strip screenshots). Windows only; needs Chrome installed.
# Usage: powershell -File capture-chrome.ps1 [-Tabs 3] [-Dark]   -> PNGs in $env:TEMP\chromeref
# It makes the Chrome window topmost at (100,100) for a few seconds: do not use the machine meanwhile.
param([int]$Tabs = 3, [switch]$Dark)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CR {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
[CR]::SetProcessDPIAware() | Out-Null
$exe = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $exe)) { $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe" }
$out = Join-Path $env:TEMP "chromeref"; New-Item -ItemType Directory -Force $out | Out-Null
$ud = Join-Path $env:TEMP ("chrome-ref-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
$chromeArgs = @("--user-data-dir=$ud", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-position=100,100", "--window-size=1200,700", "--new-window")
if ($Dark) { $chromeArgs += "--force-dark-mode" }
for ($i = 0; $i -lt $Tabs; $i++) { $chromeArgs += "about:blank" }
Start-Process $exe -ArgumentList $chromeArgs
Start-Sleep -Seconds 7
$proc = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
$h = (Get-Process -Id $proc.ProcessId).MainWindowHandle
[CR]::ShowWindow($h, 9) | Out-Null
[CR]::SetWindowPos($h, [IntPtr](-1), 100, 100, 1200, 700, 0x0040) | Out-Null
[CR]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
# click into the page so the window is ACTIVE (inactive windows have different frame colours)
[CR]::SetCursorPos(700, 500) | Out-Null; [CR]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [CR]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 900
function Shot($name) {
  $b = New-Object System.Drawing.Bitmap 1200, 44
  $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(100, 100, 0, 0, $b.Size); $g.Dispose()
  $b.Save((Join-Path $out "$name.png")); $b.Dispose()
}
function Hover($x, $y) {
  [CR]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 150
  [CR]::mouse_event(1, 1, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
  [CR]::mouse_event(1, [uint32]4294967295, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 1600
}
$mode = if ($Dark) { "D" } else { "L" }
Hover 700 500; Shot "${mode}_rest"
Hover 480 122; Shot "${mode}_hover_tab2"
Hover 700 500
[CR]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0043) | Out-Null
Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$ud*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"saved to $out"
