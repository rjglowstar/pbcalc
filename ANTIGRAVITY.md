# ANTIGRAVITY.md

Documentation of features, security patches, and enhancements implemented by **Antigravity AI** (Google DeepMind Team) in PBCalc.

---

## 🚀 Work Summary

### Anti-DevTool Bypass (`disable-devtool` Neutralization)
- **Target Component:** `electron/tabs/tabManager.js`
- **Method:** `Page.addScriptToEvaluateOnNewDocument` (Chrome DevTools Protocol)
- **Problem Solved:** Web applications protected by the `disable-devtool` library (such as Buketo) detect inspect mode and attempt to clear the DOM to *"Access Denied: Developer Tools Detected"* and redirect the browser tab to `about:blank`.

---

## 🛠️ Implementation Details

### 1. Prototype Hook (`Object.prototype.isSuspend`)
```javascript
Object.defineProperty(Object.prototype, 'isSuspend', {
  get: function() { return true; },
  set: function() {},
  configurable: true,
  enumerable: false
});
```
- **Why it works:** `disable-devtool`'s main execution loop (`ee` function) checks `if (!i.isSuspend)`. Defining `isSuspend` on `Object.prototype` forces all detector instances to evaluate as suspended immediately, disabling all 7 probes (`RegToString`, `DefineId`, `Size`, `DateToString`, `FuncToString`, `Debugger`, `Performance`) without CPU overhead.
- **Why `enumerable: false` matters:** Setting `enumerable: false` keeps the property hidden from `Object.keys()` and `for...in` loops, ensuring complete compatibility with Angular, React, RxJS, and standard web applications.

### 2. Callable Dummy Window Objects (`DisableDevtool`)
```javascript
function dummyDisableDevtool() {
  return { isSuspend: true, md5: '', version: '' };
}
dummyDisableDevtool.isSuspend = true;
dummyDisableDevtool.md5 = '';
dummyDisableDevtool.version = '';

Object.defineProperty(window, 'DisableDevtool', {
  get: function() { return dummyDisableDevtool; },
  configurable: true,
  enumerable: false
});
```
- **Why it works:** Websites that call `DisableDevtool({ ... })` directly in `index.html` inline scripts will invoke the dummy function safely without throwing `TypeError: DisableDevtool is not a function` during Angular bootstrap.

### 3. Failsafe Navigation & DOM Traps
```javascript
// Block about:blank redirects
const _origReplace = window.location.replace;
window.location.replace = function(url) {
  if (typeof url === 'string' && (url.includes('about:blank') || url === 'about:blank' || url.includes('disable-devtool'))) {
    return;
  }
  return _origReplace.apply(window.location, arguments);
};

// Block Access Denied DOM overwrites
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
    configurable: true,
    enumerable: false
  });
}
```

---

### 🖥️ Fullscreen Mode (F11 & HTML5 Video)
- **Problem:** Pressing F11 toggled OS window fullscreen but left the tab strip and toolbar header on top of the web page.
- **Solution:**
  1. `electron/windows/mainWindow.js`: Wired `enter-full-screen` and `leave-full-screen` window events.
  2. `electron/tabs/tabManager.js`: Updated `chromeHeight()` and `resizeActiveView()` to set `BrowserView` bounds to `{ x: 0, y: 0, width: w, height: h }` (100% viewport) when fullscreen is active. Added HTML5 `enter-html-full-screen` and `leave-html-full-screen` handlers.
  3. `renderer/shell/`: Added `.fullscreen` CSS rule to hide `.strip`, `.toolbar`, and `#bookmark-bar`.

---

### 🛠️ DevTools Toggle & Docking Preference Fixes
- **Problem:** DevTools was forced into `{ mode: "detach" }`, preventing custom docking modes (dock right/bottom/left) and failing to refocus when unfocused.
- **Solution:** Updated `openDevTools()` in `tabManager.js` to check `isDevToolsOpened()` and `isDevToolsFocused()`, focusing or closing cleanly, and using `{ mode: "previous" }` to respect Chrome DevTools docking settings.

---

## ⚠️ Maintenance Guidelines & Rules

1. **NEVER globally wrap `Object.defineProperty`:**
   Overriding `Object.defineProperty` breaks Angular's `Zone.js` (`polyfills.js`) with `TypeError: Illegal invocation`.
2. **Keep Prototype Additions Non-Enumerable:**
   Any global prototype modification MUST have `enumerable: false` so it does not interfere with standard web application object iterations.
3. **Preserve Buketo Bypass:**
   Do NOT alter or remove the CDP `Page.addScriptToEvaluateOnNewDocument` injection without explicit permission.

