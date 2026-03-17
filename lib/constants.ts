export const UK_BENCHMARKS = {
  subscriptions: { count: 5, monthly: 52 },
  foodDelivery: 68,
  savingsRate: 11,
};

// ── Move generation thresholds ──
// Minimum monthly spend before a move is generated for that category.

export const MOVE_THRESHOLDS = {
  subscriptionMinCount: 4,
  foodDeliveryMin: 50,
  foodDeliveryCutPct: 0.4,
  eatingOutMin: 80,
  eatingOutCutPct: 0.25,
  shoppingMin: 150,
  shoppingCutPct: 0.25,
  transportMin: 100,
  transportCutPct: 0.2,
  coffeeMin: 40,
  coffeeCutPct: 0.5,
  subscriptionCutPct: 0.3,
  defaultDebtAPR: 0.079,            // Fallback APR when interest rate unknown (personal loan floor)
  singleDebtOverpayPct: 0.1,
  singleDebtOverpayMaxSurplusPct: 0.5,
  singleDebtOverpayCap: 200,
  bufferSavingsRateThreshold: 10,
  bufferAutoSavePct: 0.5,
  bufferMinTarget: 500,
  highSaverThreshold: 15,
  highSaverInterestRate: 0.045,
} as const;

// ── Analysis window ──
// Number of months of recent data used for income & spending calculations.
// Full 12-month data is still fetched for pattern detection (recurring subs etc).
export const ANALYSIS_MONTHS = 4;

// ── Income detection thresholds ──

export const INCOME_THRESHOLDS = {
  minRegularAmount: 100,
  minRegularCount: 3,       // Require 3+ regular credits to count as income
  largeCreditMin: 500,
  largeCreditMinCount: 3,   // Require 3+ large credits (was 2)
  largeCreditIntervalMin: 5,         // Lowered from 20 to support weekly partner/shared income
  largeCreditIntervalMax: 45,
  windfallMin: 1000,        // One-off credits above this → windfall, not income
} as const;

// ── Default APRs for debt accounts ──
// TrueLayer does not provide interest rates, so we use these defaults
// until the user updates them manually.

export const DEFAULT_APR: Record<string, number> = {
  credit_card: 0.219,       // UK average credit card APR
  overdraft: 0.399,         // Typical arranged overdraft EAR
  overdraft_facility: 0.399,
  personal_loan: 0.079,     // Average personal loan rate
};

/** Estimate minimum payment from account type and balance */
export function defaultMinimumPayment(type: string, balance: number): number {
  if (type === 'credit_card') {
    // Typical UK minimum: max(£25, 2.5% of balance)
    return Math.max(25, Math.round(balance * 0.025));
  }
  if (type === 'overdraft' || type === 'overdraft_facility') {
    // Overdrafts typically require full repayment but charge monthly fees
    return Math.max(15, Math.round(balance * 0.05));
  }
  // Personal loan: assume 36-month term
  return Math.round(balance / 36);
}

// ── Trajectory display cap ──
// Months-to-goal beyond this are shown as "50+ years"

export const MAX_TRAJECTORY_MONTHS = 600;
