// ── Pre-module safety net ──
// This file MUST be the app entry point (package.json "main").
// It installs fatal-error interception BEFORE expo-router loads
// user modules (_layout.tsx, supabase.ts, etc.).
//
// Why: ES module imports are resolved before module-level code runs.
// If any import of _layout.tsx throws during initialization, the
// ErrorUtils handler set up in _layout.tsx hasn't executed yet, so the
// error reaches RCTExceptionsManager.reportFatal → RCTFatal → SIGABRT.
//
// By setting global.RN$handleException here (before expo-router/entry
// triggers require.context for all route modules), every subsequent
// call to ExceptionsManager.handleException will check this global
// first and skip the fatal native report.

'use strict';

// 1. Intercept at the ExceptionsManager level.
//    handleException() checks global.RN$handleException on every call;
//    returning true prevents reportException → NativeExceptionsManager.
if (typeof globalThis !== 'undefined') {
  globalThis.RN$handleException = function (error, isFatal) {
    if (isFatal) {
      // Log the error for debugging but don't let it kill the process.
      // The React ErrorBoundary will handle the visual fallback.
      try {
        var msg = error && error.message ? error.message : String(error);
        console.warn('[SafetyNet] Fatal intercepted: ' + msg);
      } catch (_) {
        // Even console.warn can fail in very early init
      }
      return true; // handled — do NOT call reportException
    }
    return false; // non-fatal: let normal flow continue
  };
}

// 2. Also replace the ErrorUtils global handler as a second defence.
//    ErrorUtils is set up by InitializeCore.js (before this file runs),
//    so it's always available here.
if (typeof globalThis !== 'undefined' && globalThis.ErrorUtils) {
  var _origHandler = globalThis.ErrorUtils.getGlobalHandler();
  globalThis.ErrorUtils.setGlobalHandler(function (error, isFatal) {
    if (isFatal) {
      try {
        var msg = error && error.message ? error.message : String(error);
        console.warn('[SafetyNet] Fatal via ErrorUtils: ' + msg);
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

// 3. Now load the actual Expo Router entry point.
//    This triggers require.context for all route files and initialises
//    the app. Any fatal error during this process is now intercepted.
require('expo-router/entry');
