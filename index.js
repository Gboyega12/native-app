// ── Pre-module safety net ──
// This file MUST be the app entry point (package.json "main").
// It installs fatal-error interception BEFORE expo-router loads
// user modules (_layout.tsx, supabase.ts, etc.).
//
// Why: ES module imports are resolved before module-level code runs.
// If any import of _layout.tsx throws during initialization, the
// error reaches RCTExceptionsManager.reportFatal → RCTFatal → SIGABRT.
//
// Defence layers (belt-and-suspenders):
//   1. global.RN$handleException — checked by ExceptionsManager.handleException()
//   2. ErrorUtils.setGlobalHandler — replaces the global error handler
//   3. try-catch around require('expo-router/entry') — catches synchronous throws
//   4. ExceptionsManager.handleException monkeypatch — deepest defence, intercepts
//      ALL fatal errors before they reach NativeExceptionsManager.reportException()
//   5. Re-assert ErrorUtils handler after expo-router loads (expo-router's splash
//      module wraps the handler; we verify ours is still in the chain)

'use strict';

// ── Layer 1: RN$handleException global ──
// ExceptionsManager.handleException() checks this on every call.
// Returning true prevents reportException → NativeExceptionsManager.
try {
  if (typeof globalThis !== 'undefined') {
    globalThis.RN$handleException = function (error, isFatal) {
      if (isFatal) {
        try {
          var msg = error && error.message ? error.message : String(error);
          console.warn('[SafetyNet·L1] Fatal intercepted: ' + msg);
        } catch (_) {}
        return true; // handled — do NOT call reportException
      }
      return false; // non-fatal: let normal flow continue
    };
  }
} catch (_) {
  // Assignment may fail if the C++ runtime defined a read-only global
  // (new architecture). Silently fall through to other layers.
}

// ── Layer 2: ErrorUtils global handler ──
// ErrorUtils is set up by InitializeCore.js → error-guard.js (before this
// file runs). Metro's guardedLoadModule calls ErrorUtils.reportFatalError
// for module-init errors, which invokes this handler.
var _origHandler;
if (typeof globalThis !== 'undefined' && globalThis.ErrorUtils) {
  _origHandler = globalThis.ErrorUtils.getGlobalHandler();
  globalThis.ErrorUtils.setGlobalHandler(function (error, isFatal) {
    if (isFatal) {
      try {
        var msg = error && error.message ? error.message : String(error);
        console.warn('[SafetyNet·L2] Fatal via ErrorUtils: ' + msg);
      } catch (_) {}
      // Swallow — don't forward to the original handler (which calls
      // ExceptionsManager.handleException → reportFatal → crash).
      return;
    }
    // Forward non-fatal errors normally
    if (_origHandler) {
      _origHandler(error, isFatal);
    }
  });
}

// ── Layer 3: try-catch around the require ──
// Catches any synchronous error that propagates out of module loading,
// even if layers 1 & 2 are somehow bypassed.
try {
  require('expo-router/entry');
} catch (e) {
  try {
    console.warn('[SafetyNet·L3] require(expo-router/entry) threw: ' + (e && e.message ? e.message : String(e)));
  } catch (_) {}
}

// ── Layer 4: Monkeypatch ExceptionsManager.handleException ──
// This is the DEEPEST defence. ExceptionsManager.handleException is the
// single chokepoint that ALL fatal errors pass through before reaching
// NativeExceptionsManager.reportException() → RCTFatal → SIGABRT.
//
// setUpErrorHandling.js captures `ExceptionsManager` (the object) and calls
// ExceptionsManager.handleException(e, isFatal) dynamically. By replacing
// the method on the object, our patch is called even when ErrorUtils
// invokes the original handler chain.
//
// Expo Router's splash module (expo-router/build/utils/splash.js) wraps the
// ErrorUtils handler to hide the splash screen on errors. This means our
// Layer 2 handler may be nested inside the splash wrapper. Layer 4 ensures
// that even if the splash wrapper re-throws or forwards the fatal, it is
// blocked before reaching native.
try {
  var _EM = require('react-native/Libraries/Core/ExceptionsManager').default;
  if (_EM && typeof _EM.handleException === 'function') {
    var _origHandleException = _EM.handleException;
    _EM.handleException = function (e, isFatal) {
      if (isFatal) {
        try {
          var msg = e && e.message ? e.message : String(e);
          console.warn('[SafetyNet·L4] Fatal blocked at ExceptionsManager: ' + msg);
        } catch (_) {}
        // Do NOT forward to the original — it would call reportException
        // which sends the fatal to NativeExceptionsManager → RCTFatal.
        return;
      }
      // Non-fatal: forward normally (console.error reports, warnings, etc.)
      _origHandleException(e, isFatal);
    };
  }
} catch (_) {
  // Module path may differ across RN versions — fail silently
}

// ── Layer 5: Re-assert ErrorUtils handler ──
// During require('expo-router/entry'), Expo Router's splash module may
// have wrapped the ErrorUtils handler. Verify our fatal-swallowing behaviour
// is still in the chain by re-reading the current handler and wrapping it
// if necessary. This ensures that even if the handler chain was rebuilt,
// fatal errors are still suppressed.
try {
  if (typeof globalThis !== 'undefined' && globalThis.ErrorUtils) {
    var _currentHandler = globalThis.ErrorUtils.getGlobalHandler();
    // Only re-wrap if the current handler is NOT our handler
    // (i.e., something replaced it during module loading)
    if (_currentHandler && _currentHandler !== _origHandler) {
      var _wrappedHandler = _currentHandler;
      globalThis.ErrorUtils.setGlobalHandler(function (error, isFatal) {
        if (isFatal) {
          try {
            var msg = error && error.message ? error.message : String(error);
            console.warn('[SafetyNet·L5] Fatal re-intercepted: ' + msg);
          } catch (_) {}
          return;
        }
        _wrappedHandler(error, isFatal);
      });
    }
  }
} catch (_) {}
