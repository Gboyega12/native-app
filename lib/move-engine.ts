import type { Goals, Move, GoalTrajectory, FlowchartPosition, FinancialProfile, UserIdentity } from './types';
import { MAX_TRAJECTORY_MONTHS } from './constants';
import {
  estimateVolatility,
  simulateGoalTimeline,
  simulateBufferNeed,
  calcMoveConsistency,
  type VolatilityProfile,
} from './monte-carlo';

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
}

// ── Layer 2b: Marginal Utility Multiplier ──
// Replaces the binary UKPF 3x/1.5x gate with a continuous, non-linear
// per-pound value score. Each move's multiplier depends on the user's
// current position on that category's diminishing returns curve.
//
// Buffer: steep when savings thin + variance high, flattens as buffer approaches target.
// Debt:   scales with utilization, bonus when close to closing an account.
// Invest: discounted when liquid reserves are thin (illiquid moves penalized more).
// Spending/Savings: flat — a freed/earned pound is a pound.
// Break-even: always urgent.

function calcMarginalMultiplier(
  move: Move,
  profile: FinancialProfile,
  vol: VolatilityProfile | null,
  identity: UserIdentity | null,
  debtAccounts?: any[],
  bufferRec?: { months: number; amount: number } | null,
): number {
  const cat = move.category || 'spending';
  const savingsRate = profile.metrics.savingsRate;

  // Variance-adjusted buffer target (as savings rate %)
  // Higher volatility → need more buffer → curve stays steep longer
  let bufferTargetRate: number;
  if (bufferRec && bufferRec.months > 0) {
    // Monte Carlo says this user needs N months of expenses as buffer.
    // Convert to a savings rate threshold: if they're saving enough to
    // build that buffer in ~12 months, they're on track.
    const monthlyExpenses = profile.monthly.spending;
    const neededMonthly = (bufferRec.amount) / 12;
    bufferTargetRate = profile.monthly.income > 0
      ? (neededMonthly / profile.monthly.income) * 100
      : 15;
    bufferTargetRate = Math.max(8, Math.min(bufferTargetRate, 30));
  } else {
    // Heuristic fallback based on work setup
    const work = identity?.work_setup;
    if (work === 'self_employed') bufferTargetRate = 25;
    else if (work === 'multiple_jobs' || work === 'student') bufferTargetRate = 20;
    else bufferTargetRate = 12;
  }

  switch (cat) {
    case 'buffer': {
      // Urgency: 1.0 when no savings, 0.0 when savings rate meets target
      const urgency = Math.max(0, Math.min(1, 1 - savingsRate / bufferTargetRate));
      // Range: 1.0 (fully buffered) to 3.0 (no buffer at all)
      return 1 + 2 * urgency;
    }

    case 'debt': {
      const debts = debtAccounts || [];
      const totalLimit = debts.reduce((s: number, d: any) => s + (d.credit_limit || 0), 0);
      const totalBalance = debts.reduce((s: number, d: any) => s + (d.outstanding_balance || 0), 0);
      const util = totalLimit > 0 ? totalBalance / totalLimit : 0.5; // default mid if unknown
      const urgency = Math.min(1, util);
      // Closing bonus: if total balance could be cleared in ≤3 months of surplus
      const surplus = profile.monthly.surplus;
      const closingBonus = (totalBalance > 0 && surplus > 0 && totalBalance < surplus * 3) ? 0.5 : 0;
      // Range: 1.0 (low util, not close to clearing) to 3.0 (max util + close to clearing)
      return Math.min(3, 1 + 1.5 * urgency + closingBonus);
    }

    case 'invest': {
      // Liquidity discount: penalize illiquid moves when buffer is thin
      const bufferGap = Math.max(0, Math.min(1, 1 - savingsRate / bufferTargetRate));
      const actionLower = (move.action || '').toLowerCase();
      const isIlliquid = actionLower.includes('pension') || actionLower.includes('salary sacrifice') || actionLower.includes('lifetime isa');
      // Illiquid: 0.5 to 1.0. Liquid: 0.8 to 1.0.
      return isIlliquid ? (1 - 0.5 * bufferGap) : (1 - 0.2 * bufferGap);
    }

    case 'break_even':
      return 2.5; // always urgent — in deficit

    case 'spending':
    case 'savings':
    default:
      return 1.0;
  }
}

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

    // Marginal utility multiplier — continuous, non-linear per-pound value
    // Replaces the binary UKPF 3x gate with diminishing returns curves
    const marginal = calcMarginalMultiplier(
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
    };
  });

  // Sort by UKPF-weighted score (now includes consistency)
  scored.sort((a, b) => b.ukpfScore - a.ukpfScore);

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
