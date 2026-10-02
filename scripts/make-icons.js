// Generates PBCalc's app icons from assets/icon.svg: a 512px PNG (app window / taskbar) and a
// multi-size .ico (Windows installer, shortcuts, exe). Re-run after editing the SVG:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe scripts/make-icons.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const ASSETS = path.join(__dirname, "..", "assets");
const SVG = path.join(ASSETS, "icon.svg");
const SIZES = [16, 24, 32, 48, 64, 128, 256]; // what Windows asks for in an .ico

// Minimal ICO writer: 6-byte header, one 16-byte directory entry per image, then the PNG bytes.
// Windows reads PNG-compressed entries (Vista+), so no BMP encoding is needed.
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o + 0); // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG, "utf8");
  // useContentSize + frameless: without it the window FRAME eats into the 512x512 and the capture
  // comes out 496x447, which then gets squashed into every .ico entry.
  // transparent + a transparent backgroundColor: otherwise the page is painted on opaque white and
  // the icon ships with white corners (very visible as a white box on a dark taskbar).
  const win = new BrowserWindow({
    width: 512, height: 512, useContentSize: true, frame: false, show: false,
    transparent: true, backgroundColor: "#00000000",
  });
  // overflow:hidden — otherwise the page's scrollbars are captured along the right/bottom edges
  const html = `<!doctype html><html style="overflow:hidden;background:transparent">` +
    `<body style="margin:0;overflow:hidden;background:transparent">${svg}</body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const full = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });

  fs.writeFileSync(path.join(ASSETS, "icon.png"), full.toPNG());
  const pngs = SIZES.map((size) => ({ size, data: full.resize({ width: size, height: size, quality: "best" }).toPNG() }));
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), buildIco(pngs));
  // a 32px PNG for the tab favicon of our own pages
  fs.writeFileSync(path.join(ASSETS, "icon-32.png"), pngs.find((p) => p.size === 32).data);

  console.log("icon.png  " + fs.statSync(path.join(ASSETS, "icon.png")).size + " bytes (512x512)");
  console.log("icon.ico  " + fs.statSync(path.join(ASSETS, "icon.ico")).size + " bytes (" + SIZES.join(", ") + ")");
  console.log("icon-32.png " + fs.statSync(path.join(ASSETS, "icon-32.png")).size + " bytes");
  app.exit(0);
});
