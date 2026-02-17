import type { Goals, Move, GoalTrajectory, FlowchartPosition } from './types';
import { MAX_TRAJECTORY_MONTHS } from './constants';

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

export function determineFlowchartPosition(profile: any, goals: Goals | null, debtAccounts?: any[]): FlowchartPosition {
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
// Calculates goal trajectories for each move.

export interface RankedMove extends Move {
  rank: number;
  trajectory: GoalTrajectory | null;
  ukpfScore: number;
}

export function rankMoves(
  decisionStack: Move[],
  profile: any,
  goals: Goals | null
): RankedMove[] {
  if (!decisionStack || decisionStack.length === 0) return [];

  const ukpf = determineFlowchartPosition(profile, goals);

  const scored: RankedMove[] = decisionStack.map((move) => {
    // Base score: annual impact normalised
    let score = move.annualImpact / 100;

    // Effort multiplier — easy wins score higher
    if (move.effort === 'low') score *= 1.3;
    else if (move.effort === 'high') score *= 0.8;

    // UKPF priority alignment — this is the key ranking factor
    // Moves matching the user's UKPF priority get a massive boost
    const moveCategory = move.category || 'spending';

    if (moveCategory === ukpf.priority) {
      score *= 3.0; // 3x boost for matching UKPF priority
    } else if (
      // Adjacent priorities get a smaller boost
      (ukpf.priority === 'break_even' && moveCategory === 'spending') ||
      (ukpf.priority === 'buffer' && moveCategory === 'savings') ||
      (ukpf.priority === 'debt' && moveCategory === 'break_even')
    ) {
      score *= 1.5;
    }

    // Goal alignment boost
    if (goals?.one_year_goal === 'clear_debt' && moveCategory === 'debt') score *= 1.3;
    if (goals?.one_year_goal === 'emergency_fund' && moveCategory === 'buffer') score *= 1.3;
    if (goals?.one_year_goal === 'reduce_spending' && moveCategory === 'spending') score *= 1.3;
    if (goals?.one_year_goal === 'save_target' && moveCategory === 'savings') score *= 1.3;
    if (goals?.one_year_goal === 'invest' && moveCategory === 'invest') score *= 1.3;

    // Calculate trajectory for this move
    const trajectory = calcGoalTrajectory(profile, goals, move);

    return {
      ...move,
      rank: 0,
      trajectory,
      ukpfScore: score,
    };
  });

  // Sort by UKPF-weighted score
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
// "Reach target in X months, Y months sooner"

export function calcGoalTrajectory(
  profile: any,
  goals: Goals | null,
  move: Move | null
): GoalTrajectory {
  const oneYear = goals?.one_year_goal || '';
  const label = GOAL_LABELS[oneYear] || oneYear;
  const targetAmount = goals?.target_amount || GOAL_DEFAULTS[oneYear] || 5000;

  const surplus = profile.monthly.surplus;
  const moveSaving = move?.monthlyImpact || 0;

  const rawCurrentMonths = surplus > 0 ? Math.ceil(targetAmount / surplus) : Infinity;
  const rawNewMonths = (surplus + moveSaving) > 0 ? Math.ceil(targetAmount / (surplus + moveSaving)) : Infinity;

  // Cap months at a displayable maximum (600 = 50 years)
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

  return {
    goalLabel: label,
    targetAmount,
    currentMonths,
    newMonths,
    monthsSaved,
    insight,
  };
}
