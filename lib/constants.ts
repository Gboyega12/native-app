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
  debtSnowballSavePct: 0.40,
  singleDebtOverpayPct: 0.30,
  singleDebtOverpayMaxSurplusPct: 0.5,
  singleDebtOverpayCap: 200,
  bufferSavingsRateThreshold: 10,
  bufferAutoSavePct: 0.5,
  bufferMinTarget: 500,
  highSaverThreshold: 15,
  highSaverInterestRate: 0.045,
  // Savings optimization moves
  boeBaseRate: 0.045,                // Bank of England base rate (public data, used for opportunity cost math)
  savingsRateTarget: 20,             // Next-tier target for savings rate acceleration
  idleCashMinSurplus: 100,           // Min monthly surplus before idle cash move triggers
  duplicateSubMinSavings: 10,        // Min £/mo savings before duplicate sub move triggers
  savingsConsistencyMinMonths: 3,    // Min months of data for consistency scoring
  // Investment scatter + LISA + fee moves
  investScatterMinPlatforms: 2,      // Min distinct platforms before scatter move fires
  investScatterMinMonthly: 50,       // Min total monthly outflow to investments
  lisaAnnualLimit: 4000,             // LISA annual contribution limit
  lisaBonusRate: 0.25,               // 25% government bonus
  isaAnnualLimit: 20000,             // Total ISA allowance per tax year
} as const;

// ── Default APR by debt type ──
// Used when TrueLayer doesn't provide interest rates. Based on UK market averages.
export const DEFAULT_APR: Record<string, number> = {
  credit_card: 0.399,      // 39.9% typical UK credit card
  store_card: 0.399,       // 39.9% store cards
  overdraft: 0.399,        // 39.9% EAR arranged overdraft
  personal_loan: 0.079,    // 7.9% representative APR
  car_finance: 0.089,      // 8.9% PCP/HP typical
  student_loan: 0.077,     // Plan 2: RPI + 3% (variable, ~7.7% 2024)
  bnpl: 0,                 // Buy Now Pay Later — 0% if paid on time
};

// ── Default minimum payment rules by debt type ──
// Returns monthly minimum payment given a balance.
export function defaultMinimumPayment(accountType: string, balance: number): number {
  if (balance <= 0) return 0;
  switch (accountType) {
    case 'credit_card':
    case 'store_card':
      return Math.max(25, Math.round(balance * 0.025)); // max(£25, 2.5%)
    case 'overdraft':
      // Interest-only: monthly interest on the balance
      return Math.round(balance * (DEFAULT_APR.overdraft / 12));
    case 'personal_loan':
    case 'car_finance':
    case 'student_loan':
      // Fixed-term: assume 36-month term
      return Math.round(balance / 36);
    case 'bnpl':
      // Fixed instalments: assume 3-month split
      return Math.round(balance / 3);
    default:
      return Math.max(25, Math.round(balance * 0.025));
  }
}

// ── Platform fee schedule ──
// Published annual platform/custody fees for known UK investment providers.
// Source: provider fee pages (public). Expressed as annual % of holdings.
// These are custody/platform fees only — fund charges are separate.
export const PLATFORM_FEES: Record<string, { annualPct: number; label: string; notes: string }> = {
  'Hargreaves Lansdown': { annualPct: 0.0045, label: '0.45%', notes: 'Capped at £45/yr for shares; 0.45% on funds' },
  'AJ Bell':            { annualPct: 0.0025, label: '0.25%', notes: '0.25% on funds; £3.50/deal for shares' },
  'Interactive Investor': { annualPct: 0,     label: '£0 (flat fee)', notes: '£4.99–£11.99/month flat fee, not % based' },
  'Vanguard':           { annualPct: 0.0015, label: '0.15%', notes: 'Capped at £375/yr' },
  'Nutmeg':             { annualPct: 0.0045, label: '0.45%', notes: '0.25–0.75% depending on plan' },
  'Trading 212':        { annualPct: 0,      label: '0%', notes: 'No platform fee; FX fee 0.15% on non-GBP' },
  'Freetrade':          { annualPct: 0,      label: '0%', notes: 'Free plan £0; Plus £4.99/mo for ISA' },
  'Wealthify':          { annualPct: 0.006,  label: '0.6%', notes: '0.6% management fee' },
  'DEGIRO':             { annualPct: 0,      label: '0%', notes: 'No platform fee; per-trade charges apply' },
  'eToro':              { annualPct: 0,      label: '0%', notes: 'No platform fee; spread-based pricing' },
  // Crypto platforms — fee structures differ (spread + withdrawal fees)
  'Coinbase':           { annualPct: 0,      label: 'spread', notes: '~0.5% spread on trades; no custody fee' },
  'Kraken':             { annualPct: 0,      label: 'spread', notes: '~0.26% maker fee; no custody fee' },
  'Binance':            { annualPct: 0,      label: '0.1%', notes: '0.1% trading fee; no custody fee' },
  'Crypto.com':         { annualPct: 0,      label: 'spread', notes: '~0.4% spread; no custody fee' },
};

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
  largeCreditIntervalMin: 20,
  largeCreditIntervalMax: 45,
  windfallMin: 1000,        // One-off credits above this → windfall, not income
} as const;

// ── Trajectory display cap ──
// Months-to-goal beyond this are shown as "50+ years"

export const MAX_TRAJECTORY_MONTHS = 600;
