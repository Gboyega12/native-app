// ── Reactive Engine ──
// Closes the loop between bank sync → plan progress → achievements → insights.
//
// Gap 1: Auto-verify plan steps when matching transactions appear in sync data.
// Gap 2: Detect reactive events (debt paid, subscription cancelled, etc.)
//        and return insight triggers for the UI to show modals.
// Gap 3: Suggest the next priority move using liquidity-adjusted marginal utility,
//        Monte Carlo simulations, and UKPF flowchart waterfall.
// Gap 4: Wire plan completion counts back to the achievement engine.

import { supabase } from '@/lib/supabase';
import type { Analysis, Move, EnrichedTransaction, FinancialProfile, Goals } from '@/lib/types';
import type { RankedMove } from '@/lib/move-engine';
import { rankMoves, determineFlowchartPosition } from '@/lib/move-engine';
import { checkAchievements, type ScoreSnapshot } from '@/lib/achievements';
import { estimateVolatility, simulateGoalTimeline, simulateBufferNeed, type VolatilityProfile } from '@/lib/monte-carlo';
import { calcMoveMarginalUtility, type LiquidityTier } from '@/lib/liquidity-engine';

// ── Types ──

export interface ReactiveEvent {
  type: 'debt_payment' | 'subscription_cancelled' | 'savings_detected' | 'spending_reduced'
    | 'move_auto_completed' | 'achievement_unlocked' | 'plan_step_verified';
  title: string;
  body: string;
  /** InsightModal type mapping */
  insightType: 'payday' | 'spending_alert' | 'weekly_checkin' | 'goal_milestone' | 'general';
  /** Tag for the InsightModal */
  tag: string;
  /** Action button label */
  actionLabel?: string;
  /** Pre-fill text for chat */
  actionPrefill?: string;
  /** Unique fingerprint for dismissal tracking */
  fingerprint: string;
  /** Associated data */
  data?: Record<string, any>;
}

export interface NextMoveSuggestion {
  move: Move;
  rank: number;
  /** Why this move is suggested — human-readable reason */
  reason: string;
  /** UKPF flowchart level label */
  flowchartLabel: string;
  /** Flowchart priority category */
  priority: string;
  /** Marginal utility multiplier */
  marginalMultiplier: number;
  /** Liquidity tier */
  liquidityTier: LiquidityTier;
  /** Risk-adjusted monthly impact from Monte Carlo */
  riskAdjustedImpact?: number;
  /** Monte Carlo consistency score */
  consistencyScore?: number;
  /** Goal trajectory impact if applicable */
  trajectory?: {
    monthsSaved: number;
    hitRate12m: number;
    p50: number;
  };
}

export interface ReactiveResult {
  /** Events detected this sync — each can trigger an InsightModal */
  events: ReactiveEvent[];
  /** Next priority move suggestion (computed fresh each sync) */
  nextMove: NextMoveSuggestion | null;
  /** New achievements unlocked this sync */
  newAchievements: string[];
  /** Updated plan completion count */
  planCompletedCount: number;
  /** Total move count */
  totalMoveCount: number;
}

// ── Gap 1: Transaction-to-Plan Verification ──

interface ProgressRow {
  move_key: string;
  move_action: string;
  approved: boolean;
  completed_steps: number[];
}

/**
 * Scan enriched transactions for evidence that plan steps have been completed.
 * Matches transactions to active moves/plans and auto-marks steps.
 *
 * Detection patterns:
 * - Subscription cancelled: move mentions "cancel X", no recent tx from X
 * - Debt payment: move is debt category, matching outgoing payment found
 * - Savings transfer: move is buffer/savings, matching savings transfer found
 * - Spending reduction: move targets a category, spending in that category dropped
 */
async function verifyPlanStepsFromTransactions(
  userId: string,
  enrichedTxs: EnrichedTransaction[],
  analysis: Analysis,
  previousAnalysis: Analysis | null,
): Promise<{ verified: ReactiveEvent[]; completedCount: number }> {
  const events: ReactiveEvent[] = [];

  // Fetch active progress records
  const { data: progressRows } = await supabase
    .from('plan_progress')
    .select('*')
    .eq('user_id', userId)
    .not('move_key', 'like', 'dismissed-%');

  if (!progressRows || progressRows.length === 0) {
    return { verified: events, completedCount: 0 };
  }

  const moves = analysis.all_moves || [];
  const now = new Date();
  const recentCutoff = new Date(now);
  recentCutoff.setDate(recentCutoff.getDate() - 30);

  const recentTxs = enrichedTxs.filter((tx) => new Date(tx.date) >= recentCutoff);

  let completedCount = 0;

  for (const row of progressRows) {
    if (!row.approved) continue;

    const moveIndex = parseInt(row.move_key.replace('move-', ''), 10);
    const move = !isNaN(moveIndex) ? moves[moveIndex] : null;
    const steps = move?.steps || [];
    const completedSteps: number[] = [...(row.completed_steps || [])];
    let newStepsCompleted = false;

    if (!move) {
      // Check user plans
      if (row.move_key.startsWith('plan-')) {
        // User plan — check if all steps done
        if (completedSteps.length > 0) completedCount++;
      }
      continue;
    }

    const action = (move.action || '').toLowerCase();
    const cat = move.category || 'spending';

    // ── Subscription cancellation verification ──
    if (action.includes('cancel') || action.includes('subscript')) {
      const merchants = (move.merchants || []).map((m) => m.toLowerCase());
      if (merchants.length > 0) {
        // Check if ANY of the target merchants have NO recent transactions
        const cancelledMerchants = merchants.filter((merchant) => {
          const hasTx = recentTxs.some((tx) => {
            const txMerchant = (tx.merchant || tx.description || '').toLowerCase();
            return txMerchant.includes(merchant) || merchant.includes(txMerchant);
          });
          return !hasTx;
        });

        if (cancelledMerchants.length > 0 && !completedSteps.includes(1)) {
          completedSteps.push(1); // "Cancel the ones you haven't used"
          newStepsCompleted = true;
          events.push({
            type: 'subscription_cancelled',
            title: 'Subscription cancelled',
            body: `Looks like you cancelled ${cancelledMerchants.join(', ')} — no charges in the last 30 days.`,
            insightType: 'goal_milestone',
            tag: 'VERIFIED',
            actionLabel: 'See your plan',
            fingerprint: `sub_cancel_${cancelledMerchants.sort().join('_')}_${now.getMonth()}`,
          });
        }
      }
    }

    // ── Debt payment verification ──
    if (cat === 'debt' || action.includes('debt') || action.includes('overpay')) {
      const debtPayments = recentTxs.filter((tx) => tx.amount < 0 && (tx.isDebt || tx.isBNPL));
      if (debtPayments.length > 0 && !completedSteps.includes(0)) {
        const totalPaid = debtPayments.reduce((s, tx) => s + Math.abs(tx.amount), 0);
        completedSteps.push(0); // First step: "List/pay debts"
        newStepsCompleted = true;
        events.push({
          type: 'debt_payment',
          title: 'Debt payment detected',
          body: `£${Math.round(totalPaid)} in debt payments found this month. Your move "${move.action}" is on track.`,
          insightType: 'goal_milestone',
          tag: 'PROGRESS',
          actionLabel: 'View debt plan',
          actionPrefill: 'Show me my debt payoff progress',
          fingerprint: `debt_payment_${Math.round(totalPaid)}_${now.getMonth()}`,
          data: { totalPaid, moveAction: move.action },
        });
      }
    }

    // ── Savings/buffer transfer verification ──
    if (cat === 'buffer' || cat === 'savings' || action.includes('saving') || action.includes('buffer')) {
      const savingsTransfers = recentTxs.filter((tx) => tx.amount < 0 && tx.isSavings);
      if (savingsTransfers.length > 0 && !completedSteps.includes(0)) {
        const totalSaved = savingsTransfers.reduce((s, tx) => s + Math.abs(tx.amount), 0);
        completedSteps.push(0); // "Set aside your target amount"
        newStepsCompleted = true;
        events.push({
          type: 'savings_detected',
          title: 'Savings detected',
          body: `£${Math.round(totalSaved)} moved to savings this month. Your buffer is growing.`,
          insightType: 'goal_milestone',
          tag: 'ON TRACK',
          actionLabel: 'Check progress',
          actionPrefill: 'How is my savings progress?',
          fingerprint: `savings_${Math.round(totalSaved)}_${now.getMonth()}`,
          data: { totalSaved },
        });
      }
    }

    // ── Spending reduction verification ──
    if (cat === 'spending' && previousAnalysis) {
      const prevSpending = previousAnalysis.monthly_spending || 0;
      const currSpending = analysis.monthly_spending || 0;
      if (prevSpending > 0 && currSpending < prevSpending * 0.9 && !completedSteps.includes(0)) {
        const reduction = Math.round(prevSpending - currSpending);
        completedSteps.push(0);
        newStepsCompleted = true;
        events.push({
          type: 'spending_reduced',
          title: 'Spending down',
          body: `Your monthly spending dropped by £${reduction}. That's £${reduction * 12}/yr freed up.`,
          insightType: 'goal_milestone',
          tag: 'RESULT',
          actionLabel: 'See impact',
          actionPrefill: 'Show me how my spending compares to last month',
          fingerprint: `spend_reduced_${reduction}_${now.getMonth()}`,
          data: { reduction },
        });
      }
    }

    // Check if all steps are now completed
    const allDone = steps.length > 0 && completedSteps.length >= steps.length;
    if (allDone) completedCount++;

    // Persist updated steps if changed
    if (newStepsCompleted) {
      await supabase.from('plan_progress').upsert({
        user_id: userId,
        move_key: row.move_key,
        move_action: row.move_action,
        approved: true,
        completed_steps: completedSteps,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,move_key' });

      if (allDone) {
        events.push({
          type: 'move_auto_completed',
          title: 'Move completed!',
          body: `All steps for "${move.action}" are done. £${move.annualImpact}/yr impact unlocked.`,
          insightType: 'goal_milestone',
          tag: 'COMPLETE',
          actionLabel: 'See next move',
          actionPrefill: 'What should I focus on next?',
          fingerprint: `move_complete_${row.move_key}_${now.getMonth()}`,
          data: { moveAction: move.action, annualImpact: move.annualImpact },
        });
      }
    }
  }

  return { verified: events, completedCount };
}

// ── Gap 3: Next Priority Move Suggestion ──
// Uses the full move-engine pipeline: UKPF flowchart → CRRA marginal utility →
// Monte Carlo consistency → liquidity tier → goal trajectory.

function suggestNextPriorityMove(
  analysis: Analysis,
  profile: FinancialProfile | null,
  goals: Goals | null,
  identity: any,
  debtAccounts: any[],
  progress: Record<string, ProgressRow>,
): NextMoveSuggestion | null {
  const moves = analysis.all_moves || [];
  if (moves.length === 0 || !profile) return null;

  const ukpf = determineFlowchartPosition(profile, goals, debtAccounts, identity);

  // Filter out already-completed or not-yet-started moves
  // Priority: moves that are started but incomplete > new moves matching flowchart priority
  const startedIncomplete: { move: Move; index: number }[] = [];
  const unstartedMatching: { move: Move; index: number }[] = [];
  const unstartedOther: { move: Move; index: number }[] = [];

  for (let i = 0; i < moves.length; i++) {
    const key = `move-${i}`;
    const prog = progress[key];
    const move = moves[i];
    const steps = move.steps || [];
    const completed = prog?.completed_steps || [];

    if (prog?.approved) {
      // Started but not fully done
      if (completed.length < steps.length) {
        startedIncomplete.push({ move, index: i });
      }
      // Else fully done — skip
    } else {
      // Not started
      const cat = move.category || 'spending';
      if (cat === ukpf.priority) {
        unstartedMatching.push({ move, index: i });
      } else {
        unstartedOther.push({ move, index: i });
      }
    }
  }

  // Pick the best candidate from the priority order
  const candidates = [...startedIncomplete, ...unstartedMatching, ...unstartedOther];
  if (candidates.length === 0) return null;

  // Score each candidate using the full CRRA + Monte Carlo pipeline
  let vol: VolatilityProfile | null = null;
  if (profile.budgetReality) {
    vol = estimateVolatility(profile, identity);
  }

  let bufferRec: { months: number; amount: number } | null = null;
  if (vol && profile.budgetReality) {
    const rec = simulateBufferNeed(profile, vol);
    bufferRec = { months: rec.months, amount: rec.amount };
  }

  let best: {
    candidate: typeof candidates[0];
    score: number;
    mu: { multiplier: number; liquidityTier: LiquidityTier };
    reason: string;
  } | null = null;

  for (const c of candidates) {
    const { multiplier, liquidityTier } = calcMoveMarginalUtility(
      c.move, profile, vol, identity, debtAccounts, bufferRec,
    );

    // Composite score: marginal utility × annual impact × effort bonus
    let score = multiplier * (c.move.annualImpact / 100);
    if (c.move.effort === 'low') score *= 1.3;
    else if (c.move.effort === 'high') score *= 0.8;

    // Priority boost for flowchart-matching moves
    const cat = c.move.category || 'spending';
    if (cat === ukpf.priority) score *= 1.2;

    // Boost for in-progress moves (momentum)
    const isInProgress = startedIncomplete.some((s) => s.index === c.index);
    if (isInProgress) score *= 1.5;

    // Build reason
    let reason: string;
    if (isInProgress) {
      const prog = progress[`move-${c.index}`];
      const done = prog?.completed_steps?.length || 0;
      const total = c.move.steps?.length || 0;
      reason = `${done}/${total} steps done — keep the momentum going`;
    } else if (cat === ukpf.priority) {
      reason = `Your #1 priority right now is "${ukpf.label}" — this move directly addresses it`;
    } else if (multiplier > 1.5) {
      reason = `High marginal utility (${multiplier.toFixed(1)}×) — each pound here delivers outsized value`;
    } else if (c.move.effort === 'low') {
      reason = `Quick win with £${c.move.annualImpact}/yr impact — low effort, high reward`;
    } else {
      reason = `£${c.move.annualImpact}/yr annual impact with ${c.move.effort} effort`;
    }

    if (!best || score > best.score) {
      best = { candidate: c, score, mu: { multiplier, liquidityTier }, reason };
    }
  }

  if (!best) return null;

  const { candidate, mu, reason } = best;

  // Compute trajectory for this specific move
  let trajectory: NextMoveSuggestion['trajectory'] = undefined;
  if (goals && goals.target_amount && vol) {
    const confidence = simulateGoalTimeline(
      profile,
      goals.target_amount,
      candidate.move.monthlyImpact,
      vol,
    );
    trajectory = {
      monthsSaved: 0, // Computed at display time from current vs. with-move
      hitRate12m: confidence.hitRate12m,
      p50: confidence.p50,
    };
  }

  return {
    move: candidate.move,
    rank: candidate.index + 1,
    reason,
    flowchartLabel: ukpf.label,
    priority: ukpf.priority,
    marginalMultiplier: mu.multiplier,
    liquidityTier: mu.liquidityTier,
    trajectory,
  };
}

// ── Gap 4: Reactive Achievement Detection ──

async function detectReactiveAchievements(
  userId: string,
  analysis: Analysis,
  planCompletedCount: number,
  totalMoveCount: number,
): Promise<{ newAchievements: string[]; events: ReactiveEvent[] }> {
  const events: ReactiveEvent[] = [];

  // Fetch existing achievements
  const { data: existingRows } = await supabase
    .from('user_achievements')
    .select('achievement_key')
    .eq('user_id', userId);
  const existing = (existingRows || []).map((r: any) => r.achievement_key);

  // Fetch previous score snapshot for comparison
  const { data: snapshots } = await supabase
    .from('score_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(2);

  const current: ScoreSnapshot = {
    decision_score: analysis.decision_score || 0,
    monthly_income: analysis.monthly_income || 0,
    monthly_spending: analysis.monthly_spending || 0,
    surplus: analysis.surplus || 0,
    savings_rate: analysis.monthly_income > 0
      ? Math.round((analysis.surplus / analysis.monthly_income) * 100) : 0,
    subscription_count: 0, // Will be populated from profile data
    debt_account_count: 0,
  };

  // Use the PREVIOUS snapshot (not the one we just inserted)
  const previous: ScoreSnapshot | null = snapshots && snapshots.length >= 2
    ? snapshots[1] as ScoreSnapshot : null;

  // Fetch context
  const [goalsRes, overridesRes, plansRes, streakRes] = await Promise.all([
    supabase.from('goals').select('id').eq('user_id', userId).limit(1),
    supabase.from('transaction_overrides').select('id').eq('user_id', userId).limit(1),
    supabase.from('user_plans').select('id').eq('user_id', userId).eq('status', 'active').limit(1),
    supabase.from('score_history').select('created_at').eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(60),
  ]);

  // Estimate streak from score_history entries
  let streakDays = 0;
  if (streakRes.data) {
    const now = new Date();
    for (const row of streakRes.data) {
      const dayDiff = Math.floor((now.getTime() - new Date(row.created_at).getTime()) / 86400000);
      if (dayDiff <= streakDays + 2) streakDays = dayDiff + 1; // Allow 1-day gaps
      else break;
    }
  }

  const newAchievements = checkAchievements(current, previous, existing, {
    hasGoals: (goalsRes.data?.length || 0) > 0,
    hasOverrides: (overridesRes.data?.length || 0) > 0,
    hasPlans: (plansRes.data?.length || 0) > 0,
    planCompletedCount,
    totalMoveCount,
    streakDays,
  });

  // Persist new achievements
  for (const key of newAchievements) {
    try {
      await supabase.from('user_achievements').upsert({
        user_id: userId,
        achievement_key: key,
        unlocked_at: new Date().toISOString(),
        notified: false,
      }, { onConflict: 'user_id,achievement_key' });
    } catch {}

    // Generate insight events for significant achievements
    const eventMap: Record<string, { title: string; body: string; tag: string }> = {
      spending_down_10: {
        title: 'Spending down 10%',
        body: previous
          ? `£${Math.round((previous.monthly_spending || 0) - (current.monthly_spending || 0))}/mo saved — that's £${Math.round(((previous.monthly_spending || 0) - (current.monthly_spending || 0)) * 12)}/yr.`
          : 'Your spending dropped by 10% or more.',
        tag: 'MILESTONE',
      },
      surplus_doubled: {
        title: 'Surplus doubled',
        body: `Your monthly surplus hit £${Math.round(current.surplus)}. Keep the momentum.`,
        tag: 'MILESTONE',
      },
      debt_free: {
        title: 'Debt free!',
        body: 'All outstanding debts are cleared. Time to redirect that cash flow.',
        tag: 'MILESTONE',
      },
      all_moves_done: {
        title: 'All moves complete',
        body: `You've completed every recommended move. Your decision score: ${current.decision_score}/100.`,
        tag: 'COMPLETE',
      },
      score_up_10: {
        title: 'Score up 10 points',
        body: `Decision score jumped to ${current.decision_score}/100. Real progress.`,
        tag: 'PROGRESS',
      },
    };

    const mapped = eventMap[key];
    if (mapped) {
      events.push({
        type: 'achievement_unlocked',
        title: mapped.title,
        body: mapped.body,
        insightType: 'goal_milestone',
        tag: mapped.tag,
        actionLabel: 'See achievements',
        fingerprint: `achievement_${key}_${new Date().getMonth()}`,
        data: { achievementKey: key },
      });
    }
  }

  return { newAchievements, events };
}

// ── Main Entry Point ──
// Called after every sync to close all reactive loops.

export async function runReactiveEngine(
  userId: string,
  analysis: Analysis,
  enrichedTxs: EnrichedTransaction[],
  profile: FinancialProfile | null,
  goals: Goals | null,
  identity: any,
  debtAccounts: any[],
): Promise<ReactiveResult> {
  const allEvents: ReactiveEvent[] = [];

  // Fetch previous analysis for comparison
  let previousAnalysis: Analysis | null = null;
  try {
    const { data: prevRows } = await supabase
      .from('score_history')
      .select('monthly_spending, monthly_income')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(2);
    if (prevRows && prevRows.length >= 2) {
      previousAnalysis = {
        monthly_spending: prevRows[1].monthly_spending,
        monthly_income: prevRows[1].monthly_income,
      } as Analysis;
    }
  } catch {}

  // Fetch current plan progress for the suggestion engine
  let progressMap: Record<string, ProgressRow> = {};
  try {
    const { data: progressRows } = await supabase
      .from('plan_progress')
      .select('*')
      .eq('user_id', userId)
      .not('move_key', 'like', 'dismissed-%');
    if (progressRows) {
      for (const row of progressRows) {
        progressMap[row.move_key] = {
          move_key: row.move_key,
          move_action: row.move_action,
          approved: row.approved,
          completed_steps: row.completed_steps || [],
        };
      }
    }
  } catch {}

  // Gap 1: Verify plan steps from transactions
  const { verified, completedCount } = await verifyPlanStepsFromTransactions(
    userId, enrichedTxs, analysis, previousAnalysis,
  );
  allEvents.push(...verified);

  const totalMoveCount = (analysis.all_moves || []).length;

  // Gap 4: Reactive achievement detection
  const { newAchievements, events: achievementEvents } = await detectReactiveAchievements(
    userId, analysis, completedCount, totalMoveCount,
  );
  allEvents.push(...achievementEvents);

  // Gap 3: Next priority move suggestion
  const nextMove = suggestNextPriorityMove(
    analysis, profile, goals, identity, debtAccounts, progressMap,
  );

  return {
    events: allEvents,
    nextMove,
    newAchievements,
    planCompletedCount: completedCount,
    totalMoveCount,
  };
}
