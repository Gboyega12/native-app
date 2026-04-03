// ── Lightweight analytics helpers ──
// Screen tracking for basic usage analytics.

/** Record a screen view for analytics / debugging */
export function trackScreen(name: string) {
  if (__DEV__) {
    console.log(`[analytics] screen: ${name}`);
  }
}
