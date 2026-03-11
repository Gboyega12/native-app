import type { Goals, Move, GoalTrajectory, FlowchartPosition, FinancialProfile, UserIdentity } from './types.js';
import type { LiquidityTier } from './liquidity-engine.js';
import { MAX_TRAJECTORY_MONTHS } from './constants.js';
import {
  estimateVolatility,
  simulateGoalTimeline,
  simulateBufferNeed,
  calcMoveConsistency,
  type VolatilityProfile,
} from './monte-carlo.js';
import { calcMoveMarginalUtility } from './liquidity-engine.js';

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

// ── Layer 1: UKPF Flowchart ──
// Determines where the user sits on the UK Personal Finance flowchart.
// This sets the PRIORITY CATEGORY — what type of move matters most.
// A user with 19% credit card debt should NOT get "cancel Netflix" as #1.

export function determineFlowchartPosition(profile: any, goals: Goals | null, debtAccounts?: any[], _identity?: any): FlowchartPosition {
  const surplus = profile.monthly.surplus;
  const debtCount = profile.metrics.debtAccountCount;
  const savingsRate = profile.metrics.savingsRate;
  const debtPayments = profile.monthly.debtPayments;
  const situation = goals?.current_situation || '';

  // Check if debt is "good debt" (low utilization, rewards-focused)
  const debts = debtAccounts || [];
  const totalLimit = debts.reduce((s: number, d: any) => s + (d.credit_limit || 0), 0);
  const totalBalance = debts.reduce((s: number, d: any) => s + (d.outstanding_balance || 0), 0);
  const overallUtil = totalLimit > 0 ? (totalBalance / totalLimit) * 100 : -1;
  const isGoodDebt = overallUtil >= 0 && overallUtil <= 30;

  // Level 0: Spending more than earning — must break even first
  if (surplus < 0) {
    return { level: 0, label: 'Break even', priority: 'break_even' };
  }

  // Level 1: Overwhelmed by debt — get support
  if (situation === 'in_debt' && debtCount >= 3 && !isGoodDebt) {
    return { level: 1, label: 'Get debt support', priority: 'debt' };
  }

  // Level 2: No buffer — build a 1-month emergency fund
  if (savingsRate < 5) {
    return { level: 2, label: 'Build a buffer', priority: 'buffer' };
  }

  // Level 4: High-interest debt (credit cards, BNPL) — pay it off
  // Skip this level if user has good debt (low utilization, paying on time for rewards)
  if (debtCount >= 1 && !isGoodDebt && (situation === 'in_debt' || debtPayments > 100)) {
    return { level: 4, label: 'Clear high-interest debt', priority: 'debt' };
  }

  // Level 5: Buffer exists but not a full emergency fund (3 months)
  if (savingsRate < 15) {
    return { level: 5, label: 'Full emergency fund', priority: 'buffer' };
  }

  // Level 7: Short-term goals — save for specific targets
  if (savingsRate < 25) {
    return { level: 7, label: 'Short-term goals', priority: 'savings' };
  }

  // Level 9: Long-term wealth building
  return { level: 9, label: 'Long-term wealth', priority: 'invest' };
}

// ── Layer 2: Move Ranking ──
// Takes raw moves from enrichment engine + UKPF priority + goals.
// Re-ranks so the RIGHT TYPE of move comes first, not just biggest £ amount.
// Phase 3: Incorporates Monte Carlo consistency scoring for risk-adjusted ranking.

export interface RankedMove extends Move {
  rank: number;
  trajectory: GoalTrajectory | null;
  ukpfScore: number;
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

  const ukpf = determineFlowchartPosition(profile, goals, debtAccounts, identity);

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

    // UKPF tiebreaker — small boost for matching the user's flowchart priority
    const moveCategory = move.category || 'spending';
    if (moveCategory === ukpf.priority) {
      score *= 1.15;
    }

    // Goal alignment boost
    if (goals?.one_year_goal === 'clear_debt' && moveCategory === 'debt') score *= 1.3;
    if (goals?.one_year_goal === 'emergency_fund' && moveCategory === 'buffer') score *= 1.3;
    if (goals?.one_year_goal === 'reduce_spending' && moveCategory === 'spending') score *= 1.3;
    if (goals?.one_year_goal === 'save_target' && moveCategory === 'savings') score *= 1.3;
    if (goals?.one_year_goal === 'invest' && moveCategory === 'invest') score *= 1.3;

    // Monte Carlo consistency — reward reliable moves
    let riskAdjustedImpact: number | undefined;
    let consistencyScore: number | undefined;
    if (vol) {
      const mc = calcMoveConsistency(move, vol, 456 + idx);
      riskAdjustedImpact = mc.expectedMonthly;
      consistencyScore = mc.consistencyScore;
      // Blend: 70% marginal-utility score + 30% consistency-adjusted score
      score = score * 0.7 + (mc.expectedMonthly / 100) * mc.consistencyScore * 0.3 * 100;
    }

    // Calculate trajectory for this move (with Monte Carlo if profile available)
    const trajectory = calcGoalTrajectory(profile, goals, move, identity);

    return {
      ...move,
      rank: 0,
      trajectory,
      ukpfScore: score,
      riskAdjustedImpact,
      consistencyScore,
      marginalMultiplier: marginal,
      liquidityTier,
    };
  });

  // Sort by UKPF-weighted score (now includes consistency)
  scored.sort((a, b) => b.ukpfScore - a.ukpfScore);

  // ── Category diversity enforcement ──
  // Ensure top 5 moves span at least 2 categories. If the top 5 are all
  // one category, promote the highest-scoring move from a different category.
  if (scored.length >= 5) {
    const top5Categories = new Set(scored.slice(0, 5).map(m => m.category || 'spending'));
    if (top5Categories.size < 2) {
      const dominantCat = scored[0].category || 'spending';
      const altIdx = scored.findIndex((m, i) => i >= 5 && (m.category || 'spending') !== dominantCat);
      if (altIdx > 0) {
        const [alt] = scored.splice(altIdx, 1);
        scored.splice(4, 0, alt); // Insert at position 5
      }
    }
  }

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
    insight = `This move cuts ${monthsSaved} months off your timeline, from ${currentMonths} to ${newMonths} months.`;
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
