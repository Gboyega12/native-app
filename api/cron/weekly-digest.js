// ── Weekly Digest Cron Job ──
// Runs every Monday at 9am (via Vercel Cron).
// Sends a personalized email digest to each user with:
//   - Decision score + change since last week
//   - Surplus + change
//   - Top spending category
//   - Move progress
//   - New achievements
//   - Streak count
//
// Skips users who have disabled weekly_digest in notification_preferences.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL || 'https://native-app-ashy.vercel.app';

export default async function handler(req, res) {
  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);
  const results = { sent: 0, skipped: 0, failed: 0, errors: [] };

  try {
    // Get all users with notification preferences enabled
    const { data: prefs } = await admin
      .from('notification_preferences')
      .select('user_id, email, weekly_digest')
      .eq('weekly_digest', true);

    if (!prefs || prefs.length === 0) {
      return res.json({ success: true, message: 'No users subscribed to weekly digest', ...results });
    }

    for (const pref of prefs) {
      try {
        // Only send digest to Pro subscribers
        const { data: subRow } = await admin
          .from('user_subscriptions')
          .select('tier, status')
          .eq('user_id', pref.user_id)
          .eq('status', 'active')
          .single();

        if (subRow?.tier !== 'pro') {
          results.skipped++;
          continue;
        }

        // Get latest analysis
        const { data: analysis } = await admin
          .from('analyses')
          .select('decision_score, monthly_income, monthly_spending, surplus, all_moves, discretionary, created_at')
          .eq('user_id', pref.user_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (!analysis) {
          results.skipped++;
          continue;
        }

        // Get previous score snapshot for comparison
        const { data: prevSnapshot } = await admin
          .from('score_history')
          .select('decision_score, surplus')
          .eq('user_id', pref.user_id)
          .order('created_at', { ascending: false })
          .range(1, 1) // Second most recent (skip current)
          .single();

        // Get user name
        const { data: { user } } = await admin.auth.admin.getUserById(pref.user_id);
        const name = user?.user_metadata?.full_name || '';

        // Get move progress
        const { data: progress } = await admin
          .from('plan_progress')
          .select('completed_steps')
          .eq('user_id', pref.user_id);

        const movesCompleted = (progress || []).filter((p) =>
          p.completed_steps && p.completed_steps.length > 0
        ).length;

        // Get new achievements (unlocked in last 7 days)
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const { data: recentAchievements } = await admin
          .from('user_achievements')
          .select('achievement_key, unlocked_at')
          .eq('user_id', pref.user_id)
          .gte('unlocked_at', weekAgo.toISOString());

        // Get streak
        const { data: streakRow } = await admin
          .from('user_streaks')
          .select('current_streak')
          .eq('user_id', pref.user_id)
          .single();

        // Find top spending category
        const disc = analysis.discretionary;
        const items = disc?.items || [];
        const topCat = items.length > 0
          ? items.reduce((a, b) => (a.monthly > b.monthly ? a : b))
          : null;

        // Build and send email
        const allMoves = analysis.all_moves || [];
        const topMove = allMoves[0] || null;

        // Achievement definitions (inline to avoid import in JS)
        const ACHIEVEMENT_MAP = {
          first_analysis: { name: 'First Look', description: 'Completed your first financial analysis', icon: 'B' },
          goals_set: { name: 'Goal Setter', description: 'Set your financial goals', icon: 'G' },
          first_override: { name: 'Sharp Eye', description: 'Corrected a transaction category', icon: 'E' },
          first_plan: { name: 'Action Taker', description: 'Approved your first financial plan', icon: 'P' },
          score_up_5: { name: 'Momentum', description: 'Decision score improved by 5+ points', icon: '+' },
          score_up_10: { name: 'Serious Progress', description: 'Decision score improved by 10+ points', icon: '!' },
          score_up_20: { name: 'Transformation', description: 'Decision score improved by 20+ points', icon: '*' },
          spending_down_10: { name: 'Trimmer', description: 'Reduced monthly spending by 10%+', icon: '-' },
          surplus_doubled: { name: 'Surplus Surge', description: 'Doubled your monthly surplus', icon: '2' },
          streak_7: { name: 'Week Warrior', description: 'Used Bocy 7 days in a row', icon: '7' },
          streak_30: { name: 'Monthly Habit', description: 'Used Bocy for 30 days', icon: '3' },
          debt_free: { name: 'Debt Free', description: 'Zero outstanding debt accounts', icon: '0' },
          savings_rate_10: { name: 'Saver', description: 'Savings rate reached 10%+', icon: 'S' },
          score_strong: { name: 'Strong Position', description: 'Decision score reached 75+', icon: 'A' },
        };

        const newAchievementDefs = (recentAchievements || [])
          .map((a) => ACHIEVEMENT_MAP[a.achievement_key])
          .filter(Boolean);

        const scoreChange = prevSnapshot ? analysis.decision_score - prevSnapshot.decision_score : 0;
        const surplusChange = prevSnapshot ? analysis.surplus - prevSnapshot.surplus : 0;

        // Use the send endpoint
        const sendRes = await fetch(`${appUrl}/api/notifications/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cronSecret || ''}`,
          },
          body: JSON.stringify({
            to: pref.email,
            subject: `Your score: ${analysis.decision_score} ${scoreChange >= 0 ? '\u2191' : '\u2193'}${Math.abs(scoreChange)} — Bocy Weekly`,
            html: buildDigestHtml({
              name,
              decisionScore: analysis.decision_score,
              scoreChange,
              monthlyIncome: analysis.monthly_income,
              monthlySpending: analysis.monthly_spending,
              surplus: analysis.surplus,
              surplusChange,
              topCategory: topCat?.category || 'N/A',
              topCategoryAmount: topCat?.monthly || 0,
              movesCompleted,
              totalMoves: allMoves.length,
              topMove: topMove?.action || null,
              topMoveImpact: topMove?.monthlyImpact || 0,
              newAchievements: newAchievementDefs,
              streakDays: streakRow?.current_streak || 0,
            }),
            user_id: pref.user_id,
            notification_type: 'weekly_digest',
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
      } catch (userErr) {
        results.failed++;
        results.errors.push({ user_id: pref.user_id, error: userErr?.message });
      }
    }

    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('[weekly-digest] Cron failed:', err?.message);
    return res.status(500).json({ success: false, error: err?.message });
  }
}

// ── Inline HTML builder (avoids TS import issues in JS cron) ──
function buildDigestHtml(data) {
  const BRAND = '#00d4aa';
  const BG = '#0A0A0A';
  const SURFACE = '#141414';
  const BORDER = '#1F1F1F';
  const DIM = '#999999';

  const scoreColor = data.scoreChange > 0 ? BRAND : data.scoreChange < 0 ? '#E05252' : DIM;
  const scoreArrow = data.scoreChange > 0 ? '\u2191' : data.scoreChange < 0 ? '\u2193' : '\u2192';
  const surplusColor = data.surplusChange > 0 ? BRAND : data.surplusChange < 0 ? '#E05252' : DIM;

  const achievements = data.newAchievements.length > 0
    ? `<div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:24px;margin-bottom:16px;">
        <h2 style="font-size:18px;margin:0 0 16px;">New achievements</h2>
        ${data.newAchievements.map((a) => `
          <div style="margin-bottom:12px;">
            <span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;background:${BRAND}20;color:${BRAND};border:1px solid ${BRAND}40;border-radius:50%;font-weight:700;margin-right:12px;vertical-align:middle;">${a.icon}</span>
            <strong>${a.name}</strong> <span style="color:${DIM};font-size:12px;">${a.description}</span>
          </div>
        `).join('')}
      </div>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><style>body{margin:0;padding:0;background:${BG};font-family:-apple-system,sans-serif;color:#fff;}</style></head><body>
<div style="max-width:520px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:24px;"><span style="font-size:24px;font-weight:800;">B</span> <span style="color:${DIM};font-size:14px;">Bocy</span></div>
  <div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:24px;margin-bottom:16px;">
    <h2 style="font-size:18px;margin:0 0 16px;">Hi ${data.name || 'there'}, here's your week</h2>
    <div style="text-align:center;padding:16px 0;">
      <div style="display:inline-block;text-align:center;padding:0 16px;">
        <div style="font-size:28px;font-weight:700;">${data.decisionScore}</div>
        <div style="font-size:11px;color:${DIM};text-transform:uppercase;">Score <span style="color:${scoreColor};">${scoreArrow}${Math.abs(data.scoreChange)}</span></div>
      </div>
      <div style="display:inline-block;text-align:center;padding:0 16px;">
        <div style="font-size:28px;font-weight:700;">\u00a3${Math.round(data.surplus).toLocaleString()}</div>
        <div style="font-size:11px;color:${DIM};text-transform:uppercase;">Surplus <span style="color:${surplusColor};">${data.surplusChange >= 0 ? '+' : ''}\u00a3${Math.round(data.surplusChange).toLocaleString()}</span></div>
      </div>
    </div>
    <div style="height:6px;background:${BORDER};border-radius:3px;margin:8px 0;">
      <div style="height:6px;width:${data.decisionScore}%;background:${BRAND};border-radius:3px;"></div>
    </div>
    <hr style="border:none;border-top:1px solid ${BORDER};margin:20px 0;">
    <p style="font-size:14px;line-height:22px;">
      <strong>Top spending:</strong> ${data.topCategory} at \u00a3${Math.round(data.topCategoryAmount).toLocaleString()}/mo<br>
      <strong>Moves completed:</strong> ${data.movesCompleted} of ${data.totalMoves}
      ${data.streakDays > 0 ? `<br><strong>Active days:</strong> ${data.streakDays} day streak` : ''}
    </p>
  </div>
  ${achievements}
  ${data.topMove ? `<div style="background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:24px;margin-bottom:16px;">
    <h2 style="font-size:18px;margin:0 0 12px;">Your top move</h2>
    <p style="font-size:14px;line-height:22px;">${data.topMove}</p>
    <p style="color:${BRAND};font-weight:600;">\u00a3${Math.round(data.topMoveImpact * 12).toLocaleString()}/year impact</p>
  </div>` : ''}
  <div style="text-align:center;margin-top:24px;padding-top:24px;border-top:1px solid ${BORDER};">
    <p style="color:${DIM};font-size:12px;">You're receiving this because you have a Bocy account.</p>
  </div>
</div></body></html>`;
}
