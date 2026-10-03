const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.resolve(projectRoot, 'build-dist');

// Obfuscation configuration tailored for high security + 100% Electron stability
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: false,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  target: 'node',
  unicodeEscapeSequence: false
};

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function obfuscateJsFilesInDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      obfuscateJsFilesInDir(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      const code = fs.readFileSync(fullPath, 'utf8');
      try {
        const isPreload = entry.name === 'tab-preload.js';
        const opts = isPreload
          ? { ...obfuscatorOptions, stringArray: false }
          : obfuscatorOptions;
        const obfuscatedResult = JavaScriptObfuscator.obfuscate(code, opts);
        fs.writeFileSync(fullPath, obfuscatedResult.getObfuscatedCode(), 'utf8');
        console.log(`[Obfuscated] ${path.relative(distDir, fullPath)}`);
      } catch (err) {
        console.error(`[Error Obfuscating] ${fullPath}:`, err);
        process.exit(1);
      }
    }
  }
}

console.log('=== Starting PBCalc Build Obfuscation ===');

// Clean previous build-dist
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}
fs.mkdirSync(distDir, { recursive: true });

// Directories and files to include in build-dist
const foldersToCopy = ['electron', 'preloads', 'renderer', 'assets'];

for (const folder of foldersToCopy) {
  const src = path.join(projectRoot, folder);
  const dest = path.join(distDir, folder);
  if (fs.existsSync(src)) {
    console.log(`Copying ${folder} -> build-dist/${folder}...`);
    copyDirRecursive(src, dest);
  }
}

// Copy package.json and strip "build" and "devDependencies" for the app package
const pkgSrc = path.join(projectRoot, 'package.json');
const pkgDest = path.join(distDir, 'package.json');
const pkgData = JSON.parse(fs.readFileSync(pkgSrc, 'utf8'));
delete pkgData.build;
delete pkgData.devDependencies;
fs.writeFileSync(pkgDest, JSON.stringify(pkgData, null, 2), 'utf8');

console.log('Obfuscating JavaScript files...');
for (const folder of ['electron', 'preloads', 'renderer']) {
  const targetDir = path.join(distDir, folder);
  if (fs.existsSync(targetDir)) {
    obfuscateJsFilesInDir(targetDir);
  }
}

console.log('=== Obfuscation Complete! Files ready in build-dist/ ===');
