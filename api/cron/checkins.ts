// ── Proactive Check-in Cron Job ──
// Runs weekly on Thursday at 12 noon (via Vercel Cron).
// Sends a contextual nudge to Pro users. If a specific trigger fires
// (spending spike, inactivity, milestone) the message is tailored.
// Otherwise a general daily financial check-in is sent so the 12 noon
// notification always arrives.
//
// Check-in triggers (in priority order):
//   1. Surplus drop: Surplus dropped significantly since last snapshot
//   2. Spending spike: A category jumped 30%+ vs. last period
//   3. Plan stale: User has moves but hasn't opened app in 3+ days
//   4. Milestone approaching: Close to a savings/debt goal
//   5. Fallback: General daily financial summary (always fires)

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL || 'https://app.bocy.io';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers.authorization as string) || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);
  const results = { sent: 0, skipped: 0, failed: 0, errors: [] as Array<{ user_id: string; error: string }> };

  try {
    // Get users with check-in prompts enabled
    const { data: prefs } = await admin
      .from('notification_preferences')
      .select('user_id, email, checkin_prompts')
      .eq('checkin_prompts', true);

    if (!prefs || prefs.length === 0) {
      return res.json({ success: true, message: 'No users subscribed to check-ins', ...results });
    }

    const now = new Date();
    // Cooldown: don't send if we already sent a check-in today
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    for (const pref of prefs) {
      try {
        // Send check-ins to active subscribers and trial users
        const { data: subRow } = await admin
          .from('user_subscriptions')
          .select('tier, status')
          .eq('user_id', pref.user_id)
          .eq('status', 'active')
          .maybeSingle();

        const isSubscribed = subRow?.tier === 'pro';

        // If not subscribed, check if still in 14-day trial
        if (!isSubscribed) {
          const { data: { user: authUser } } = await admin.auth.admin.getUserById(pref.user_id);
          if (!authUser) { results.skipped++; continue; }
          const created = new Date(authUser.created_at);
          const trialEnd = new Date(created.getTime() + 14 * 24 * 60 * 60 * 1000);
          if (new Date() >= trialEnd) { results.skipped++; continue; }
        }

        // Check if we already sent a check-in today (1-per-day limit)
        const { data: recentNotif } = await admin
          .from('notification_log')
          .select('id')
          .eq('user_id', pref.user_id)
          .eq('notification_type', 'checkin')
          .gte('sent_at', todayStart.toISOString())
          .limit(1);

        if (recentNotif && recentNotif.length > 0) {
          results.skipped++;
          continue;
        }

        // Get latest + previous score snapshots
        const { data: snapshots } = await admin
          .from('score_history')
          .select('decision_score, monthly_spending, surplus, savings_rate, created_at')
          .eq('user_id', pref.user_id)
          .order('created_at', { ascending: false })
          .limit(2);

        if (!snapshots || snapshots.length === 0) {
          results.skipped++;
          continue;
        }

        const current = snapshots[0];
        const previous = snapshots.length > 1 ? snapshots[1] : null;

        // Get user info (name + email fallback for Google OAuth users)
        const { data: { user } } = await admin.auth.admin.getUserById(pref.user_id);
        const name: string = user?.user_metadata?.full_name?.split(' ')[0] || '';
        const recipientEmail: string | undefined = pref.email
          || user?.email
          || user?.user_metadata?.email
          || user?.identities?.[0]?.identity_data?.email;
        if (!recipientEmail) {
          results.skipped++;
          continue;
        }

        // Get last activity
        const { data: lastChat } = await admin
          .from('chat_messages')
          .select('updated_at')
          .eq('user_id', pref.user_id)
          .single();

        const lastActive = lastChat?.updated_at ? new Date(lastChat.updated_at) : null;
        const daysSinceActive = lastActive
          ? Math.floor((now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24))
          : 999;

        // ── Determine check-in message ──
        let message: string | null = null;

        // 1. Surplus drop
        if (previous && previous.surplus > 0 && current.surplus < previous.surplus * 0.7) {
          const drop = Math.round(previous.surplus - current.surplus);
          message = `Your surplus dropped by \u00a3${drop} recently. This usually happens when spending increases or income changes. Want to look at what shifted and find a quick fix?`;
        }

        // 2. Spending spike
        else if (previous && previous.monthly_spending > 0) {
          const spike = (current.monthly_spending - previous.monthly_spending) / previous.monthly_spending;
          if (spike >= 0.3) {
            const increase = Math.round(spike * 100);
            message = `Your spending jumped ${increase}% compared to last period. Let's take a look at what's driving the increase \u2014 there might be an easy win hiding in there.`;
          }
        }

        // 3. Inactive with pending moves
        else if (daysSinceActive >= 3) {
          const { data: analysis } = await admin
            .from('analyses')
            .select('all_moves')
            .eq('user_id', pref.user_id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

          const moves: unknown[] = analysis?.all_moves || [];
          const { data: progress } = await admin
            .from('plan_progress')
            .select('move_key')
            .eq('user_id', pref.user_id)
            .eq('approved', true);

          const startedCount = progress?.length || 0;
          const unstartedCount = moves.length - startedCount;

          if (unstartedCount > 0) {
            message = `You've got ${unstartedCount} move${unstartedCount !== 1 ? 's' : ''} waiting that could save you money. The best one takes less than 10 minutes. Ready to knock it out?`;
          } else if (daysSinceActive >= 7) {
            message = `Haven't seen you in a while! Your financial data has been refreshing in the background. Come take a look at how things have changed.`;
          }
        }

        // 4. Approaching savings milestone
        else if (current.savings_rate >= 8 && current.savings_rate < 10) {
          message = `You're at a ${Math.round(current.savings_rate)}% savings rate \u2014 just a small push from hitting 10%. That's a major milestone. Let's see what can get you there.`;
        }

        // Fallback: if no specific condition triggered, send a general daily
        // check-in so the 12 noon notification always arrives for Pro users.
        if (!message) {
          const surplus = current.surplus;
          if (surplus >= 300) {
            message = `You've got \u00a3${Math.round(surplus)} surplus this month \u2014 your finances are in a strong position. Want to see if there's a new move worth trying?`;
          } else if (surplus >= 0) {
            message = `You've got \u00a3${Math.round(surplus)} surplus this month. There's room to grow \u2014 want to take a quick look at what could stretch that further?`;
          } else {
            message = `You're running a \u00a3${Math.round(Math.abs(surplus))} deficit this month. A few targeted moves could start turning things around. Want to take a look?`;
          }
        }

        // Send check-in email
        const BRAND = '#00d4aa';
        const BG = '#0A0A0A';
        const SURFACE = '#141414';
        const BORDER = '#1F1F1F';
        const DIM = '#999999';

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><style>body{margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff;}</style></head><body>
<div style="max-width:520px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:24px;"><span style="font-size:24px;font-weight:800;">B</span> <span style="color:${DIM};font-size:14px;">Bocy</span></div>
  <div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:24px;">
    <p style="font-size:14px;line-height:22px;">Hi ${name || 'there'},</p>
    <p style="font-size:14px;line-height:22px;">${message}</p>
    <div style="text-align:center;margin-top:20px;">
      <a href="${appUrl}" style="display:inline-block;background:${BRAND};color:${BG};padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">Chat with Bocy</a>
    </div>
  </div>
  <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid ${BORDER};">
    <p style="color:${DIM};font-size:12px;">You're receiving this because you have a Bocy account.<br>To manage or turn off email notifications, visit your <a href="${appUrl}/profile?section=notifications" style="color:${DIM};">notification settings</a> in the app.</p>
  </div>
</div></body></html>`;

        const sendRes = await fetch(`${appUrl}/api/notifications/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cronSecret || ''}`,
          },
          body: JSON.stringify({
            to: recipientEmail,
            subject: 'Bocy has a suggestion for you',
            html,
            push_body: message,
            user_id: pref.user_id,
            notification_type: 'checkin',
          }),
        });

        const sendData = await sendRes.json();
        if (sendData.success) {
          results.sent++;
        } else if (sendData.skipped) {
          results.skipped++;
        } else {
          results.failed++;
          results.errors.push({ user_id: pref.user_id, error: sendData.error });
        }
      } catch (userErr: unknown) {
        const message = userErr instanceof Error ? userErr.message : String(userErr);
        console.warn(`[checkins] Failed for user ${pref.user_id}:`, message);
        results.failed++;
        results.errors.push({ user_id: pref.user_id, error: message });
      }
    }

    return res.json({ success: true, ...results });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[checkins] Cron failed:', message);
    return res.status(500).json({ success: false, error: message });
  }
}
