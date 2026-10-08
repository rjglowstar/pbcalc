// The dummy price engine must reproduce the numbers in the owner's iPad recording (Screen Recording ... 07-10-2026 at 1.38.07 PM.mp4).
// Run: node scripts/verify-calc-pricing.js
const P = require("../renderer/calc/pricing.js");
let failed = 0, total = 0;
const check = (name, cond, extra) => { total++; if (!cond) failed++; console.log("  .. " + (cond ? "ok " : "FAIL ") + name + (!cond && extra ? "  <" + extra + ">" : "")); };
const near = (a, b) => Math.abs(a - b) < 0.006;
const part = (o) => ({ weight: "0.5", shape: "ROUND", color: "D", clarity: "FL", fluor: "NON", discount: -30, grades: P.PRESETS["3EX"], ...o });

console.log("-- video: 0.5 ct ROUND D FL NON -30% 3EX");
let r = P.pricePart(part());
check("List 4700", r.list === 4700, r.list);
check("$/Ct 3290", r.net === 3290, r.net);
check("Total 1645", r.total === 1645, r.total);
console.log("-- video: wheels moved (clarity VS1 / VS2, colour F)");
r = P.pricePart(part({ color: "F", clarity: "VS1" }));
check("F VS1: List 2600, $/Ct 1820, Total 910", r.list === 2600 && r.net === 1820 && r.total === 910, JSON.stringify(r));
r = P.pricePart(part({ color: "F", clarity: "VS2" }));
check("F VS2: List 2200, $/Ct 1540, Total 770", r.list === 2200 && r.net === 1540 && r.total === 770, JSON.stringify(r));
console.log("-- video: summary with stone weight 1.05");
let s = P.summary([part()], "1.05");
check("Polish 0.50, Total Polish 1645", near(s.polish, 0.5) && s.total === 1645);
check("Result 47.62 %", near(s.result, 47.62), s.result);
check("Rough $/Ct 1566.67", near(s.rough, 1566.67), s.rough);
s = P.summary([part({ color: "F", clarity: "VS2" })], "1.05");
check("after F VS2: Total Polish 770, Rough $/Ct 733.33", s.total === 770 && near(s.rough, 733.33), JSON.stringify(s));
console.log("-- empty screen shows zeros, never NaN");
s = P.summary([part({ weight: "" })], "");
check("no weight: List 0, $/Ct 0, Total 0, Polish 0, Result 0, Rough 0", s.parts[0].list === 0 && s.parts[0].net === 0 && s.total === 0 && s.polish === 0 && s.result === 0 && s.rough === 0, JSON.stringify(s));
check("junk weight is read as empty", P.pricePart(part({ weight: "abc" })).list === 0 && P.pricePart(part({ weight: "-3" })).list === 0);
console.log("-- the wheels really move the price");
const base = P.pricePart(part()).net;
check("a worse clarity is cheaper", P.pricePart(part({ clarity: "SI1" })).net < base);
check("a worse colour is cheaper", P.pricePart(part({ color: "J" })).net < base);
check("another shape is cheaper than ROUND", P.pricePart(part({ shape: "PEAR" })).net < base);
check("a heavier stone costs more per carat", P.pricePart(part({ weight: "1.2" })).list > P.pricePart(part()).list);
check("a bigger discount (-35) gives a lower $/Ct than -30", P.pricePart(part({ discount: -35 })).net < base);
check("strong fluorescence lowers it", P.pricePart(part({ fluor: "STG" })).net < base);
check("lower cut/polish/symmetry lowers it", P.pricePart(part({ grades: P.PRESETS.GD })).net < base);
console.log("-- presets as in the video");
check("EX-VG = EX EX VG, GD = GD VG VG", P.PRESETS["EX-VG"].join() === "EX,EX,VG" && P.PRESETS.GD.join() === "GD,VG,VG");
check("presetOf finds the preset, null for a custom mix", P.presetOf(["EX", "EX", "VG"]) === "EX-VG" && P.presetOf(["EX", "GD", "VG"]) === null);
console.log("-- more than one part adds up");
s = P.summary([part(), part({ weight: "1" })], "3");
check("two parts: Polish 1.50, Total = sum", near(s.polish, 1.5) && s.total === s.parts[0].total + s.parts[1].total);
console.log("-- every combination prices without error (9 shapes x 10 colours x 9 clarities x 5 fluor x 4 presets)");
let bad = 0;
for (const sh of P.SHAPES) for (const c of P.COLORS) for (const q of P.CLARITIES) for (const f of P.FLUORS) for (const pr of P.PRESET_NAMES) {
  const x = P.pricePart(part({ shape: sh, color: c, clarity: q, fluor: f, grades: P.PRESETS[pr] }));
  if (!Number.isFinite(x.net) || x.net <= 0 || x.list <= 0) bad++;
}
check("all positive finite numbers", bad === 0, bad);
console.log("PBCALC_CALCPRICING total=" + total + " failed=" + failed);
process.exit(failed ? 1 : 0);
