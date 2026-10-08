const { app, nativeTheme } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// "Updating PBCalc..." window that stays on screen while PBCalc is NOT running.
//
// ROOT CAUSE this answers (owner: "when the update runs PBCalc closes and opens again and the user has no idea whether it is working"):
// an update installs SILENTLY (updater.js: quitAndInstall(true, true) - the visible wizard asks "who should this be installed for" and
// wants administrator rights, measured). So from the moment PBCalc quits until the installer starts it again NOTHING is on screen: no
// window of ours exists (the program is gone) and a silent installer has none. The same gap showed as a flicker when the update was
// started at the next START after "Cancel": the browser window appeared, then vanished.
// A window can only outlive PBCalc if it belongs to ANOTHER process, so this starts a small separate Windows PowerShell process that draws
// the window with WinForms/GDI+ (powershell.exe is part of Windows 10/11; nothing to ship). It looks like PBCalc's update dialog
// (blue disc with the update arrow, the two version chips, light / dark like the browser) and shows what is REALLY happening, read from the
// processes: 1 "Closing PBCalc" (until the old PBCalc process is gone) -> 2 "Installing the new version" (while the installer process runs)
// -> 3 "Opening PBCalc again" (installer finished, new PBCalc not up yet) -> all three ticked and the window closes as soon as a NEW PBCalc
// process with a window exists (the old one's id is passed in, so it is never mistaken for the new one). It says so when the update did not
// finish (installer gone and PBCalc did not come back within `failAfter` seconds, or `giveUp` seconds passed) instead of staying for ever;
// the X closes it at any time and never stops the update. It only DISPLAYS: it installs nothing and talks to nobody.
//
// Traps found by measuring:
//  * the window MUST NOT be a plain child of PBCalc: a child spawned the usual way died the moment PBCalc exited (measured, also with
//    `detached`; and a `detached` powershell without a console ends at once), which is exactly when the window is needed. It is started through
//    `cmd /c start "" /b powershell ...`, after which it belongs to nobody and survives (measured: still alive after the parent quit);
//  * because of that PBCalc does not know the window's process id: the window writes its own id to "<script>.pid" and closes itself when
//    "<script>.stop" appears (close() makes that file) - no killing by id;
//  * the strings reach PowerShell as single-quoted literals (' doubled); the C# source uses no C# 6 syntax (Windows PowerShell 5.1
//    compiles it with C# 5); the script is a FILE (about 12 KB; as -EncodedCommand it is over the 32 KB command-line limit).
const ps = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const CSHARP = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

public class PbcUpdateForm : Form {
  public bool Dark;
  public string From = "", To = "", Head = "", Sub = "", FailHead = "", FailText = "", Note = "";
  public string[] StepTitle = new string[3];
  public string[] StepSub = new string[3];
  public int Step;
  public bool Failed;
  float t;
  Timer anim;
  bool hover, down;
  RectangleF btn = new RectangleF(480 - 32 - 104, 470 - 24 - 38, 104, 38);   // the Close button of the failure screen (drawn, not a control: a control clipped to a pill had jagged edges)
  Color bg, fg, muted, accent, accentHi, accentText, chip, chipNew, border, okc, okBg, warnc;

  public PbcUpdateForm() {
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    FormBorderStyle = FormBorderStyle.FixedDialog;
    MaximizeBox = false;
    MinimizeBox = true;
    StartPosition = FormStartPosition.CenterScreen;
    TopMost = true;
    Text = "PBCalc update";
    ClientSize = new Size(480, 470);
    anim = new Timer();
    anim.Interval = 33;
    anim.Tick += delegate { t += 0.033f; Invalidate(); };
  }

  // after the fields are set, before the window is shown
  public void Apply() {
    if (Dark) {
      bg = Color.FromArgb(0x3c, 0x3c, 0x3c); fg = Color.FromArgb(0xe8, 0xea, 0xed); muted = Color.FromArgb(0x9a, 0xa0, 0xa6);
      accent = Color.FromArgb(0x8a, 0xb4, 0xf8); accentHi = Color.FromArgb(0xae, 0xcb, 0xfa); accentText = Color.FromArgb(0x20, 0x21, 0x24);
      chip = Color.FromArgb(0x3c, 0x40, 0x43); chipNew = Color.FromArgb(0x46, 0x52, 0x69); border = Color.FromArgb(0x46, 0x48, 0x4c);
      okc = Color.FromArgb(0x81, 0xc9, 0x95); okBg = Color.FromArgb(0x3f, 0x57, 0x4a); warnc = Color.FromArgb(0xfd, 0xd6, 0x63);
    } else {
      bg = Color.White; fg = Color.FromArgb(0x20, 0x21, 0x24); muted = Color.FromArgb(0x5f, 0x63, 0x68);
      accent = Color.FromArgb(0x1a, 0x73, 0xe8); accentHi = Color.FromArgb(0x18, 0x5a, 0xbc); accentText = Color.White;
      chip = Color.FromArgb(0xf1, 0xf3, 0xf4); chipNew = Color.FromArgb(0xe8, 0xf0, 0xfe); border = Color.FromArgb(0xda, 0xdc, 0xe0);
      okc = Color.FromArgb(0x18, 0x80, 0x38); okBg = Color.FromArgb(0xdd, 0xf0, 0xe2); warnc = Color.FromArgb(0xb0, 0x60, 0x00);
    }
    BackColor = bg;
    anim.Start();
  }

  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  // The process is started with windowsHide (no console flash) and Windows then hides the FIRST window it shows too (measured: no window
  // for 27 s); showing it a second time makes it appear.
  protected override void OnShown(EventArgs e) { base.OnShown(e); ShowWindow(Handle, 5); Activate(); }

  public void ShowFailure() { Failed = true; TopMost = false; Invalidate(); }

  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    bool h = Failed && btn.Contains(e.Location);
    if (h != hover) { hover = h; Cursor = h ? Cursors.Hand : Cursors.Default; Invalidate(); }
  }
  protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); if (hover) { hover = false; Cursor = Cursors.Default; Invalidate(); } }
  protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); if (Failed && btn.Contains(e.Location)) { down = true; Invalidate(); } }
  protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); bool hit = down && btn.Contains(e.Location); down = false; if (hit) Close(); else Invalidate(); }
  protected override bool ProcessCmdKey(ref Message msg, Keys keyData) {
    if (Failed && (keyData == Keys.Enter || keyData == Keys.Escape)) { Close(); return true; }
    return base.ProcessCmdKey(ref msg, keyData);
  }

  static GraphicsPath Round(RectangleF r, float rad) {
    GraphicsPath p = new GraphicsPath();
    float d = rad * 2;
    if (d > r.Height) d = r.Height;
    if (d > r.Width) d = r.Width;
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }

  void Text2(Graphics g, string s, Font f, Color c, RectangleF r, StringAlignment h) {
    StringFormat sf = new StringFormat();
    sf.Alignment = h;
    sf.LineAlignment = StringAlignment.Near;
    sf.Trimming = StringTrimming.EllipsisWord;
    using (SolidBrush b = new SolidBrush(c)) g.DrawString(s, f, b, r, sf);
    sf.Dispose();
  }

  PointF Gl(float cx, float cy, float x, float y) { float s = 34f / 24f; return new PointF(cx + (x - 12f) * s, cy + (y - 12f) * s); }

  protected override void OnPaint(PaintEventArgs e) {
    Graphics g = e.Graphics;
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
    g.Clear(bg);
    int W = ClientSize.Width;
    float cx = W / 2f, cy = 72f;
    Color discA = Failed ? Color.FromArgb(0xf9, 0xab, 0x00) : accent;
    Color discB = Failed ? Color.FromArgb(0xe3, 0x74, 0x00) : accentHi;
    if (!Failed) {
      float ph = (t % 2.6f) / 2.6f;
      for (int k = 0; k < 2; k++) {
        float p = (ph + k * 0.5f) % 1f;
        float rad = 32f * (0.8f + 0.55f * p);
        int a = (int)(150 * (1f - p));
        using (Pen pen = new Pen(Color.FromArgb(a, accent), 2f)) g.DrawEllipse(pen, cx - rad, cy - rad, rad * 2, rad * 2);
      }
    }
    RectangleF d = new RectangleF(cx - 32, cy - 32, 64, 64);
    using (LinearGradientBrush lg = new LinearGradientBrush(d, discA, discB, 45f)) g.FillEllipse(lg, d);
    Color glyph = (Dark && !Failed) ? accentText : Color.White;
    using (SolidBrush gb = new SolidBrush(glyph)) {
      if (Failed) {
        g.FillRectangle(gb, cx - 2.5f, cy - 15f, 5f, 18f);
        g.FillEllipse(gb, cx - 3f, cy + 8f, 6f, 6f);
      } else {
        PointF[] arrow = new PointF[] { Gl(cx, cy, 11, 3), Gl(cx, cy, 13, 3), Gl(cx, cy, 13, 11.2f), Gl(cx, cy, 15.6f, 8.6f), Gl(cx, cy, 17, 10), Gl(cx, cy, 12, 15), Gl(cx, cy, 7, 10), Gl(cx, cy, 8.4f, 8.6f), Gl(cx, cy, 11, 11.2f) };
        g.FillPolygon(gb, arrow);
        PointF a1 = Gl(cx, cy, 5, 18), a2 = Gl(cx, cy, 19, 20);
        g.FillRectangle(gb, a1.X, a1.Y, a2.X - a1.X, a2.Y - a1.Y);
      }
    }
    Font hf = new Font("Segoe UI Semibold", 17f);
    Font sf = new Font("Segoe UI", 10.5f);
    Font tf = new Font("Segoe UI Semibold", 10.5f);
    Font df = new Font("Segoe UI", 9.5f);
    Font cf = new Font("Segoe UI Semibold", 9.5f);
    Text2(g, Failed ? FailHead : Head, hf, fg, new RectangleF(24, 122, W - 48, 34), StringAlignment.Center);
    if (Failed) {
      Text2(g, FailText, sf, muted, new RectangleF(48, 170, W - 96, 190), StringAlignment.Center);
      Color fill = down ? accentHi : (hover ? accentHi : accent);
      using (GraphicsPath bp = Round(btn, 19)) using (SolidBrush bb = new SolidBrush(fill)) g.FillPath(bb, bp);
      Font bf = new Font("Segoe UI Semibold", 10f);
      Text2(g, "Close", bf, accentText, new RectangleF(btn.X, btn.Y + 10, btn.Width, 20), StringAlignment.Center);
      bf.Dispose();
    } else {
      Text2(g, Sub, sf, muted, new RectangleF(24, 158, W - 48, 22), StringAlignment.Center);
      if (From.Length > 0 || To.Length > 0) {
        float w1 = From.Length > 0 ? g.MeasureString(From, cf).Width + 22 : 0, w2 = To.Length > 0 ? g.MeasureString(To, cf).Width + 22 : 0;
        float gap = (w1 > 0 && w2 > 0) ? 34 : 0;
        float x = cx - (w1 + gap + w2) / 2f, y = 190f;
        if (w1 > 0) {
          RectangleF r1 = new RectangleF(x, y, w1, 26);
          using (GraphicsPath p = Round(r1, 13)) { using (SolidBrush b = new SolidBrush(chip)) g.FillPath(b, p); using (Pen pn = new Pen(border)) g.DrawPath(pn, p); }
          Text2(g, From, cf, muted, new RectangleF(r1.X, r1.Y + 4, r1.Width, 20), StringAlignment.Center);
          x += w1;
        }
        if (gap > 0) {
          using (Pen ap = new Pen(muted, 2f)) { ap.EndCap = LineCap.Round; ap.StartCap = LineCap.Round; g.DrawLine(ap, x + 9, y + 13, x + gap - 9, y + 13); g.DrawLine(ap, x + gap - 14, y + 8, x + gap - 9, y + 13); g.DrawLine(ap, x + gap - 14, y + 18, x + gap - 9, y + 13); }
          x += gap;
        }
        if (w2 > 0) {
          RectangleF r2 = new RectangleF(x, y, w2, 26);
          using (GraphicsPath p = Round(r2, 13)) using (SolidBrush b = new SolidBrush(chipNew)) g.FillPath(b, p);
          Text2(g, To, cf, accent, new RectangleF(r2.X, r2.Y + 4, r2.Width, 20), StringAlignment.Center);
        }
      }
      for (int i = 0; i < 3; i++) {
        float top = 236f + i * 52f;
        RectangleF ic = new RectangleF(44, top + 4, 34, 34);
        bool done = i < Step, active = i == Step;
        if (done) {
          using (SolidBrush b = new SolidBrush(okBg)) g.FillEllipse(b, ic);
          using (Pen ck = new Pen(okc, 2.4f)) { ck.StartCap = LineCap.Round; ck.EndCap = LineCap.Round; ck.LineJoin = LineJoin.Round; g.DrawLines(ck, new PointF[] { new PointF(ic.X + 10, ic.Y + 17.5f), new PointF(ic.X + 15, ic.Y + 22.5f), new PointF(ic.X + 24, ic.Y + 12) }); }
        } else if (active) {
          using (SolidBrush b = new SolidBrush(chipNew)) g.FillEllipse(b, ic);
          using (Pen sp = new Pen(accent, 2.6f)) { sp.StartCap = LineCap.Round; sp.EndCap = LineCap.Round; g.DrawArc(sp, ic.X + 8, ic.Y + 8, 18, 18, (t * 300f) % 360f, 250f); }
        } else {
          using (Pen rp = new Pen(border, 2f)) g.DrawEllipse(rp, ic.X + 1, ic.Y + 1, 32, 32);
        }
        Color tc = (done || active) ? fg : muted;
        Text2(g, StepTitle[i], tf, tc, new RectangleF(92, top + 2, W - 92 - 40, 20), StringAlignment.Near);
        Text2(g, StepSub[i], df, muted, new RectangleF(92, top + 22, W - 92 - 40, 18), StringAlignment.Near);
      }
      // moving bar
      RectangleF track = new RectangleF(44, 408, W - 88, 6);
      using (GraphicsPath tp = Round(track, 3)) {
        using (SolidBrush b = new SolidBrush(chip)) g.FillPath(b, tp);
        g.SetClip(tp);
        if (Step >= 3) {
          using (SolidBrush b = new SolidBrush(okc)) g.FillRectangle(b, track);
        } else {
          float bw = track.Width * 0.32f;
          float pos = ((t * 0.7f) % 1.4f) - 0.2f;
          RectangleF blk = new RectangleF(track.X + pos * track.Width, track.Y, bw, track.Height);
          using (LinearGradientBrush lg = new LinearGradientBrush(new RectangleF(blk.X - 1, blk.Y, blk.Width + 2, blk.Height), accentHi, accent, 0f)) g.FillRectangle(lg, blk);
        }
        g.ResetClip();
      }
      Text2(g, Note, df, muted, new RectangleF(24, 430, W - 48, 20), StringAlignment.Center);
    }
    hf.Dispose(); sf.Dispose(); tf.Dispose(); df.Dispose(); cf.Dispose();
  }

  protected override void Dispose(bool disposing) { if (disposing && anim != null) anim.Dispose(); base.Dispose(disposing); }
}
`;

function buildScript(o) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
${CSHARP}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$oldPid = ${Number(o.oldPid) | 0}
$newName = ${ps(o.newName)}
$installerLike = ${ps(o.installerLike)}
$failAfter = ${Number(o.failAfter) || 40}
$giveUp = ${Number(o.giveUp) || 300}
$exe = ${ps(o.exe)}
$iconFile = ${ps(o.iconFile || o.exe)}
$stopFile = ${ps(o.stopFile)}
try { Set-Content -LiteralPath ($PSCommandPath + '.pid') -Value $PID } catch {}
$f = New-Object PbcUpdateForm
$f.Dark = ${o.dark ? "$true" : "$false"}
$f.From = ${ps(o.from || "")}
$f.To = ${ps(o.to || "")}
$f.Head = ${ps(o.title)}
$f.Sub = ${ps(o.to ? o.sub : o.subNoVersion)}
$f.Note = ${ps(o.note)}
$f.FailHead = ${ps(o.failTitle)}
$f.FailText = ${ps(o.failText)}
$f.StepTitle[0] = ${ps(o.steps[0][0])}; $f.StepSub[0] = ${ps(o.steps[0][1])}
$f.StepTitle[1] = ${ps(o.steps[1][0])}; $f.StepSub[1] = ${ps(o.steps[1][1])}
$f.StepTitle[2] = ${ps(o.steps[2][0])}; $f.StepSub[2] = ${ps(o.steps[2][1])}
try { if ($iconFile -like '*.ico') { $f.Icon = New-Object System.Drawing.Icon($iconFile) } else { $f.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconFile) } } catch {}
$f.Apply()
$start = Get-Date
$script:oldGone = $null
$script:installerSeen = $false
$script:doneAt = $null
$script:failShown = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.Add_Tick({
  $now = Get-Date
  $secs = ($now - $start).TotalSeconds
  if (Test-Path -LiteralPath $stopFile) { $timer.Stop(); $f.Close(); return }
  if ($script:failShown) { return }                 # the failure screen stays until the user closes it (or close() is asked for, above)
  if ($script:doneAt) { if (($now - $script:doneAt).TotalMilliseconds -gt 1100) { $timer.Stop(); $f.Close() }; return }
  if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) -and -not $script:oldGone) { $script:oldGone = $now }
  $new = Get-Process -Name $newName -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $oldPid -and $_.MainWindowHandle -ne [IntPtr]::Zero }
  $installer = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like $installerLike }
  if ($installer) { $script:installerSeen = $true }
  if ($new -and $script:oldGone) { $f.Step = 3; $script:doneAt = $now; return }
  if (-not $script:oldGone) { $f.Step = 0 }
  elseif ($script:installerSeen -and -not $installer) { $f.Step = 2 }
  else { $f.Step = 1 }
  $failed = ($secs -gt $giveUp)
  if ($script:oldGone -and -not $installer -and -not $new -and (($now - $script:oldGone).TotalSeconds -gt $failAfter)) { $failed = $true }
  if ($failed) { $script:failShown = $true; $f.ShowFailure() }
})
$timer.Start()
[void]$f.ShowDialog()
`;
}

const DEFAULTS = {
  newName: "PBCalc", installerLike: "PBCalc Setup*",
  title: "Updating PBCalc",
  sub: "", subNoVersion: "The new version is being installed.",
  note: "Please wait. PBCalc opens again by itself.",
  steps: [
    ["Closing PBCalc", "Open tabs are closed and are not restored."],
    ["Installing the new version", "This takes a few seconds."],
    ["Opening PBCalc again", "It opens by itself - nothing to do."],
  ],
  failTitle: "The update did not finish",
  failText: "PBCalc did not open again.\n\nPlease start PBCalc from the Start menu. If this keeps happening, ask the person who gave you PBCalc.",
};

// The window's title-bar / taskbar icon. The installed program's exe carries PBCalc's icon; a development run (npm start) runs Electron's exe,
// whose icon is Electron's (the owner saw "another project's icon"), so there assets/icon.ico is used.
function iconFile() {
  try {
    if (!app.isPackaged) { const ico = path.join(__dirname, "..", "assets", "icon.ico"); if (fs.existsSync(ico)) return ico; }
  } catch (_) {}
  return process.execPath;
}

// Starts the window. Returns { pid() , close(), file } or null if it could not be started.
//   pid()   the window's process id once it has started (null before), read from the file the window writes;
//   close() asks the window to close (used when the update turned out not to be needed) and removes its files.
// `o`: { from, to } version labels (optional); the rest of the overrides are for the tests (process names, timings).
function show(o = {}) {
  try {
    const sub = o.to ? "PBCalc " + o.to + " is being installed." : "";
    const tag = "pbcalc-update-ui-" + process.pid + "-" + Date.now();
    const file = path.join(os.tmpdir(), tag + ".ps1"), stopFile = file + ".stop", pidFile = file + ".pid";
    const script = buildScript({
      ...DEFAULTS, sub, exe: process.execPath, iconFile: iconFile(), oldPid: process.pid, dark: nativeTheme.shouldUseDarkColors, stopFile, ...o,
      from: o.from ? "v" + String(o.from).replace(/^v/i, "") : "", to: o.to ? "v" + String(o.to).replace(/^v/i, "") : "",
    });
    // UTF-8 with a BOM, which Windows PowerShell 5.1 needs to read it as UTF-8; the script deletes its own files when its window closes.
    const NL = String.fromCharCode(10);
    fs.writeFileSync(file, String.fromCharCode(0xfeff) + script + NL +
      "Remove-Item -LiteralPath $PSCommandPath, ($PSCommandPath + '.pid'), ($PSCommandPath + '.stop') -Force -ErrorAction SilentlyContinue" + NL);
    // cmd /c start "" /b ...: the window becomes independent of PBCalc (see the header). windowsVerbatimArguments + /s: the quotes below are cmd's own.
    const ps1 = (o.powershell || "powershell.exe") + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + file + '"';
    const child = spawn("cmd.exe", ["/d", "/s", "/c", '"start "" /b ' + ps1 + '"'], { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
    child.on("error", () => {});
    child.unref();
    return {
      file,
      pid() { try { const n = parseInt(fs.readFileSync(pidFile, "utf8").replace(/[^0-9]/g, ""), 10); return n > 0 ? n : null; } catch (_) { return null; } },
      close() {
        try { fs.writeFileSync(stopFile, "stop"); } catch (_) {}
        setTimeout(() => { for (const f of [file, stopFile, pidFile]) { try { fs.unlinkSync(f); } catch (_) {} } }, 3000).unref();
      },
    };
  } catch (_) { return null; }
}

module.exports = { show, buildScript, iconFile, DEFAULTS };
