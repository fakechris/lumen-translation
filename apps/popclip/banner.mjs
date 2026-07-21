// Raw JS prepended verbatim to the PopClip bundle (esbuild `banner`, never
// parsed or constant-folded). PopClip's JavaScriptCore sandbox lacks
// AbortController, which @lumen/engines' fetch timeouts construct. esbuild
// aggressively folds every literal `AbortController` reference back to a bare
// global, so a runtime guard in engine code cannot survive bundling. Providing
// the polyfill as a banner is bulletproof: the folded `new AbortController()`
// in the body resolves to this shim in PopClip, while browsers/Node keep their
// native implementation (the `typeof` check below is real runtime code here).
export const ABORT_CONTROLLER_BANNER = `(function(){
  if (typeof globalThis.AbortController !== "undefined") return;
  function AbortControllerShim(){
    var listeners = [];
    this.signal = {
      aborted: false,
      reason: undefined,
      addEventListener: function(type, cb){ if (type === "abort" && typeof cb === "function") listeners.push(cb); },
      removeEventListener: function(type, cb){ var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); },
      dispatchEvent: function(){ return false; }
    };
    this.__listeners = listeners;
  }
  AbortControllerShim.prototype.abort = function(reason){
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal.reason = reason;
    for (var i = 0; i < this.__listeners.length; i++){ try { this.__listeners[i](); } catch (e) {} }
  };
  globalThis.AbortController = AbortControllerShim;
})();`;
