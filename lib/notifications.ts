// ── Notification Service ──
// Abstraction layer for sending notifications. Currently email-only via Resend.
// When building for iOS/Android, swap in expo-notifications for push delivery.
//
// Architecture:
//   1. Email (now)     — Resend API for weekly digests, milestones, check-ins
//   2. Push (future)   — expo-notifications for real-time alerts on mobile
//   3. In-app (now)    — Proactive chat messages from Bocy

export type NotificationType =
  | 'weekly_digest'
  | 'milestone'
  | 'checkin'
  | 'score_change'
  | 'achievement';

export type NotificationChannel = 'email' | 'push' | 'in_app';

export interface NotificationPreferences {
  user_id: string;
  weekly_digest: boolean;
  milestone_alerts: boolean;
  checkin_prompts: boolean;
  score_updates: boolean;
  achievement_alerts: boolean;
  email: string;
  push_token?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface NotificationPayload {
  user_id: string;
  type: NotificationType;
  channel: NotificationChannel;
  subject?: string;
  title: string;
  body: string;
  data?: Record<string, any>;
}

// ── Push notification scaffolding ──
// Ready for expo-notifications when building for app stores.
// For now, these are no-ops that log intent.

export async function registerPushToken(userId: string): Promise<string | null> {
  // TODO: When building for iOS/Android:
  // 1. import * as Notifications from 'expo-notifications';
  // 2. const { status } = await Notifications.requestPermissionsAsync();
  // 3. const token = await Notifications.getExpoPushTokenAsync();
  // 4. Save token to notification_preferences table
  // Web mode — no-op until native build
  return null;
}

export async function sendPushNotification(
  pushToken: string,
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<boolean> {
  // TODO: When building for iOS/Android:
  // POST to https://exp.host/--/api/v2/push/send
  // with { to: pushToken, title, body, data }
  // Web mode — no-op until native build
  return false;
}
