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
} as const;

// ── Analysis window ──
// Number of months of recent data used for income & spending calculations.
// Full 12-month data is still fetched for pattern detection (recurring subs etc).
export const ANALYSIS_MONTHS = 4;

// ── Income detection thresholds ──

export const INCOME_THRESHOLDS = {
  minRegularAmount: 100,
  largeCreditMin: 500,
  largeCreditMinCount: 2,
  largeCreditIntervalMin: 20,
  largeCreditIntervalMax: 45,
} as const;

// ── Trajectory display cap ──
// Months-to-goal beyond this are shown as "50+ years"

export const MAX_TRAJECTORY_MONTHS = 600;
