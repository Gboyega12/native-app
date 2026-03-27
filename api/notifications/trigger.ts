// ── Notification Triggers ──
// Evaluates user financial state and sends push notifications for:
//   1. Payday alerts (income arrival)
//   2. Spending limit warnings (50% threshold)
//   3. Growth engine time-sensitive alerts (tax deadlines, ISA allowance)
//
// POST body: { user_id }
// Called after sync or analysis refresh.

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:notifications@updates.bocy.io';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const webPush = require('web-push') as {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string): Promise<{ statusCode: number }>;
};

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

async function sendPushToUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  notification: { title: string; body: string; url?: string; tag: string },
) {
  const { data: subscriptions } = await admin
    .from('web_push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_id', userId);

  if (!subscriptions?.length) return { sent: 0 };

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    icon: '/assets/images/icon.png',
    data: { url: notification.url || '/' },
    tag: notification.tag,
  });

  let sent = 0;
  for (const sub of subscriptions) {
    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent++;
    } catch (err: unknown) {
      const pushErr = err as { statusCode?: number };
      if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
        await admin.from('web_push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
    }
  }

  // Log
  try {
    await admin.from('notification_log').insert({
      user_id: userId,
      notification_type: notification.tag,
      recipient_email: 'web_push',
      subject: notification.title,
      status: sent > 0 ? 'sent' : 'failed',
    });
  } catch {}

  return { sent };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // Auth: accept user JWT or CRON_SECRET
  const authHeader = (req.headers.authorization as string) || '';
  const cronSecret = process.env.CRON_SECRET;
  let userId: string | null = null;

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    userId = req.body?.user_id;
  } else if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    const supabase = createClient(supabaseUrl, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '');
    const { data: { user } } = await supabase.auth.getUser(token);
    userId = user?.id || null;
  }

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.json({ success: false, error: 'vapid_not_configured', triggered: [] });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const triggered: string[] = [];

  try {
    // Fetch user's latest analysis
    const { data: analysisRow } = await admin
      .from('financial_analysis')
      .select('analysis')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const analysis = analysisRow?.analysis;
    if (!analysis) {
      return res.json({ success: true, triggered: [], reason: 'no_analysis' });
    }

    // Fetch notification state to avoid duplicate alerts
    const { data: notifState } = await admin
      .from('notification_state')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    const state = notifState || {};

    // ── 1. Payday Alert ──
    const incomeEvents = Array.isArray(analysis.recent_income_events)
      ? analysis.recent_income_events
      : [];
    if (incomeEvents.length > 0) {
      const latestIncome = incomeEvents[0];
      const incomeFingerprint = incomeEvents
        .map((e: any) => `${e?.source}:${Math.round(e?.amount ?? 0)}`)
        .sort()
        .join('|');

      if (incomeFingerprint && incomeFingerprint !== state.last_income_fingerprint) {
        const amount = Math.round(latestIncome?.amount ?? 0);
        await sendPushToUser(admin, userId, {
          title: 'Payday Alert',
          body: `Your salary of \u00a3${amount.toLocaleString()} has arrived. Tap to see your plan.`,
          url: '/',
          tag: 'income_arrival',
        });
        triggered.push('payday');

        // Update state
        await admin.from('notification_state').upsert({
          user_id: userId,
          last_income_fingerprint: incomeFingerprint,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 2. Spending Limit Warning (50% threshold) ──
    const weeklyBudget = analysis.weekly_budget ?? 0;
    const spentThisWeek = analysis.spent_this_week ?? 0;

    if (weeklyBudget > 0) {
      const spentPct = (spentThisWeek / weeklyBudget) * 100;
      const lastSpendingPct = state.last_spending_pct ?? 0;

      // Trigger when crossing 50% and haven't already notified for this threshold
      if (spentPct >= 50 && lastSpendingPct < 50) {
        const remaining = Math.max(0, Math.round(weeklyBudget - spentThisWeek));
        await sendPushToUser(admin, userId, {
          title: 'Spending Alert',
          body: `You've used ${Math.round(spentPct)}% of your weekly budget. \u00a3${remaining.toLocaleString()} left to spend.`,
          url: '/',
          tag: 'spending_limit',
        });
        triggered.push('spending_50pct');

        await admin.from('notification_state').upsert({
          user_id: userId,
          last_spending_pct: Math.round(spentPct),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 3. Growth Engine: Tax Season Alerts ──
    const now = new Date();
    const currentMonth = now.getMonth(); // 0-indexed
    const currentDay = now.getDate();

    // ISA deadline: April 5th - alert in March
    if (currentMonth === 2 && !state.isa_deadline_notified_year?.toString().includes(String(now.getFullYear()))) {
      const isaAllowance = 20000;
      const investmentTotal = Array.isArray(analysis.investments)
        ? analysis.investments.reduce((sum: number, inv: any) => {
            if (inv?.asset_class === 'isa' || inv?.name?.toLowerCase().includes('isa')) {
              return sum + (inv.current_value || 0);
            }
            return sum;
          }, 0)
        : 0;

      const isaRemaining = Math.max(0, isaAllowance - investmentTotal);

      if (isaRemaining > 0) {
        await sendPushToUser(admin, userId, {
          title: 'Tax Season Ending Soon',
          body: `You have \u00a3${isaRemaining.toLocaleString()} ISA allowance remaining. Use it before April 5th to maximise tax-free savings.`,
          url: '/(main)/(tabs)/chat?context=tax_optimisation_isa',
          tag: 'tax_isa_deadline',
        });
        triggered.push('isa_deadline');

        await admin.from('notification_state').upsert({
          user_id: userId,
          isa_deadline_notified_year: String(now.getFullYear()),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // Self Assessment deadline: January 31st - alert in January
    if (currentMonth === 0 && currentDay <= 28 && !state.sa_deadline_notified_year?.toString().includes(String(now.getFullYear()))) {
      await sendPushToUser(admin, userId, {
        title: 'Self Assessment Deadline',
        body: 'The Self Assessment tax return deadline is January 31st. Tap for help with your tax optimisation.',
        url: '/(main)/(tabs)/chat?context=tax_self_assessment',
        tag: 'tax_sa_deadline',
      });
      triggered.push('sa_deadline');

      await admin.from('notification_state').upsert({
        user_id: userId,
        sa_deadline_notified_year: String(now.getFullYear()),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    }

    return res.json({ success: true, triggered });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[notification-trigger] Error:', message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
