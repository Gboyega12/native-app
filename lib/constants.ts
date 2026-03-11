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
  debtSnowballSavePct: 0.15,
  singleDebtOverpayPct: 0.1,
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
