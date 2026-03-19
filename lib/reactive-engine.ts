// ── Reactive Engine ──
// Closes the loop between bank sync → plan progress → achievements → insights.
//
// Gap 1: Auto-verify plan steps when matching transactions appear in sync data.
// Gap 2: Detect reactive events (debt paid, subscription cancelled, etc.)
//        and return insight triggers for the UI to show modals.
// Gap 3: Suggest the next priority move using liquidity-adjusted marginal utility
//        and Monte Carlo simulations.
// Gap 4: Wire plan completion counts back to the achievement engine.

import { supabase } from '@/lib/supabase';
import type { Analysis, Move, MoveSubGoal, EnrichedTransaction, FinancialProfile, Goals, UserIdentity, DebtAccount } from '@/lib/types';
import type { RankedMove } from '@/lib/move-engine';
import { rankMoves } from '@/lib/move-engine';
import { checkAchievements, type ScoreSnapshot } from '@/lib/achievements';
import { estimateVolatility, simulateGoalTimeline, simulateBufferNeed, type VolatilityProfile } from '@/lib/monte-carlo';
import { calcMoveMarginalUtility, type LiquidityTier } from '@/lib/liquidity-engine';
// extractCreditCardBrand: simple heuristic to pull card brand from account name
function extractCreditCardBrand(name: string): string | null {
  const brands = ['visa', 'mastercard', 'amex', 'american express', 'barclaycard', 'hsbc', 'natwest', 'lloyds', 'halifax', 'nationwide', 'monzo', 'starling', 'revolut', 'chase'];
  const lower = name.toLowerCase();
  for (const b of brands) {
    if (lower.includes(b)) return b.charAt(0).toUpperCase() + b.slice(1);
  }
  return null;
}

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
  data?: Record<string, unknown>;
}

export interface NextMoveSuggestion {
  move: Move;
  rank: number;
  /** Why this move is suggested — human-readable reason */
  reason: string;
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
  /** Steps verified this sync — keyed by move_key → updated completed_steps.
   *  The UI merges these into local progress state to tick checkboxes + update progress bars. */
  verifiedSteps: Record<string, number[]>;
  /** Updated sub-goals with current values — keyed by move_key.
   *  The UI uses these for real progress bars per sub-goal. */
  verifiedSubGoals: Record<string, MoveSubGoal[]>;
}

// ── Gap 1: Sub-Goal Verification from Real Data ──

interface ProgressRow {
  move_key: string;
  move_action: string;
  approved: boolean;
  completed_steps: number[];
  sub_goals?: MoveSubGoal[];
}

/**
 * Verify sub-goals against real data sources:
 * - debt_clear → check current balance from debt accounts
 * - sub_cancel → check if merchant has 0 recent transactions
 * - spending_reduce → check current category spend from profile metrics
 * - savings_reach → check cumulative savings transfers
 * - buffer_build → check cumulative savings/buffer transfers
 *
 * Also keeps the old step-based verification for moves without sub-goals.
 */
async function verifySubGoalsFromData(
  userId: string,
  enrichedTxs: EnrichedTransaction[],
  analysis: Analysis,
  profile: FinancialProfile | null,
  debtAccounts: DebtAccount[],
  previousAnalysis: Analysis | null,
): Promise<{
  verified: ReactiveEvent[];
  completedCount: number;
  verifiedSteps: Record<string, number[]>;
  verifiedSubGoals: Record<string, MoveSubGoal[]>;
}> {
  const events: ReactiveEvent[] = [];
  const verifiedSteps: Record<string, number[]> = {};
  const verifiedSubGoals: Record<string, MoveSubGoal[]> = {};

  // Fetch active progress records
  const { data: progressRows } = await supabase
    .from('plan_progress')
    .select('*')
    .eq('user_id', userId)
    .not('move_key', 'like', 'dismissed-%');

  if (!progressRows || progressRows.length === 0) {
    return { verified: events, completedCount: 0, verifiedSteps, verifiedSubGoals };
  }

  const moves = analysis.all_moves || [];
  const now = new Date();
  const recentCutoff = new Date(now);
  recentCutoff.setDate(recentCutoff.getDate() - 30);
  const recentTxs = enrichedTxs.filter((tx) => new Date(tx.date) >= recentCutoff);

  // Build spending lookup from profile metrics
  const spendingByCategory: Record<string, number> = {};
  if (profile?.metrics) {
    const pm = profile.metrics;
    spendingByCategory['Delivery'] = pm.foodDelivery || 0;
    spendingByCategory['Eating Out'] = pm.eatingOut || 0;
    spendingByCategory['Shopping'] = pm.shopping || 0;
    spendingByCategory['Transport'] = pm.transport || 0;
    spendingByCategory['Coffee & Cafes'] = pm.coffeeAndCafes || 0;
  }

  // Build debt balance lookup by account name — index by multiple possible names
  // so sub-goals can match regardless of which naming path created them
  const debtByName: Record<string, number> = {};
  for (const d of debtAccounts) {
    const bal = d.outstanding_balance || 0;
    // Primary: account_name as stored in DB (used by enrichment engine)
    if (d.account_name) debtByName[d.account_name] = bal;
    // Also index by institution and extracted brand for legacy sub-goals
    if (d.institution) debtByName[d.institution] = bal;
    const brand = extractCreditCardBrand(d.account_name || '');
    if (brand) debtByName[brand] = bal;
  }

  let completedCount = 0;

  for (const row of progressRows) {
    if (!row.approved) continue;

    const moveIndex = parseInt(row.move_key.replace('move-', ''), 10);
    const move = !isNaN(moveIndex) ? moves[moveIndex] : null;

    if (!move) {
      if (row.move_key.startsWith('plan-')) {
        if ((row.completed_steps || []).length > 0) completedCount++;
      }
      continue;
    }

    const subGoals: MoveSubGoal[] = move.subGoals
      ? move.subGoals.map((sg) => ({ ...sg }))
      : [];
    const completedSteps: number[] = [...(row.completed_steps || [])];
    let changed = false;

    if (subGoals.length > 0) {
      // ── Sub-goal verification ──
      let subGoalCompletedCount = 0;

      for (let si = 0; si < subGoals.length; si++) {
        const sg = subGoals[si];

        // Update currentValue from real data
        switch (sg.type) {
          case 'debt_clear': {
            // Look up current balance by account name
            const balance = debtByName[sg.target];
            sg.currentValue = balance != null ? Math.round(balance) : sg.currentValue ?? sg.startValue;
            if (sg.currentValue <= 0 && !sg.completedAt) {
              sg.completedAt = now.toISOString();
              changed = true;
              events.push({
                type: 'debt_payment',
                title: `${sg.target} cleared!`,
                body: `You've paid off ${sg.target}. ${subGoals.length - subGoalCompletedCount - 1} debt${subGoals.length - subGoalCompletedCount - 1 !== 1 ? 's' : ''} remaining.`,
                insightType: 'goal_milestone',
                tag: 'CLEARED',
                actionLabel: 'See progress',
                actionPrefill: 'Show me my debt payoff progress',
                fingerprint: `debt_clear_${sg.target}_${now.getMonth()}`,
                data: { target: sg.target, moveAction: move.action },
              });
            } else if (sg.currentValue < sg.startValue && sg.currentValue > 0 && !completedSteps.includes(si)) {
              // Partial progress — debt is being paid down
              changed = true;
            }
            break;
          }

          case 'sub_cancel': {
            // Check if merchant has NO recent transactions
            const merchantLower = sg.target.toLowerCase();
            const hasTx = recentTxs.some((tx) => {
              const txM = (tx.merchant || tx.description || '').toLowerCase();
              return txM.includes(merchantLower) || merchantLower.includes(txM);
            });
            sg.currentValue = hasTx ? sg.startValue : 0;
            if (!hasTx && !sg.completedAt) {
              sg.completedAt = now.toISOString();
              changed = true;
              events.push({
                type: 'subscription_cancelled',
                title: `${sg.target} cancelled`,
                body: `No charges from ${sg.target} in the last 30 days — \u00a3${sg.startValue}/mo saved.`,
                insightType: 'goal_milestone',
                tag: 'VERIFIED',
                actionLabel: 'See your plan',
                fingerprint: `sub_cancel_${sg.target}_${now.getMonth()}`,
                data: { target: sg.target, amount: sg.startValue },
              });
            }
            break;
          }

          case 'spending_reduce': {
            // Check current spend vs target from profile metrics
            const currentSpend = Math.round(spendingByCategory[sg.target] || sg.startValue);
            sg.currentValue = currentSpend;
            if (currentSpend <= sg.targetValue && !sg.completedAt) {
              sg.completedAt = now.toISOString();
              changed = true;
              const reduction = sg.startValue - currentSpend;
              events.push({
                type: 'spending_reduced',
                title: `${sg.target} spend down`,
                body: `${sg.target} spending dropped to \u00a3${currentSpend}/mo — \u00a3${reduction}/mo saved.`,
                insightType: 'goal_milestone',
                tag: 'RESULT',
                actionLabel: 'See impact',
                fingerprint: `spend_reduce_${sg.target}_${now.getMonth()}`,
                data: { category: sg.target, reduction },
              });
            } else if (currentSpend < sg.startValue && !sg.completedAt) {
              // Partial progress
              changed = true;
            }
            break;
          }

          case 'buffer_build':
          case 'savings_reach': {
            // Sum recent savings transfers as proxy for progress
            const savingsTxs = recentTxs.filter((tx) => tx.amount < 0 && tx.isSavings);
            const totalSaved = savingsTxs.reduce((s, tx) => s + Math.abs(tx.amount), 0);
            // Use stored progress or accumulate
            const prevValue = row.sub_goals?.[si]?.currentValue || 0;
            sg.currentValue = Math.round(Math.max(prevValue, totalSaved));
            if (sg.currentValue >= sg.targetValue && !sg.completedAt) {
              sg.completedAt = now.toISOString();
              changed = true;
              events.push({
                type: 'savings_detected',
                title: `${sg.target} target hit!`,
                body: `You've reached your \u00a3${sg.targetValue} target for ${sg.target.toLowerCase()}.`,
                insightType: 'goal_milestone',
                tag: 'COMPLETE',
                actionLabel: 'See progress',
                fingerprint: `${sg.type}_${sg.target}_${now.getMonth()}`,
                data: { target: sg.target, amount: sg.targetValue },
              });
            } else if (totalSaved > 0 && !sg.completedAt) {
              changed = true;
            }
            break;
          }
        }

        if (sg.completedAt) {
          subGoalCompletedCount++;
          // Map sub-goal completion to step completion for backward compat
          if (!completedSteps.includes(si)) {
            completedSteps.push(si);
          }
        }
      }

      // Check if ALL sub-goals are complete → move is done
      const allSubGoalsDone = subGoals.every((sg) => sg.completedAt);
      if (allSubGoalsDone) completedCount++;

      // Always populate verifiedSubGoals so UI can render them
      verifiedSubGoals[row.move_key] = subGoals;
      verifiedSteps[row.move_key] = completedSteps;

      // Persist when progress detected OR when DB row is missing sub_goals
      const dbMissingSg = !row.sub_goals || !Array.isArray(row.sub_goals) || row.sub_goals.length === 0;
      if (changed || dbMissingSg) {
        await supabase.from('plan_progress').upsert({
          user_id: userId,
          move_key: row.move_key,
          move_action: row.move_action,
          approved: true,
          completed_steps: completedSteps,
          sub_goals: subGoals,
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id,move_key' });
      }

      if (changed && allSubGoalsDone) {
        events.push({
          type: 'move_auto_completed',
          title: 'Move completed!',
          body: `All goals for "${move.action}" are done. \u00a3${move.annualImpact}/yr impact unlocked.`,
          insightType: 'goal_milestone',
          tag: 'COMPLETE',
          actionLabel: 'See next move',
          actionPrefill: 'What should I focus on next?',
          fingerprint: `move_complete_${row.move_key}_${now.getMonth()}`,
          data: { moveAction: move.action, annualImpact: move.annualImpact },
        });
      }
    } else {
      // ── Legacy step-based verification for moves without sub-goals ──
      const steps = move.steps || [];
      const cat = move.category || 'spending';
      let newStepsCompleted = false;

      if (cat === 'debt') {
        const debtPayments = recentTxs.filter((tx) => tx.amount < 0 && (tx.isDebt || tx.isBNPL));
        if (debtPayments.length > 0 && !completedSteps.includes(0)) {
          completedSteps.push(0);
          newStepsCompleted = true;
        }
      } else if (cat === 'buffer' || cat === 'savings') {
        const savingsTransfers = recentTxs.filter((tx) => tx.amount < 0 && tx.isSavings);
        if (savingsTransfers.length > 0 && !completedSteps.includes(0)) {
          completedSteps.push(0);
          newStepsCompleted = true;
        }
      } else if (cat === 'spending' && previousAnalysis) {
        const prevSpending = previousAnalysis.monthly_spending || 0;
        const currSpending = analysis.monthly_spending || 0;
        if (prevSpending > 0 && currSpending < prevSpending * 0.9 && !completedSteps.includes(0)) {
          completedSteps.push(0);
          newStepsCompleted = true;
        }
      }

      const allDone = steps.length > 0 && completedSteps.length >= steps.length;
      if (allDone) completedCount++;

      if (newStepsCompleted) {
        verifiedSteps[row.move_key] = completedSteps;
        await supabase.from('plan_progress').upsert({
          user_id: userId,
          move_key: row.move_key,
          move_action: row.move_action,
          approved: true,
          completed_steps: completedSteps,
          updated_at: now.toISOString(),
        }, { onConflict: 'user_id,move_key' });
      }
    }
  }

  return { verified: events, completedCount, verifiedSteps, verifiedSubGoals };
}

// ── Gap 3: Next Priority Move Suggestion ──
// Uses the full move-engine pipeline: UKPF flowchart → CRRA marginal utility →
// Monte Carlo consistency → liquidity tier → goal trajectory.
//
// Chaining: When a move is just completed, the next suggestion chains to
// a move in the SAME category first (debt → next debt, buffer → next buffer)
// before falling back to the general priority order.

function suggestNextPriorityMove(
  analysis: Analysis,
  profile: FinancialProfile | null,
  goals: Goals | null,
  identity: UserIdentity | null,
  debtAccounts: DebtAccount[],
  progress: Record<string, ProgressRow>,
  justCompletedEvents: ReactiveEvent[],
): NextMoveSuggestion | null {
  const moves = analysis.all_moves || [];
  if (moves.length === 0 || !profile) return null;

  // Detect what was just completed to enable chaining
  const justCompletedCategory = justCompletedEvents
    .filter((e) => e.type === 'move_auto_completed' || e.type === 'debt_payment' || e.type === 'subscription_cancelled')
    .map((e) => {
      // Find the move's category from the action text
      const m = moves.find((mv) => mv.action === e.data?.moveAction);
      return m?.category || null;
    })
    .find((c) => c != null) || null;

  // Build candidate buckets
  const startedIncomplete: { move: Move; index: number }[] = [];
  const chainMatches: { move: Move; index: number }[] = [];
  const unstartedMatching: { move: Move; index: number }[] = [];
  const unstartedOther: { move: Move; index: number }[] = [];

  for (let i = 0; i < moves.length; i++) {
    const key = `move-${i}`;
    const prog = progress[key];
    const move = moves[i];
    const steps = move.steps || [];
    const completed = prog?.completed_steps || [];

    if (prog?.approved) {
      if (completed.length < steps.length) {
        startedIncomplete.push({ move, index: i });
      }
      // Fully done — skip
    } else {
      const cat = move.category || 'spending';
      // Chain: same category as what was just completed
      if (justCompletedCategory && cat === justCompletedCategory) {
        chainMatches.push({ move, index: i });
      } else {
        // Goal alignment: moves matching user's 1-year goal category get priority
        const goalCategory = goals?.one_year_goal === 'clear_debt' ? 'debt'
          : goals?.one_year_goal === 'emergency_fund' ? 'buffer'
          : goals?.one_year_goal === 'reduce_spending' ? 'spending'
          : goals?.one_year_goal === 'save_target' ? 'savings'
          : goals?.one_year_goal === 'invest' ? 'invest'
          : null;
        if (goalCategory && cat === goalCategory) {
          unstartedMatching.push({ move, index: i });
        } else {
          unstartedOther.push({ move, index: i });
        }
      }
    }
  }

  // Priority order: in-progress > chain matches > goal-aligned matches > rest
  const candidates = [...startedIncomplete, ...chainMatches, ...unstartedMatching, ...unstartedOther];
  if (candidates.length === 0) return null;

  // Score candidates using CRRA + Monte Carlo
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
    isChain: boolean;
  } | null = null;

  for (const c of candidates) {
    const { multiplier, liquidityTier } = calcMoveMarginalUtility(
      c.move, profile, vol, identity, debtAccounts, bufferRec,
    );

    let score = multiplier * (c.move.annualImpact / 100);
    if (c.move.effort === 'low') score *= 1.3;
    else if (c.move.effort === 'high') score *= 0.8;

    const cat = c.move.category || 'spending';

    // Goal alignment boost — 1.3x for moves matching user's stated goal
    const goalCategory = goals?.one_year_goal === 'clear_debt' ? 'debt'
      : goals?.one_year_goal === 'emergency_fund' ? 'buffer'
      : goals?.one_year_goal === 'reduce_spending' ? 'spending'
      : goals?.one_year_goal === 'save_target' ? 'savings'
      : goals?.one_year_goal === 'invest' ? 'invest'
      : null;
    if (goalCategory && cat === goalCategory) score *= 1.3;

    const isInProgress = startedIncomplete.some((s) => s.index === c.index);
    if (isInProgress) score *= 1.5;

    // Strong chain boost: same-category continuation after completing a move
    const isChain = chainMatches.some((s) => s.index === c.index);
    if (isChain) score *= 2.0;

    let reason: string;
    if (isChain) {
      reason = `Next ${cat} move — keep clearing these`;
    } else if (isInProgress) {
      const prog = progress[`move-${c.index}`];
      const done = prog?.completed_steps?.length || 0;
      const total = c.move.steps?.length || 0;
      reason = `${done}/${total} steps done — keep going`;
    } else if (goalCategory && cat === goalCategory) {
      const goalLabels: Record<string, string> = {
        clear_debt: 'Clear debt', emergency_fund: 'Build emergency fund',
        reduce_spending: 'Reduce spending', save_target: 'Hit savings target', invest: 'Start investing',
      };
      reason = `Matches your goal: ${goalLabels[goals!.one_year_goal!] || goals!.one_year_goal}`;
    } else if (c.move.effort === 'low') {
      reason = `Quick win — £${c.move.annualImpact}/yr`;
    } else {
      reason = `£${c.move.annualImpact}/yr impact`;
    }

    if (!best || score > best.score) {
      best = { candidate: c, score, mu: { multiplier, liquidityTier }, reason, isChain };
    }
  }

  if (!best) return null;

  const { candidate, mu, reason } = best;

  // Compute trajectory
  let trajectory: NextMoveSuggestion['trajectory'] = undefined;
  if (goals && goals.target_amount && vol) {
    const confidence = simulateGoalTimeline(
      profile,
      goals.target_amount,
      candidate.move.monthlyImpact,
      vol,
    );
    trajectory = {
      monthsSaved: 0,
      hitRate12m: confidence.hitRate12m,
      p50: confidence.p50,
    };
  }

  return {
    move: candidate.move,
    rank: candidate.index + 1,
    reason,
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
  const existing = (existingRows || []).map((r: { achievement_key: string }) => r.achievement_key);

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
    debt_account_count: debtAccounts.length,
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
  identity: UserIdentity | null,
  debtAccounts: DebtAccount[],
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

  // Gap 1: Verify sub-goals from real data
  const { verified, completedCount, verifiedSteps, verifiedSubGoals } = await verifySubGoalsFromData(
    userId, enrichedTxs, analysis, profile, debtAccounts, previousAnalysis,
  );
  allEvents.push(...verified);

  const totalMoveCount = (analysis.all_moves || []).length;

  // Gap 4: Reactive achievement detection
  const { newAchievements, events: achievementEvents } = await detectReactiveAchievements(
    userId, analysis, completedCount, totalMoveCount,
  );
  allEvents.push(...achievementEvents);

  // Gap 3: Next priority move suggestion (with chaining from just-completed events)
  const nextMove = suggestNextPriorityMove(
    analysis, profile, goals, identity, debtAccounts, progressMap, allEvents,
  );

  return {
    events: allEvents,
    nextMove,
    newAchievements,
    planCompletedCount: completedCount,
    totalMoveCount,
    verifiedSteps,
    verifiedSubGoals,
  };
}
