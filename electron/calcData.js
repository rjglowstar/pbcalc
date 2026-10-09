const { app } = require("electron");
const fs = require("fs");
const path = require("path");

// The calculator's DUMMY data: every list (shapes, colours, clarities, fluorescence, cuts, sub-cuts, labs, CPS presets) and every table of the calculation
// (list rates, discounts, manufacturing labour, lab costs) lives in ONE json file in PBCalc's data folder: calc-data.json. The program writes it from
// calcData.default.json the first time (and whenever it is deleted), reads it again each time the calculator comes up, so editing it needs no new build.
// It is on the keep list in privacy.js (the wipe at exit must not delete it).
// A section that is missing or has the wrong shape is replaced by the default one, so a typo in the file can never leave the calculator without data.
const DEFAULT_FILE = path.join(__dirname, "calcData.default.json");
const dataFile = () => path.join(app.getPath("userData"), "calc-data.json");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\ufeff/, "")); } catch (_) { return null; }
}

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const strList = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
// one check per section that must be usable by the calculator
const CHECK = {
  netDivisor: (v) => typeof v === "number" && v > 0,
  adDiscLabs: (v) => Array.isArray(v) && v.every(isStr),
  defaultLab: isStr, defaultCps: isStr,
  defaultDepth: (v) => typeof v === "number", defaultRatio: (v) => typeof v === "number",
  shapes: (v) => Array.isArray(v) && v.length > 0 && v.every((s) => isObj(s) && isStr(s.code) && isStr(s.name) && typeof s.factor === "number"),
  colors: strList, clarities: strList, fluorescence: strList, cuts: strList, labs: strList,
  cps: (v) => isObj(v) && Object.keys(v).length > 0 && Object.values(v).every((t) => Array.isArray(t) && t.length === 3 && t.every(isStr)),
  subCuts: (v) => Array.isArray(v) && v.every((s) => isObj(s) && isStr(s.code) && isStr(s.cut) && Array.isArray(s.shapes)),
  rate: (v) => isObj(v) && Array.isArray(v.weightBands) && v.weightBands.length > 0 && v.weightBands.every((b) => typeof b.from === "number" && typeof b.base === "number") && isObj(v.colorFactor) && isObj(v.clarityFactor),
  discount: (v) => isObj(v) && isObj(v.byLab) && isObj(v.gradePoints) && isObj(v.fluorPoints),
  mfgLabourPercents: (v) => Array.isArray(v) && v.every((r) => typeof r.fromRange === "number" && typeof r.toRange === "number" && typeof r.roundPercentage === "number"),
  labCosts: (v) => Array.isArray(v) && v.every((r) => isStr(r.lab) && typeof r.fromWt === "number" && typeof r.toWt === "number" && typeof r.amount === "number"),
};

const LISTS = new Set(["shapes", "colors", "clarities", "subCuts", "rate", "discount"]);

// the defaults, with the user's sections laid over them where they are usable
function merge(user, def) {
  const out = { ...def };
  if (!isObj(user)) return out;
  // a file written by an OLDER version of the lists (fewer shapes / colours / clarities) must not hide the new ones: those sections come from the defaults
  const stale = !(typeof user.version === "number" && user.version >= def.version);
  for (const k of Object.keys(def)) {
    if (stale && LISTS.has(k)) continue;
    const check = CHECK[k];
    if (k in user && (!check || check(user[k]))) out[k] = user[k];
  }
  return out;
}

function load() {
  const def = readJson(DEFAULT_FILE) || {};
  const file = dataFile();
  if (!fs.existsSync(file)) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(DEFAULT_FILE, file); } catch (_) { /* unwritable folder: the defaults still work */ }
    return def;
  }
  return merge(readJson(file), def);
}

module.exports = { load, merge, dataFile, DEFAULT_FILE };
