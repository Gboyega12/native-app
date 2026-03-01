// ── Daily Spending Nudge Cron Job ──
// Runs daily at 7pm (via Vercel Cron).
// Sends a contextual spending update based on real transaction data:
//   - How much the user has spent today and this week
//   - How much of their weekly budget remains
//   - Encouragement or a gentle nudge depending on pace
//
// Example messages:
//   "You spent £45 today. That's £120 of your £200 weekly budget used
//    with 3 days left — you're on track."
//   "Heads up — you've used £180 of your £200 weekly budget and it's
//    only Wednesday. You have £20 left for the rest of the week."

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL || 'https://app.bocy.io';

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const results = { sent: 0, skipped: 0 };

  try {
    // Get users with check-in prompts enabled (spending updates use the same preference)
    const { data: prefs } = await admin
      .from('notification_preferences')
      .select('user_id, email, checkin_prompts')
      .eq('checkin_prompts', true);

    if (!prefs || prefs.length === 0) {
      return res.json({ success: true, message: 'No users subscribed', ...results });
    }

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const dayOfWeek = now.getDay(); // 0=Sun
    const dayName = DAYS_OF_WEEK[dayOfWeek];

    // Calculate week start (Monday)
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diff);
    weekStart.setHours(0, 0, 0, 0);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    // Days remaining in the week (Mon=start, Sun=end)
    const daysIntoWeek = diff + 1; // 1 on Monday, 7 on Sunday
    const daysRemaining = 7 - daysIntoWeek;

    for (const pref of prefs) {
      try {
        // Rate limit: don't send a daily spending nudge if we already sent one today
        const { data: recentNotif } = await admin
          .from('notification_log')
          .select('id')
          .eq('user_id', pref.user_id)
          .eq('notification_type', 'daily_spending')
          .gte('sent_at', todayStr + 'T00:00:00Z')
          .limit(1);

        if (recentNotif && recentNotif.length > 0) {
          results.skipped++;
          continue;
        }

        // Get latest analysis for weekly budget
        const { data: analysis } = await admin
          .from('analyses')
          .select('surplus, monthly_income, monthly_spending, non_discretionary, discretionary, income_floor, is_variable_income')
          .eq('user_id', pref.user_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (!analysis) {
          results.skipped++;
          continue;
        }

        // Calculate weekly budget
        const rawIncome = analysis.monthly_income || 0;
        const income = analysis.is_variable_income && analysis.income_floor
          ? analysis.income_floor
          : rawIncome;
        const nonDiscTotal = analysis.non_discretionary?.total || 0;
        const discTotal = analysis.discretionary?.total || 0;
        const leftToDecide = Math.max(0, income - nonDiscTotal - discTotal);
        const weeklyBudget = Math.round(leftToDecide / 4.33);

        // If no meaningful budget, skip
        if (weeklyBudget <= 0) {
          results.skipped++;
          continue;
        }

        // Get this week's transactions from stored CSV
        const { data: bankRows } = await admin
          .from('bank_data')
          .select('csv_data')
          .eq('user_id', pref.user_id)
          .order('created_at', { ascending: false });

        if (!bankRows || bankRows.length === 0) {
          results.skipped++;
          continue;
        }

        // Parse CSV to find this week's spending
        let spentToday = 0;
        let spentThisWeek = 0;
        for (const row of bankRows) {
          if (!row.csv_data) continue;
          const lines = row.csv_data.split('\n');
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = line.split(',');
            if (parts.length < 3) continue;
            const txDate = parts[0].trim();
            const amount = parseFloat(parts[parts.length - 1]) || 0;

            // Only count spending (negative amounts)
            if (amount >= 0) continue;

            if (txDate >= weekStartStr && txDate <= todayStr) {
              spentThisWeek += Math.abs(amount);
            }
            if (txDate === todayStr) {
              spentToday += Math.abs(amount);
            }
          }
        }

        spentToday = Math.round(spentToday);
        spentThisWeek = Math.round(spentThisWeek);
        const remaining = Math.max(0, weeklyBudget - spentThisWeek);
        const usedPct = weeklyBudget > 0 ? Math.round((spentThisWeek / weeklyBudget) * 100) : 0;

        // Build contextual message
        let message;
        let emoji = '';

        if (usedPct <= 50 && daysIntoWeek >= 3) {
          // Under budget, well into the week — positive reinforcement
          emoji = 'on-track';
          message = `You've spent \u00a3${spentThisWeek} of your \u00a3${weeklyBudget} weekly budget so far. That's only ${usedPct}% with ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''} left — you're doing great this week.`;
        } else if (usedPct <= 75) {
          // Normal pace
          emoji = 'steady';
          const dailyRemaining = daysRemaining > 0 ? Math.round(remaining / daysRemaining) : remaining;
          message = `It's ${dayName} and you've spent \u00a3${spentThisWeek} of your \u00a3${weeklyBudget} weekly budget. You have \u00a3${remaining} left — about \u00a3${dailyRemaining}/day for the rest of the week.`;
        } else if (usedPct <= 100) {
          // Getting close to budget
          emoji = 'caution';
          message = `Heads up — you've used ${usedPct}% of your \u00a3${weeklyBudget} weekly budget (\u00a3${spentThisWeek} spent). You have \u00a3${remaining} left${daysRemaining > 0 ? ` for ${daysRemaining} more day${daysRemaining !== 1 ? 's' : ''}` : ' for the rest of today'}. Want to chat about where to save this week?`;
        } else {
          // Over budget
          const overBy = spentThisWeek - weeklyBudget;
          emoji = 'over';
          message = `You've gone \u00a3${overBy} over your \u00a3${weeklyBudget} weekly budget this week (\u00a3${spentThisWeek} total). It happens — let's look at what drove the extra spending and find a way to balance it out next week.`;
        }

        // Add today's spend if meaningful
        if (spentToday > 0 && usedPct <= 100) {
          message = `You spent \u00a3${spentToday} today. ` + message;
        }

        // Get user name
        const { data: { user } } = await admin.auth.admin.getUserById(pref.user_id);
        const name = user?.user_metadata?.full_name?.split(' ')[0] || '';

        // Build email
        const BRAND = '#00d4aa';
        const BG = '#0A0A0A';
        const SURFACE = '#141414';
        const BORDER = '#1F1F1F';
        const DIM = '#999999';

        const barColor = usedPct <= 75 ? BRAND : usedPct <= 100 ? '#F5A623' : '#E05252';
        const barWidth = Math.min(usedPct, 100);

        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><style>body{margin:0;padding:0;background:${BG};font-family:-apple-system,sans-serif;color:#fff;}</style></head><body>
<div style="max-width:520px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:24px;"><span style="font-size:24px;font-weight:800;">B</span> <span style="color:${DIM};font-size:14px;">Bocy</span></div>
  <div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:24px;">
    <p style="font-size:14px;line-height:22px;margin:0 0 8px;">Hi ${name || 'there'},</p>
    <p style="font-size:14px;line-height:22px;margin:0 0 16px;">${message}</p>
    <div style="display:flex;justify-content:space-between;font-size:12px;color:${DIM};margin-bottom:6px;">
      <span>\u00a3${spentThisWeek} spent</span>
      <span>\u00a3${weeklyBudget} budget</span>
    </div>
    <div style="height:8px;background:${BORDER};border-radius:4px;">
      <div style="height:8px;width:${barWidth}%;background:${barColor};border-radius:4px;"></div>
    </div>
    <div style="text-align:center;margin-top:20px;">
      <a href="${appUrl}" style="display:inline-block;background:${BRAND};color:${BG};padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">Open Bocy</a>
    </div>
  </div>
  <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid ${BORDER};">
    <p style="color:${DIM};font-size:12px;">You're receiving this because you have a Bocy account.<br>To manage or turn off email notifications, visit your <a href="${appUrl}/profile?section=notifications" style="color:${DIM};">notification settings</a> in the app.</p>
  </div>
</div></body></html>`;

        // Send notification via multi-channel endpoint
        await fetch(`${appUrl}/api/notifications/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cronSecret || ''}`,
          },
          body: JSON.stringify({
            to: pref.email,
            subject: usedPct <= 75
              ? `\u00a3${remaining} left this week — you're on track`
              : usedPct <= 100
              ? `\u00a3${remaining} left of your \u00a3${weeklyBudget} weekly budget`
              : `Over budget this week — let's rebalance`,
            html,
            user_id: pref.user_id,
            notification_type: 'daily_spending',
          }),
        });

        results.sent++;
      } catch (userErr) {
        console.warn(`[daily-spending] Failed for user ${pref.user_id}:`, userErr?.message);
        results.skipped++;
      }
    }

    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('[daily-spending] Cron failed:', err?.message);
    return res.status(500).json({ success: false, error: err?.message });
  }
}
