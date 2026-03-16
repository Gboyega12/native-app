// ── Sentry Server-Side (Vercel Functions) ──

import * as Sentry from '@sentry/node';

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.EXPO_PUBLIC_SENTRY_DSN || '';

let _initialised = false;

export function initSentryServer() {
  if (_initialised || !SENTRY_DSN) return;
  _initialised = true;

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.1,
  });
}

export function captureServerException(err: unknown, context?: Record<string, unknown>) {
  initSentryServer();
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
