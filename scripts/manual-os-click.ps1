# Helper for manual-os-click.js: performs the real OS mouse clicks it asks for.
param([string]$Channel)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[M]::SetProcessDPIAware() | Out-Null
$last = 0
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline -and -not (Test-Path (Join-Path $Channel "done_all"))) {
  $f = Join-Path $Channel "step.json"
  if (Test-Path $f) {
    try { $s = Get-Content $f -Raw | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 100; continue }
    if ($s.n -gt $last) {
      $last = $s.n
      [M]::SetCursorPos([int]$s.x, [int]$s.y) | Out-Null
      Start-Sleep -Milliseconds 350
      # SetCursorPos alone may not produce a real mouse-move message for the page; nudge by a pixel
      # and back so hover (mouseenter / :hover) registers exactly as if the user moved the mouse.
      [M]::mouse_event(1, 1, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 40
      [M]::mouse_event(1, [uint32]4294967295, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 100
      if ($s.mode -ne "move") {
        [M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
      }
      Set-Content (Join-Path $Channel ("done_" + $s.n)) "1"
    }
  }
  Start-Sleep -Milliseconds 100
}
