// ── Haptic feedback utility ──
// Wraps expo-haptics with a web-safe fallback (no-op on web).
// All haptic calls are fire-and-forget — never await these.

import * as Haptics from 'expo-haptics';

const isWeb = typeof document !== 'undefined';

/** Light tap — card press, toggle, selection */
export function hapticLight() {
  if (isWeb) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

/** Medium tap — confirm action, expand/collapse */
export function hapticMedium() {
  if (isWeb) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Heavy tap — pull-to-refresh complete, milestone */
export function hapticHeavy() {
  if (isWeb) return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
}

/** Success — achievement unlocked, sync complete */
export function hapticSuccess() {
  if (isWeb) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** Warning — overspend alert, error */
export function hapticWarning() {
  if (isWeb) return;
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

/** Tick — scrubbing through values, carousel snap */
export function hapticTick() {
  if (isWeb) return;
  Haptics.selectionAsync().catch(() => {});
}
