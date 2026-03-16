// ── Mixpanel analytics helpers ──
// Lightweight wrapper for Mixpanel HTTP tracking API.
// Uses EU data residency endpoint. No native SDK dependency.

const MIXPANEL_TOKEN = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN ?? '';
const MIXPANEL_API = 'https://api-eu.mixpanel.com';

let _userId: string | null = null;
let _userProps: Record<string, any> = {};

function encode(data: Record<string, any>): string {
  return btoa(JSON.stringify(data));
}

function send(endpoint: string, data: Record<string, any>): void {
  if (!MIXPANEL_TOKEN) return;
  const url = `${MIXPANEL_API}/${endpoint}/?data=${encode(data)}&verbose=0`;
  // Fire-and-forget — analytics should never block the UI
  fetch(url).catch(() => {});
}

/**
 * Initialise Mixpanel and identify the user.
 * Call once on app boot when the user session is available.
 */
export async function initMixpanel(userId: string, email?: string): Promise<void> {
  _userId = userId;
  if (email) {
    _userProps['$email'] = email;
  }
  _userProps['platform'] = 'web';

  send('engage', {
    $token: MIXPANEL_TOKEN,
    $distinct_id: userId,
    $set: _userProps,
  });
}

/** Track an event with optional properties. */
export function trackEvent(name: string, properties?: Record<string, any>): void {
  send('track', {
    event: name,
    properties: {
      token: MIXPANEL_TOKEN,
      distinct_id: _userId,
      ...properties,
    },
  });
}

/** Track a screen/page view. */
export function trackScreen(screenName: string, properties?: Record<string, any>): void {
  trackEvent('Screen Viewed', { screen: screenName, ...properties });
}

/** Set a user profile property. */
export function setUserProperty(key: string, value: any): void {
  if (!_userId) return;
  send('engage', {
    $token: MIXPANEL_TOKEN,
    $distinct_id: _userId,
    $set: { [key]: value },
  });
}

/** Set user properties that should only be set once (e.g. sign-up date). */
export function setUserPropertyOnce(key: string, value: any): void {
  if (!_userId) return;
  send('engage', {
    $token: MIXPANEL_TOKEN,
    $distinct_id: _userId,
    $set_once: { [key]: value },
  });
}

/** Reset Mixpanel state (call on sign-out). */
export function resetMixpanel(): void {
  _userId = null;
  _userProps = {};
}
