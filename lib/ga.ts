// ── Google Analytics (GA4) helper ──
// Lightweight wrapper around gtag for event tracking.
// Falls back silently when gtag is not loaded (native builds, SSR).

const GA_ID = 'G-9M5YQ6864E';

function gtag(...args: unknown[]) {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (typeof w.gtag === 'function') {
    w.gtag(...args);
  }
}

/** Track a page/screen view */
export function gaPageView(pagePath: string, pageTitle?: string) {
  gtag('config', GA_ID, {
    page_path: pagePath,
    page_title: pageTitle || pagePath,
  });
}

/** Track a custom event */
export function gaEvent(eventName: string, params?: Record<string, unknown>) {
  gtag('event', eventName, params);
}

/** Set the user ID for cross-device tracking */
export function gaSetUserId(userId: string) {
  gtag('config', GA_ID, { user_id: userId });
}

/** Set user properties */
export function gaSetUserProperties(properties: Record<string, unknown>) {
  gtag('set', 'user_properties', properties);
}
