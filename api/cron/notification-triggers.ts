// ── Notification Triggers Cron Job ──
// Runs daily at 9am (via Vercel Cron).
// Iterates over all users with push enabled and calls the notification
// trigger logic for each one. This ensures time-sensitive alerts
// (ISA deadline, council tax, BoE rate decisions, etc.) fire even
// when users haven't opened the app recently.

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL || 'https://app.bocy.io';
const cronSecret = process.env.CRON_SECRET;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = (req.headers.authorization as string) || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);
  const results = { triggered: 0, skipped: 0, failed: 0, errors: [] as Array<{ user_id: string; error: string }> };

  try {
    // Get all users who have an active web push subscription
    const { data: subscribers } = await admin
      .from('web_push_subscriptions')
      .select('user_id')
      .limit(1000);

    if (!subscribers || subscribers.length === 0) {
      return res.json({ success: true, message: 'No users with push subscriptions', ...results });
    }

    // Deduplicate user IDs (a user may have multiple subscriptions)
    const userIds = [...new Set(subscribers.map(s => s.user_id))];

    for (const userId of userIds) {
      try {
        const response = await fetch(`${appUrl}/api/notifications/trigger`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cronSecret}`,
          },
          body: JSON.stringify({ user_id: userId }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.triggered?.length > 0) {
            results.triggered++;
          } else {
            results.skipped++;
          }
        } else {
          results.failed++;
          results.errors.push({ user_id: userId, error: `HTTP ${response.status}` });
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        results.failed++;
        results.errors.push({ user_id: userId, error: message });
      }
    }

    return res.json({ success: true, users: userIds.length, ...results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[cron/notification-triggers] Error:', message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
