// ── Liquidity-Adjusted Marginal Utility Engine ──
// Replaces heuristic 3x/1.5x multipliers with real economic utility functions.
//
// Core model: CRRA (Constant Relative Risk Aversion)
//   U(c) = c^(1-γ) / (1-γ)  for γ ≠ 1
//   U(c) = ln(c)             for γ = 1
//   MU(c) = c^(-γ)           marginal utility of the next pound
//
// Each spending category has its own risk-aversion parameter γ (gamma):
//   High γ (essentials): steep diminishing returns — first £ is critical
//   Low γ (discretionary): flatter curve — value is more linear
//
// Layered with liquidity tiers: a £1 locked in a pension is worth less
// than £1 in your current account when your buffer is thin.

import type { Move, FinancialProfile, UserIdentity } from './types';
import type { VolatilityProfile } from './monte-carlo';

// ── Liquidity Tiers ──
// Discount factor applied to the marginal utility based on how quickly
// the user can access the money. Thin buffers amplify the penalty on
// illiquid moves.

export type LiquidityTier = 'instant' | 'near_liquid' | 'short_locked' | 'medium_locked' | 'long_locked';

const BASE_LIQUIDITY_DISCOUNT: Record<LiquidityTier, number> = {
  instant: 1.0,        // Current account, cancelled subscription savings
  near_liquid: 0.95,   // Easy-access savings account
  short_locked: 0.85,  // Notice accounts, regular savers
  medium_locked: 0.75, // Cash ISA, premium bonds
  long_locked: 0.55,   // Pension, Lifetime ISA (before 60)
};

/**
 * Liquidity discount, amplified when the user's buffer is thin.
 * A user with no savings gets a harsher penalty for locking money away
 * than a user with 6 months of buffer.
 */
export function getLiquidityDiscount(
  tier: LiquidityTier,
  bufferGap: number, // 0 = fully buffered, 1 = no buffer at all
): number {
  const base = BASE_LIQUIDITY_DISCOUNT[tier];
  if (tier === 'instant' || tier === 'near_liquid') return base;
  // Amplify penalty: at full buffer gap, locked tiers lose up to 30% extra
  const amplification = 1 - (0.30 * bufferGap * (1 - base));
  return Math.max(0.2, base * amplification);
}

// ── Category Risk Aversion (γ) ──
// Higher γ = steeper diminishing returns.
// Essentials: losing the first £100 of rent is catastrophic.
// Entertainment: losing £100 of Netflix budget is uncomfortable, not critical.

const SPENDING_CATEGORY_GAMMA: Record<string, number> = {
  // Essentials — steep diminishing returns
  'Rent': 2.2,
  'Mortgage': 2.2,
  'Bills': 2.0,
  'Utilities': 2.0,
  'Council Tax': 2.0,
  'Childcare': 2.2,
  'Groceries': 1.8,
  'Insurance': 1.8,
  'Health': 1.6,

  // Semi-essential — moderate curve
  'Transport': 1.4,
  'Education': 1.3,

  // Discretionary — flatter curve
  'Eating Out': 0.8,
  'Coffee & Cafes': 0.7,
  'Shopping': 0.8,
  'Entertainment': 0.7,
  'Delivery': 0.6,
  'Subscriptions': 0.6,
  'Charity': 0.9,
  'Fitness': 0.8,
  'Personal Care': 0.9,
  'Pets': 1.2,

  // Catch-all
  'Other': 1.0,
  'Transfers': 0.5,
};

/** γ for move-level categories (buffer, debt, invest, etc.) */
const MOVE_CATEGORY_GAMMA: Record<string, number> = {
  break_even: 2.8,  // Deficit is the most urgent state
  buffer: 2.2,      // Buffer has steep returns (insurance against ruin)
  debt: 1.8,        // Interest saved — strong but not as steep
  spending: 0.9,    // Freed pound ≈ a pound
  savings: 1.0,     // Moderate curve
  invest: 0.7,      // Long-term, flatter (compounding makes up for it)
};

// ── UK Reference Spending (ONS Family Spending Survey) ──
// Median monthly spend per category. Used as the inflection point on
// the utility curve — spending BELOW this has high MU, ABOVE has low MU.

export const UK_REFERENCE_SPEND: Record<string, number> = {
  'Rent': 850,
  'Mortgage': 900,
  'Bills': 200,
  'Utilities': 180,
  'Groceries': 280,
  'Insurance': 120,
  'Council Tax': 160,
  'Childcare': 800,
  'Transport': 180,
  'Health': 50,
  'Education': 100,
  'Eating Out': 80,
  'Coffee & Cafes': 30,
  'Shopping': 150,
  'Entertainment': 60,
  'Delivery': 45,
  'Subscriptions': 50,
  'Fitness': 40,
  'Personal Care': 35,
  'Pets': 50,
  'Charity': 30,
  'Other': 100,
};

/** Reference monthly allocation for move categories */
const MOVE_CATEGORY_REFERENCE: Record<string, number> = {
  break_even: 1,     // Any deficit → reference near zero (maximum urgency)
  buffer: 200,       // ~£200/month toward buffer is healthy
  debt: 150,         // Median debt repayment
  spending: 500,     // Median discretionary
  savings: 200,      // Median savings contribution
  invest: 150,       // Median investment
};

// ── Core Utility Functions ──

/**
 * CRRA marginal utility: MU(c) = (c/ref)^(-γ)
 *
 * Normalised so MU = 1.0 at the reference spending level.
 * Below reference → MU > 1 (underspending, high value per £).
 * Above reference → MU < 1 (overspending, diminishing returns).
 */
export function marginalUtility(
  currentSpend: number,
  gamma: number,
  reference: number,
): number {
  const c = Math.max(currentSpend, 0.5); // floor to avoid log(0)/div-by-zero
  const ref = Math.max(reference, 1);
  return Math.pow(c / ref, -gamma);
}

/**
 * Total utility (integral of MU). Used by the budget solver.
 * U(c) = ref * (c/ref)^(1-γ) / (1-γ)  for γ ≠ 1
 * U(c) = ref * ln(c/ref)               for γ = 1
 */
export function totalUtility(
  spend: number,
  gamma: number,
  reference: number,
): number {
  const c = Math.max(spend, 0.5);
  const ref = Math.max(reference, 1);
  const ratio = c / ref;
  if (Math.abs(gamma - 1) < 0.01) {
    return ref * Math.log(ratio);
  }
  return ref * (Math.pow(ratio, 1 - gamma) - 1) / (1 - gamma);
}

// ── Move-Level Marginal Utility ──

/**
 * Infer the liquidity tier of a move from its action text and category.
 */
export function inferLiquidityTier(move: Move): LiquidityTier {
  const action = (move.action || '').toLowerCase();
  const cat = move.category || 'spending';

  if (
    action.includes('pension') ||
    action.includes('salary sacrifice') ||
    action.includes('lifetime isa')
  ) {
    return 'long_locked';
  }

  if (action.includes(' isa') || action.includes('premium bond')) {
    return 'medium_locked';
  }

  if (action.includes('notice account') || action.includes('regular saver')) {
    return 'short_locked';
  }

  if (cat === 'buffer' || cat === 'savings' || action.includes('savings account')) {
    return 'near_liquid';
  }

  return 'instant';
}

/**
 * Full liquidity-adjusted marginal utility for a single move.
 *
 * Combines:
 *   1. CRRA diminishing returns (category-specific γ)
 *   2. Liquidity tier discount (amplified by buffer gap)
 *   3. Debt closing bonus (extra utility when near debt freedom)
 *   4. Variance-adjusted buffer reference (from Monte Carlo)
 */
export function calcMoveMarginalUtility(
  move: Move,
  profile: FinancialProfile,
  vol: VolatilityProfile | null,
  identity: UserIdentity | null,
  debtAccounts?: any[],
  bufferRec?: { months: number; amount: number } | null,
): { multiplier: number; liquidityTier: LiquidityTier } {
  const cat = move.category || 'spending';
  const tier = inferLiquidityTier(move);

  // ── Current allocation in this move's category ──
  let currentSpend: number;
  switch (cat) {
    case 'buffer': {
      const rate = profile.metrics.savingsRate;
      currentSpend = Math.max(0, (rate / 100) * profile.monthly.income);
      break;
    }
    case 'debt':
      currentSpend = profile.monthly.debtPayments;
      break;
    case 'invest':
      currentSpend = Math.max(0, profile.monthly.surplus * 0.3);
      break;
    case 'break_even':
      currentSpend = 0; // in deficit — zero positive allocation
      break;
    default:
      currentSpend = profile.budgetReality?.discretionary?.total || profile.monthly.spending * 0.4;
  }

  // ── Reference: variance-adjusted for buffer ──
  let reference = MOVE_CATEGORY_REFERENCE[cat] || 200;
  if (cat === 'buffer' && bufferRec) {
    // Monte Carlo says the user needs £X buffer → monthly target = X/12
    reference = Math.max(reference, bufferRec.amount / 12);
  }

  // ── γ (risk aversion) ──
  const gamma = MOVE_CATEGORY_GAMMA[cat] || 1.0;

  // ── Raw CRRA marginal utility ──
  let mu = marginalUtility(currentSpend, gamma, reference);

  // ── Buffer gap for liquidity penalty ──
  const savingsRate = profile.metrics.savingsRate;
  let bufferTargetRate = 12;
  if (bufferRec && bufferRec.months > 0) {
    const monthlyExpenses = profile.monthly.spending;
    const needed = bufferRec.amount / 12;
    bufferTargetRate = profile.monthly.income > 0
      ? (needed / profile.monthly.income) * 100
      : 15;
    bufferTargetRate = Math.max(8, Math.min(bufferTargetRate, 30));
  } else {
    const work = identity?.work_setup;
    if (work === 'self_employed') bufferTargetRate = 25;
    else if (work === 'multiple_jobs' || work === 'student') bufferTargetRate = 20;
  }
  const bufferGap = Math.max(0, Math.min(1, 1 - savingsRate / bufferTargetRate));

  // ── Apply liquidity discount ──
  const discount = getLiquidityDiscount(tier, bufferGap);
  mu *= discount;

  // ── Debt closing bonus ──
  if (cat === 'debt' && debtAccounts) {
    const totalBalance = debtAccounts.reduce(
      (s: number, d: any) => s + (d.outstanding_balance || 0), 0,
    );
    const surplus = profile.monthly.surplus;
    if (totalBalance > 0 && surplus > 0 && totalBalance < surplus * 3) {
      mu *= 1.35; // 35% bonus: clearing debt entirely is a psychological win
    }
  }

  // ── Clamp ──
  return {
    multiplier: Math.max(0.25, Math.min(3.5, mu)),
    liquidityTier: tier,
  };
}

// ── Spending-Category Utility (for the budget solver) ──

/**
 * Get the γ parameter for a spending category.
 */
export function getCategoryGamma(category: string, isEssential: boolean): number {
  return SPENDING_CATEGORY_GAMMA[category] || (isEssential ? 1.5 : 0.8);
}

/**
 * Get the UK reference spend for a category.
 */
export function getCategoryReference(category: string): number {
  return UK_REFERENCE_SPEND[category] || 100;
}
