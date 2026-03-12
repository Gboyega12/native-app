// ── Budget-Line Constrained Optimisation Solver ──
//
// Given income and current category-level allocations, find the reallocation
// that maximises total weighted utility subject to the budget constraint.
//
// Economic principle: at optimum, the weighted marginal utility of a pound
// should be EQUAL across all moveable categories:
//
//   w_i · MU_i(c_i) = λ   for all i
//
// where λ is the shadow price of the budget constraint.
//
// Algorithm: iterative transfer — move £ from lowest weighted-MU category
// to highest weighted-MU category until MU gap converges below threshold.

import {
  marginalUtility,
  totalUtility,
  getCategoryGamma,
  getCategoryReference,
} from './liquidity-engine.js';
import type { FinancialProfile, UserIdentity } from './types.js';

// ── Types ──

export interface BudgetSlice {
  category: string;
  currentMonthly: number;
  optimalMonthly: number;
  delta: number;          // optimal - current (positive = allocate more)
  weightedMU: number;     // weighted marginal utility at optimal level
  gamma: number;
  reference: number;
  weight: number;
  isEssential: boolean;
  isFixed: boolean;       // true = cannot be reduced (e.g. rent, council tax)
}

export interface BudgetAllocation {
  slices: BudgetSlice[];
  totalIncome: number;
  totalCurrentSpend: number;
  unallocated: number;
  /** Shadow price λ — weighted MU at optimum (lower = more efficiently allocated) */
  shadowPrice: number;
  /** 0-100: how close the current allocation is to optimal */
  efficiency: number;
  /** Biggest single reallocation opportunity */
  topReallocation: {
    from: string;
    to: string;
    amount: number;
    utilityGain: string;
  } | null;
}

// ── Priority Weights ──
// User priorities from identity discovery shift the utility weights
// so the solver favours categories aligned with what the user cares about.

function buildWeights(identity?: UserIdentity | null): Record<string, number> {
  const base: Record<string, number> = {
    essential: 1.0,
    discretionary: 1.0,
    buffer: 1.0,
    debt: 1.0,
    savings: 1.0,
    invest: 1.0,
  };

  const priorities = identity?.priorities || [];
  if (priorities.includes('security')) {
    base.buffer *= 1.4;
    base.debt *= 1.2;
    base.essential *= 1.1;
  }
  if (priorities.includes('growth')) {
    base.invest *= 1.4;
    base.savings *= 1.2;
  }
  if (priorities.includes('freedom')) {
    base.savings *= 1.3;
    base.buffer *= 1.2;
  }
  if (priorities.includes('experiences')) {
    base.discretionary *= 1.2;
  }
  if (priorities.includes('family')) {
    base.essential *= 1.2;
    base.buffer *= 1.1;
  }

  const risk = identity?.risk_appetite;
  if (risk === 'conservative') {
    base.buffer *= 1.3;
    base.invest *= 0.8;
  } else if (risk === 'growth') {
    base.invest *= 1.3;
    base.buffer *= 0.9;
  }

  return base;
}

// ── Fixed Categories ──
// These cannot be reduced by the solver — they are contractual obligations.
const FIXED_CATEGORIES = new Set([
  'Rent', 'Mortgage', 'Council Tax', 'Insurance', 'Childcare',
]);

// ── Solver ──

/**
 * Solve the budget allocation: given the user's real income and current
 * spending pattern, find the optimal reallocation that maximises weighted
 * utility across all categories.
 *
 * The solver respects:
 * - Fixed obligations (rent, mortgage) that can't be reduced
 * - Essential vs discretionary classification from the enrichment engine
 * - User priorities and risk appetite as utility weights
 * - Surplus allocation across buffer, savings, debt, and investment
 */
export function solveBudgetAllocation(
  profile: FinancialProfile,
  identity?: UserIdentity | null,
): BudgetAllocation {
  // For variable earners, solve against the conservative income floor (p25)
  // so the budget doesn't assume a good week every week.
  const income = profile.monthly.isVariableIncome && profile.monthly.incomeFloor
    ? profile.monthly.incomeFloor
    : profile.monthly.income;
  if (income <= 0) {
    return {
      slices: [], totalIncome: 0, totalCurrentSpend: 0,
      unallocated: 0, shadowPrice: 0, efficiency: 0, topReallocation: null,
    };
  }

  const weights = buildWeights(identity);
  const slices: BudgetSlice[] = [];

  // ── Build slices from budget reality ──

  for (const item of (profile.budgetReality.nonDiscretionary.items || [])) {
    const gamma = getCategoryGamma(item.category, true);
    const ref = getCategoryReference(item.category);
    const isFixed = FIXED_CATEGORIES.has(item.category);
    slices.push({
      category: item.category,
      currentMonthly: item.monthly,
      optimalMonthly: item.monthly,
      delta: 0,
      weightedMU: 0,
      gamma,
      reference: ref,
      weight: weights.essential,
      isEssential: true,
      isFixed,
    });
  }

  for (const item of (profile.budgetReality.discretionary.items || [])) {
    const gamma = getCategoryGamma(item.category, false);
    const ref = getCategoryReference(item.category);
    slices.push({
      category: item.category,
      currentMonthly: item.monthly,
      optimalMonthly: item.monthly,
      delta: 0,
      weightedMU: 0,
      gamma,
      reference: ref,
      weight: weights.discretionary,
      isEssential: false,
      isFixed: false,
    });
  }

  // ── Virtual allocation categories for surplus ──
  const surplus = Math.max(0, profile.monthly.surplus);

  if (profile.monthly.debtPayments > 0) {
    slices.push({
      category: 'Debt Repayment',
      currentMonthly: profile.monthly.debtPayments,
      optimalMonthly: profile.monthly.debtPayments,
      delta: 0,
      weightedMU: 0,
      gamma: 1.8,
      reference: 150,
      weight: weights.debt,
      isEssential: true, // minimums are non-negotiable
      isFixed: true,      // can't reduce below minimum
    });
  }

  // Split unallocated surplus into buffer, savings, invest
  // Responsive starting point based on current financial state
  if (surplus > 0) {
    const savingsRate = profile.metrics?.savingsRate ?? 0;
    const hasDebt = profile.monthly.debtPayments > 0;
    const riskAppetite = identity?.risk_appetite;

    // Determine split based on buffer adequacy (savings rate as proxy)
    let bufferPct: number;
    let savingsPct: number;
    let investPct: number;

    if (savingsRate < 5) {
      // Near-zero buffer: prioritise buffer heavily
      bufferPct = 0.70; savingsPct = 0.20; investPct = 0.10;
    } else if (savingsRate < 15) {
      // Thin buffer: moderate buffer priority
      bufferPct = 0.50; savingsPct = 0.30; investPct = 0.20;
    } else if (hasDebt) {
      // Adequate buffer but has debt: redirect investment share to debt
      bufferPct = 0.20; savingsPct = 0.30; investPct = 0.50;
    } else {
      // Adequate buffer, no debt: balanced growth
      bufferPct = 0.20; savingsPct = 0.40; investPct = 0.40;
    }

    // Risk appetite adjustment (shift between buffer and invest, keeping total = 1.0)
    if (riskAppetite === 'conservative') {
      const shift = Math.min(0.10, investPct); // can't shift more than invest has
      bufferPct += shift; investPct -= shift;
    } else if (riskAppetite === 'growth') {
      const shift = Math.min(0.10, bufferPct); // can't shift more than buffer has
      investPct += shift; bufferPct -= shift;
    }

    const bufferShare = surplus * bufferPct;
    const savingsShare = surplus * savingsPct;
    const investShare = surplus * investPct;

    slices.push({
      category: 'Buffer',
      currentMonthly: bufferShare,
      optimalMonthly: bufferShare,
      delta: 0,
      weightedMU: 0,
      gamma: 2.2,
      reference: 200,
      weight: weights.buffer,
      isEssential: false,
      isFixed: false,
    });

    slices.push({
      category: 'Savings',
      currentMonthly: savingsShare,
      optimalMonthly: savingsShare,
      delta: 0,
      weightedMU: 0,
      gamma: 1.0,
      reference: 200,
      weight: weights.savings,
      isEssential: false,
      isFixed: false,
    });

    slices.push({
      category: 'Invest',
      currentMonthly: investShare,
      optimalMonthly: investShare,
      delta: 0,
      weightedMU: 0,
      gamma: 0.7,
      reference: 150,
      weight: weights.invest,
      isEssential: false,
      isFixed: false,
    });
  }

  // ── Iterative optimisation ──
  // Transfer small amounts from lowest weighted-MU to highest weighted-MU.

  const STEP = 5;    // £5 per iteration
  const MAX_ITER = 300;
  const MU_GAP_THRESHOLD = 0.03;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    // Recalculate weighted MU for each slice at current optimal level
    for (const s of slices) {
      s.weightedMU = s.weight * marginalUtility(
        Math.max(0.5, s.optimalMonthly), s.gamma, s.reference,
      );
    }

    // Find the highest-MU category (candidate to receive money)
    const sorted = [...slices].sort((a, b) => b.weightedMU - a.weightedMU);
    const receiver = sorted[0];

    // Find the lowest-MU transferable category (can give money away)
    const transferable = slices
      .filter((s) => !s.isFixed && s.optimalMonthly > STEP)
      .sort((a, b) => a.weightedMU - b.weightedMU);
    const donor = transferable[0];

    if (!receiver || !donor || receiver === donor) break;

    const gap = receiver.weightedMU - donor.weightedMU;
    if (gap < MU_GAP_THRESHOLD) break;

    // Transfer
    donor.optimalMonthly -= STEP;
    receiver.optimalMonthly += STEP;
  }

  // ── Compute deltas and round ──
  for (const s of slices) {
    s.optimalMonthly = Math.round(s.optimalMonthly);
    s.delta = s.optimalMonthly - Math.round(s.currentMonthly);
    // Final MU at optimal allocation
    s.weightedMU = Math.round(
      s.weight * marginalUtility(Math.max(0.5, s.optimalMonthly), s.gamma, s.reference) * 100,
    ) / 100;
  }

  // ── Top reallocation ──
  const byDelta = [...slices].sort((a, b) => a.delta - b.delta);
  const biggestCut = byDelta[0];
  const biggestAdd = byDelta[byDelta.length - 1];

  const topReallocation =
    biggestCut && biggestAdd && biggestCut !== biggestAdd && Math.abs(biggestCut.delta) >= 10
      ? {
          from: biggestCut.category,
          to: biggestAdd.category,
          amount: Math.min(Math.abs(biggestCut.delta), biggestAdd.delta),
          utilityGain: describeUtilityGain(biggestCut, biggestAdd),
        }
      : null;

  // ── Efficiency score ──
  // 100 = current allocation is already optimal, 0 = maximally misallocated
  const totalDelta = slices.reduce((s, sl) => s + Math.abs(sl.delta), 0);
  const totalCurrent = slices.reduce((s, sl) => s + sl.currentMonthly, 0);
  const efficiency = totalCurrent > 0
    ? Math.round(Math.max(0, Math.min(100, 100 - (totalDelta / totalCurrent) * 50)))
    : 50;

  // ── Shadow price (average weighted MU at optimum) ──
  const moveable = slices.filter((s) => !s.isFixed);
  const shadowPrice = moveable.length > 0
    ? Math.round(moveable.reduce((s, sl) => s + sl.weightedMU, 0) / moveable.length * 100) / 100
    : 0;

  return {
    slices,
    totalIncome: Math.round(income),
    totalCurrentSpend: Math.round(totalCurrent),
    unallocated: Math.round(Math.max(0, income - totalCurrent)),
    shadowPrice,
    efficiency,
    topReallocation,
  };
}

function describeUtilityGain(from: BudgetSlice, to: BudgetSlice): string {
  const amount = Math.min(Math.abs(from.delta), to.delta);
  if (to.category === 'Buffer' || to.category === 'Debt Repayment') {
    return `Redirecting £${amount}/month from ${from.category.toLowerCase()} to ${to.category.toLowerCase()} reduces financial risk`;
  }
  if (to.category === 'Invest' || to.category === 'Savings') {
    return `Moving £${amount}/month from ${from.category.toLowerCase()} into ${to.category.toLowerCase()} builds long-term wealth`;
  }
  return `Rebalancing £${amount}/month from ${from.category.toLowerCase()} to ${to.category.toLowerCase()} improves overall value per pound`;
}
