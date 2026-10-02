const origSetInterval = window.setInterval;
window.setInterval = function (handler, timeout, ...args) {
  if (timeout === 500 && typeof handler === "function") {
    console.log("[Interval] timeout:", timeout, "source:", handler.toString());
  }
  return origSetInterval.apply(this, [handler, timeout, ...args]);
};
