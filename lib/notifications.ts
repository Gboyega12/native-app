// ── Notification Service ──
// Handles push token registration (via expo-notifications) and email delivery (Resend).
//
// Architecture:
//   1. Email        — Resend API for weekly digests, milestones, check-ins
//   2. Push         — expo-notifications for real-time alerts on mobile
//   3. In-app       — Proactive chat messages from Bocy

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';

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

// ── Push notification registration ──

export async function registerPushToken(userId: string): Promise<string | null> {
  // Push notifications are only available on native platforms
  if (Platform.OS === 'web') return null;

  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;

    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') return null;

    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: 'f8e22d4e-78f5-43b2-9369-4dfa3c00ff02',
    });
    const token = tokenData.data;

    // Persist to notification_preferences
    await supabase
      .from('notification_preferences')
      .update({ push_token: token, updated_at: new Date().toISOString() })
      .eq('user_id', userId);

    return token;
  } catch (err) {
    console.warn('[notifications] Push registration failed:', err);
    return null;
  }
}

// ── Push notification delivery ──

export async function sendPushNotification(
  pushToken: string,
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<boolean> {
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: pushToken, title, body, data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── iOS notification channel setup ──

export function configureNotificationChannels(): void {
  if (Platform.OS === 'web') return;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowInForeground: true,
    }),
  });
}
