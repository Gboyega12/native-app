import type { Goals, Move, GoalTrajectory, FlowchartPosition } from './types';

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

export function determineFlowchartPosition(profile: any, goals: Goals | null): FlowchartPosition {
  const surplus = profile.monthly.surplus;
  const debtCount = profile.metrics.debtAccountCount;
  const savingsRate = profile.metrics.savingsRate;
  const situation = goals?.current_situation || '';

  if (surplus < 0) {
    return { level: 0, label: 'Break even' };
  }
  if (situation === 'in_debt' && debtCount >= 3) {
    return { level: 1, label: 'Debt support' };
  }
  if (savingsRate < 5) {
    return { level: 2, label: 'Build a buffer' };
  }
  if (debtCount >= 1 && situation === 'in_debt') {
    return { level: 4, label: 'Clear high-interest debt' };
  }
  if (savingsRate < 15) {
    return { level: 5, label: 'Full emergency fund' };
  }
  if (savingsRate < 25) {
    return { level: 7, label: 'Short-term goals' };
  }
  return { level: 9, label: 'Long-term wealth' };
}

export function calcGoalTrajectory(
  profile: any,
  goals: Goals | null,
  topMove: Move | null
): GoalTrajectory {
  const oneYear = goals?.one_year_goal || '';
  const label = GOAL_LABELS[oneYear] || oneYear;
  const targetAmount = goals?.target_amount || GOAL_DEFAULTS[oneYear] || 5000;

  const surplus = profile.monthly.surplus;
  const moveSaving = topMove?.monthlyImpact || 0;

  const currentMonths = surplus > 0 ? Math.ceil(targetAmount / surplus) : Infinity;
  const newMonths = (surplus + moveSaving) > 0 ? Math.ceil(targetAmount / (surplus + moveSaving)) : Infinity;
  const monthsSaved = currentMonths === Infinity ? 0 : currentMonths - newMonths;

  let insight = '';
  if (currentMonths === Infinity) {
    insight = `At current pace, you won't reach your goal. The top move adds \u00a3${moveSaving}/month to get you moving.`;
  } else if (monthsSaved > 0) {
    insight = `This move cuts ${monthsSaved} months off your timeline \u2014 from ${currentMonths} to ${newMonths} months.`;
  } else {
    insight = `You're already on a good trajectory (${currentMonths} months). Keep it up.`;
  }

  return {
    goalLabel: label,
    targetAmount,
    currentMonths: currentMonths === Infinity ? -1 : currentMonths,
    newMonths: newMonths === Infinity ? -1 : newMonths,
    monthsSaved,
    insight,
  };
}

export function findMostMaterialMove(
  decisionStack: Move[],
  profile: any,
  goals: Goals | null
): Move | null {
  if (!decisionStack || decisionStack.length === 0) return null;

  const ukpf = determineFlowchartPosition(profile, goals);

  const scored = decisionStack.map((move) => {
    let score = move.annualImpact / 100;

    if (move.effort === 'low') score *= 1.3;
    else if (move.effort === 'high') score *= 0.8;

    if (ukpf.level <= 2 && move.action.toLowerCase().includes('emergency')) score *= 1.5;
    if (ukpf.level === 4 && move.action.toLowerCase().includes('debt')) score *= 1.5;
    if (ukpf.level >= 7 && move.action.toLowerCase().includes('sav')) score *= 1.3;

    return { move, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].move;
}
