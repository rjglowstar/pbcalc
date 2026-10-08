// Dummy diamond price engine for the calculator screen. NOT real prices: made-up numbers in the shape of a price list, so the
// wheels change the result. The real PB price list is a SQL procedure (Mfg.API GetDiamondRate) and is deliberately not copied.
// Runs in the page (window.CalcPricing) and in Node (module.exports), so the test can check it without a window.
//
// Chain (matches the owner's recording): list $/ct (shape x colour x clarity x weight band)
//   net $/ct  = list x (1 + (discount + grade adjustment + fluorescence adjustment) / 100)
//   part total = net $/ct x part weight
//   Polish = sum of part weights, Total Polish = sum of part totals, Result % = Polish / stone weight, Rough $/Ct = Total Polish / stone weight.
(function (root) {
  const SHAPES = ["ROUND", "PEAR", "OVAL", "HEART", "EMERALD", "MARQUISE", "PRINCESS", "RADIANT", "CUSHION"];
  const COLORS = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];
  const CLARITIES = ["FL", "IF", "VVS1", "VVS2", "VS1", "VS2", "SI1", "SI2", "I1"];
  const FLUORS = ["NON", "FNT", "MED", "STG", "VSTG"];
  const GRADES = ["EX", "VG", "GD", "FR", "PR"];
  const PRESETS = { "3EX": ["EX", "EX", "EX"], "EX-VG": ["EX", "EX", "VG"], VG: ["VG", "VG", "VG"], GD: ["GD", "VG", "VG"] };   // cut, polish, symmetry
  const PRESET_NAMES = ["3EX", "EX-VG", "VG", "GD"];

  // round, 0.50-0.69 ct, list $/ct: rows = colours D..M, columns = clarities FL..I1
  const BASE = [
    [4700, 4100, 3700, 3300, 3000, 2650, 2300, 1950, 1500],
    [4400, 3900, 3500, 3150, 2850, 2550, 2250, 1900, 1450],
    [4100, 3700, 3300, 2950, 2600, 2200, 2000, 1750, 1350],
    [3700, 3400, 3050, 2750, 2450, 2100, 1900, 1700, 1300],
    [3300, 3050, 2750, 2500, 2250, 1950, 1800, 1600, 1250],
    [2900, 2700, 2450, 2250, 2050, 1850, 1700, 1500, 1150],
    [2550, 2400, 2200, 2050, 1900, 1700, 1550, 1400, 1050],
    [2250, 2150, 1950, 1850, 1700, 1550, 1400, 1250, 950],
    [2000, 1900, 1750, 1650, 1550, 1400, 1250, 1100, 850],
    [1800, 1700, 1600, 1500, 1400, 1250, 1150, 1000, 750],
  ];
  const SHAPE_MULT = { ROUND: 1, PEAR: 0.78, OVAL: 0.8, HEART: 0.72, EMERALD: 0.74, MARQUISE: 0.7, PRINCESS: 0.82, RADIANT: 0.76, CUSHION: 0.79 };
  // [from, multiplier]: the weight band a part falls in (>= from)
  const WEIGHT_BANDS = [[0, 0.3], [0.23, 0.38], [0.3, 0.55], [0.4, 0.72], [0.5, 1], [0.7, 1.3], [0.9, 1.55], [1, 2], [1.5, 2.6], [2, 3.4], [3, 4.6]];
  const GRADE_PTS = { EX: 0, VG: -1.5, GD: -3.5, FR: -6, PR: -10 };      // percentage points off the discount
  const GRADE_WEIGHT = [1, 0.5, 0.5];                                     // cut counts most, polish and symmetry half each
  const FLUOR_PTS = { NON: 0, FNT: -1, MED: -3, STG: -6, VSTG: -10 };

  const round = (n, step) => Math.round(n / step) * step;
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };

  // list $/ct for one part; 0 while the weight is empty (nothing to price yet)
  function listPrice(p, drift) {
    const w = num(p.weight);
    if (!w) return 0;
    const ci = Math.max(0, COLORS.indexOf(p.color)), qi = Math.max(0, CLARITIES.indexOf(p.clarity));
    let band = 1;
    for (const [from, m] of WEIGHT_BANDS) if (w >= from) band = m;
    return round(BASE[ci][qi] * (SHAPE_MULT[p.shape] || 1) * band * (drift || 1), 10);
  }

  function adjustment(p) {
    const g = p.grades || PRESETS["3EX"];
    let pts = 0;
    for (let i = 0; i < 3; i++) pts += (GRADE_PTS[g[i]] || 0) * GRADE_WEIGHT[i];
    return pts + (FLUOR_PTS[p.fluor] || 0);
  }

  // one part -> { list, net, total, weight }
  function pricePart(p, drift) {
    const list = listPrice(p, drift);
    const disc = Number.isFinite(+p.discount) ? +p.discount : 0;
    const net = list ? Math.round(list * (1 + (disc + adjustment(p)) / 100)) : 0;
    return { list, net, total: net * num(p.weight), weight: num(p.weight) };
  }

  // the whole screen: parts[] + stone weight
  function summary(parts, stoneWeight, drift) {
    const priced = parts.map((p) => pricePart(p, drift));
    const polish = priced.reduce((s, r) => s + r.weight, 0);
    const total = priced.reduce((s, r) => s + r.total, 0);
    const stone = num(stoneWeight);
    return {
      parts: priced,
      polish,
      total,
      result: stone ? (polish / stone) * 100 : 0,
      rough: stone ? total / stone : 0,
    };
  }

  // which preset (if any) a set of three grades equals
  function presetOf(grades) {
    for (const n of PRESET_NAMES) if (PRESETS[n].every((g, i) => g === grades[i])) return n;
    return null;
  }

  const api = { SHAPES, COLORS, CLARITIES, FLUORS, GRADES, PRESETS, PRESET_NAMES, listPrice, pricePart, summary, presetOf, adjustment, num };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CalcPricing = api;
})(typeof window !== "undefined" ? window : this);
