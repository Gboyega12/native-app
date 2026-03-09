// ── Service Worker Registration ──
// Registers /sw.js for the PWA.
// Called once from _layout.tsx when the user session is established.

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('[SW] Registration failed:', err);
  });
}
