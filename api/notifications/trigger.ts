// ── Notification Triggers ──
// Evaluates user financial state and sends push notifications for:
//   1. Payday alerts (income arrival)
//   2. Spending limit warnings (50% threshold)
//   3. Growth engine time-sensitive alerts (tax deadlines, ISA allowance)
//   4. Unusual spending spike (category 2x weekly average)
//   5. Surplus milestone (first £100, £500, £1000)
//   6. Debt payoff countdown (< 3 months remaining)
//   7. Move reminder (approved but not started after 7 days)
//   8. Weekly spending recap (Sunday summary)
//   9. Savings rate milestone (10%, 20%, 30%)
//  10. Capital Gains Tax deadline (December alert)
//  11. Pension annual allowance (March alert)
//  12. Bank of England rate change (rate decision days)
//  13. Council tax new year (April alert)
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

/** Returns ISO week key like "2026-W13" for dedup */
function isoWeekKey(d: Date): string {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Returns month key like "2026-03" for dedup */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Surplus milestone thresholds */
const SURPLUS_MILESTONES = [100, 250, 500, 1000, 2000, 5000];

/** Savings rate milestone thresholds */
const SAVINGS_RATE_MILESTONES = [10, 20, 30, 50];

/** 2026 Bank of England MPC announcement dates (month-day) */
const BOE_RATE_DATES_2026 = [
  '02-05', '03-19', '05-07', '06-18', '08-06', '09-17', '11-05', '12-17',
];

async function sendPushToUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: ReturnType<typeof createClient<any>>,
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createClient<any>(supabaseUrl, serviceKey);
  const triggered: string[] = [];

  try {
    const now = new Date();
    const currentMonth = now.getMonth(); // 0-indexed
    const currentDay = now.getDate();

    // Fetch user's latest analysis (table is "analyses", columns are top-level)
    const { data: analysis } = await admin
      .from('analyses')
      .select('monthly_income, monthly_spending, surplus, non_discretionary, discretionary, income_sources, income_floor, is_variable_income')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

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

    // ── Compute weekly budget & this week's spending from real data ──
    // (mirrors api/cron/daily-spending.ts logic)
    const rawIncome = analysis.monthly_income || 0;
    const income = analysis.is_variable_income && analysis.income_floor
      ? analysis.income_floor
      : rawIncome;
    const nonDiscTotal = (analysis.non_discretionary as { total?: number })?.total || 0;
    const discTotal = (analysis.discretionary as { total?: number })?.total || 0;
    const leftToDecide = Math.max(0, income - nonDiscTotal - discTotal);
    const weeklyBudget = Math.round(leftToDecide / 4.33);

    // Parse bank_data CSV to get this week's actual spending
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay()); // Sunday start
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const todayStr = now.toISOString().slice(0, 10);

    let spentThisWeek = 0;
    const categorySpending: Record<string, number> = {};

    const { data: bankRows } = await admin
      .from('bank_data')
      .select('csv_data')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (bankRows?.length) {
      for (const row of bankRows) {
        if (!row.csv_data) continue;
        const lines = (row.csv_data as string).split('\n');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(',');
          if (parts.length < 3) continue;
          const txDate = parts[0].trim();
          const desc = parts.slice(1, -1).join(',').trim();
          const amount = parseFloat(parts[parts.length - 1]) || 0;

          if (amount >= 0) continue; // only spending
          if (txDate >= weekStartStr && txDate <= todayStr) {
            spentThisWeek += Math.abs(amount);
            // Rough category grouping by description for spike detection
            const key = desc.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20);
            categorySpending[key] = (categorySpending[key] || 0) + Math.abs(amount);
          }
        }
      }
    }
    spentThisWeek = Math.round(spentThisWeek);

    // ── 1. Payday Alert ──
    // Derive income fingerprint from income_sources JSONB
    const incomeSources = Array.isArray(analysis.income_sources)
      ? analysis.income_sources
      : [];
    if (incomeSources.length > 0) {
      const incomeFingerprint = incomeSources
        .map((s: any) => `${s?.description || s?.source || 'unknown'}:${Math.round(s?.monthly_amount ?? s?.amount ?? 0)}`)
        .sort()
        .join('|');

      if (incomeFingerprint && incomeFingerprint !== state.last_income_fingerprint) {
        const topAmount = Math.round(
          incomeSources.reduce((max: number, s: any) =>
            Math.max(max, s?.monthly_amount ?? s?.amount ?? 0), 0)
        );
        await sendPushToUser(admin, userId, {
          title: 'Income Update',
          body: `Your income of £${topAmount.toLocaleString()}/month has been detected. Tap to see your plan.`,
          url: '/',
          tag: 'income_arrival',
        });
        triggered.push('payday');

        await admin.from('notification_state').upsert({
          user_id: userId,
          last_income_fingerprint: incomeFingerprint,
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 2. Spending Limit Warning (50% threshold) ──
    if (weeklyBudget > 0 && spentThisWeek > 0) {
      const spentPct = (spentThisWeek / weeklyBudget) * 100;
      const lastSpendingPct = state.last_spending_pct ?? 0;

      if (spentPct >= 50 && lastSpendingPct < 50) {
        const remaining = Math.max(0, Math.round(weeklyBudget - spentThisWeek));
        await sendPushToUser(admin, userId, {
          title: 'Spending Alert',
          body: `You've used ${Math.round(spentPct)}% of your weekly budget. £${remaining.toLocaleString()} left to spend.`,
          url: '/',
          tag: 'spending_limit',
        });
        triggered.push('spending_50pct');

        await admin.from('notification_state').upsert({
          user_id: userId,
          last_spending_pct: Math.round(spentPct),
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 3. Growth Engine: Tax Season Alerts ──

    // ISA deadline: April 5th - alert in March
    if (currentMonth === 2 && !state.isa_deadline_notified_year?.toString().includes(String(now.getFullYear()))) {
      const isaAllowance = 20000;

      // Check investments table for ISA holdings
      const { data: isaInvestments } = await admin
        .from('investments')
        .select('current_value, name, asset_class')
        .eq('user_id', userId);

      const investmentTotal = (isaInvestments || []).reduce((sum: number, inv: any) => {
        if (inv?.asset_class === 'isa' || inv?.name?.toLowerCase().includes('isa')) {
          return sum + (inv.current_value || 0);
        }
        return sum;
      }, 0);

      const isaRemaining = Math.max(0, isaAllowance - investmentTotal);

      if (isaRemaining > 0) {
        await sendPushToUser(admin, userId, {
          title: 'Tax Season Ending Soon',
          body: `You have £${isaRemaining.toLocaleString()} ISA allowance remaining. Use it before April 5th to maximise tax-free savings.`,
          url: '/(main)/(tabs)/chat?context=tax_optimisation_isa',
          tag: 'tax_isa_deadline',
        });
        triggered.push('isa_deadline');

        await admin.from('notification_state').upsert({
          user_id: userId,
          isa_deadline_notified_year: String(now.getFullYear()),
          updated_at: now.toISOString(),
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
        updated_at: now.toISOString(),
      }, { onConflict: 'user_id' });
    }


    // ═══════════════════════════════════════════════════════════
    // MONEY-SAVING NOTIFICATIONS
    // ═══════════════════════════════════════════════════════════

    // ── 4. Unusual Spending Spike ──
    // Alert when any merchant/category this week is 2x its share of weekly average
    const thisWeek = isoWeekKey(now);
    const discObj = (analysis.discretionary || {}) as Record<string, number>;
    const discEntries = Object.entries(discObj).filter(([k]) => k !== 'total');

    if (state.last_spending_spike_week !== thisWeek && discEntries.length > 0) {
      const spikeCats: string[] = [];
      for (const [catName, monthlyAmount] of discEntries) {
        if (typeof monthlyAmount !== 'number') continue;
        const weeklyAvg = monthlyAmount / 4.33;
        // Check if this week's real spending in similar transactions exceeds 2x
        // Use category name to loosely match CSV descriptions
        const catKey = catName.toLowerCase().replace(/[^a-z]/g, '').slice(0, 20);
        const actualThisWeek = categorySpending[catKey] ?? 0;
        if (weeklyAvg > 10 && actualThisWeek >= weeklyAvg * 2) {
          spikeCats.push(catName);
        }
      }

      if (spikeCats.length > 0) {
        const topSpike = spikeCats[0];
        await sendPushToUser(admin, userId, {
          title: 'Spending Spike',
          body: `Your ${topSpike} spending is unusually high this week — more than double your average. Tap to review.`,
          url: '/',
          tag: 'spending_spike',
        });
        triggered.push('spending_spike');

        await admin.from('notification_state').upsert({
          user_id: userId,
          last_spending_spike_week: thisWeek,
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 5. Surplus Milestone ──
    // Celebrate when monthly surplus crosses a meaningful threshold
    const surplus = analysis.surplus ?? 0;
    const lastSurplusMilestone = state.last_surplus_milestone ?? 0;

    if (surplus > 0) {
      const currentMilestone = SURPLUS_MILESTONES.filter(m => surplus >= m).pop() ?? 0;

      if (currentMilestone > lastSurplusMilestone) {
        await sendPushToUser(admin, userId, {
          title: 'Surplus Milestone',
          body: `Your monthly surplus has reached £${currentMilestone.toLocaleString()}. You're building real momentum.`,
          url: '/',
          tag: 'surplus_milestone',
        });
        triggered.push('surplus_milestone');

        await admin.from('notification_state').upsert({
          user_id: userId,
          last_surplus_milestone: currentMilestone,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 6. Debt Payoff Countdown ──
    // Alert when a debt account is < 3 months from being cleared
    const thisMonth = monthKey(now);

    if (state.last_debt_countdown_month !== thisMonth) {
      const { data: debtAccounts } = await admin
        .from('debt_accounts')
        .select('account_name, outstanding_balance, minimum_payment')
        .eq('user_id', userId);

      if (debtAccounts?.length) {
        for (const debt of debtAccounts) {
          const balance = debt.outstanding_balance ?? 0;
          const payment = debt.minimum_payment ?? 0;
          if (balance > 0 && payment > 0) {
            const monthsLeft = Math.ceil(balance / payment);
            if (monthsLeft <= 3 && monthsLeft > 0) {
              await sendPushToUser(admin, userId, {
                title: 'Debt Freedom Close',
                body: `${debt.account_name} could be cleared in ~${monthsLeft} month${monthsLeft === 1 ? '' : 's'}. Keep going — you're nearly there.`,
                url: '/(main)/(tabs)/chat?context=debt_strategy',
                tag: 'debt_countdown',
              });
              triggered.push('debt_countdown');

              await admin.from('notification_state').upsert({
                user_id: userId,
                last_debt_countdown_month: thisMonth,
                updated_at: new Date().toISOString(),
              }, { onConflict: 'user_id' });
              break; // One debt alert per cycle
            }
          }
        }
      }
    }


    // ═══════════════════════════════════════════════════════════
    // BEHAVIORAL NUDGES
    // ═══════════════════════════════════════════════════════════

    // ── 7. Move Reminder ──
    // Nudge if a move was approved 7+ days ago but no steps completed
    const lastReminder = state.last_move_reminder_at
      ? new Date(state.last_move_reminder_at)
      : null;
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const reminderCooldown = !lastReminder || lastReminder < sevenDaysAgo;

    if (reminderCooldown) {
      const { data: staleProgress } = await admin
        .from('plan_progress')
        .select('move_action, created_at, completed_steps')
        .eq('user_id', userId)
        .eq('approved', true);

      if (staleProgress?.length) {
        const staleMoves = staleProgress.filter(p => {
          const completedCount = Array.isArray(p.completed_steps) ? p.completed_steps.length : 0;
          const createdAt = new Date(p.created_at);
          return completedCount === 0 && createdAt < sevenDaysAgo;
        });

        if (staleMoves.length > 0) {
          const moveAction = staleMoves[0].move_action;
          await sendPushToUser(admin, userId, {
            title: 'Ready to Start?',
            body: `You approved "${moveAction}" — tap to take the first step.`,
            url: '/(main)/(tabs)/chat',
            tag: 'move_reminder',
          });
          triggered.push('move_reminder');

          await admin.from('notification_state').upsert({
            user_id: userId,
            last_move_reminder_at: now.toISOString(),
            updated_at: now.toISOString(),
          }, { onConflict: 'user_id' });
        }
      }
    }

    // ── 8. Weekly Spending Recap ──
    // Sunday summary of the week's spending vs budget
    const isSunday = now.getDay() === 0;

    if (isSunday && state.last_weekly_recap_week !== thisWeek && weeklyBudget > 0) {
      const pctUsed = Math.round((spentThisWeek / weeklyBudget) * 100);
      const remaining = Math.max(0, Math.round(weeklyBudget - spentThisWeek));
      const underOver = spentThisWeek <= weeklyBudget
        ? `£${remaining.toLocaleString()} under budget`
        : `£${Math.round(spentThisWeek - weeklyBudget).toLocaleString()} over budget`;

      await sendPushToUser(admin, userId, {
        title: 'Weekly Recap',
        body: `You spent £${Math.round(spentThisWeek).toLocaleString()} this week (${pctUsed}% of budget) — ${underOver}.`,
        url: '/',
        tag: 'weekly_recap',
      });
      triggered.push('weekly_recap');

      await admin.from('notification_state').upsert({
        user_id: userId,
        last_weekly_recap_week: thisWeek,
        updated_at: now.toISOString(),
      }, { onConflict: 'user_id' });
    }

    // ── 9. Savings Rate Milestone ──
    // Celebrate when savings rate crosses 10%, 20%, 30%, 50%
    const { data: latestScore } = await admin
      .from('score_history')
      .select('savings_rate')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const savingsRate = latestScore?.savings_rate ?? 0;
    const lastSavingsRateMilestone = state.last_savings_rate_milestone ?? 0;

    if (savingsRate > 0) {
      const currentRateMilestone = SAVINGS_RATE_MILESTONES.filter(m => savingsRate >= m).pop() ?? 0;

      if (currentRateMilestone > lastSavingsRateMilestone) {
        await sendPushToUser(admin, userId, {
          title: 'Savings Rate Up',
          body: `You're now saving ${currentRateMilestone}% of your income. That puts you ahead of most UK households.`,
          url: '/',
          tag: 'savings_rate_milestone',
        });
        triggered.push('savings_rate_milestone');

        await admin.from('notification_state').upsert({
          user_id: userId,
          last_savings_rate_milestone: currentRateMilestone,
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }


    // ═══════════════════════════════════════════════════════════
    // CALENDAR-AWARE / UK-SPECIFIC
    // ═══════════════════════════════════════════════════════════

    // ── 10. Capital Gains Tax Deadline ──
    // December alert: CGT reporting deadline is Jan 31st (same as Self Assessment)
    if (currentMonth === 11 && !state.cgt_deadline_notified_year?.toString().includes(String(now.getFullYear()))) {
      // Only alert if user has investments with potential gains
      const { data: investments } = await admin
        .from('investments')
        .select('name, current_value, purchase_cost')
        .eq('user_id', userId);

      const hasGains = investments?.some(inv =>
        (inv.current_value ?? 0) > (inv.purchase_cost ?? 0)
      );

      if (hasGains) {
        await sendPushToUser(admin, userId, {
          title: 'Capital Gains Tax',
          body: 'The CGT reporting deadline is January 31st. Review your investment gains and use your £3,000 annual exemption before the tax year ends.',
          url: '/(main)/(tabs)/chat?context=tax_capital_gains',
          tag: 'tax_cgt_deadline',
        });
        triggered.push('cgt_deadline');

        await admin.from('notification_state').upsert({
          user_id: userId,
          cgt_deadline_notified_year: String(now.getFullYear()),
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 11. Pension Annual Allowance ──
    // March alert: remind to use pension allowance before April 5th
    if (currentMonth === 2 && !state.pension_allowance_notified_year?.toString().includes(String(now.getFullYear()))) {
      const { data: pensionAssets } = await admin
        .from('manual_assets')
        .select('estimated_value')
        .eq('user_id', userId)
        .in('asset_type', ['pension', 'sipp']);

      if (pensionAssets?.length) {
        const totalPension = pensionAssets.reduce(
          (sum, a) => sum + (a.estimated_value ?? 0), 0
        );
        await sendPushToUser(admin, userId, {
          title: 'Pension Allowance',
          body: `You have pension assets of £${Math.round(totalPension).toLocaleString()}. The £60,000 annual allowance resets on April 6th — maximise your tax relief before then.`,
          url: '/(main)/(tabs)/chat?context=pension_optimisation',
          tag: 'pension_allowance',
        });
        triggered.push('pension_allowance');

        await admin.from('notification_state').upsert({
          user_id: userId,
          pension_allowance_notified_year: String(now.getFullYear()),
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 12. Bank of England Rate Decision ──
    // Alert on MPC announcement days if user has variable-rate savings
    const todayMMDD = `${String(currentMonth + 1).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
    const isRateDay = BOE_RATE_DATES_2026.includes(todayMMDD);
    const currentBoeMonth = monthKey(now);

    if (isRateDay && state.boe_rate_notified_month !== currentBoeMonth) {
      const { data: savingsAccounts } = await admin
        .from('savings_accounts')
        .select('account_name, interest_rate, account_type')
        .eq('user_id', userId);

      const hasVariableRate = savingsAccounts?.some(
        a => a.account_type === 'easy_access' || a.account_type === 'other'
      );

      if (hasVariableRate) {
        await sendPushToUser(admin, userId, {
          title: 'Rate Decision Today',
          body: 'The Bank of England announces its interest rate decision today. Your savings rates may change — review your accounts.',
          url: '/(main)/(tabs)/chat?context=savings_rates',
          tag: 'boe_rate_decision',
        });
        triggered.push('boe_rate_decision');

        await admin.from('notification_state').upsert({
          user_id: userId,
          boe_rate_notified_month: currentBoeMonth,
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id' });
      }
    }

    // ── 13. Council Tax New Year ──
    // April alert: new council tax year, bands may change
    if (currentMonth === 3 && currentDay <= 7 && !state.council_tax_notified_year?.toString().includes(String(now.getFullYear()))) {
      await sendPushToUser(admin, userId, {
        title: 'Council Tax Update',
        body: 'The new council tax year has started. Your band or rate may have changed — check your local authority for updates.',
        url: '/(main)/(tabs)/chat?context=council_tax',
        tag: 'council_tax_new_year',
      });
      triggered.push('council_tax');

      await admin.from('notification_state').upsert({
        user_id: userId,
        council_tax_notified_year: String(now.getFullYear()),
        updated_at: now.toISOString(),
      }, { onConflict: 'user_id' });
    }

    return res.json({ success: true, triggered });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[notification-trigger] Error:', message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
