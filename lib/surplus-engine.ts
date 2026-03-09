// ── UK Tax Math Engine ──
// Provides tax rate calculations used by the liquidity-adjusted marginal
// utility engine to make move scoring tax-aware.
//
// Core functions:
//   - calcMarginalRate: effective marginal rate at a given gross income
//   - calcPensionEffectiveReturn: £ in pension per £1 of take-home
//   - inferTaxSituation: best-effort tax inference from transaction data
//
// UK tax year 2025/26 rates. Update annually.

import type { FinancialProfile, UserIdentity } from './types';

// ── UK Tax Constants (2025/26) ──

export const UK_TAX = {
  personalAllowance: 12_570,
  personalAllowanceTaperStart: 100_000,
  personalAllowanceTaperEnd: 125_140,
  basicRateLimit: 37_700,
  higherRateThreshold: 50_270,
  additionalRateThreshold: 125_140,
  basicRate: 0.20,
  higherRate: 0.40,
  additionalRate: 0.45,
  niPrimaryThreshold: 12_570,
  niRate: 0.08,
  niUpperEarningsLimit: 50_270,
  niUpperRate: 0.02,
  isaAllowance: 20_000,
  pensionAnnualAllowance: 60_000,
  cgtAllowance: 3_000,
  cgtBasicRate: 0.10,
  cgtHigherRate: 0.20,
  childBenefitThreshold: 60_000,
  childBenefitTaperEnd: 80_000,
  childBenefitWeeklyFirst: 26.05,
  childBenefitWeeklySubsequent: 17.25,
} as const;

// ── Student Loan Thresholds (2025/26) ──

export const STUDENT_LOAN = {
  plan1: { threshold: 24_990, rate: 0.09 },
  plan2: { threshold: 27_295, rate: 0.09 },
  plan4: { threshold: 31_395, rate: 0.09 },
  plan5: { threshold: 25_000, rate: 0.09 },
  postgrad: { threshold: 21_000, rate: 0.06 },
} as const;

export type StudentLoanPlan = keyof typeof STUDENT_LOAN | 'none';

// ── Tax Situation ──

export interface TaxSituation {
  grossIncome: number;
  employerPensionPct: number;
  employerPensionMatch: number;
  personalPensionPct: number;
  salarySacrifice: boolean;
  studentLoan: StudentLoanPlan;
  hasChildBenefit: boolean;
  numberOfChildren: number;
  mortgageRate: number;
  mortgageBalance: number;
  existingIsaUsed: number;
  existingPensionUsed: number;
}

// ── Marginal Rate Calculator ──

export interface MarginalRateBreakdown {
  incomeTax: number;
  nationalInsurance: number;
  studentLoan: number;
  childBenefit: number;
  combined: number;
  keepRate: number;
}

/**
 * Calculate the effective marginal tax rate at a given gross income.
 * Accounts for income tax, PA taper, NI, student loan, and child benefit charge.
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

  // Income tax
  if (grossIncome > UK_TAX.additionalRateThreshold) {
    incomeTaxRate = UK_TAX.additionalRate;
  } else if (grossIncome > UK_TAX.personalAllowanceTaperStart
    && grossIncome <= UK_TAX.personalAllowanceTaperEnd) {
    incomeTaxRate = UK_TAX.higherRate + UK_TAX.basicRate; // 60% effective
  } else if (grossIncome > UK_TAX.higherRateThreshold) {
    incomeTaxRate = UK_TAX.higherRate;
  } else if (grossIncome > UK_TAX.personalAllowance) {
    incomeTaxRate = UK_TAX.basicRate;
  }

  // National Insurance
  if (grossIncome <= UK_TAX.niPrimaryThreshold) {
    niRate = 0;
  } else if (grossIncome <= UK_TAX.niUpperEarningsLimit) {
    niRate = UK_TAX.niRate;
  } else {
    niRate = UK_TAX.niUpperRate;
  }

  // Student loan
  if (studentLoan !== 'none') {
    const plan = STUDENT_LOAN[studentLoan];
    if (grossIncome > plan.threshold) {
      studentLoanRate = plan.rate;
    }
  }

  // Child benefit high income charge
  if (hasChildBenefit && numberOfChildren > 0
    && grossIncome > UK_TAX.childBenefitThreshold
    && grossIncome < UK_TAX.childBenefitTaperEnd) {
    const weeklyBenefit = UK_TAX.childBenefitWeeklyFirst
      + Math.max(0, numberOfChildren - 1) * UK_TAX.childBenefitWeeklySubsequent;
    const annualBenefit = weeklyBenefit * 52;
    childBenefitRate = annualBenefit / (UK_TAX.childBenefitTaperEnd - UK_TAX.childBenefitThreshold);
  }

  const combined = incomeTaxRate + niRate + studentLoanRate + childBenefitRate;

  return {
    incomeTax: incomeTaxRate,
    nationalInsurance: niRate,
    studentLoan: studentLoanRate,
    childBenefit: childBenefitRate,
    combined: Math.min(combined, 0.95),
    keepRate: Math.max(0.05, 1 - combined),
  };
}

// ── Pension Effective Return ──

/**
 * How many pension-pounds does £1 of take-home buy?
 *
 * Salary sacrifice: £1 in pension costs (1 - marginal.combined) in take-home.
 *   So £1 net buys £(1/keepRate) in pension.
 *
 * SIPP: £1 net → HMRC adds basic rate relief → £(1/(1-incomeTax)) in pension.
 *   Higher rate reclaimed via self-assessment.
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
    return 1 / marginal.keepRate;
  }

  const taxRelief = marginal.incomeTax;
  return 1 / (1 - taxRelief);
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
  const netMonthly = profile.monthly.income;
  const netAnnual = netMonthly * 12;

  // Estimate gross from net using approximate effective rates
  let grossEstimate = netAnnual / (1 - 0.25);
  if (grossEstimate > UK_TAX.higherRateThreshold) {
    grossEstimate = netAnnual / (1 - 0.33);
  }
  if (grossEstimate > UK_TAX.personalAllowanceTaperStart) {
    grossEstimate = netAnnual / (1 - 0.42);
  }

  const hasMortgage = identity?.housing === 'mortgage';
  const mortgagePayment = profile.budgetReality.nonDiscretionary.items
    .find(i => i.category === 'Mortgage');
  const estimatedMortgageBalance = mortgagePayment
    ? mortgagePayment.monthly * 12 * 20
    : 0;

  return {
    grossIncome: Math.round(grossEstimate),
    employerPensionPct: identity?.work_setup === 'office' || identity?.work_setup === 'hybrid' ? 5 : 0,
    employerPensionMatch: identity?.work_setup === 'office' || identity?.work_setup === 'hybrid' ? 5 : 0,
    personalPensionPct: identity?.work_setup === 'office' || identity?.work_setup === 'hybrid' ? 5 : 0,
    salarySacrifice: false,
    studentLoan: 'none',
    hasChildBenefit: (identity?.dependents || []).includes('young_children'),
    numberOfChildren: (identity?.dependents || []).includes('young_children') ? 1 : 0,
    mortgageRate: hasMortgage ? 0.045 : 0,
    mortgageBalance: hasMortgage ? estimatedMortgageBalance : 0,
    existingIsaUsed: 0,
    existingPensionUsed: 0,
  };
}
