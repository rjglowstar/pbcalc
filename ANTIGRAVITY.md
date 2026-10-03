# ANTIGRAVITY.md

Architectural Reference & System Documentation for **PBCalc Browser**
Maintained by **Antigravity AI** (Google DeepMind Team)

---

## 📌 Executive Overview

PBCalc is a high-security, custom Electron multi-tab web browser designed for privacy, speed, and anti-detection web compatibility. It incorporates custom anti-fingerprinting hooks, devtools disarming bypasses, Chrome parity headers, and automated build obfuscation to protect internal source code from reverse engineering or AI analysis.

---

## 🚀 Key Systems & Features

### 1. Anti-DevTool & Detection Neutralization (`disable-devtool` Bypass)
- **Target Component:** `preloads/tab-preload.js`
- **Method:** `webFrame.executeJavaScript(..., true)` (Native Electron Preload Main-World Script Injection)
- **Problem Solved:** Web applications protected by the `disable-devtool` library (such as Buketo) detect inspect mode and attempt to clear the DOM with *"Access Denied: Developer Tools Detected"* and redirect the tab to `about:blank`.
- **CDP Neutralization:** Eliminates the need for Chrome DevTools Protocol (`debugger.attach("1.3")`) hooks which trigger Akamai EdgeSuite WAFbot detection (e.g. Meesho.com `403 Access Denied`).

#### Core Injection Implementation:
```javascript
// 1. Prototype Hook: Neutralizes disable-devtool's internal execution loop
Object.defineProperty(Object.prototype, 'isSuspend', {
  get: function() { return true; },
  set: function() {},
  configurable: true,
  enumerable: false // CRITICAL: Non-enumerable so Object.keys() / for...in loops aren't broken
});

// 2. Dummy Window Objects: Handles inline DisableDevtool() initializations
function dummyDisableDevtool() {
  return { isSuspend: true, md5: '', version: '' };
}
dummyDisableDevtool.isSuspend = true;
dummyDisableDevtool.md5 = '';
dummyDisableDevtool.version = '';

Object.defineProperty(window, 'DisableDevtool', {
  get: function() { return dummyDisableDevtool; },
  set: function() {},
  configurable: true,
  enumerable: false
});
Object.defineProperty(window, 'DISABLE_DEVTOOL', {
  get: function() { return dummyDisableDevtool; },
  set: function() {},
  configurable: true,
  enumerable: false
});

// 3. Location Replace & DOM Overwrite Traps
const _origReplace = window.location.replace;
window.location.replace = function(url) {
  if (typeof url === 'string' && (url.includes('about:blank') || url === 'about:blank' || url.includes('disable-devtool'))) {
    return;
  }
  return _origReplace.apply(window.location, arguments);
};

const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
if (innerHTMLDesc && innerHTMLDesc.set) {
  const _origSet = innerHTMLDesc.set;
  Object.defineProperty(Element.prototype, 'innerHTML', {
    set: function(val) {
      if (typeof val === 'string' && (val.includes('Developer Tools Detected') || val.includes('Access Denied'))) {
        return;
      }
      return _origSet.call(this, val);
    },
    get: function() { return innerHTMLDesc.get.call(this); },
    configurable: true,
    enumerable: false
  });
}
```

---

### 2. 🔒 Source Code Obfuscation & Build Security Pipeline
- **Target Files:** All JavaScript source files in `electron/`, `preloads/`, and `renderer/`.
- **Script:** `scripts/obfuscate.js` (Automated build tool powered by `javascript-obfuscator`).
- **Goal:** Prevent third parties or AI tools from inspecting or reversing internal application logic when opening the packaged `.exe` installer or `app.asar` archive.

#### Build Workflow:
1. **Source Isolation:** Original un-obfuscated source code stays intact in `electron/`, `preloads/`, `renderer/` for local development.
2. **Automated Staging (`build-dist/`):** Running `npm run dist` executes `node scripts/obfuscate.js`, copying runtime files to `build-dist/` and scrambling all 36 `.js` files using hexadecimal identifier mangling and Base64 string matrix encoding.
3. **Electron Stability Settings:**
   ```javascript
   const obfuscatorOptions = {
     compact: true,
     controlFlowFlattening: false,
     deadCodeInjection: false,
     debugProtection: false,
     disableConsoleOutput: false,
     identifierNamesGenerator: 'hexadecimal',
     renameGlobals: false, // Preserves window, document, contextBridge, webFrame, ipcRenderer
     selfDefending: false,
     simplify: true,
     stringArray: true,
     stringArrayEncoding: ['base64'],
     stringArrayThreshold: 0.75,
     target: 'node'
   };
   ```
4. **Packager Configuration (`package.json`):**
   ```json
   "build": {
     "directories": {
       "app": "build-dist",
       "output": "release"
     },
     "files": [
       "electron/**/*",
       "preloads/**/*",
       "renderer/**/*",
       "assets/**/*",
       "package.json",
       "!CLAUDE.md",
       "!ANTIGRAVITY.md",
       "!.claude/**/*",
       "!scripts/**/*",
       "!.git/**/*",
       "!.dev-userdata/**/*"
     ],
     "asar": true
   }
   ```
5. **Excluded Assets:** All AI prompts (`CLAUDE.md`, `ANTIGRAVITY.md`), `.claude/`, `.git/`, test scripts (`scripts/`), and dev data folders are **100% excluded** from the final `.exe` installer.

---

### 3. 🖥️ Fullscreen Chrome Parity (F11 & HTML5 Video)
- **Problem:** Toggling F11 fullscreen left the address bar and tab strip visible over web view.
- **Solution:**
  1. `electron/windows/mainWindow.js`: Wires `enter-full-screen` / `leave-full-screen` BrowserWindow events.
  2. `electron/tabs/tabManager.js`: Recalculates `chromeHeight()` to `0` during fullscreen and sets `BrowserView` bounds to `{ x: 0, y: 0, width: w, height: h }`.
  3. `renderer/shell/shell.css`: Toggles `.fullscreen` CSS class to hide `.strip`, `.toolbar`, and `#bookmark-bar`.

---

### 4. 💬 WAF & Web Application Compatibility (Akamai & WhatsApp Web)
- **Problem:** Sites using Akamai EdgeSuite WAF (e.g. `https://www.meesho.com/`) returned **403 Access Denied** when `navigator.userAgentData` was overridden via `Object.defineProperty` (which created an own property on `navigator`, triggering Akamai's DOM-tampering bot detector).
- **Solution:**
  1. `electron/main.js`: Sets standard Chrome User-Agent dynamically matching `process.versions.chrome`: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`.
  2. `preloads/tab-preload.js`: Native `Navigator.prototype.userAgentData` property getters are preserved without own-property detection (`navigator.hasOwnProperty('userAgentData') === false`), ensuring 100% consistency between `navigator.userAgent` and native Client Hints (`Sec-Ch-Ua`).

---

### 5. 🚀 High-Performance HTTP Caching & Shader Lock Prevention
- **Target Component:** `electron/main.js`
- **Optimization:** Retains standard Chromium HTTP disk caching so web application assets (images, CSS, scripts) remain fast and cached across navigations.
- **GPU Lock Switch:** Configured `app.commandLine.appendSwitch("disable-gpu-shader-disk-cache")` to prevent GPU shader file-locking warnings during rapid dev restarts.

---

## 🛠️ Command Reference

- `npm start` — Run PBCalc in local development mode (uses `.dev-userdata/` profile).
- `npm run obfuscate` — Run `node scripts/obfuscate.js` to create the obfuscated `build-dist/` folder.
- `npm run dist` — Execute the full production pipeline (Obfuscates code -> Builds Windows NSIS installer `.exe` in `release/`).

---

## ⚠️ Non-Negotiable Maintenance Rules

1. **Never globally wrap `Object.defineProperty`:**
   Overriding `Object.defineProperty` breaks Angular's `Zone.js` (`polyfills.js`) with `TypeError: Illegal invocation`.
2. **Keep Prototype Extensions Non-Enumerable (`enumerable: false`):**
   All custom prototype additions must have `enumerable: false` to avoid breaking `Object.keys()` or `for...in` loops in third-party frameworks (React, Angular, RxJS).
3. **Preserve Buketo Bypass Integrity:**
   Do NOT modify or remove the main-world prototype hooks in `preloads/tab-preload.js` without explicit permission.
4. **Production Build Protocol:**
   Always use `npm run dist` when packaging for end-users. Never package raw un-obfuscated source code.
