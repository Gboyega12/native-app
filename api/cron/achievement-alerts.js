// ── Achievement Alert Cron Job ──
// Runs every 6 hours (via Vercel Cron).
// Picks up achievements with notified=false and sends notifications
// only for financially meaningful milestones — each with a real £ number.
//
// Valuable achievements (notified):
//   - spending_down_10: "You cut £X/mo from spending — that's £Y/yr"
//   - surplus_doubled:  "Surplus doubled: £X → £Y/mo"
//   - debt_free:        "Last debt cleared"
//   - all_moves_done:   "All moves complete — £X/yr total impact"
//
// All other achievements are marked notified=true silently (no email).
// Gated on checkin_prompts preference (same bucket as nudges).

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl = process.env.APP_URL || 'https://app.bocy.io';

// Only these achievements get a notification — the rest unlock silently
const VALUABLE_KEYS = ['spending_down_10', 'surplus_doubled', 'debt_free', 'all_moves_done'];

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
  const results = { sent: 0, silenced: 0, skipped: 0, failed: 0, errors: [] };

  try {
    // Get all un-notified achievements
    const { data: pending } = await admin
      .from('user_achievements')
      .select('id, user_id, achievement_key, unlocked_at')
      .eq('notified', false);

    if (!pending || pending.length === 0) {
      return res.json({ success: true, message: 'No pending achievements', ...results });
    }

    // Group by user to batch lookups
    const byUser = {};
    for (const ach of pending) {
      if (!byUser[ach.user_id]) byUser[ach.user_id] = [];
      byUser[ach.user_id].push(ach);
    }

    for (const [userId, achievements] of Object.entries(byUser)) {
      try {
        // Split into valuable (send notification) vs silent (just mark notified)
        const valuable = achievements.filter((a) => VALUABLE_KEYS.includes(a.achievement_key));
        const silent = achievements.filter((a) => !VALUABLE_KEYS.includes(a.achievement_key));

        // Mark silent ones as notified immediately
        if (silent.length > 0) {
          await admin
            .from('user_achievements')
            .update({ notified: true })
            .in('id', silent.map((a) => a.id));
          results.silenced += silent.length;
        }

        if (valuable.length === 0) continue;

        // Check notification preference
        const { data: pref } = await admin
          .from('notification_preferences')
          .select('email, checkin_prompts')
          .eq('user_id', userId)
          .single();

        if (!pref || pref.checkin_prompts === false) {
          // Preference off — mark as notified but don't send
          await admin
            .from('user_achievements')
            .update({ notified: true })
            .in('id', valuable.map((a) => a.id));
          results.skipped += valuable.length;
          continue;
        }

        // Get user name + email
        const { data: { user } } = await admin.auth.admin.getUserById(userId);
        const name = user?.user_metadata?.full_name || '';
        const recipientEmail = pref.email
          || user?.email
          || user?.user_metadata?.email
          || user?.identities?.[0]?.identity_data?.email;

        if (!recipientEmail) {
          await admin
            .from('user_achievements')
            .update({ notified: true })
            .in('id', valuable.map((a) => a.id));
          results.skipped += valuable.length;
          continue;
        }

        // Get financial context for building £-based messages
        const { data: analysis } = await admin
          .from('analyses')
          .select('monthly_spending, surplus, all_moves')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        const { data: prevSnapshots } = await admin
          .from('score_history')
          .select('monthly_spending, surplus')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .range(1, 1);

        const prev = prevSnapshots?.[0] || null;

        // Send one notification per valuable achievement
        for (const ach of valuable) {
          try {
            const msg = buildAchievementMessage(ach.achievement_key, {
              name,
              currentSpending: analysis?.monthly_spending || 0,
              previousSpending: prev?.monthly_spending || 0,
              currentSurplus: analysis?.surplus || 0,
              previousSurplus: prev?.surplus || 0,
              allMoves: analysis?.all_moves || [],
            });

            if (!msg) {
              // Shouldn't happen, but mark notified to avoid stuck loop
              await admin
                .from('user_achievements')
                .update({ notified: true })
                .eq('id', ach.id);
              results.silenced++;
              continue;
            }

            const sendRes = await fetch(`${appUrl}/api/notifications/send`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cronSecret || ''}`,
              },
              body: JSON.stringify({
                to: recipientEmail,
                subject: msg.subject,
                html: buildAchievementHtml(msg, name),
                push_body: msg.pushBody,
                user_id: userId,
                notification_type: 'achievement',
              }),
            });

            const sendData = await sendRes.json();
            if (sendData.success) {
              results.sent++;
            } else {
              results.failed++;
              results.errors.push({ user_id: userId, key: ach.achievement_key, error: sendData.error });
            }

            // Mark notified regardless of send success (avoid spam on retry)
            await admin
              .from('user_achievements')
              .update({ notified: true })
              .eq('id', ach.id);
          } catch (achErr) {
            results.failed++;
            results.errors.push({ user_id: userId, key: ach.achievement_key, error: achErr?.message });
            // Still mark notified to prevent retry loops
            await admin
              .from('user_achievements')
              .update({ notified: true })
              .eq('id', ach.id);
          }
        }
      } catch (userErr) {
        results.failed++;
        results.errors.push({ user_id: userId, error: userErr?.message });
      }
    }

    return res.json({ success: true, ...results });
  } catch (err) {
    console.error('[achievement-alerts] Cron failed:', err?.message);
    return res.status(500).json({ success: false, error: err?.message });
  }
}

// ── Build £-based achievement message ──

function buildAchievementMessage(key, ctx) {
  const spendingCut = Math.round(ctx.previousSpending - ctx.currentSpending);
  const annualSaving = Math.round(spendingCut * 12);
  const totalMoveImpact = (ctx.allMoves || []).reduce(
    (sum, m) => sum + (m.monthlyImpact || 0), 0
  );

  switch (key) {
    case 'spending_down_10':
      return {
        headline: 'You cut your spending by 10%+',
        detail: `That's £${spendingCut.toLocaleString()} less per month — £${annualSaving.toLocaleString()} per year back in your pocket.`,
        subject: `You cut £${spendingCut.toLocaleString()}/mo from spending — that's £${annualSaving.toLocaleString()}/yr`,
        pushBody: `You cut £${spendingCut.toLocaleString()}/mo from spending — £${annualSaving.toLocaleString()}/yr saved.`,
      };

    case 'surplus_doubled':
      return {
        headline: 'Your surplus doubled',
        detail: `£${Math.round(ctx.previousSurplus).toLocaleString()}/mo → £${Math.round(ctx.currentSurplus).toLocaleString()}/mo. That's £${Math.round((ctx.currentSurplus - ctx.previousSurplus) * 12).toLocaleString()} more per year.`,
        subject: `Surplus doubled: £${Math.round(ctx.previousSurplus).toLocaleString()} → £${Math.round(ctx.currentSurplus).toLocaleString()}/mo`,
        pushBody: `Surplus doubled to £${Math.round(ctx.currentSurplus).toLocaleString()}/mo — £${Math.round(ctx.currentSurplus * 12).toLocaleString()}/yr.`,
      };

    case 'debt_free':
      return {
        headline: "You're debt free",
        detail: 'Every pound you were paying in interest is now yours. This changes everything.',
        subject: 'Debt free — every pound of interest is now yours',
        pushBody: 'You cleared your last debt. Every pound of interest is now yours.',
      };

    case 'all_moves_done': {
      const annualImpact = Math.round(totalMoveImpact * 12);
      return {
        headline: 'Every move completed',
        detail: annualImpact > 0
          ? `You worked through your entire plan. Total impact: £${annualImpact.toLocaleString()}/year.`
          : 'You worked through every move in your plan. Nice work.',
        subject: annualImpact > 0
          ? `All moves done — £${annualImpact.toLocaleString()}/yr total impact`
          : 'All moves done — your plan is complete',
        pushBody: annualImpact > 0
          ? `All moves complete — £${annualImpact.toLocaleString()}/yr total impact.`
          : 'All moves complete. Your plan is done.',
      };
    }

    default:
      return null;
  }
}

// ── Inline HTML builder ──

function buildAchievementHtml(msg, name) {
  const BRAND = '#00d4aa';
  const BG = '#0A0A0A';
  const SURFACE = '#141414';
  const BORDER = '#1F1F1F';
  const DIM = '#999999';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><style>body{margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff;}</style></head><body>
<div style="max-width:520px;margin:0 auto;padding:32px 24px;">
  <div style="text-align:center;margin-bottom:24px;"><span style="font-size:24px;font-weight:800;">B</span> <span style="color:${DIM};font-size:14px;">Bocy</span></div>
  <div style="background:${SURFACE};border:1px solid ${BRAND}40;border-radius:14px;padding:32px 24px;text-align:center;margin-bottom:16px;">
    <p style="font-size:10px;color:${BRAND};text-transform:uppercase;letter-spacing:2px;margin:0 0 16px;">Milestone</p>
    <h2 style="font-size:18px;margin:0 0 12px;">${msg.headline}</h2>
    <p style="font-size:14px;line-height:22px;color:${DIM};margin:0;">${msg.detail}</p>
  </div>
  <div style="text-align:center;margin-top:32px;padding-top:24px;border-top:1px solid ${BORDER};">
    <p style="color:${DIM};font-size:12px;">You're receiving this because you have a Bocy account.<br>To manage or turn off email notifications, visit your <a href="${appUrl}/profile?section=notifications" style="color:${DIM};">notification settings</a> in the app.</p>
  </div>
</div></body></html>`;
}
