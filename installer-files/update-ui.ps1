param([string]$To = '', [string]$From = '', [string]$Exe = '', [string]$Dark = 'auto', [string]$NewName = 'PBCalc', [string]$InstallerLike = 'PBCalc Setup*')

$ErrorActionPreference = 'SilentlyContinue'
# one window only (PBCalc's own and the installer's may start at the same moment): the first one holds a lock file until its process ends. NOT decided by the
# window title: PBCalc's own update dialog (a real PBCalc process) has the same title, and nothing here may ever look at - or stop - PBCalc itself.
try { $script:lock = [System.IO.File]::Open((Join-Path $env:TEMP 'pbcalc-update-ui.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Remove-Item -LiteralPath $PSCommandPath, ($PSCommandPath + '.pid'), ($PSCommandPath + '.stop'), ($PSCommandPath + '.state') -Force -ErrorAction SilentlyContinue; exit }
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'

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
  const int TITLE = 34;
  bool hover, down;
  RectangleF btn = new RectangleF(480 - 32 - 104, 470 - 24 - 38, 104, 38);   // the Close button of the failure screen (drawn, not a control: a control clipped to a pill had jagged edges)
  Color bg, fg, muted, accent, accentHi, accentText, chip, chipNew, border, okc, okBg, warnc;

  public PbcUpdateForm() {
    SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
    // The system title bar cannot show the icon WITHOUT its minimize / maximize / close buttons (owner's screenshot: a half icon over the title
    // text), so the window has no system frame and draws its own title strip: PBCalc's icon, then "PBCalc update" (TITLE px high).
    FormBorderStyle = FormBorderStyle.None;
    // No minimize / maximize / close buttons: while an update runs there is nothing the user could usefully do with them, and hiding the window
    // would bring back "nothing is happening". The window stays on top, and a close request from the user (Alt+F4, the taskbar) is refused below
    // until the failure screen shows - that screen has its own Close button (and Enter / Esc).
    MaximizeBox = false;
    MinimizeBox = false;
    StartPosition = FormStartPosition.CenterScreen;
    TopMost = true;
    Text = "PBCalc update";
    ClientSize = new Size(480, 470 + TITLE);
    anim = new Timer();
    anim.Interval = 33;
    anim.Tick += delegate { t += 0.033f; Invalidate(); };
  }

  protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.ClassStyle |= 0x20000; return cp; } }   // CS_DROPSHADOW: a borderless window gets Windows' shadow

  // the title strip is the window's handle for dragging it
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x84) {   // WM_NCHITTEST
      int v = m.LParam.ToInt32();
      Point pt = PointToClient(new Point((short)(v & 0xFFFF), (short)((v >> 16) & 0xFFFF)));
      if (pt.Y >= 0 && pt.Y < TITLE && pt.X >= 0 && pt.X < ClientSize.Width) { m.Result = (IntPtr)2; return; }   // HTCAPTION
    }
    base.WndProc(ref m);
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
  [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, int step, IntPtr brush, int flags);
  // The process is started with windowsHide (no console flash) and Windows then hides the FIRST window it shows too (measured: no window
  // for 27 s); showing it a second time makes it appear.
  protected override void OnShown(EventArgs e) { base.OnShown(e); ShowWindow(Handle, 5); Activate(); }

  // Form.Close() called from code ALSO reports CloseReason.UserClosing (measured: the window refused to close itself), so the code's own closes go
  // through CloseNow() and only a close nobody asked for is refused.
  bool allowClose;
  public void CloseNow() { allowClose = true; Close(); }
  protected override void OnFormClosing(FormClosingEventArgs e) {
    if (!Failed && !allowClose && e.CloseReason != CloseReason.WindowsShutDown) { e.Cancel = true; return; }
    base.OnFormClosing(e);
  }

  public void ShowFailure() { Failed = true; TopMost = false; Invalidate(); }

  protected override void OnMouseMove(MouseEventArgs e) {
    base.OnMouseMove(e);
    bool h = Failed && btn.Contains(e.X, e.Y - TITLE);
    if (h != hover) { hover = h; Cursor = h ? Cursors.Hand : Cursors.Default; Invalidate(); }
  }
  protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); if (hover) { hover = false; Cursor = Cursors.Default; Invalidate(); } }
  protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); if (Failed && btn.Contains(e.X, e.Y - TITLE)) { down = true; Invalidate(); } }
  protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); bool hit = down && btn.Contains(e.X, e.Y - TITLE); down = false; if (hit) Close(); else Invalidate(); }
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
    // title strip: PBCalc's icon first, then the title
    // Drawn with Windows' own DrawIconEx: GDI+ (Icon.ToBitmap / DrawIcon) turned PBCalc's icon file into coloured noise (measured), Windows draws it right
    if (Icon != null) {
      using (Icon small = new Icon(Icon, 16, 16)) {
        IntPtr dc = g.GetHdc();
        try { DrawIconEx(dc, 12, (TITLE - 16) / 2, small.Handle, 16, 16, 0, IntPtr.Zero, 3); } finally { g.ReleaseHdc(dc); }
      }
    }
    using (Font tfont = new Font("Segoe UI", 9f)) Text2(g, "PBCalc update", tfont, fg, new RectangleF(36, (TITLE - 16) / 2f - 1, W - 48, 18), StringAlignment.Near);
    g.TranslateTransform(0, TITLE);   // everything below was laid out for a window without the strip
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
    g.ResetTransform();
    using (Pen bp2 = new Pen(border)) g.DrawRectangle(bp2, 0, 0, W - 1, ClientSize.Height - 1);
  }

  protected override void Dispose(bool disposing) { if (disposing && anim != null) anim.Dispose(); base.Dispose(disposing); }
}

'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$newName = $NewName
$installerLike = $InstallerLike
$failAfter = 40
$giveUp = 300
$exe = $Exe
$iconFile = $Exe
$stopFile = (Join-Path $env:TEMP 'pbcalc-update-ui-installer.stop')
Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
# the PBCalc process(es) that exist NOW are the OLD program: the update window waits for them to go and is closed only by a DIFFERENT one with a window
$oldIds = @(Get-Process -Name $newName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
try { Set-Content -LiteralPath ($PSCommandPath + '.pid') -Value $PID } catch {}
$f = New-Object PbcUpdateForm
$f.Dark = ($Dark -eq 'dark' -or ($Dark -eq 'auto' -and ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue).AppsUseLightTheme -eq 0)))
$f.From = $From
$f.To = $To
$f.Head = 'Updating PBCalc'
$f.Sub = $(if ($To) { 'PBCalc ' + $To + ' is being installed.' } else { 'The new version is being installed.' })
$f.Note = 'Please wait. PBCalc opens again by itself.'
$f.FailHead = 'The update did not finish'
$f.FailText = 'PBCalc did not open again.

Please start PBCalc from the Start menu. If this keeps happening, ask the person who gave you PBCalc.'
$f.StepTitle[0] = 'Closing PBCalc'; $f.StepSub[0] = 'Open tabs are closed and are not restored.'
$f.StepTitle[1] = 'Installing the new version'; $f.StepSub[1] = 'This takes a few seconds.'
$f.StepTitle[2] = 'Opening PBCalc again'; $f.StepSub[2] = 'It opens by itself - nothing to do.'
try { if ($iconFile -like '*.ico') { $f.Icon = New-Object System.Drawing.Icon($iconFile, 32, 32) } else { $f.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconFile) } } catch {}
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
  if (Test-Path -LiteralPath $stopFile) { $timer.Stop(); $f.CloseNow(); return }
  if ($script:failShown) { return }                 # the failure screen stays until the user closes it (or close() is asked for, above)
  if ($script:doneAt) { if (($now - $script:doneAt).TotalMilliseconds -gt 1100) { $timer.Stop(); $f.CloseNow() }; return }
  if (-not $script:oldGone -and -not ($oldIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })) { $script:oldGone = $now }
  $new = Get-Process -Name $newName -ErrorAction SilentlyContinue | Where-Object { $oldIds -notcontains $_.Id -and $_.MainWindowHandle -ne [IntPtr]::Zero }
  $installer = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like $installerLike }
  if ($installer) { $script:installerSeen = $true }
  if ($new -and $script:oldGone) { $f.Step = 3; $script:doneAt = $now; return }
  if (-not $script:oldGone) { $f.Step = 0 }
  elseif ($script:installerSeen -and -not $installer) { $f.Step = 2 }
  else { $f.Step = 1 }
  $failed = ($secs -gt $giveUp)
  if ($script:oldGone -and -not $installer -and -not $new -and (($now - $script:oldGone).TotalSeconds -gt $failAfter)) { $failed = $true }
  if ($failed) { $script:failShown = $true; $f.ShowFailure(); try { Set-Content -LiteralPath ($PSCommandPath + '.state') -Value 'failed' } catch {} }   # (the tests wait for this file before they press a key)
})
$timer.Start()
[void]$f.ShowDialog()

