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

import type { Move, FinancialProfile, UserIdentity } from './types.js';
import type { VolatilityProfile } from './monte-carlo.js';
import { calcMarginalRate, calcPensionEffectiveReturn, inferTaxSituation, type TaxSituation } from './surplus-engine.js';

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

  // ── Conservative surplus when essential gaps exist ──
  // If we detect essentials missing from the data (rent via partner, variable
  // bills, etc.), the surplus is likely overstated. Use the midpoint of
  // typical ranges as a conservative deduction.
  let effectiveSurplus = profile.monthly.surplus;
  const essentialGapDeduction = (profile as any).essentialGapDeduction || 0;
  if (essentialGapDeduction > 0) {
    effectiveSurplus = Math.max(0, effectiveSurplus - essentialGapDeduction);
  }

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
      currentSpend = Math.max(0, effectiveSurplus * 0.3);
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
  let bufferGap = Math.max(0, Math.min(1, 1 - savingsRate / bufferTargetRate));

  // ── Pay frequency adjustment ──
  // Weekly/fortnightly earners replenish faster, reducing effective buffer gap.
  // A weekly earner with a thin buffer is less exposed than a monthly earner
  // with the same buffer — their next paycheck is days away, not weeks.
  const primaryIncome = profile.incomeSources?.find((s) => s.isSalary) || profile.incomeSources?.[0];
  const payFrequency = primaryIncome?.frequency || 'monthly';
  if (payFrequency === 'weekly') {
    bufferGap *= 0.80; // 20% reduction — cash replenishes every 7 days
  } else if (payFrequency === 'fortnightly') {
    bufferGap *= 0.90; // 10% reduction — cash replenishes every 14 days
  }

  // ── Apply liquidity discount ──
  const discount = getLiquidityDiscount(tier, bufferGap);
  mu *= discount;

  // ── Tax efficiency multiplier ──
  // For invest/savings moves, the effective value of £1 depends on the tax
  // wrapper. A pension contribution with 40% relief turns £0.60 net into £1.00
  // in the pension — that's a 1.67x multiplier on utility per pound of take-home.
  // This makes the CRRA model tax-aware: pension moves naturally rank higher for
  // higher-rate taxpayers, ISA beats GIA, employer match dominates everything.
  const taxMultiplier = calcTaxEfficiencyMultiplier(move, profile, identity);
  mu *= taxMultiplier;

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
    multiplier: Math.max(0.25, Math.min(4.0, mu)), // raised cap to 4.0 for tax-boosted moves
    liquidityTier: tier,
  };
}

// ── Tax Efficiency Multiplier ──
// Adjusts the marginal utility of invest/savings moves based on the
// tax wrapper they target. This is where UK tax math enters the CRRA model.
//
// The multiplier represents how many £ of value each £1 of take-home
// produces in the target wrapper:
//   - Employer match: 2.0+ (your £1 → £2+ in pension)
//   - Salary sacrifice pension (higher rate): ~1.67 (£0.60 net → £1.00)
//   - SIPP (higher rate): ~1.67 (£1 net → £1.67 in pension after relief)
//   - ISA: 1.0 (no tax on growth, but no upfront boost)
//   - GIA: <1.0 (tax drag on gains reduces effective value)
//   - Mortgage overpay: guaranteed return at mortgage rate (no tax)

function calcTaxEfficiencyMultiplier(
  move: Move,
  profile: FinancialProfile,
  identity: UserIdentity | null,
): number {
  const cat = move.category || 'spending';
  if (cat !== 'invest' && cat !== 'savings' && cat !== 'debt') return 1.0;

  const action = (move.action || '').toLowerCase();

  // Infer tax situation for the marginal rate calculation
  let tax: TaxSituation;
  try {
    tax = inferTaxSituation(profile, identity);
  } catch {
    return 1.0; // can't compute — no penalty, no boost
  }

  const marginal = calcMarginalRate(
    tax.grossIncome,
    tax.studentLoan,
    tax.hasChildBenefit,
    tax.numberOfChildren,
  );

  // ── Employer pension match ──
  // £1 you contribute → employer adds £1 → 100% instant return.
  // Plus tax savings if salary sacrifice.
  if (action.includes('employer match') || action.includes('full employer')) {
    const pensionBoost = tax.salarySacrifice
      ? calcPensionEffectiveReturn(tax.grossIncome, 'salary_sacrifice', tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren)
      : 1.0;
    return 1.0 + pensionBoost; // match + tax relief
  }

  // ── Pension (salary sacrifice or SIPP) ──
  if (action.includes('pension') || action.includes('salary sacrifice') || action.includes('sipp')) {
    const method = (action.includes('salary sacrifice') || tax.salarySacrifice)
      ? 'salary_sacrifice' as const
      : 'sipp' as const;

    // Pension in the PA taper zone (£100k-£125,140) is exceptionally valuable
    const boost = calcPensionEffectiveReturn(
      tax.grossIncome, method, tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren,
    );

    // Pension multiplier: how many pension-pounds per take-home pound.
    // Capped to avoid extreme values from edge cases.
    return Math.min(2.5, boost);
  }

  // ── ISA ──
  // No upfront tax boost, but all growth is tax-free.
  // Compare to GIA where growth is taxed at CGT rate.
  // Effective multiplier: 1.0 + the tax drag avoided.
  if (action.includes(' isa') || action.includes('stocks and shares isa') || action.includes('stocks & shares isa')) {
    // Tax drag on a GIA at ~7% growth over 10 years averages ~0.5-1% pa
    // ISA avoids this → worth ~1.05-1.10x per pound vs GIA
    const cgtRate = marginal.incomeTax >= 0.40 ? 0.20 : 0.10;
    return 1.0 + (cgtRate * 0.15); // modest boost for tax-free wrapper
  }

  // ── Mortgage overpayment ──
  // Guaranteed return at the mortgage rate, tax-free.
  // This should compete with post-tax returns on savings.
  if (action.includes('mortgage') && action.includes('overpay')) {
    // Mortgage rate as a multiplier: 4.5% mortgage ≈ 1.045x per pound.
    // Compare to post-tax savings rate to determine relative value.
    const mortgageRate = tax.mortgageRate || 0.045;
    const postTaxSavingsRate = 0.04 * (1 - marginal.incomeTax); // savings interest taxed
    if (mortgageRate > postTaxSavingsRate) {
      return 1.0 + (mortgageRate - postTaxSavingsRate); // small bonus
    }
    return 1.0;
  }

  // ── Premium Bonds ──
  // Prize rate ~4%, tax-free. Compare to post-tax savings.
  if (action.includes('premium bond')) {
    const postTaxSavings = 0.04 * (1 - marginal.incomeTax);
    return 1.0 + Math.max(0, 0.04 - postTaxSavings); // tax-free advantage
  }

  // ── Debt overpayment ──
  // Rate-based return is now handled by calcOpportunityCostMultiplier in move-engine.
  // No additional tax multiplier here to avoid double-counting.

  return 1.0;
}

// ── Opportunity Cost Multiplier ──
// Compares effective return of a move to the risk-free rate.
// Paying 39.9% debt = 39.9% guaranteed return → much higher than 4.5% savings.

export function calcOpportunityCostMultiplier(
  move: Move,
  profile: FinancialProfile,
  debtAccounts?: any[],
): number {
  const cat = move.category || 'spending';
  const boeRate = 0.045; // risk-free baseline (BOE base rate)

  if (cat === 'debt') {
    // Effective return = APR of the debt being targeted
    const debts = debtAccounts || [];
    const highestAPR = debts.reduce((max: number, d: any) => {
      const apr = d.interest_rate || 0;
      return apr > max ? apr : max;
    }, 0.079); // floor at personal loan rate
    return Math.min(3.0, highestAPR / boeRate); // cap at 3x to avoid extreme distortion
  }

  if (cat === 'savings' || cat === 'buffer') {
    // Effective return = best savings rate available
    return 1.0; // savings rate ≈ base rate → 1x multiplier
  }

  if (cat === 'invest') {
    // Expected equity return minus risk discount
    const expectedReturn = 0.07; // long-run UK equity ~7%
    const riskDiscount = 0.02;   // volatility penalty
    return Math.max(1.0, (expectedReturn - riskDiscount) / boeRate);
  }

  return 1.0; // spending moves: no rate comparison
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
