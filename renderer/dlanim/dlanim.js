// Chrome's "download started" flight: a 64px circle with the download glyph rises from the middle of the
// page to the toolbar Downloads button, getting more opaque and then fading out as it arrives.
//
// MEASURED from a real Chrome (capture-dlanim.ps1, 58 fps, light theme, 1200x700 window; see
// scripts/chrome-reference/README.md). t = ms since the download started; f = how far along the path
// from the start point to the button's centre; o = opacity of the whole circle.
//   - the circle is first visible ~35ms in (o 0.07) and rises almost linearly (~0.65 px/ms) ...
//   - ... its opacity climbs linearly to 0.93 by t=300 ...
//   - ... then it slows (~0.45 px/ms) and fades out, gone by ~t=500.
// The first half is measured frame by frame. The last ~200ms are read off the frames more coarsely (the
// downloads card was drawn over that part of the path in the recording), so t=366/451/500 carry more
// uncertainty (a few tens of ms) than the rest.
(function () {
  const DURATION = 520;
  const TIMELINE = [
    { t: 0,   f: 0,     o: 0 },
    { t: 12,  f: 0.025, o: 0 },
    { t: 34,  f: 0.071, o: 0.07 },
    { t: 134, f: 0.283, o: 0.39 },
    { t: 220, f: 0.490, o: 0.67 },
    { t: 300, f: 0.700, o: 0.93 },
    { t: 366, f: 0.799, o: 0.30 },
    { t: 451, f: 0.922, o: 0.13 },
    { t: 500, f: 1,     o: 0 },
    { t: DURATION, f: 1, o: 0 },
  ];
  const RADIUS = 32;           // the circle is 64px
  let anim = null;

  // fromY/toY: centre of the circle at the start / at the button, in this view's coordinates.
  window.__start = function (p) {
    const c = document.getElementById("c");
    document.body.classList.toggle("dark", !!p.dark);
    if (anim) { try { anim.cancel(); } catch (_) {} }
    const frames = TIMELINE.map((k) => ({
      offset: k.t / DURATION,
      opacity: k.o,
      transform: "translateY(" + (p.fromY + k.f * (p.toY - p.fromY) - RADIUS).toFixed(2) + "px)",
    }));
    anim = c.animate(frames, { duration: DURATION, easing: "linear", fill: "both" });
    window.__anim = anim;       // for tests: pause and set currentTime to inspect any moment
    return DURATION;
  };
  window.__timeline = TIMELINE;
  window.__duration = DURATION;
})();
