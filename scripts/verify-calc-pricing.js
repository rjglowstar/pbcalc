// The calculator's price engine must do the ERP's Plan Maker calculation (Mfg.Web planmaker.component + pricing.service.ts), in the ERP's order, from the dummy data
// (electron/calcData.default.json, the file PBCalc copies to calc-data.json). Every expected number below is worked out BY HAND in this file from the data's numbers
// (not by calling the engine's own helpers), so a wrong formula cannot agree with itself.
// Run: node scripts/verify-calc-pricing.js
const fs = require("fs"), path = require("path");
const P = require("../renderer/calc/pricing.js");
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "electron", "calcData.default.json"), "utf8"));
P.configure(DATA);
let failed = 0, total = 0;
const check = (name, cond, extra) => { total++; if (!cond) failed++; console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra !== undefined ? "  <" + extra + ">" : "")); };
const near = (a, b) => Math.abs(a - b) < 0.0051;
const part = (o) => ({ weight: "0.5", shape: "RD", color: "D", clarity: "FL", fluor: "NON", adDisc: 0, grades: P.cpsTriple("3X"), subCut: "EX-ID", lab: "GIA", depth: "60", ratio: "1", ...o });

console.log("-- the default part, worked by hand: 0.5 ct RD D FL NON 3X ID, lab GIA, depth 60, ratio 1");
// rate: band 0.50 -> 4700 x colour D 1 x clarity FL 1 x shape RD 1 = 4700
// discount: GIA 30 + round 0 + grades 0 + NON 0 + ID 0 + depth 0 + ratio 0 = 30 %
// oAmount: (4700 - 4700 x 30 / 100) x 0.5 = 1645        mfgLabour: 1645 is in 1000..1999.99 -> 9 % = 148.05 -> 148      labLabour: GIA 0.5..0.99 = 60 per piece
// amount: (1645 - 148 - 60) / 14 = 102.642857 -> 102.64        pcAvg: 1645 / 0.5 = 3290
let r = P.pricePart(part());
check("rate 4700, discount 30 %", r.rate === 4700 && r.discount === 30, JSON.stringify(r));
check("original amount 1645, $/ct (pcAvg) 3290", r.oAmount === 1645 && r.pcAvg === 3290);
check("manufacturing labour 148 (9 % of 1645, rounded), lab cost 60", r.mfgLabour === 148 && r.labLabour === 60);
check("net amount (1645 - 148 - 60) / 14 = 102.64", r.amount === 102.64, r.amount);

console.log("-- the screen's four numbers (stone / rough weight 1.05)");
let s = P.summary([part()], "1.05");
check("Polish 0.50", near(s.polish, 0.5));
check("Result (RtP) = 0.5 x 100 / 1.05 = 47.62 %", near(s.result, 47.62), s.result);
check("Total Polish = the part's net amount 102.64", near(s.total, 102.64));
check("Rough $/Ct (Avg) = 102.64 / 1.05 = 97.75", near(s.rough, 97.75), s.rough);
s = P.summary([part(), part({ weight: "0.3" })], "1.05");
// second part 0.3 ct: rate band 0.30 = 2585 -> rounded to 10 = 2590; (2590 - 777) x 0.3 = 543.9; mfg 12 % (500..999.99) = 65.268 -> 65; GIA 0.30..0.49 = 35; (543.9 - 65 - 35) / 14 = 31.7071 -> 31.71
check("two parts: Polish 0.80, Total = 102.64 + 31.71", near(s.polish, 0.8) && near(s.total, 134.35), s.total);

console.log("-- the labs: the same part priced by every lab");
// IGI: discount 36 -> (4700 - 1692) x 0.5 = 1504; mfg 9 % = 135.36 -> 135; lab IGI 0.5..0.99 = 35; (1504 - 135 - 35) / 14 = 95.2857 -> 95.29
// HRD: 33 -> (4700 - 1551) x 0.5 = 1574.5; mfg 141.705 -> 142; lab 45; (1574.5 - 142 - 45) / 14 = 99.1071 -> 99.11
// NONE: 44 -> (4700 - 2068) x 0.5 = 1316; mfg 118.44 -> 118; lab 0; (1316 - 118) / 14 = 85.5714 -> 85.57
// FC: 48 -> (4700 - 2256) x 0.5 = 1222; mfg 109.98 -> 110; lab 0; (1222 - 110) / 14 = 79.4286 -> 79.43
const byLab = Object.fromEntries(r.labs.map((l) => [l.name, l]));
check("GIA 102.64, IGI 95.29, HRD 99.11", byLab.GIA.amount === 102.64 && byLab.IGI.amount === 95.29 && byLab.HRD.amount === 99.11, JSON.stringify(r.labs.map((l) => l.name + " " + l.amount)));
check("NONE 85.57, FC 79.43 (no lab cost)", byLab.NONE.amount === 85.57 && byLab.FC.amount === 79.43 && byLab.NONE.labLabour === 0 && byLab.FC.labLabour === 0);
check("choosing IGI gives IGI's numbers", P.pricePart(part({ lab: "IGI" })).amount === 95.29 && P.pricePart(part({ lab: "IGI" })).discount === 36);
check("AUTO takes the higher of GIA and NONE (here GIA 102.64 > NONE 85.57)", P.pricePart(part({ lab: "AUTO" })).lab === "GIA" && P.pricePart(part({ lab: "AUTO" })).amount === 102.64);
check("the lab row's rough per carat: GIA 97.75, NONE 81.50", near(P.summary([part()], "1.05").labs.find((l) => l.name === "GIA").rough, 97.75) && near(P.summary([part()], "1.05").labs.find((l) => l.name === "NONE").rough, 81.5));

console.log("-- Additional Discount: it REPLACES the discount, only for NONE / FC (the ERP's rule)");
// NONE with 20 %: (4700 - 940) x 0.5 = 1880; mfg 9 % = 169.2 -> 169; (1880 - 169) / 14 = 122.2143 -> 122.21
r = P.pricePart(part({ lab: "NONE", adDisc: 20 }));
check("NONE + 20 %: discount 20, original amount 1880, net 122.21", r.discount === 20 && r.oAmount === 1880 && r.amount === 122.21, JSON.stringify(r));
check("GIA ignores it (still discount 30, net 102.64)", P.pricePart(part({ lab: "GIA", adDisc: 20 })).amount === 102.64);
check("AUTO with 20 %: NONE (122.21) now beats GIA (102.64) and is chosen", P.pricePart(part({ lab: "AUTO", adDisc: 20 })).lab === "NONE" && P.pricePart(part({ lab: "AUTO", adDisc: 20 })).amount === 122.21);

console.log("-- a fancy shape pays more manufacturing labour, and has a shape factor and a fancy discount");
// OV 0.5: rate 4700 x 0.8 = 3760; discount GIA 30 + fancy 4 = 34 (ratio 1.4 is inside OV's 1.30..1.55); (3760 - 1278.4) x 0.5 = 1240.8
// mfg: 9 % = 111.672, fancy: 111.672 x 10 / 100 + 111.672 = 122.8392 -> 123; lab 60; (1240.8 - 123 - 60) / 14 = 75.5571 -> 75.56
r = P.pricePart(part({ shape: "OV", subCut: null, ratio: "1.4" }));
check("OV: rate 3760, discount 34, original 1240.8, mfg 123, net 75.56", r.rate === 3760 && r.discount === 34 && r.oAmount === 1240.8 && r.mfgLabour === 123 && r.amount === 75.56, JSON.stringify(r));
check("a ratio outside the shape's range costs discount points (OV 1.9: 1.55 -> 0.35 = 35 hundredths x 0.2 = 5 max)", P.pricePart(part({ shape: "OV", subCut: null, ratio: "1.9" })).discount === 39);

console.log("-- the fields really move the price");
const base = P.pricePart(part()).amount;
check("a worse clarity is cheaper", P.pricePart(part({ clarity: "SI1" })).amount < base);
check("a worse colour is cheaper", P.pricePart(part({ color: "J" })).amount < base);
check("lower cut / polish / symmetry (3V) takes more discount: 30 + 1.5 + 0.75 + 0.75 = 33", P.pricePart(part({ grades: P.cpsTriple("3V") })).discount === 33);
check("strong fluorescence (STG) takes 6 more points", P.pricePart(part({ fluor: "STG" })).discount === 36);
check("a sub-cut moves it: EX-1 +0.5, EX-2 +1, Excellent +3", P.pricePart(part({ subCut: "EX-1" })).discount === 30.5 && P.pricePart(part({ subCut: "EX-2" })).discount === 31 && P.pricePart(part({ subCut: "Excellent" })).discount === 33);
check("a depth far from ideal costs points (68: 4.5 over x 0.5 = 2.25)", P.pricePart(part({ depth: "68" })).discount === 32.25);
check("a heavier stone costs more per carat", P.pricePart(part({ weight: "1.2" })).rate > P.pricePart(part()).rate);
check("per-carat lab cost above 5 ct: GIA 5.5 ct = 60 x 5.5 = 330", P.pricePart(part({ weight: "5.5" })).labLabour === 330);

console.log("-- sub-cuts and presets, as in the ERP");
check("RD EX has EX-ID, EX-1..EX-5, Excellent; OV EX has all but EX-ID; FR / PR have none", P.subCutsFor("RD", "EX").map((x) => x.code).join() === "EX-ID,EX-1,EX-2,EX-3,EX-4,EX-5,Excellent" && P.subCutsFor("OV", "EX").map((x) => x.code).join() === "EX-1,EX-2,EX-3,EX-4,EX-5,Excellent" && P.subCutsFor("RD", "FR").length === 0);
check("CPS presets: 3X = EX EX EX, 2X = EX EX VG, VX = VG EX EX, 3V, GX = GD EX EX, 3G = GD VG VG, 3F = FR VG VG", ["3X:EX,EX,EX", "2X:EX,EX,VG", "VX:VG,EX,EX", "3V:VG,VG,VG", "GX:GD,EX,EX", "3G:GD,VG,VG", "3F:FR,VG,VG"].every((t) => P.cpsTriple(t.split(":")[0]).join() === t.split(":")[1]));
check("presetOf finds the preset, null for a custom mix", P.presetOf(["EX", "EX", "VG"]) === "2X" && P.presetOf(["EX", "GD", "VG"]) === null);
check("the lab list is AUTO + the data's labs", P.labsAll().join() === "AUTO,GIA,IGI,HRD,NONE,FC,JP-GIA,JP-IGI,JP-HRD,JP-NONE,JP-FC,OR-NONE");

console.log("-- empty screen shows zeros, never NaN");
s = P.summary([part({ weight: "" })], "");
check("no weight: everything 0", s.parts[0].rate === 0 && s.parts[0].amount === 0 && s.total === 0 && s.polish === 0 && s.result === 0 && s.rough === 0, JSON.stringify(s.total));
check("junk weight is read as empty", P.pricePart(part({ weight: "abc" })).rate === 0 && P.pricePart(part({ weight: "-3" })).rate === 0);
check("no stone weight: Result and Rough stay 0 while the part is priced", (() => { const x = P.summary([part()], ""); return x.result === 0 && x.rough === 0 && x.total === 102.64; })());

console.log("-- every combination prices without error (9 shapes x 10 colours x 12 clarities x 5 fluor x 7 CPS x 6 labs)");
let bad = 0, n = 0;
for (const sh of P.shapes()) for (const c of P.colors()) for (const q of P.clarities()) for (const f of P.fluorescence()) for (const pr of P.cpsNames()) for (const lab of P.labsAll()) {
  const sub = P.subCutsFor(sh.code, P.cpsTriple(pr)[0]);
  const x = P.pricePart(part({ shape: sh.code, color: c, clarity: q, fluor: f, grades: P.cpsTriple(pr), subCut: sub.length ? sub[0].code : null, lab }));
  n++;
  if (!Number.isFinite(x.amount) || !Number.isFinite(x.rate) || x.rate <= 0 || x.amount < 0) bad++;
}
check("all finite, rate above 0, a cheap stone with a lab never goes below 0 (" + n + " combinations)", bad === 0, bad);

console.log("-- the data file loader: a broken section falls back to the default one");
const { merge } = require("../electron/calcData.js");
let m = merge({ version: DATA.version, shapes: "oops", colors: ["X", "Y"], netDivisor: -3, cps: { A: [1, 2] }, labCosts: "no" }, DATA);
check("bad shapes / netDivisor / cps / labCosts -> the defaults", m.shapes.length === DATA.shapes.length && m.netDivisor === 14 && Object.keys(m.cps).length === 7 && m.labCosts.length === DATA.labCosts.length);
check("a good section of the user's file is kept (colours X, Y)", m.colors.join() === "X,Y");
let old = merge({ version: 1, shapes: [{ code: "RD", name: "ROUND", factor: 1 }], colors: ["X"], netDivisor: 10 }, DATA);
check("a file written by an older list version gets the new shape / colour lists, its other sections stay", old.shapes.length === DATA.shapes.length && old.colors.length === DATA.colors.length && old.netDivisor === 10);
check("nothing readable at all -> all defaults", JSON.stringify(merge(null, DATA)) === JSON.stringify(DATA));
check("a changed divisor in the data changes the result (netDivisor 7 doubles it: 205.29)", (() => { P.configure({ ...DATA, netDivisor: 7 }); const a = P.pricePart(part()).amount; P.configure(DATA); return near(a, 205.29); })());

console.log("PBCALC_CALCPRICING total=" + total + " failed=" + failed);
process.exit(failed ? 1 : 0);
