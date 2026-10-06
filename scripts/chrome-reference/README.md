# Chrome reference measurements

The tab strip in `renderer/shell/` copies real Chrome (153, Windows, default theme) pixel for pixel.
These are the numbers and how they were obtained, so they can be re-measured when Chrome changes.

## Method
1. Start Chrome with a throw-away profile and N `about:blank` tabs (`capture-chrome.ps1` does all of
   this): `--user-data-dir=<temp> --no-first-run --window-position=100,100 --window-size=1200,700
   --new-window about:blank ...` (`--force-dark-mode` for dark). Make the window topmost and click into
   its page so it is active (an inactive window has different frame colours).
2. Screenshot the top 44 rows with `CopyFromScreen`, park / hover the cursor over a tab with
   `SetCursorPos` plus a 1px mouse nudge, then sample pixels (System.Drawing): colour runs along rows and
   columns, and the coverage of one colour over another for sub-pixel edges.
3. `measure.js` runs the same probes against PBCalc; `verify-ui.js` compares the two.

## Results (window px, 1200px window, first tab active)
| item | Chrome 153 |
|---|---|
| strip height / toolbar starts | 40 |
| tab search button | x14..42, y6..34, radius 8; bg ECF3FE (dark 3C3C3C), chevron 041E49 (dark D3E3FD) |
| slot pitch (max) | 238 -> body 232 wide, bodies 6px apart, first body at x=48 |
| active body | x48..280, y6..40, top radius 10, bottom flares radius ~12; FFFFFF (dark 3C3C3C) |
| hovered inactive tab | pill y6..34 (28 tall), radius 10 on all corners; A8C7FA (dark 004A77) |
| separators | 2x16 at y12..28 centred on the slot edge; A8C7FA (dark 3C3C3C); hidden beside the active / hovered tab; one also before + |
| + button | 28px circle, glyph 10px, 3px after the last slot; hover fill = the tab hover colour |
| content | favicon box 16 at +8 (ink 14), title from +32, close box 16 at right-8, 8px gaps |
| close X | ink 8x8; hover circle 16px, rgba(31,31,31,.155) (dark rgba(255,255,255,.155)) |
| text | 12px; active 1F1F1F / inactive 474747 (dark E3E3E3 / C7C7C7); favicon globe 5F6368 (dark 9AA0A6) |
| frame | D3E3FD (dark 1F2020) |
| tabs area | ends at x=969 in a 1200 window (a 62px draggable gap, then the window buttons, follow the + button) |

## How tabs shrink (body width w = pitch - 6)
* inactive: close X shown when w >= 84 (84 yes, 83 no); the title box ends 8px before the X (or before
  the edge); favicon always; title gone below w ~ 41
* active: X always; title box ends 8px before the X (gone when w < 65); favicon clipped where the X box
  starts minus 8 (gone when w < 41); minimum body 33
* pitch at 1200px for N tabs: 8 -> 116, 11 -> 84, 14 -> 66, 18 -> 52, 24 -> 39 (the tabs fill 924px)

## Animations (measured with `capture-anim.ps1` / `capture-close.ps1`, Chrome 153, light)

Frames of the tab strip were captured in a loop (~60/s) while Chrome opened, closed and hovered
tabs; each frame was reduced to one number (the active tab's white run: where it starts and how
wide it is, or one pixel's colour). The curves below are what those samples fit.

| what | duration | curve | how it was read |
|---|---|---|---|
| tab opens (new tab grows, others make room) | **200ms** | CSS `ease-out` | width 0 -> 221px; 25% of the time -> 44% of the width, 50% -> 72%, 75% -> 91% |
| tab closes (the others slide over) | **200ms** | CSS `ease-out` | active tab slid 860 -> 744px between t=16ms and t=215ms, same fit |
| tab hover fill D3E3FD -> A8C7FA | **175ms** | CSS `ease-out` | R channel 211 -> 168; 33% -> 53%, 52% -> 74%, 71% -> 88% |
| ...and back on leave | **185ms** | CSS `ease-in` | 30% -> 14%, 50% -> 33%, 70% -> 58% |
| widths after closing **with the pointer in the strip** | — | — | they do NOT change: 105px before and 105px for the whole 1.2s after |
| ...once the pointer leaves | **330ms pause, then 200ms** | CSS `ease-out` | nothing until t=326ms, then 744/105 -> 843/122 by t=527ms |

Implemented in `renderer/shell/shell.css` (`transition` on `.tab` flex-basis/min-width and on the
hover fills) and `renderer/shell/shell.js` (`growIn`, `collapseAway`, `lockTabWidths`,
`TAB_RELAYOUT_DELAY_MS`). `scripts/verify-tabs.js` asserts all of it.

Not measured yet: the toolbar buttons' own hover fade (the probe needs the button's real
coordinates - `capture-hover.ps1` sampled a pixel that stayed white). They currently reuse the tab
hover timing above.

## Many tabs (measured from the user's own 82-tab Chrome window, screenshots 56/58/59)

Measured by autocorrelating the tab-strip pixel row (the repeating unit IS the tab pitch) and by
finding the active tab's white body run:

| item | Chrome |
|---|---|
| tab limit | none — it keeps shrinking; 82 tabs were open in a 1919px window |
| inactive tab pitch at that count | **18px** (favicon only: no title, no close X) |
| active tab body | **32px** — the active tab stays wider than the compressed ones |
| overflow | the strip does NOT scroll; tabs compress instead |

PBCalc matches this with `min-width: 18px` on `.tab`, `min-width: 34px` on `.tab.active` (34 slot
-> 32px body) and the `@container tab (max-width: 40px)` rule that drops the body insets to 1px and
centres the favicon. `MAX_TABS` is now only a safety ceiling against a runaway `window.open`.
Verified in PBCalc at the same window size: 82 tabs -> inactive 20px, active body 32px, no scrolling.

## Narrow tabs: separators and the active tab's close button

| item | evidence |
|---|---|
| separators between tiny tabs | NONE in the user's real 82-tab window (17px pitch): the pixels between two tabs are pure frame colour. A clean Chrome launched by `capture-seps.ps1` **does** draw them even at 15px (38 separator columns at 20 tabs / 600px), so the two disagree — PBCalc follows the real-world window and hides them in narrow mode (<= 40px). |
| active tab, 36-48px | **X only, favicon dropped**. Two independent measurements: the reference table in `verify-ui.js` (pitch 47 and 39 -> favicon 0 / title 0 / X 1) and `capture-activex.ps1`, whose ASCII ink map shows a bare X glyph at 37px and at 28px with no hover. |
| active tab, at its floor (<= 35px) | favicon at rest, close X **on hover** (user's zoomed screenshots of their own 82-tab window). A clean Chrome measured here shows the X even at 28px, so the two disagree at this size only; PBCalc follows the real-world window. |
| active tab, wide | favicon AND close X (measured at 57px: left ink 112 = favicon, right ink 40 = X) |
| inactive close X | gone below ~84px (matches the earlier measurement) |

`capture-seps.ps1` (separator count per tab count / window width) and `capture-activex.ps1` (ink in
the active tab, split left/right) were written for this and can be re-run.

## Dark mode: browser UI vs web page (`capture-darkmode.ps1`)

A page served over HTTP (Chrome blocks top-level `data:` URLs) writes `prefers-color-scheme` and its
computed colours into its own title; the title is read back from the window, and the painted page is
sampled from the screen.

| Chrome | prefers-color-scheme | page canvas |
|---|---|---|
| default, light OS | false | 255,255,255 |
| `--force-dark-mode` (dark UI) | **true** | **255,255,255** |

So Chrome's dark UI DOES tell pages "dark" — but it still paints the canvas of a page that sets no
background WHITE. PBCalc matched the first half and not the second: Chromium painted that canvas
#3C3C3C (60,60,60 measured on screen), which made ordinary light sites look dark-themed. Fixed by
`view.setBackgroundColor("#ffffff")` on every tab in `tabManager.createTab`. Verified the same way:
PBCalc now paints 255,255,255 in both modes. Test: `scripts/verify-theme.js`.

## A download that opens a new tab (probe: what the tab looks like at `will-download`)

Chrome: a site's Download button does `window.open(url)` / `target=_blank`; a new tab flashes open, the
response turns out to be a file, the tab closes itself, the download carries on and you are back on the
page you were on. PBCalc left a blank tab behind. What the initiating tab looks like at the moment the
download starts, measured per scenario (Electron 41, probe in a harness; `wc` = the webContents passed to
`will-download`):

| how the download starts | `wc.getURL()` | `tab.url` | verdict |
|---|---|---|---|
| `target=_blank` link to a file | `""` | `""` | opened only for the download -> closes |
| `window.open(url)` of a file | `""` | `""` | closes |
| `target=_blank` link -> 302 -> file | `""` | `""` | closes |
| plain link on a page that is showing | the page's URL | the page's URL | stays |
| `window.open(url)` of a real page | (no download) | the page's URL | stays |

So the rule is exactly "nothing was ever committed in this tab" (`getURL()` is empty or `about:blank`):
`closeTabOpenedForDownload` in `tabManager.js`, called from the download manager. It never closes the last
tab, returns to the opener tab (not to the strip's last tab), and does not cancel the download (a slow
file finished in full after its tab closed). Test: `scripts/verify-download-tab.js`.

Not measured against real Chrome (the machine was in use, and the key-driven script refuses to run then):
whether Chrome waits for a Save As answer before closing in "ask where to save" mode. PBCalc waits.

## The "download started" animation (`capture-dlanim.ps1`, `dlserver.js`)

When a download starts Chrome flies a circled download arrow from the page up to the toolbar Downloads
button. Recorded frame by frame (58 fps, light theme, 1200x700 window, a 200x640 crop of the window along the
button's column) and analysed in Electron (`nativeImage`): difference from the frame before the download.
t = 0 is the circle's first visible frame (~35 ms after the download starts).

| what | measured |
|---|---|
| circle | **64x64**, centred on the Downloads button's column (window x 974.5 for that button) |
| glyph | the toolbar's own arrow-into-tray, ~25px wide, blue |
| light colours | fill ~ `#ECF1FA`, glyph ~ `#0B51B8` (read at 93% opacity: 237,242,250 / 28,93,189) |
| dark colours | fill ~ `#383A3E`, glyph white (sampled from the owner's dark-theme screenshot: 70,72,76 at ~93%) |
| start | ~46.5% of the way down the page area (window y ~372), at the button's x |
| motion | rises almost linearly at ~0.65 px/ms for ~270 ms, then ~0.45 px/ms; arrives at the button's centre |
| opacity | linear 0.07 -> 0.93 over the first ~270 ms, then fades to nothing by ~500 ms |
| positions (y of the centre, window px) | t=0: 350, 100: 284, 186: 221, 266: 156 (then read from frames: 332: ~125, 417: ~87) |
| when | **only when the Downloads button already exists** (a first download in a clean profile just fades the button in with its progress ring and opens the bubble; nothing flies). PBCalc's button is always present, so it flies every time |

The first ~270 ms are measured frame by frame; the last ~200 ms are read off the frames more coarsely, because
the downloads card was drawn over that part of the path in the recording (the circle passes under it), so
those numbers carry a few tens of ms of uncertainty. The user's dark-theme screenshot is consistent with the
light-theme timeline: its circle is at the same phase as the recording's frame at t=266.

**Capture traps, all hit while recording this** (they cost far more time than the measurement):
* A fixed screen rectangle recorded the OWNER'S OWN window (private content). Chrome had put its window on the
  second monitor, and `SetWindowPos(TOPMOST)` does not take from a background process. Never screen-grab a
  guessed rectangle: read the browser window's real rectangle, and VERIFY every frame is Chrome (the
  tab-strip pixel is Chrome's blue, active D3E3FD or inactive ~DDE3E9) or abort.
* `PrintWindow` (window-only capture) returned false for this window; not worth fighting.
* `Get-Process ...MainWindowHandle` returned a hidden helper window for Chrome. Enumerate the process's
  top-level windows and take the visible, browser-sized one.
* Chrome creates its window at the requested position and then moves it, so wait until the rectangle is stable.
* A PowerShell variable named `$base` collided with a typed `[string]$Base` parameter (names are
  case-insensitive; assigning `$null` to a typed string gives `""`), which made an "arm after N ms" trigger
  fire on the very first frame.
* A fixed recording schedule kept missing the second download (startup speed varies), so the script now keeps a
  ~1 s ring buffer and triggers on the flight itself.
Test of the implementation: `scripts/verify-dlanim.js` (renders the circle and compares with the table above).

## Reload button menu (Chrome 154, measured)

Real Chrome, throw-away profile, window on the second display, the toolbar's Reload button right-clicked with
real OS input (SetCursorPos + a one-pixel mouse nudge so Chromium sees the pointer, then right button down/up) and
the window captured with `CopyFromScreen`:

| Situation | Result |
|---|---|
| DevTools open (`--auto-open-devtools-for-tabs`) | a rounded menu hangs under the button, left edge aligned with it: **Normal Reload** `Ctrl+R`, **Hard Reload** `Ctrl+Shift+R`, **Empty Cache and Hard Reload** (no shortcut) |
| DevTools closed | nothing at all |

So the menu exists only while DevTools is open. PBCalc: `reloadMenu` in tabManager (also not while the button is Stop, never
in Restricted Mode); hard reload = `reloadIgnoringCache`, empty cache = `session.clearCache()` then hard reload; the
shortcuts Ctrl+Shift+R / Ctrl+F5 / Shift+F5 are the hard reload as in Chrome (they used to do a plain reload).
Not done: Chrome also opens the menu on a press-and-hold of the button (long press); only the right-click is built.
Test: `scripts/verify-reload-menu.js` (measures what each reload sends to a local server).
Traps found while measuring: PowerShell's `Move` is an alias of `Move-Item` (a helper named `Move` silently never moved
the pointer); the pointer must land on the right WINDOW (`WindowFromPoint`) or the clicks go to whatever covers it.
