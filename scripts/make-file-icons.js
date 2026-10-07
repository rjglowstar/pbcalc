// Generates the per-file-type icons Explorer shows for files PBCalc is the default app for (PDF, web page, image, text), like
// Chrome's "page with the browser logo and a type label". Output: assets/file-icons/<kind>.ico (no preview PNGs: nothing uses them).
// The ProgIds' DefaultIcon (electron/defaultBrowser.js) points at the installed copy of these files.
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/make-file-icons.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "assets", "file-icons");
const LOGO = fs.readFileSync(path.join(__dirname, "..", "assets", "icon.png")).toString("base64");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const KINDS = { pdf: ["PDF", "#D93025"], html: ["HTML", "#1A73E8"], image: ["IMAGE", "#188038"], text: ["TEXT", "#5F6368"], svg: ["SVG", "#E8710A"] };

function buildIco(pngs) {
  const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16, s = size >= 256 ? 0 : size;
    dir.writeUInt8(s, o); dir.writeUInt8(s, o + 1); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12); offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// 256x256 canvas: white page with a folded corner, the PBCalc logo, and a coloured label band across the bottom.
const page = (label, colour) => `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <path d="M44 8h116l56 56v178a6 6 0 0 1-6 6H44a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6z" fill="#fff" stroke="#9AA0A6" stroke-width="6" stroke-linejoin="round"/>
  <path d="M160 8v50a6 6 0 0 0 6 6h50z" fill="#E3E5E8" stroke="#9AA0A6" stroke-width="6" stroke-linejoin="round"/>
  <image href="data:image/png;base64,${LOGO}" x="64" y="64" width="128" height="104"/>
  <rect x="38" y="184" width="180" height="58" fill="${colour}"/>
  <text x="128" y="226" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${label.length > 4 ? 40 : 46}" fill="#fff">${label}</text>
</svg>`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: 256, height: 256, useContentSize: true, frame: false, show: false, transparent: true, backgroundColor: "#00000000" });
  for (const [kind, [label, colour]] of Object.entries(KINDS)) {
    const html = `<!doctype html><html style="overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">${page(label, colour)}</body></html>`;
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 400));
    const full = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    fs.writeFileSync(path.join(OUT, kind + ".ico"), buildIco(SIZES.map((size) => ({ size, data: full.resize({ width: size, height: size, quality: "best" }).toPNG() }))));
    console.log(kind + ".ico " + fs.statSync(path.join(OUT, kind + ".ico")).size + " bytes");
  }
  app.exit(0);
});
