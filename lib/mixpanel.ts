// ── Mixpanel analytics helpers ──
// Wraps mixpanel-react-native for cross-platform event tracking.
// Uses EU data residency endpoint. Lazily loaded to avoid crashes
// if the native module fails to link.

import { Platform } from 'react-native';

const MIXPANEL_TOKEN = process.env.EXPO_PUBLIC_MIXPANEL_TOKEN ?? 'e51a3b39e9901ef59b3b1af02cdcd7b2';
const MIXPANEL_SERVER_URL = 'https://api-eu.mixpanel.com';

let _mixpanel: any = null;
let _initialising = false;

/** Lazily resolve the Mixpanel class — returns null if unavailable. */
function getMixpanelClass() {
  try {
    const mod = require('mixpanel-react-native');
    return mod.Mixpanel ?? mod.default;
  } catch (e) {
    console.warn('[Mixpanel] Module not available:', e);
    return null;
  }
}

/**
 * Initialise Mixpanel and identify the user.
 * Call once on app boot when the user session is available.
 */
export async function initMixpanel(userId: string, email?: string): Promise<void> {
  if (_mixpanel || _initialising) return;
  _initialising = true;

  const MixpanelClass = getMixpanelClass();
  if (!MixpanelClass) {
    _initialising = false;
    return;
  }

  try {
    // useNative: false for Expo compatibility (JS-only mode)
    const instance = new MixpanelClass(MIXPANEL_TOKEN, true, false);
    await instance.init(false, {}, MIXPANEL_SERVER_URL);
    await instance.identify(userId);

    if (email) {
      instance.getPeople().set('$email', email);
    }
    instance.getPeople().set('platform', Platform.OS);

    _mixpanel = instance;
  } catch (e) {
    console.warn('[Mixpanel] init failed:', e);
  } finally {
    _initialising = false;
  }
}

/** Track an event with optional properties. */
export function trackEvent(name: string, properties?: Record<string, any>): void {
  _mixpanel?.track(name, properties);
}

/** Set a user profile property. */
export function setUserProperty(key: string, value: any): void {
  _mixpanel?.getPeople()?.set(key, value);
}

/** Set user properties that should only be set once (e.g. sign-up date). */
export function setUserPropertyOnce(key: string, value: any): void {
  _mixpanel?.getPeople()?.setOnce(key, value);
}

/** Reset Mixpanel state (call on sign-out). */
export function resetMixpanel(): void {
  _mixpanel?.reset();
  _mixpanel = null;
}
