import type { Goals, Move, GoalTrajectory, FinancialProfile, UserIdentity, DebtAccount, ScenarioComparison } from './types';
import type { LiquidityTier } from './liquidity-engine';
import { MAX_TRAJECTORY_MONTHS } from './constants';
import { computeProfileSignals, type ProfileSignals } from './profile-signals';
import {
  estimateVolatility,
  simulateGoalTimeline,
  simulateBufferNeed,
  calcMoveConsistency,
  type VolatilityProfile,
} from './monte-carlo';
import { calcMoveMarginalUtility, calcOpportunityCostMultiplier } from './liquidity-engine';
import { classifyDebtAccounts, applyLiquidityOverride } from './debt-engine';

const GOAL_LABELS: Record<string, string> = {
  clear_debt: 'Clear all debt',
  emergency_fund: 'Build emergency fund',
  save_target: 'Hit a savings target',
  reduce_spending: 'Reduce monthly spending',
  invest: 'Start investing',
  buy_home: 'Buy a home',
  go_freelance: 'Go freelance',
  financial_freedom: 'Achieve financial freedom',
};

const GOAL_DEFAULTS: Record<string, number> = {
  emergency_fund: 2500,
  save_target: 5000,
  buy_home: 25000,
  go_freelance: 10000,
  financial_freedom: 100000,
  reduce_spending: 0,
  invest: 1000,
  clear_debt: 0,
};

// ── Phase 3A: Feasibility Gate ──
// Checks whether a move can actually be executed given the user's constraints.

export interface FeasibilityResult {
  feasible: boolean;
  reason?: string;
}

export function checkFeasibility(
  move: Move,
  profile: FinancialProfile,
  bufferRec: { months: number; amount: number } | null,
  debtAccounts?: DebtAccount[],
): FeasibilityResult {
  const surplus = profile.monthly.surplus;
  const cat = move.category || 'spending';

  // 1. Liquidity check: reject if executing move would drop buffer below minimum
  if (cat === 'allocate' || cat === 'invest') {
    const bufferMin = bufferRec?.amount ?? profile.monthly.spending * 3;
    const liquidAssets = surplus * 3; // rough estimate
    if (move.amount && move.amount > liquidAssets - bufferMin) {
      return { feasible: false, reason: 'Executing this move would drop your buffer below the safety minimum' };
    }
  }

  // 2. Hierarchy check: reject Tier 3/4 moves if Tier 1 opportunities exist
  const hasExpensiveDebt = (debtAccounts || []).some(
    (d) => (d.interest_rate || 0) > 0.15 && (d.outstanding_balance || 0) > 0,
  );
  if (hasExpensiveDebt && (cat === 'invest' || cat === 'allocate')) {
    return { feasible: false, reason: 'High-interest debt should be prioritized before investing' };
  }

  // 3. Surplus check: can't execute if no surplus
  if (surplus <= 0 && cat !== 'spending' && cat !== 'debt') {
    return { feasible: false, reason: 'No surplus available — reduce spending first' };
  }

  return { feasible: true };
}

// ── Phase 3C: Scenario Comparison ──

export function compareScenarios(
  moveA: Move | null,
  moveB: Move,
  profile: FinancialProfile,
  vol: VolatilityProfile,
  targetAmount: number,
): ScenarioComparison {
  const currentImpact = moveA?.monthlyImpact || 0;
  const recommendedImpact = moveB.monthlyImpact;

  const current = simulateGoalTimeline(profile, targetAmount, currentImpact, vol, 42);
  const recommended = simulateGoalTimeline(profile, targetAmount, recommendedImpact, vol, 42);

  return {
    current: { median: current.p50, p10: current.p10, p90: current.p90 },
    recommended: { median: recommended.p50, p10: recommended.p10, p90: recommended.p90 },
    netDifference: current.p50 - recommended.p50,
    probability: recommended.hitRate24m,
  };
}

// ── Phase 3D: Partial Allocation ──

export interface AllocationSplit {
  moveIndex: number;
  action: string;
  amount: number;
  category: string;
}

export function computePartialAllocation(
  rankedMoves: RankedMove[],
  surplus: number,
): AllocationSplit[] {
  if (surplus <= 0 || rankedMoves.length === 0) return [];

  const splits: AllocationSplit[] = [];
  let remaining = surplus;

  // Allocate proportionally by score to top moves
  const topMoves = rankedMoves.slice(0, 5).filter((m) => m.monthlyImpact > 0);
  const totalScore = topMoves.reduce((s, m) => s + m.score, 0);

  if (totalScore <= 0) return [];

  for (const move of topMoves) {
    if (remaining <= 0) break;

    const proportion = move.score / totalScore;
    const amount = Math.min(
      Math.round(surplus * proportion),
      move.monthlyImpact,
      remaining,
    );

    if (amount >= 10) { // minimum £10 allocation
      splits.push({
        moveIndex: move.rank - 1,
        action: move.action,
        amount,
        category: move.category || 'spending',
      });
      remaining -= amount;
    }
  }

  return splits;
}

// ── Move Ranking ──
// Takes raw moves from enrichment engine + goals + identity signals.
// Re-ranks so the RIGHT TYPE of move comes first, not just biggest £ amount.
// Uses CRRA marginal utility, opportunity cost, goal alignment, and Monte Carlo consistency.

export interface RankedMove extends Move {
  rank: number;
  trajectory: GoalTrajectory | null;
  score: number;
  /** Monte Carlo: risk-adjusted monthly impact (accounts for follow-through) */
  riskAdjustedImpact?: number;
  /** Monte Carlo: 0-1 consistency score (1 = highly reliable) */
  consistencyScore?: number;
  /** Marginal utility multiplier — shows how much value the next pound delivers in this move's context */
  marginalMultiplier?: number;
  /** Liquidity tier: how quickly the savings from this move can be accessed */
  liquidityTier?: LiquidityTier;
}

// ── Layer 2b: Liquidity-Adjusted Marginal Utility ──
// Uses CRRA (Constant Relative Risk Aversion) utility functions instead of
// heuristic multipliers. Each move's value depends on:
//
//   1. Diminishing returns curve (category-specific γ parameter)
//   2. Liquidity tier (instant → long-locked) with buffer-gap amplification
//   3. Debt closing bonus (psychological + financial win near debt freedom)
//   4. Variance-adjusted reference points (from Monte Carlo buffer sizing)
//
// See lib/liquidity-engine.ts for the full economic model.

export function rankMoves(
  decisionStack: Move[],
  profile: any,
  goals: Goals | null,
  identity?: UserIdentity | null,
  debtAccounts?: any[],
): RankedMove[] {
  if (!decisionStack || decisionStack.length === 0) return [];

  // Compute profile signals once for all moves
  const signals = computeProfileSignals(profile as FinancialProfile, identity || null, goals, debtAccounts || []);

  // Compute volatility once for all moves
  let vol: VolatilityProfile | null = null;
  if (profile.budgetReality) {
    vol = estimateVolatility(profile as FinancialProfile, identity);
  }

  // Variance-adjusted buffer recommendation (computed once, shared across moves)
  let bufferRec: { months: number; amount: number } | null = null;
  if (vol && profile.budgetReality) {
    const rec = simulateBufferNeed(profile as FinancialProfile, vol);
    bufferRec = { months: rec.months, amount: rec.amount };
  }

  const scored: RankedMove[] = decisionStack.map((move, idx) => {
    // Phase 3A: Feasibility gate — mark infeasible moves as suppressed
    const feasibility = checkFeasibility(move, profile as FinancialProfile, bufferRec, debtAccounts);
    if (!feasibility.feasible) {
      move.suppressed = true;
      move.suppressedReason = feasibility.reason;
    }

    // Base score: annual impact normalised
    let score = move.annualImpact / 100;

    // Effort multiplier — easy wins score higher
    if (move.effort === 'low') score *= 1.3;
    else if (move.effort === 'high') score *= 0.8;

    // Liquidity-adjusted marginal utility — CRRA diminishing returns
    // with liquidity tier discounts and variance-adjusted reference points
    const { multiplier: marginal, liquidityTier } = calcMoveMarginalUtility(
      move,
      profile as FinancialProfile,
      vol,
      identity || null,
      debtAccounts,
      bufferRec,
    );
    score *= marginal;

    // Opportunity cost multiplier — compares effective return to risk-free rate
    // Makes 29.9% debt rank ~7x higher than 3.9% debt
    const opportunityCost = calcOpportunityCostMultiplier(move, profile as FinancialProfile, debtAccounts);
    score *= opportunityCost;

    // Goal alignment boost
    const moveCategory = move.category || 'spending';
    if (goals?.one_year_goal === 'clear_debt' && moveCategory === 'debt') score *= 1.3;
    if (goals?.one_year_goal === 'emergency_fund' && moveCategory === 'buffer') score *= 1.3;
    if (goals?.one_year_goal === 'reduce_spending' && moveCategory === 'spending') score *= 1.3;
    if (goals?.one_year_goal === 'save_target' && moveCategory === 'savings') score *= 1.3;
    if (goals?.one_year_goal === 'invest' && moveCategory === 'invest') score *= 1.3;

    // Profile signals: category affinity from identity + risk + priorities + events
    const affinity = signals.categoryAffinity[moveCategory] ?? 1.0;
    score *= affinity;

    // Sophistication gate: suppress complex moves for beginners
    if (signals.sophisticationLevel < 0.5 && (moveCategory === 'invest' || moveCategory === 'allocate')) {
      score *= 0.5;
    }

    // Monte Carlo consistency — reward reliable moves
    let riskAdjustedImpact: number | undefined;
    let consistencyScore: number | undefined;
    if (vol) {
      const mc = calcMoveConsistency(move, vol, 456 + idx);
      riskAdjustedImpact = mc.expectedMonthly;
      consistencyScore = mc.consistencyScore;
      // Blend: keep score in same units — multiply by consistency factor (0.7-1.0)
      // High consistency (0.95) → barely penalized; low consistency (0.3) → score × 0.79
      const consistencyFactor = 0.7 + 0.3 * (mc.consistencyScore || 0.5);
      score *= consistencyFactor;
    }

    // Phase 3A: Heavily penalize suppressed moves (still shown but deprioritized)
    if (move.suppressed) score *= 0.1;

    // Calculate trajectory for this move (with Monte Carlo if profile available)
    const trajectory = calcGoalTrajectory(profile, goals, move, identity);

    // Phase 3C: Attach scenario comparison for moves with goal context
    if (vol && goals?.target_amount && goals.target_amount > 0) {
      move.scenario = compareScenarios(null, move, profile as FinancialProfile, vol, goals.target_amount);
    }

    // ── Generate proof string ──
    // Concise mathematical explanation of the impact calculation
    const proof = buildProofString(move, trajectory, marginal, opportunityCost, liquidityTier, consistencyScore);

    return {
      ...move,
      proof,
      rank: 0,
      trajectory,
      score,
      riskAdjustedImpact,
      consistencyScore,
      marginalMultiplier: marginal,
      liquidityTier,
    };
  });

  // Phase 4C: Liquidity override gate — suppress non-tier-1 debt moves when buffer is dangerously low
  if (profile.monthly && debtAccounts && debtAccounts.length > 0) {
    const bufferMonths = profile.monthly.spending > 0
      ? (profile.monthly.surplus * 3) / profile.monthly.spending
      : 99;
    const tieredDebts = classifyDebtAccounts(debtAccounts);
    applyLiquidityOverride(scored, bufferMonths, tieredDebts);
  }

  // Sort by score (includes CRRA utility, opportunity cost, goal alignment, Monte Carlo consistency)
  scored.sort((a, b) => b.score - a.score);

  // Assign ranks
  scored.forEach((m, i) => { m.rank = i + 1; });

  return scored;
}

// Backward-compatible: returns just the top move
export function findMostMaterialMove(
  decisionStack: Move[],
  profile: any,
  goals: Goals | null
): Move | null {
  const ranked = rankMoves(decisionStack, profile, goals);
  return ranked.length > 0 ? ranked[0] : null;
}

// ── Goal Trajectory Calculator ──
// Phase 1: Deterministic baseline + Monte Carlo confidence bands.
// "70% chance of reaching goal in 13 months" replaces "13 months to goal".

export function calcGoalTrajectory(
  profile: any,
  goals: Goals | null,
  move: Move | null,
  identity?: UserIdentity | null,
): GoalTrajectory {
  const oneYear = goals?.one_year_goal || '';
  const label = GOAL_LABELS[oneYear] || oneYear;
  const targetAmount = goals?.target_amount || GOAL_DEFAULTS[oneYear] || 5000;

  const surplus = profile.monthly.surplus;
  const moveSaving = move?.monthlyImpact || 0;

  // ── Deterministic baseline (backward-compatible) ──
  const rawCurrentMonths = surplus > 0 ? Math.ceil(targetAmount / surplus) : Infinity;
  const rawNewMonths = (surplus + moveSaving) > 0 ? Math.ceil(targetAmount / (surplus + moveSaving)) : Infinity;

  const currentMonths = rawCurrentMonths === Infinity ? -1 : Math.min(rawCurrentMonths, MAX_TRAJECTORY_MONTHS);
  const newMonths = rawNewMonths === Infinity ? -1 : Math.min(rawNewMonths, MAX_TRAJECTORY_MONTHS);
  const monthsSaved = currentMonths < 0 ? 0 : Math.max(0, currentMonths - (newMonths < 0 ? currentMonths : newMonths));

  let insight = '';
  if (currentMonths < 0) {
    insight = `At current pace, you won't reach your goal. This move adds \u00a3${moveSaving}/month to get you moving.`;
  } else if (monthsSaved > 0) {
    insight = `This move cuts ${monthsSaved} months off your timeline \u2014 from ${currentMonths} to ${newMonths} months.`;
  } else {
    insight = `You're on track (${currentMonths} months). This move accelerates it.`;
  }

  const result: GoalTrajectory = {
    goalLabel: label,
    targetAmount,
    currentMonths,
    newMonths,
    monthsSaved,
    insight,
  };

  // ── Monte Carlo confidence bands (Phase 1) ──
  // Only run if we have enough profile data for variance estimation.
  if (targetAmount > 0 && profile.budgetReality) {
    const vol = estimateVolatility(profile as FinancialProfile, identity);
    const confidence = simulateGoalTimeline(
      profile as FinancialProfile,
      targetAmount,
      moveSaving,
      vol,
    );
    result.confidence = confidence;

    // Phase 3b: personalized buffer recommendation for emergency_fund goals
    if (oneYear === 'emergency_fund' || oneYear === 'buffer') {
      result.bufferRecommendation = simulateBufferNeed(profile as FinancialProfile, vol);
    }

    // Enrich insight with probability
    if (confidence.p50 > 0 && confidence.p50 < 120) {
      const spread = confidence.p90 - confidence.p10;
      if (spread > 3) {
        insight = `Most likely ${confidence.p50} months (${confidence.p10}\u2013${confidence.p90} range). `;
        if (confidence.hitRate12m > 0 && confidence.hitRate12m < 100) {
          insight += `${confidence.hitRate12m}% chance within 12 months.`;
        }
      } else {
        insight = `On track — ${confidence.p50} months with high certainty.`;
      }
      result.insight = insight;
    }
  }

  return result;
}

// ── Proof String Generator ──
// Creates a concise mathematical explanation of the move's impact.
// Displayed in the "THE MATH" box on move cards.

function buildProofString(
  move: Move,
  trajectory: GoalTrajectory | null,
  marginalMultiplier: number,
  opportunityCost: number,
  liquidityTier: LiquidityTier | undefined,
  consistencyScore: number | undefined,
): string {
  const parts: string[] = [];
  const cat = move.category || 'spending';

  // Line 1: Core calculation
  if (cat === 'debt') {
    // Debt moves: show interest cost math
    const monthlyPayment = move.monthlyImpact;
    if (move.annualImpact > 0) {
      parts.push(`\u00a3${move.annualImpact}/yr in interest saved`);
    }
    if (opportunityCost > 1.5) {
      parts.push(`debt APR is ${Math.round(opportunityCost * 4.5)}% vs 4.5% base rate \u2192 ${opportunityCost.toFixed(1)}x priority`);
    }
  } else if (cat === 'spending') {
    // Spending moves: show reduction math
    const subGoal = move.subGoals?.[0];
    if (subGoal && subGoal.startValue > 0) {
      const pctCut = Math.round(((subGoal.startValue - subGoal.targetValue) / subGoal.startValue) * 100);
      parts.push(`\u00a3${subGoal.startValue}/mo \u2192 \u00a3${subGoal.targetValue}/mo (${pctCut}% reduction)`);
    }
    parts.push(`\u00a3${move.monthlyImpact}/mo \u00d7 12 = \u00a3${move.annualImpact}/yr freed up`);
  } else if (cat === 'buffer' || cat === 'savings') {
    parts.push(`\u00a3${move.monthlyImpact}/mo \u00d7 12 = \u00a3${move.annualImpact}/yr toward your goal`);
  } else {
    parts.push(`\u00a3${move.monthlyImpact}/mo \u00d7 12 = \u00a3${move.annualImpact}/yr impact`);
  }

  // Line 2: Marginal utility context (only when noteworthy)
  if (marginalMultiplier > 1.5) {
    parts.push(`high marginal value: each \u00a31 here delivers ${marginalMultiplier.toFixed(1)}x utility`);
  } else if (marginalMultiplier < 0.5) {
    parts.push(`diminishing returns: already well-optimised in this area`);
  }

  // Line 3: Trajectory impact
  if (trajectory && trajectory.currentMonths > 0 && trajectory.monthsSaved > 0) {
    const conf = trajectory.confidence;
    if (conf && conf.p50 > 0 && conf.p50 < 120) {
      parts.push(`goal timeline: ${trajectory.currentMonths}mo \u2192 ${conf.p50}mo (${conf.p10}\u2013${conf.p90} range)`);
      if (conf.hitRate12m > 0 && conf.hitRate12m < 100) {
        parts.push(`${conf.hitRate12m}% chance of reaching goal within 12 months`);
      }
    } else {
      parts.push(`goal timeline: ${trajectory.currentMonths}mo \u2192 ${trajectory.newMonths}mo (${trajectory.monthsSaved}mo faster)`);
    }
  }

  // Line 4: Consistency (only if Monte Carlo ran)
  if (consistencyScore != null && consistencyScore < 0.7) {
    parts.push(`consistency: ${Math.round(consistencyScore * 100)}% \u2014 this one takes discipline`);
  }

  return parts.join('\n');
}
