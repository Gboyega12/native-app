// ── Send Notification (Email + Web Push) ──
// Multi-channel notification endpoint. Sends email via Resend API and
// web push via the web-push library (direct call, no HTTP round-trip).
// Called by cron jobs and achievement triggers.

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import webPush from 'web-push';
import sanitizeHtml from 'sanitize-html';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const bodySchema = z.object({
  to: z.string(),
  subject: z.string(),
  html: z.string(),
  user_id: z.string().optional(),
  notification_type: z.string().optional(),
  push_body: z.string().optional(),
});

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:notifications@updates.bocy.io';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

/** Strip HTML tags and decode common entities to get plain text. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify internal call (cron secret or service key)
  const authHeader = (req.headers.authorization as string) || '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
  }
  const { to, subject, html: rawHtml, user_id, notification_type, push_body } = parsed.data;

  // Sanitize HTML to prevent injection attacks
  const html = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'style']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      '*': ['style', 'class'],
      img: ['src', 'alt', 'width', 'height'],
      a: ['href', 'target', 'rel'],
    },
    allowedSchemes: ['https', 'mailto'],
  });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('[notifications] RESEND_API_KEY not configured — email skipped');
    return res.json({ success: false, error: 'email_not_configured', skipped: true });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`,
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Bocy <notifications@updates.bocy.io>',
        to: [to],
        subject,
        html,
      }),
    });

    const data = await response.json();

    // Log to notification_log table
    const admin = (user_id && serviceKey) ? createClient(supabaseUrl!, serviceKey) : null;
    if (admin) {
      try {
        await admin.from('notification_log').insert({
          user_id,
          notification_type: notification_type || 'general',
          recipient_email: to,
          subject,
          status: response.ok ? 'sent' : 'failed',
          error_message: response.ok ? null : JSON.stringify(data),
        });
      } catch (logErr: unknown) {
        const message = logErr instanceof Error ? logErr.message : String(logErr);
        console.warn('[notifications] Failed to log notification:', message);
      }
    }

    if (!response.ok) {
      console.warn('[notifications] Resend API error:', data);
      return res.json({ success: false, error: data?.message || 'send_failed' });
    }

    // Also deliver via web push if user_id is provided
    let webPushResult: { success: boolean; sent?: number; total?: number; error?: string; count?: number } | null = null;
    if (user_id && admin && VAPID_PUBLIC && VAPID_PRIVATE) {
      try {
        // Fetch all active web push subscriptions for this user
        const { data: subscriptions, error: subErr } = await admin
          .from('web_push_subscriptions')
          .select('endpoint, p256dh, auth')
          .eq('user_id', user_id);

        if (!subErr && subscriptions?.length > 0) {
          // Use push_body if provided, otherwise extract readable text from HTML
          const pushBodyText = push_body || htmlToPlainText(html);

          const payload = JSON.stringify({
            title: subject,
            body: pushBodyText,
            icon: '/assets/images/icon.png',
            data: { url: '/' },
            tag: notification_type || 'bocy-notification',
          });

          const results = await Promise.allSettled(
            subscriptions.map(async (sub: { endpoint: string; p256dh: string; auth: string }) => {
              try {
                await webPush.sendNotification(
                  { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                  payload,
                );
                return { endpoint: sub.endpoint, status: 'sent' as const };
              } catch (err: unknown) {
                const pushErr = err as { statusCode?: number; message?: string };
                // 410 Gone or 404 = subscription expired, clean it up
                if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
                  await admin.from('web_push_subscriptions').delete().eq('endpoint', sub.endpoint);
                }
                return { endpoint: sub.endpoint, status: 'failed' as const, error: pushErr.message };
              }
            })
          );

          const sent = results.filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ status: string }>).value?.status === 'sent').length;
          webPushResult = { success: sent > 0, sent, total: subscriptions.length };

          // Log web push delivery
          try {
            await admin.from('notification_log').insert({
              user_id,
              notification_type: (notification_type || 'general') + '_web_push',
              recipient_email: to,
              subject,
              status: sent > 0 ? 'sent' : 'failed',
              error_message: sent > 0 ? null : 'All web push subscriptions failed',
            });
          } catch {}
        } else {
          webPushResult = { success: false, error: 'no_subscriptions', count: 0 };
        }
      } catch (pushErr: unknown) {
        const message = pushErr instanceof Error ? pushErr.message : String(pushErr);
        console.warn('[notifications] Web push delivery failed:', message);
        webPushResult = { success: false, error: message };
      }
    }

    return res.json({ success: true, id: data.id, web_push: webPushResult });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[notifications] Send failed:', message);
    return res.json({ success: false, error: message || 'request_failed' });
  }
}
