// ── Service Worker Registration ──
// Registers /sw.js on the web platform. No-op on native.
// Called once from _layout.tsx when the user session is established.

import { Platform } from 'react-native';

export function registerServiceWorker(): void {
  if (Platform.OS !== 'web') return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('[SW] Registration failed:', err);
  });
}
