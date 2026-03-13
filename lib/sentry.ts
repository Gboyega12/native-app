// ── Sentry Error Tracking ──
// Initialises Sentry for the client-side (React) app.
// Server-side (Vercel functions) should call initSentryServer().

import * as Sentry from '@sentry/react';

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';

let _clientInitialised = false;

export function initSentryClient() {
  if (_clientInitialised || !SENTRY_DSN) return;
  _clientInitialised = true;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
  });
}

export function setSentryUser(userId: string, email?: string | null) {
  Sentry.setUser({ id: userId, ...(email ? { email } : {}) });
}

export function clearSentryUser() {
  Sentry.setUser(null);
}

export function captureException(err: unknown, context?: Record<string, unknown>) {
  if (context) {
    Sentry.withScope((scope) => {
      scope.setExtras(context);
      Sentry.captureException(err);
    });
  } else {
    Sentry.captureException(err);
  }
}

export { Sentry };
