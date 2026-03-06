// ── Surplus Allocation Engine ──
// For users with positive surplus: answers "where does the next pound go?"
//
// Mathematical model:
//   1. Compute effective marginal tax rate at current income
//   2. Calculate after-tax effective return for each wrapper/destination
//   3. Build a waterfall: allocate surplus in order of highest effective return
//   4. Project compound growth per tier with Monte Carlo bands
//
// UK tax year 2025/26 rates. Update annually.

import type { FinancialProfile, UserIdentity, Move } from './types';
import type { VolatilityProfile } from './monte-carlo';

// ── UK Tax Constants (2025/26) ──

export const UK_TAX = {
  personalAllowance: 12_570,
  personalAllowanceTaperStart: 100_000,
  // PA reduces by £1 for every £2 over £100k → fully gone at £125,140
  personalAllowanceTaperEnd: 125_140,
  basicRateLimit: 37_700, // taxable income up to this = 20%
  higherRateThreshold: 50_270, // PA + basic band
  additionalRateThreshold: 125_140,
  basicRate: 0.20,
  higherRate: 0.40,
  additionalRate: 0.45,
  niPrimaryThreshold: 12_570, // annual
  niRate: 0.08, // 8% on earnings between PT and UEL
  niUpperEarningsLimit: 50_270,
  niUpperRate: 0.02, // 2% above UEL
  // ISA
  isaAllowance: 20_000,
  // Pension
  pensionAnnualAllowance: 60_000,
  pensionLifetimeAllowance: Infinity, // abolished from 2024/25
  // Personal Savings Allowance
  psaBasicRate: 1_000,
  psaHigherRate: 500,
  psaAdditionalRate: 0,
  // Capital Gains
  cgtAllowance: 3_000,
  cgtBasicRate: 0.10,
  cgtHigherRate: 0.20,
  // Dividend
  dividendAllowance: 500,
  dividendBasicRate: 0.0875,
  dividendHigherRate: 0.3375,
  dividendAdditionalRate: 0.3935,
  // Child Benefit (High Income Charge)
  childBenefitThreshold: 60_000,
  childBenefitTaperEnd: 80_000,
  childBenefitWeeklyFirst: 26.05,
  childBenefitWeeklySubsequent: 17.25,
} as const;

// ── Student Loan Thresholds (2025/26) ──

export const STUDENT_LOAN = {
  plan1: { threshold: 24_990, rate: 0.09 },
  plan2: { threshold: 27_295, rate: 0.09 },
  plan4: { threshold: 31_395, rate: 0.09 }, // Scotland
  plan5: { threshold: 25_000, rate: 0.09 },
  postgrad: { threshold: 21_000, rate: 0.06 },
} as const;

export type StudentLoanPlan = keyof typeof STUDENT_LOAN | 'none';

// ── Tax Situation ──

export interface TaxSituation {
  grossIncome: number;
  employerPensionPct: number;     // employer contribution %
  employerPensionMatch: number;   // employer matches up to this % of salary
  personalPensionPct: number;     // existing personal contribution %
  salarySacrifice: boolean;       // whether pension is via salary sacrifice
  studentLoan: StudentLoanPlan;
  hasChildBenefit: boolean;
  numberOfChildren: number;
  mortgageRate: number;           // current mortgage interest rate (0 if none)
  mortgageBalance: number;        // outstanding balance
  existingIsaUsed: number;        // ISA allowance used this tax year
  existingPensionUsed: number;    // pension allowance used this tax year
}

// ── Marginal Rate Calculator ──

/**
 * Calculate the effective marginal tax rate at a given gross income.
 * Accounts for:
 *   - Income tax (basic/higher/additional)
 *   - Personal allowance taper (60% effective rate in £100k-£125,140 band)
 *   - National Insurance
 *   - Student loan repayments
 *   - Child benefit high income charge
 */
export function calcMarginalRate(
  grossIncome: number,
  studentLoan: StudentLoanPlan = 'none',
  hasChildBenefit: boolean = false,
  numberOfChildren: number = 0,
): MarginalRateBreakdown {
  let incomeTaxRate = 0;
  let niRate = 0;
  let studentLoanRate = 0;
  let childBenefitRate = 0;

  // ── Income tax ──
  if (grossIncome > UK_TAX.additionalRateThreshold) {
    incomeTaxRate = UK_TAX.additionalRate;
  } else if (grossIncome > UK_TAX.personalAllowanceTaperStart
    && grossIncome <= UK_TAX.personalAllowanceTaperEnd) {
    // In the PA taper zone: for every £2 earned, £1 of PA is lost
    // So effective rate = marginal rate + 20% (from losing PA)
    // = 40% + 20% = 60%
    incomeTaxRate = UK_TAX.higherRate + UK_TAX.basicRate; // 60%
  } else if (grossIncome > UK_TAX.higherRateThreshold) {
    incomeTaxRate = UK_TAX.higherRate;
  } else if (grossIncome > UK_TAX.personalAllowance) {
    incomeTaxRate = UK_TAX.basicRate;
  }

  // ── National Insurance ──
  if (grossIncome <= UK_TAX.niPrimaryThreshold) {
    niRate = 0;
  } else if (grossIncome <= UK_TAX.niUpperEarningsLimit) {
    niRate = UK_TAX.niRate;
  } else {
    niRate = UK_TAX.niUpperRate;
  }

  // ── Student loan ──
  if (studentLoan !== 'none') {
    const plan = STUDENT_LOAN[studentLoan];
    if (grossIncome > plan.threshold) {
      studentLoanRate = plan.rate;
    }
  }

  // ── Child benefit high income charge ──
  if (hasChildBenefit && numberOfChildren > 0
    && grossIncome > UK_TAX.childBenefitThreshold
    && grossIncome < UK_TAX.childBenefitTaperEnd) {
    // Lose 1% of child benefit per £200 over threshold
    const weeklyBenefit = UK_TAX.childBenefitWeeklyFirst
      + Math.max(0, numberOfChildren - 1) * UK_TAX.childBenefitWeeklySubsequent;
    const annualBenefit = weeklyBenefit * 52;
    // Per £200 over threshold, lose 1% of annual benefit
    // So per £1 over threshold, lose annualBenefit / 20000
    // Effective marginal rate from HICBC = annualBenefit / 20000
    childBenefitRate = annualBenefit / (UK_TAX.childBenefitTaperEnd - UK_TAX.childBenefitThreshold);
  }

  const combined = incomeTaxRate + niRate + studentLoanRate + childBenefitRate;

  return {
    incomeTax: incomeTaxRate,
    nationalInsurance: niRate,
    studentLoan: studentLoanRate,
    childBenefit: childBenefitRate,
    combined: Math.min(combined, 0.95), // theoretical cap
    keepRate: Math.max(0.05, 1 - combined),
  };
}

export interface MarginalRateBreakdown {
  incomeTax: number;
  nationalInsurance: number;
  studentLoan: number;
  childBenefit: number;
  combined: number;
  keepRate: number; // 1 - combined: what you keep from the next £1
}

// ── Tax Relief Calculator ──

/**
 * Calculate the effective return from contributing £1 to a pension (SIPP or salary sacrifice).
 *
 * For salary sacrifice:
 *   - Saves income tax at marginal rate
 *   - Saves NI at marginal rate
 *   - Saves student loan at marginal rate (contribution comes off gross)
 *   - Can recover child benefit if it brings income below threshold
 *
 * For personal SIPP contribution:
 *   - HMRC adds basic rate relief (20%) automatically
 *   - Higher/additional rate taxpayers claim the rest via self-assessment
 *   - No NI saving (already paid)
 *   - Can reduce income for child benefit purposes
 *
 * Returns the effective boost: £1 net cost → £X in the pension.
 */
export function calcPensionEffectiveReturn(
  grossIncome: number,
  method: 'salary_sacrifice' | 'sipp',
  studentLoan: StudentLoanPlan = 'none',
  hasChildBenefit: boolean = false,
  numberOfChildren: number = 0,
): number {
  const marginal = calcMarginalRate(grossIncome, studentLoan, hasChildBenefit, numberOfChildren);

  if (method === 'salary_sacrifice') {
    // £1 of salary sacrificed = £1 in pension, costs you (1 - marginal.combined) in take-home
    // Effective return = 1 / keepRate - 1 (return on the take-home cost)
    // But more intuitively: £1 net cost buys £(1/keepRate) in pension
    return 1 / marginal.keepRate;
  }

  // SIPP: you pay from net income, get basic rate relief from HMRC
  // Cost to you: £1 net. HMRC adds £0.25 (for basic rate payer) → £1.25 in pension
  // Higher rate: claim additional 20% via SA → effective cost is £0.60 for £1 in pension
  // So £1 net buys £(1 / (1 - incomeTax)) in pension
  const taxRelief = marginal.incomeTax;
  return 1 / (1 - taxRelief);
}

// ── Allocation Destinations ──

export type AllocationDestination =
  | 'employer_match'
  | 'high_interest_debt'
  | 'pension_tax_relief'
  | 'pension_pa_recovery'  // pension to recover personal allowance (60% band)
  | 'pension_child_benefit' // pension to recover child benefit
  | 'isa'
  | 'mortgage_overpay'
  | 'gia'
  | 'emergency_buffer'
  | 'premium_bonds';

export interface WaterfallTier {
  destination: AllocationDestination;
  label: string;
  monthlyAmount: number;
  annualAmount: number;
  effectiveReturn: number;    // first-year effective return (tax relief + growth)
  guaranteedReturn: number;   // the guaranteed component (tax relief, interest saved)
  growthReturn: number;       // the market/growth component (uncertain)
  capacity: number;           // max annual allocation to this tier
  capacityUsed: number;       // amount already allocated this tax year
  reasoning: string;
  /** Compound projection over 5, 10, 20 years (nominal, pre-inflation) */
  projection: CompoundProjection;
}

export interface CompoundProjection {
  years5: number;
  years10: number;
  years20: number;
  /** Monthly contribution that produces this projection */
  monthlyContribution: number;
  /** Assumed annual growth rate */
  growthRate: number;
}

export interface SurplusAllocation {
  monthlySurplus: number;
  annualSurplus: number;
  marginalRate: MarginalRateBreakdown;
  waterfall: WaterfallTier[];
  totalAllocated: number;
  unallocated: number;
  /** Weighted average effective first-year return across all tiers */
  blendedReturn: number;
  /** How many £ of tax relief / employer match are being left on the table */
  freeMoneyMissed: number;
}

// ── Growth Assumptions ──

const GROWTH_RATES: Record<string, number> = {
  equity: 0.07,           // long-run real + inflation ≈ 7% nominal
  bonds: 0.04,
  cash_savings: 0.04,     // high-interest savings accounts
  premium_bonds: 0.04,    // prize rate ≈ 4%
  pension_default: 0.06,  // blended multi-asset default fund
  mortgage_saved: 0,      // no growth, just interest saved
  debt_saved: 0,          // no growth, just interest saved
};

function compoundProjection(
  monthlyAmount: number,
  annualRate: number,
): CompoundProjection {
  const r = annualRate / 12;
  const fv = (months: number) => {
    if (r === 0) return monthlyAmount * months;
    return monthlyAmount * ((Math.pow(1 + r, months) - 1) / r);
  };

  return {
    years5: Math.round(fv(60)),
    years10: Math.round(fv(120)),
    years20: Math.round(fv(240)),
    monthlyContribution: monthlyAmount,
    growthRate: annualRate,
  };
}

// ── Core: Build Surplus Waterfall ──

/**
 * Given a user's financial situation, build the optimal surplus allocation waterfall.
 * Each tier is ordered by effective return — the mathematically best place for the next £.
 *
 * The waterfall fills greedily: saturate the highest-return tier before moving to the next.
 */
export function buildSurplusWaterfall(
  profile: FinancialProfile,
  tax: TaxSituation,
  identity: UserIdentity | null,
): SurplusAllocation {
  const surplus = Math.max(0, profile.monthly.surplus);
  const annualSurplus = surplus * 12;
  const marginal = calcMarginalRate(
    tax.grossIncome, tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren,
  );

  const tiers: WaterfallTier[] = [];

  // ── 1. Employer pension match (100%+ instant return) ──
  if (tax.employerPensionMatch > 0 && tax.personalPensionPct < tax.employerPensionMatch) {
    const unmatchedPct = tax.employerPensionMatch - tax.personalPensionPct;
    const annualCapacity = (unmatchedPct / 100) * tax.grossIncome;
    const monthlyCapacity = annualCapacity / 12;

    // Return: employer puts in £1 for your £1 = 100% instant return
    // Plus tax relief if salary sacrifice
    const pensionBoost = tax.salarySacrifice
      ? calcPensionEffectiveReturn(tax.grossIncome, 'salary_sacrifice', tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren)
      : 1;
    // Total: employer match (100%) + your net cost efficiency
    const effectiveReturn = 1.0 + (pensionBoost - 1); // 100% match + tax savings

    tiers.push({
      destination: 'employer_match',
      label: 'Employer pension match',
      monthlyAmount: 0, // filled by waterfall
      annualAmount: 0,
      effectiveReturn,
      guaranteedReturn: 1.0, // the match itself
      growthReturn: GROWTH_RATES.pension_default,
      capacity: annualCapacity,
      capacityUsed: 0,
      reasoning: `Your employer matches up to ${tax.employerPensionMatch}% of salary. You're contributing ${tax.personalPensionPct}%. Each extra £1 you put in, they add £1 — that's a 100% instant return before any investment growth.`,
      projection: compoundProjection(0, GROWTH_RATES.pension_default),
    });
  }

  // ── 2. High-interest debt (guaranteed return at debt rate) ──
  // Debt overpayment gives a guaranteed, tax-free return equal to the interest rate.
  // We don't have debt rates in the profile, so estimate from debt signals.
  const debtPayments = profile.monthly.debtPayments;
  if (debtPayments > 0 && profile.metrics.debtAccountCount > 0) {
    // Assume credit card rate (~19%) if we see card debt, otherwise ~8% for loans
    const estimatedRate = profile.metrics.creditCardCount > 0 ? 0.19 : 0.08;
    const annualCapacity = debtPayments * 12 * 3; // rough: could overpay up to 3x current payments

    tiers.push({
      destination: 'high_interest_debt',
      label: 'Pay off high-interest debt',
      monthlyAmount: 0,
      annualAmount: 0,
      effectiveReturn: estimatedRate,
      guaranteedReturn: estimatedRate,
      growthReturn: 0,
      capacity: annualCapacity,
      capacityUsed: 0,
      reasoning: `Paying off debt at ~${(estimatedRate * 100).toFixed(0)}% interest is a guaranteed, tax-free return. No investment reliably beats this.`,
      projection: compoundProjection(0, 0), // debt payoff doesn't compound positively
    });
  }

  // ── 3. Pension to recover personal allowance (60% effective band) ──
  if (tax.grossIncome > UK_TAX.personalAllowanceTaperStart
    && tax.grossIncome <= UK_TAX.personalAllowanceTaperEnd) {
    const amountInTaper = tax.grossIncome - UK_TAX.personalAllowanceTaperStart;
    const remainingPaToRecover = Math.min(amountInTaper, UK_TAX.personalAllowance);
    const annualCapacity = remainingPaToRecover;

    const method = tax.salarySacrifice ? 'salary_sacrifice' : 'sipp';
    // In the taper zone, every £1 to pension saves 60% income tax + NI + student loan
    const effectiveReturn = calcPensionEffectiveReturn(
      tax.grossIncome, method, tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren,
    );

    tiers.push({
      destination: 'pension_pa_recovery',
      label: 'Pension — recover personal allowance',
      monthlyAmount: 0,
      annualAmount: 0,
      effectiveReturn,
      guaranteedReturn: effectiveReturn - 1, // the tax relief portion
      growthReturn: GROWTH_RATES.pension_default,
      capacity: annualCapacity,
      capacityUsed: tax.existingPensionUsed,
      reasoning: `Your income is in the £100k–£125,140 band where you lose £1 of personal allowance for every £2 earned. Pension contributions here have a 60%+ effective tax relief rate — the highest available.`,
      projection: compoundProjection(0, GROWTH_RATES.pension_default),
    });
  }

  // ── 4. Pension to recover child benefit ──
  if (tax.hasChildBenefit && tax.numberOfChildren > 0
    && tax.grossIncome > UK_TAX.childBenefitThreshold
    && tax.grossIncome <= UK_TAX.childBenefitTaperEnd) {
    const amountOverThreshold = tax.grossIncome - UK_TAX.childBenefitThreshold;
    const annualCapacity = Math.min(amountOverThreshold,
      UK_TAX.childBenefitTaperEnd - UK_TAX.childBenefitThreshold);

    const weeklyBenefit = UK_TAX.childBenefitWeeklyFirst
      + Math.max(0, tax.numberOfChildren - 1) * UK_TAX.childBenefitWeeklySubsequent;
    const annualBenefit = weeklyBenefit * 52;

    // Effective return: pension contribution + recovering child benefit
    const method = tax.salarySacrifice ? 'salary_sacrifice' : 'sipp';
    const pensionReturn = calcPensionEffectiveReturn(
      tax.grossIncome, method, tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren,
    );

    tiers.push({
      destination: 'pension_child_benefit',
      label: 'Pension — recover child benefit',
      monthlyAmount: 0,
      annualAmount: 0,
      effectiveReturn: pensionReturn, // child benefit recovery already factored into marginal rate
      guaranteedReturn: pensionReturn - 1,
      growthReturn: GROWTH_RATES.pension_default,
      capacity: annualCapacity,
      capacityUsed: 0,
      reasoning: `Contributing to your pension brings your adjusted income below £${UK_TAX.childBenefitThreshold.toLocaleString()}, recovering £${Math.round(annualBenefit).toLocaleString()}/year in child benefit.`,
      projection: compoundProjection(0, GROWTH_RATES.pension_default),
    });
  }

  // ── 5. Pension for standard tax relief (higher/basic rate) ──
  {
    const pensionCapRemaining = Math.max(0,
      UK_TAX.pensionAnnualAllowance - tax.existingPensionUsed);

    if (pensionCapRemaining > 0 && marginal.incomeTax >= UK_TAX.basicRate) {
      const method = tax.salarySacrifice ? 'salary_sacrifice' : 'sipp';
      const effectiveReturn = calcPensionEffectiveReturn(
        tax.grossIncome, method, tax.studentLoan, tax.hasChildBenefit, tax.numberOfChildren,
      );

      const rateLabel = marginal.incomeTax >= UK_TAX.higherRate ? 'higher' : 'basic';

      tiers.push({
        destination: 'pension_tax_relief',
        label: `Pension — ${rateLabel} rate relief`,
        monthlyAmount: 0,
        annualAmount: 0,
        effectiveReturn,
        guaranteedReturn: effectiveReturn - 1,
        growthReturn: GROWTH_RATES.pension_default,
        capacity: pensionCapRemaining,
        capacityUsed: tax.existingPensionUsed,
        reasoning: method === 'salary_sacrifice'
          ? `Via salary sacrifice, each £1 of take-home you redirect costs you £${marginal.keepRate.toFixed(2)} but puts £1 in your pension — a ${((effectiveReturn - 1) * 100).toFixed(0)}% instant boost from tax + NI savings.`
          : `Each £1 you contribute, HMRC adds ${(marginal.incomeTax * 100).toFixed(0)}p in tax relief. As a ${rateLabel} rate taxpayer, £1 net cost puts £${(1 / (1 - marginal.incomeTax)).toFixed(2)} into your pension.`,
        projection: compoundProjection(0, GROWTH_RATES.pension_default),
      });
    }
  }

  // ── 6. ISA (tax-free growth) ──
  {
    const isaRemaining = Math.max(0, UK_TAX.isaAllowance - tax.existingIsaUsed);
    if (isaRemaining > 0) {
      tiers.push({
        destination: 'isa',
        label: 'Stocks & Shares ISA',
        monthlyAmount: 0,
        annualAmount: 0,
        effectiveReturn: GROWTH_RATES.equity, // no tax drag = full return
        guaranteedReturn: 0,
        growthReturn: GROWTH_RATES.equity,
        capacity: isaRemaining,
        capacityUsed: tax.existingIsaUsed,
        reasoning: `All growth and dividends inside an ISA are tax-free. At ${(GROWTH_RATES.equity * 100).toFixed(0)}% assumed growth, this is the most efficient wrapper after pension allowances are used.`,
        projection: compoundProjection(0, GROWTH_RATES.equity),
      });
    }
  }

  // ── 7. Mortgage overpayment (guaranteed return at mortgage rate) ──
  if (tax.mortgageRate > 0 && tax.mortgageBalance > 0) {
    // Most mortgages allow 10% overpayment per year without penalty
    const annualCapacity = tax.mortgageBalance * 0.10;

    tiers.push({
      destination: 'mortgage_overpay',
      label: 'Mortgage overpayment',
      monthlyAmount: 0,
      annualAmount: 0,
      effectiveReturn: tax.mortgageRate,
      guaranteedReturn: tax.mortgageRate,
      growthReturn: 0,
      capacity: annualCapacity,
      capacityUsed: 0,
      reasoning: `Overpaying your mortgage at ${(tax.mortgageRate * 100).toFixed(1)}% gives a guaranteed, tax-free return. Compare this to the after-tax return on savings — if your mortgage rate exceeds your after-tax savings rate, overpaying wins.`,
      projection: compoundProjection(0, 0), // interest saved, not compounding asset
    });
  }

  // ── 8. Premium Bonds (tax-free, liquid) ──
  tiers.push({
    destination: 'premium_bonds',
    label: 'Premium Bonds',
    monthlyAmount: 0,
    annualAmount: 0,
    effectiveReturn: GROWTH_RATES.premium_bonds,
    guaranteedReturn: 0, // prizes are probabilistic
    growthReturn: GROWTH_RATES.premium_bonds,
    capacity: 50_000, // NS&I max holding
    capacityUsed: 0,
    reasoning: `Prize rate ~${(GROWTH_RATES.premium_bonds * 100).toFixed(0)}%, tax-free. Liquid (3 working days). Good holding pen for surplus beyond ISA allowance.`,
    projection: compoundProjection(0, GROWTH_RATES.premium_bonds),
  });

  // ── 9. General Investment Account (taxable overflow) ──
  tiers.push({
    destination: 'gia',
    label: 'General Investment Account',
    monthlyAmount: 0,
    annualAmount: 0,
    effectiveReturn: calcGIAEffectiveReturn(marginal),
    guaranteedReturn: 0,
    growthReturn: GROWTH_RATES.equity,
    capacity: Infinity,
    capacityUsed: 0,
    reasoning: `After ISA and pension allowances, a GIA is the overflow. Growth is taxed: ${(UK_TAX.cgtBasicRate * 100).toFixed(0)}–${(UK_TAX.cgtHigherRate * 100).toFixed(0)}% CGT above the £${UK_TAX.cgtAllowance.toLocaleString()} allowance, dividends taxed above £${UK_TAX.dividendAllowance}.`,
    projection: compoundProjection(0, GROWTH_RATES.equity * 0.85), // rough tax drag
  });

  // ── Sort by effective return (descending) ──
  tiers.sort((a, b) => b.effectiveReturn - a.effectiveReturn);

  // ── Fill the waterfall ──
  let remaining = annualSurplus;
  let totalAllocated = 0;
  let freeMoneyMissed = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;

    const availableCapacity = Math.max(0, tier.capacity - tier.capacityUsed);
    const allocation = Math.min(remaining, availableCapacity);

    tier.annualAmount = Math.round(allocation);
    tier.monthlyAmount = Math.round(allocation / 12);
    tier.projection = compoundProjection(tier.monthlyAmount, tier.growthReturn);

    remaining -= allocation;
    totalAllocated += allocation;
  }

  // Calculate free money missed: employer match + high-return pension tiers not fully used
  for (const tier of tiers) {
    if (tier.destination === 'employer_match') {
      const unused = Math.max(0, tier.capacity - tier.annualAmount);
      if (unused > 0) freeMoneyMissed += unused; // employer match left on the table
    }
  }

  const blendedReturn = totalAllocated > 0
    ? tiers.reduce((sum, t) => sum + t.annualAmount * t.effectiveReturn, 0) / totalAllocated
    : 0;

  return {
    monthlySurplus: surplus,
    annualSurplus,
    marginalRate: marginal,
    waterfall: tiers.filter(t => t.annualAmount > 0 || t.destination === 'employer_match'),
    totalAllocated: Math.round(totalAllocated),
    unallocated: Math.round(remaining),
    blendedReturn: Math.round(blendedReturn * 1000) / 1000,
    freeMoneyMissed: Math.round(freeMoneyMissed),
  };
}

/**
 * Approximate after-tax return in a GIA.
 * Assumes equity growth, taxed via CGT with annual allowance.
 * This is a simplified model — real tax depends on when you sell.
 */
function calcGIAEffectiveReturn(marginal: MarginalRateBreakdown): number {
  const grossReturn = GROWTH_RATES.equity;
  // Rough tax drag: assume you crystallise gains annually
  // In practice, deferral helps — this is conservative
  const cgtRate = marginal.incomeTax >= UK_TAX.higherRate
    ? UK_TAX.cgtHigherRate
    : UK_TAX.cgtBasicRate;
  // With £3k allowance, small portfolios pay no CGT
  // For simplicity, assume partial tax drag
  const taxDrag = cgtRate * 0.5; // half the return is taxable on average
  return grossReturn * (1 - taxDrag);
}

// ── Surplus Moves Generator ──

/**
 * Generate moves from the surplus waterfall for users at flowchart level 7+.
 * These are ALLOCATION moves, not spending-reduction moves.
 */
export function generateSurplusMoves(
  waterfall: SurplusAllocation,
): Move[] {
  const moves: Move[] = [];

  for (const tier of waterfall.waterfall) {
    if (tier.monthlyAmount <= 0) continue;

    const move: Move = {
      action: buildMoveAction(tier),
      annualImpact: tier.annualAmount,
      monthlyImpact: tier.monthlyAmount,
      effort: getEffort(tier.destination),
      strategy: tier.reasoning,
      steps: buildSteps(tier),
      effect: buildEffect(tier),
      category: mapDestToCategory(tier.destination),
      timeline: buildTimeline(tier),
    };

    moves.push(move);
  }

  return moves;
}

function buildMoveAction(tier: WaterfallTier): string {
  switch (tier.destination) {
    case 'employer_match':
      return `Increase pension to get full employer match (£${tier.monthlyAmount}/mo)`;
    case 'high_interest_debt':
      return `Overpay high-interest debt by £${tier.monthlyAmount}/mo`;
    case 'pension_pa_recovery':
      return `Pension contribution to recover personal allowance (£${tier.monthlyAmount}/mo)`;
    case 'pension_child_benefit':
      return `Pension contribution to recover child benefit (£${tier.monthlyAmount}/mo)`;
    case 'pension_tax_relief':
      return `Contribute £${tier.monthlyAmount}/mo to pension for tax relief`;
    case 'isa':
      return `Invest £${tier.monthlyAmount}/mo into Stocks & Shares ISA`;
    case 'mortgage_overpay':
      return `Overpay mortgage by £${tier.monthlyAmount}/mo`;
    case 'premium_bonds':
      return `Put £${tier.monthlyAmount}/mo into Premium Bonds`;
    case 'gia':
      return `Invest £${tier.monthlyAmount}/mo in a General Investment Account`;
    default:
      return `Allocate £${tier.monthlyAmount}/mo to ${tier.label}`;
  }
}

function buildSteps(tier: WaterfallTier): string[] {
  switch (tier.destination) {
    case 'employer_match':
      return [
        'Check your payslip for current pension contribution %',
        'Contact HR or use your pension portal to increase your contribution',
        'Set contribution to at least the employer match threshold',
        'Verify the increase on your next payslip',
      ];
    case 'pension_pa_recovery':
    case 'pension_child_benefit':
    case 'pension_tax_relief':
      return [
        'Open a SIPP if you don\'t have one (Vanguard, AJ Bell, or similar)',
        `Set up a monthly direct debit for £${tier.monthlyAmount}`,
        'Choose a diversified fund (global equity tracker is the default)',
        'If higher/additional rate, claim extra relief via self-assessment',
      ];
    case 'isa':
      return [
        'Open a Stocks & Shares ISA if you don\'t have one',
        `Set up a monthly direct debit for £${tier.monthlyAmount}`,
        'Choose a low-cost global equity index fund',
        'Check remaining ISA allowance before year-end (5 April)',
      ];
    case 'mortgage_overpay':
      return [
        'Check your mortgage terms for overpayment allowance (usually 10%/year)',
        'Set up a monthly overpayment via your lender\'s app or standing order',
        'Track the balance reduction — each overpayment reduces future interest',
      ];
    case 'high_interest_debt':
      return [
        'List debts by interest rate (highest first)',
        `Direct £${tier.monthlyAmount}/mo extra toward the highest-rate debt`,
        'Once cleared, redirect the full payment to the next debt (avalanche method)',
      ];
    case 'premium_bonds':
      return [
        'Open an NS&I account at nsandi.com',
        `Set up a monthly standing order for £${tier.monthlyAmount}`,
        'Prizes are drawn monthly — check via the NS&I app',
      ];
    case 'gia':
      return [
        'Open a GIA with a low-cost platform (Vanguard, iWeb, InvestEngine)',
        `Set up a monthly investment of £${tier.monthlyAmount}`,
        'Use the CGT allowance (£3,000) and bed-and-ISA to manage tax',
      ];
    default:
      return [`Allocate £${tier.monthlyAmount}/mo to ${tier.label}`];
  }
}

function buildEffect(tier: WaterfallTier): string {
  const p = tier.projection;
  if (p.years10 > 0) {
    return `£${tier.monthlyAmount}/mo at ${(tier.growthReturn * 100).toFixed(0)}% growth → £${p.years5.toLocaleString()} in 5 years, £${p.years10.toLocaleString()} in 10 years, £${p.years20.toLocaleString()} in 20 years.`;
  }
  if (tier.guaranteedReturn > 0) {
    return `Guaranteed ${(tier.guaranteedReturn * 100).toFixed(1)}% return — £${Math.round(tier.annualAmount * tier.guaranteedReturn).toLocaleString()}/year saved in interest.`;
  }
  return `£${tier.monthlyAmount}/mo allocated to ${tier.label}.`;
}

function buildTimeline(tier: WaterfallTier): string {
  if (tier.destination === 'high_interest_debt') return '6-24 months to clear';
  if (tier.destination === 'employer_match') return 'Immediate — update pension contribution';
  if (tier.destination === 'mortgage_overpay') return 'Ongoing — reduces term over years';
  return 'Ongoing — monthly contributions';
}

function getEffort(dest: AllocationDestination): 'low' | 'medium' | 'high' {
  switch (dest) {
    case 'employer_match': return 'low';
    case 'isa': return 'low';
    case 'premium_bonds': return 'low';
    case 'pension_tax_relief': return 'medium';
    case 'pension_pa_recovery': return 'medium';
    case 'pension_child_benefit': return 'medium';
    case 'mortgage_overpay': return 'low';
    case 'high_interest_debt': return 'medium';
    case 'gia': return 'medium';
    default: return 'medium';
  }
}

function mapDestToCategory(dest: AllocationDestination): Move['category'] {
  switch (dest) {
    case 'employer_match':
    case 'pension_tax_relief':
    case 'pension_pa_recovery':
    case 'pension_child_benefit':
      return 'invest';
    case 'high_interest_debt':
      return 'debt';
    case 'isa':
    case 'gia':
      return 'invest';
    case 'mortgage_overpay':
      return 'debt';
    case 'premium_bonds':
      return 'savings';
    case 'emergency_buffer':
      return 'buffer';
    default:
      return 'savings';
  }
}

// ── Threshold Proximity Alerts ──

/**
 * Identify tax thresholds the user is near, where small changes
 * in income or pension contributions have outsized effects.
 */
export function findThresholdProximity(
  grossIncome: number,
  tax: TaxSituation,
): ThresholdAlert[] {
  const alerts: ThresholdAlert[] = [];
  const buffer = 3000; // within £3k of a threshold

  // Higher rate threshold
  if (grossIncome > UK_TAX.higherRateThreshold - buffer
    && grossIncome < UK_TAX.higherRateThreshold + buffer) {
    const distance = UK_TAX.higherRateThreshold - grossIncome;
    alerts.push({
      threshold: 'higher_rate',
      label: 'Higher rate tax threshold',
      amount: UK_TAX.higherRateThreshold,
      distance,
      direction: distance > 0 ? 'below' : 'above',
      insight: distance > 0
        ? `You're £${Math.abs(distance).toLocaleString()} below the higher rate threshold. Income above £${UK_TAX.higherRateThreshold.toLocaleString()} is taxed at 40% instead of 20%.`
        : `You're £${Math.abs(distance).toLocaleString()} into the higher rate band. A pension contribution of £${Math.abs(distance).toLocaleString()} would bring you back to basic rate.`,
    });
  }

  // Personal allowance taper
  if (grossIncome > UK_TAX.personalAllowanceTaperStart - buffer
    && grossIncome < UK_TAX.personalAllowanceTaperEnd + buffer) {
    const distance = UK_TAX.personalAllowanceTaperStart - grossIncome;
    alerts.push({
      threshold: 'pa_taper',
      label: 'Personal allowance taper',
      amount: UK_TAX.personalAllowanceTaperStart,
      distance,
      direction: distance > 0 ? 'below' : 'above',
      insight: distance > 0
        ? `You're £${Math.abs(distance).toLocaleString()} below the personal allowance taper. Income above £100,000 is effectively taxed at 60%.`
        : `You're in the 60% effective tax band. A pension contribution of £${Math.min(Math.abs(distance), UK_TAX.personalAllowance).toLocaleString()} would recover your personal allowance.`,
    });
  }

  // Child benefit threshold
  if (tax.hasChildBenefit && tax.numberOfChildren > 0) {
    if (grossIncome > UK_TAX.childBenefitThreshold - buffer
      && grossIncome < UK_TAX.childBenefitTaperEnd + buffer) {
      const distance = UK_TAX.childBenefitThreshold - grossIncome;
      const weeklyBenefit = UK_TAX.childBenefitWeeklyFirst
        + Math.max(0, tax.numberOfChildren - 1) * UK_TAX.childBenefitWeeklySubsequent;
      const annualBenefit = Math.round(weeklyBenefit * 52);

      alerts.push({
        threshold: 'child_benefit',
        label: 'Child benefit charge',
        amount: UK_TAX.childBenefitThreshold,
        distance,
        direction: distance > 0 ? 'below' : 'above',
        insight: distance > 0
          ? `You're £${Math.abs(distance).toLocaleString()} below the child benefit charge threshold. Above £${UK_TAX.childBenefitThreshold.toLocaleString()}, you start losing £${annualBenefit.toLocaleString()}/year in child benefit.`
          : `You're above the child benefit threshold. A pension contribution of £${Math.abs(distance).toLocaleString()} would recover up to £${annualBenefit.toLocaleString()}/year in child benefit.`,
      });
    }
  }

  return alerts;
}

export interface ThresholdAlert {
  threshold: 'higher_rate' | 'pa_taper' | 'child_benefit' | 'additional_rate';
  label: string;
  amount: number;
  distance: number;
  direction: 'above' | 'below';
  insight: string;
}

// ── Infer Tax Situation from Profile ──

/**
 * Best-effort inference of tax situation from transaction data and identity.
 * Users can override these in settings for precision.
 */
export function inferTaxSituation(
  profile: FinancialProfile,
  identity: UserIdentity | null,
): TaxSituation {
  // Gross income: estimate from net using marginal rate
  // For salary, net ≈ gross × (1 - effective_rate)
  // Start with a rough estimate and iterate
  const netMonthly = profile.monthly.income;
  const netAnnual = netMonthly * 12;

  // First pass: assume basic rate to estimate gross
  let grossEstimate = netAnnual / (1 - 0.25); // ~25% effective for median earner
  // Refine: if estimated gross > higher rate threshold, adjust
  if (grossEstimate > UK_TAX.higherRateThreshold) {
    grossEstimate = netAnnual / (1 - 0.33); // ~33% effective for higher rate
  }
  if (grossEstimate > UK_TAX.personalAllowanceTaperStart) {
    grossEstimate = netAnnual / (1 - 0.42); // ~42% effective in taper zone
  }

  // Detect mortgage from transactions
  const hasMortgage = identity?.housing === 'mortgage';
  const mortgagePayment = profile.budgetReality.nonDiscretionary.items
    .find(i => i.category === 'Mortgage');
  const estimatedMortgageBalance = mortgagePayment
    ? mortgagePayment.monthly * 12 * 20 // rough: 20 years remaining
    : 0;

  return {
    grossIncome: Math.round(grossEstimate),
    employerPensionPct: identity?.work_setup === 'office' || identity?.work_setup === 'hybrid' ? 5 : 0,
    employerPensionMatch: identity?.work_setup === 'office' || identity?.work_setup === 'hybrid' ? 5 : 0,
    personalPensionPct: identity?.work_setup === 'office' || identity?.work_setup === 'hybrid' ? 5 : 0,
    salarySacrifice: false, // conservative default
    studentLoan: 'none', // can't infer from transactions reliably
    hasChildBenefit: (identity?.dependents || []).includes('young_children'),
    numberOfChildren: (identity?.dependents || []).includes('young_children') ? 1 : 0,
    mortgageRate: hasMortgage ? 0.045 : 0, // estimate if not provided
    mortgageBalance: hasMortgage ? estimatedMortgageBalance : 0,
    existingIsaUsed: 0,
    existingPensionUsed: 0,
  };
}
