// electron/printPreview.js openForFrame(): a holder window given an iframe's own captured HTML. That HTML usually still carries the very
// onload="window.print(); window.close();" that triggered the capture in the first place (the ERP's pattern) - without this, reloading it
// verbatim re-fires the same handler INSIDE the holder: window.print() opens a second, bare native dialog, and window.close() destroys the
// window before it can be printed at all (measured: net::ERR_ABORTED / did-fail-load -3). Both are made harmless no-ops here, in the main
// world, before any of the holder's own script runs.
const { webFrame } = require("electron");
try {
  webFrame.executeJavaScript(`(function(){try{
    Object.defineProperty(window, 'print', { configurable: true, writable: true, enumerable: false, value: function(){} });
    Object.defineProperty(window, 'close', { configurable: true, writable: true, enumerable: false, value: function(){} });
  }catch(e){}})();`, true);
} catch (_) {}
