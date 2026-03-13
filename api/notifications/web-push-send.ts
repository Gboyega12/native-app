// ── Web Push Delivery ──
// Internal endpoint to send a web push notification to a specific user.
// Looks up the user's subscriptions in `web_push_subscriptions` and
// delivers via the Web Push protocol (RFC 8030) using the `web-push` library.
//
// POST body: { user_id, title, body, icon?, url?, tag? }
// Auth: Bearer CRON_SECRET (internal calls from cron/triggers only)

import { createClient } from '@supabase/supabase-js';
import webPush from 'web-push';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:notifications@updates.bocy.io';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth check — internal calls only
  const authHeader = (req.headers.authorization as string) || '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.json({ success: false, error: 'vapid_not_configured', skipped: true });
  }

  if (!serviceKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const { user_id, title, body, icon, url, tag } = req.body;

  if (!user_id || !title) {
    return res.status(400).json({ error: 'Missing user_id or title' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);

  try {
    // Fetch all active subscriptions for this user
    const { data: subscriptions, error } = await admin
      .from('web_push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', user_id);

    if (error || !subscriptions?.length) {
      return res.json({ success: false, error: 'no_subscriptions', count: 0 });
    }

    const payload = JSON.stringify({
      title: title || 'Bocy',
      body: body || '',
      icon: icon || '/assets/images/icon.png',
      data: { url: url || '/' },
      tag: tag || 'bocy-notification',
    });

    const results = await Promise.allSettled(
      subscriptions.map(async (sub: { endpoint: string; p256dh: string; auth: string }) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };

        try {
          await webPush.sendNotification(pushSubscription, payload);
          return { endpoint: sub.endpoint, status: 'sent' as const };
        } catch (err: unknown) {
          const pushErr = err as { statusCode?: number; message?: string };
          // 410 Gone or 404 = subscription expired, clean it up
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            await admin
              .from('web_push_subscriptions')
              .delete()
              .eq('endpoint', sub.endpoint);
          }
          return { endpoint: sub.endpoint, status: 'failed' as const, error: pushErr.message };
        }
      })
    );

    const sent = results.filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ status: string }>).value?.status === 'sent').length;

    // Log delivery
    try {
      await admin.from('notification_log').insert({
        user_id,
        notification_type: tag || 'web_push',
        recipient_email: 'web_push',
        subject: title,
        status: sent > 0 ? 'sent' : 'failed',
        error_message: sent > 0 ? null : 'All subscriptions failed',
      });
    } catch {}

    return res.json({ success: sent > 0, sent, total: subscriptions.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[web-push-send] Error:', message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
