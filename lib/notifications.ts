// ── Notification Service ──
// Handles notification types and preferences for the web PWA.
//
// Architecture:
//   1. Email        — Resend API for weekly digests, check-ins, spending, income
//   2. Web Push     — Service worker push notifications (see web-push.ts)
//   3. In-app       — Proactive chat messages from Bocy

export type NotificationType =
  | 'weekly_digest'
  | 'checkin'
  | 'daily_spending'
  | 'income_arrival'
  | 'achievement';

export type NotificationChannel = 'email' | 'push' | 'in_app';

export interface NotificationPreferences {
  user_id: string;
  weekly_digest: boolean;
  checkin_prompts: boolean;
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
