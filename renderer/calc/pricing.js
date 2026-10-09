// The calculator screen's price engine. It follows the ERP's Plan Maker (Mfg.Web planmaker.component + pricing.service.ts), step for step, but the numbers
// it works from are DUMMY ones, read from calc-data.json (PBCalc's data folder; defaults in electron/calcData.default.json). The real rate / discount tables are
// a SQL procedure (Mfg.API GetDiamondRate) and the ERP's pricing server; neither is in the repos, so they are not copied.
// Runs in the page (window.CalcPricing) and in Node (module.exports), so the tests can check it without a window. Call configure(data) first.
//
// The chain for ONE part and ONE lab (the ERP's, in the ERP's order):
//   rate        list $/ct = weight band base (colour D, clarity FL, round) x colour factor x clarity factor x shape factor x drift, rounded to 10
//   discount    % taken OFF the rate = lab base + shape group + grade points + fluorescence + sub-cut + depth + ratio
//               (the ERP's "Additional Discount" REPLACES it, and only for the labs in adDiscLabs: NONE and FC)
//   oAmount     original amount = (rate - rate x discount / 100) x polish weight
//   mfgLabour   a percentage of oAmount by amount range; a non-round shape pays fancyPercentage more on top
//   labLabour   the lab's certificate cost for that weight (per piece or per carat); 0 for NONE / FC
//   amount      net amount = (oAmount - mfgLabour - labLabour) / netDivisor (14 in the ERP)
//   pcAvg       oAmount / weight
//   lab AUTO    is GIA and NONE both priced, the higher amount wins (when both are above 0), as in the ERP
// The screen: Polish = sum of the part weights, Result (RtP) = Polish x 100 / stone (rough) weight, Total Polish = sum of the part amounts,
// Rough $/Ct. (Avg) = Total Polish / stone weight.
(function (root) {
  let D = null;                                                  // the data (calc-data.json)
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const r2 = (n) => Math.round(n * 100) / 100;
  const roundTo = (n, step) => Math.round(n / step) * step;
  const need = () => { if (!D) throw new Error("CalcPricing.configure(data) was not called"); return D; };

  function configure(data) { D = data; return api; }

  // ── the lists the wheels and chips are made from ──
  const shapes = () => need().shapes;
  const shapeOf = (code) => need().shapes.find((s) => s.code === code) || need().shapes[0];
  const groupOf = (code) => (shapeOf(code).group === "round" ? "round" : "fancy");
  const labsAll = () => ["AUTO"].concat(need().labs);
  const cpsNames = () => Object.keys(need().cps);
  const cpsTriple = (name) => (need().cps[name] || need().cps[Object.keys(need().cps)[0]]).slice();   // [cut, polish, symmetry]
  function presetOf(grades) { for (const n of cpsNames()) if (need().cps[n].every((g, i) => g === grades[i])) return n; return null; }
  // the sub-cuts the ERP offers for this shape and cut grade (none for FR / PR)
  const subCutsFor = (shape, cut) => need().subCuts.filter((s) => s.cut === cut && s.shapes.includes(shape));
  const adDiscApplies = (lab) => need().adDiscLabs.includes(lab);

  // ── rate ──
  function listRate(p, drift) {
    const d = need(), w = num(p.weight);
    if (!w) return 0;
    const bands = d.rate.weightBands.slice().sort((a, b) => a.from - b.from);   // a hand-edited calc-data.json need not be in order
    let base = bands[0].base;
    for (const b of bands) if (w >= b.from) base = b.base;
    const cf = d.rate.colorFactor[p.color], qf = d.rate.clarityFactor[p.clarity];
    return roundTo(base * (cf == null ? 1 : cf) * (qf == null ? 1 : qf) * shapeOf(p.shape).factor * (drift || 1), d.rate.roundTo || 10);
  }

  // ── discount (% off the rate) for one lab ──
  function discountOf(p, lab) {
    const d = need().discount;
    let pts = (d.byLab[lab] || 0) + (d.byShapeGroup[groupOf(p.shape)] || 0);
    const g = p.grades || cpsTriple(need().defaultCps);
    for (let i = 0; i < 3; i++) pts += (d.gradePoints[g[i]] || 0) * (d.gradeWeights[i] == null ? 1 : d.gradeWeights[i]);
    pts += d.fluorPoints[p.fluor] || 0;
    const sc = need().subCuts.find((s) => s.code === p.subCut);
    if (sc) pts += sc.adjust || 0;
    const depth = num(p.depth);
    if (depth && d.depth) {
      const out = depth < d.depth.min ? d.depth.min - depth : depth > d.depth.max ? depth - d.depth.max : 0;
      pts += Math.min(d.depth.maxPoints, out * d.depth.perPoint);
    }
    const ratio = num(p.ratio);
    if (ratio && d.ratio) {
      const range = groupOf(p.shape) === "round" ? d.ratio.roundIdeal : d.ratio.fancyIdeal[p.shape];
      if (range) {
        const out = ratio < range[0] ? range[0] - ratio : ratio > range[1] ? ratio - range[1] : 0;
        pts += Math.min(d.ratio.maxPoints, (out / 0.01) * d.ratio.perHundredth);
      }
    }
    return r2(pts);
  }

  // ── labour ──
  function mfgLabourOf(oAmount, shapeCode) {
    const range = need().mfgLabourPercents.find((r) => oAmount >= r.fromRange && oAmount <= r.toRange);
    if (!range) return 0;
    const base = (oAmount * range.roundPercentage) / 100;
    const v = groupOf(shapeCode) === "round" ? base : (base * (range.fancyPercentage || 0)) / 100 + base;
    return Math.round(v);
  }
  function labLabourOf(lab, shapeCode, wt) {
    if (!lab || need().adDiscLabs.includes(lab)) return 0;
    const c = need().labCosts.find((x) => x.lab.split(",").includes(lab) && (!x.shape || x.shape === "ALL" || x.shape.split(",").includes(shapeCode)) && wt >= x.fromWt && wt <= x.toWt);
    if (!c) return 0;
    return c.ratePer === "Carets" ? r2(c.amount * wt) : c.amount;
  }

  const EMPTY = { rate: 0, discount: 0, oAmount: 0, pcAvg: 0, mfgLabour: 0, labLabour: 0, amount: 0 };

  // one part, one lab (not AUTO)
  function priceLab(p, lab, drift) {
    const wt = num(p.weight), rate = listRate(p, drift);
    if (!wt || !rate) return { name: lab, ...EMPTY, rate };
    const useAd = num(p.adDisc) > 0 && adDiscApplies(lab);
    const discount = useAd ? r2(num(p.adDisc)) : discountOf(p, lab);
    const oAmount = r2((rate - (rate * discount) / 100) * wt);
    if (!(oAmount > 0)) return { name: lab, ...EMPTY, rate, discount };
    const mfgLabour = mfgLabourOf(oAmount, p.shape);
    const labLabour = labLabourOf(lab, p.shape, wt);
    // (a very cheap stone with an expensive lab would come out below 0: shown as 0)
    const amount = Math.max(0, r2((oAmount - mfgLabour - labLabour) / need().netDivisor));
    return { name: lab, rate, discount, oAmount, pcAvg: r2(oAmount / wt), mfgLabour, labLabour, amount };
  }

  // one part: the chosen lab (AUTO = the better of GIA and NONE) + what every lab would give
  function pricePart(p, drift) {
    const d = need(), wt = num(p.weight);
    const labs = d.labs.map((l) => priceLab(p, l, drift));
    const byName = (n) => labs.find((x) => x.name === n) || priceLab(p, n, drift);
    let used, res;
    if ((p.lab || d.defaultLab) === "AUTO") {
      const gia = byName("GIA"), none = byName("NONE");
      if (gia.amount > 0 && none.amount > 0) res = gia.amount >= none.amount ? gia : none;
      else res = gia.amount > 0 ? gia : none.amount > 0 ? none : gia;
      used = res.name;
    } else { used = p.lab; res = byName(used); }
    return { weight: wt, lab: used, rate: res.rate, discount: res.discount, oAmount: res.oAmount, pcAvg: res.pcAvg, mfgLabour: res.mfgLabour, labLabour: res.labLabour, amount: res.amount, labs };
  }

  // the whole screen: parts[] + stone (rough) weight
  function summary(parts, stoneWeight, drift) {
    const priced = parts.map((p) => pricePart(p, drift));
    const polish = priced.reduce((s, r) => s + r.weight, 0);
    const total = priced.reduce((s, r) => s + r.amount, 0);
    const stone = num(stoneWeight);
    const labs = need().labs.map((name, k) => { const t = priced.reduce((acc, r) => acc + r.labs[k].amount, 0); return { name, total: t, rough: stone ? t / stone : 0 }; });
    return { parts: priced, labs, polish, total, result: stone ? (polish * 100) / stone : 0, rough: stone ? total / stone : 0 };
  }

  const api = { configure, data: () => need(), shapes, shapeOf, groupOf, colors: () => need().colors, clarities: () => need().clarities, fluorescence: () => need().fluorescence, cuts: () => need().cuts,
    labsAll, labs: () => need().labs, cpsNames, cpsTriple, presetOf, subCutsFor, adDiscApplies, listRate, discountOf, mfgLabourOf, labLabourOf, priceLab, pricePart, summary, num };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CalcPricing = api;
})(typeof window !== "undefined" ? window : globalThis);
