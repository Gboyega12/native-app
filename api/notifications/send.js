// ── Send Email Notification ──
// Generic email sender endpoint. Uses Resend API.
// Called by cron jobs and achievement triggers.
//
// When building for iOS/Android, add push notification delivery here too.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify internal call (cron secret or service key)
  const authHeader = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, subject, html, user_id, notification_type } = req.body;
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, html' });
  }

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
        from: process.env.EMAIL_FROM || 'Bocy <notifications@bocy.app>',
        to: [to],
        subject,
        html,
      }),
    });

    const data = await response.json();

    // Log to notification_log table
    if (user_id && serviceKey) {
      try {
        const admin = createClient(supabaseUrl, serviceKey);
        await admin.from('notification_log').insert({
          user_id,
          notification_type: notification_type || 'general',
          recipient_email: to,
          subject,
          status: response.ok ? 'sent' : 'failed',
          error_message: response.ok ? null : JSON.stringify(data),
        });
      } catch (logErr) {
        console.warn('[notifications] Failed to log notification:', logErr?.message);
      }
    }

    if (!response.ok) {
      console.warn('[notifications] Resend API error:', data);
      return res.json({ success: false, error: data?.message || 'send_failed' });
    }

    return res.json({ success: true, id: data.id });
  } catch (err) {
    console.error('[notifications] Send failed:', err?.message);
    return res.json({ success: false, error: err?.message || 'request_failed' });
  }
}
