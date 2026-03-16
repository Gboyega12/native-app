// ── Predictive Financial Signal Engine ──
// Ensemble of 7 weak signals extracted from transaction time series.
// Jim Simons principle: no single model wins — combine multiple independent
// signals for robust prediction. Each signal maps to a specific action.
//
// Signals:
//   1. Spending Momentum   — EMA crossover (3m vs 6m) per category
//   2. Income Regime        — stable / rising / falling / volatile
//   3. Surplus Trajectory   — linear regression + months-to-zero
//   4. Seasonal Forecast    — month-of-year spending index
//   5. Subscription Drift   — silent price creeps
//   6. Category Anomaly     — z-score of current month vs history
//   7. Cash Flow Timing     — intra-month bill-vs-income risk

import type {
  EnrichedTransaction, FinancialProfile, UserIdentity, RecurringItem,
  FinancialSignal, SignalType, SignalSeverity,
} from './types.js';
import { getSeasonalIndex, getSeasonalMultiplier } from './spending-forecast.js';

// ── Helpers ──

interface MonthlySpend {
  month: string;       // 'YYYY-MM'
  income: number;
  essential: number;
  discretionary: number;
  total: number;
  byCategory: Map<string, number>;
}

function buildMonthlyBreakdown(enriched: EnrichedTransaction[]): MonthlySpend[] {
  const map = new Map<string, MonthlySpend>();

  for (const tx of enriched) {
    const month = tx.date.slice(0, 7);
    if (!month || month.length !== 7) continue;

    let entry = map.get(month);
    if (!entry) {
      entry = { month, income: 0, essential: 0, discretionary: 0, total: 0, byCategory: new Map() };
      map.set(month, entry);
    }

    if (tx.isIncome) {
      entry.income += Math.abs(tx.amount);
      continue;
    }
    if (tx.isTransfer || tx.isRefund || tx.isSavings || tx.amount >= 0) continue;

    const abs = Math.abs(tx.amount);
    entry.total += abs;
    if (tx.isEssential) entry.essential += abs;
    else entry.discretionary += abs;

    const cat = tx.category || 'Other';
    entry.byCategory.set(cat, (entry.byCategory.get(cat) || 0) + abs);
  }

  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
}

/** Exponential Moving Average */
function ema(values: number[], span: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (span + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

/** Simple linear regression: returns { slope, intercept, r2 } */
function linearRegression(values: number[]): { slope: number; intercept: number; residualStd: number } {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0, residualStd: 0 };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, residualStd: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // Residual standard deviation
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
  }
  const residualStd = Math.sqrt(ssRes / Math.max(1, n - 2));

  return { slope, intercept, residualStd };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Signal 1: Spending Momentum ──

function detectSpendingMomentum(months: MonthlySpend[]): FinancialSignal[] {
  if (months.length < 3) return [];
  const signals: FinancialSignal[] = [];

  // Aggregate all categories seen across months
  const categories = new Set<string>();
  for (const m of months) {
    for (const cat of m.byCategory.keys()) categories.add(cat);
  }

  for (const cat of categories) {
    const values = months.map((m) => m.byCategory.get(cat) || 0);
    // Need at least some spending to detect momentum
    const avgSpend = mean(values);
    if (avgSpend < 20) continue; // Ignore tiny categories

    const ema3 = ema(values, 3);
    const ema6 = ema(values, Math.min(6, values.length));
    if (ema6 <= 0) continue;

    const momentum = (ema3 - ema6) / ema6;
    if (Math.abs(momentum) < 0.10) continue; // Below 10% threshold

    const isAccelerating = momentum > 0;
    const pctChange = Math.round(Math.abs(momentum) * 100);
    const monthlyDelta = Math.round(Math.abs(ema3 - ema6));

    const severity: SignalSeverity = Math.abs(momentum) > 0.25 ? 'alert'
      : Math.abs(momentum) > 0.15 ? 'watch' : 'info';

    signals.push({
      id: `spending_momentum_${cat.toLowerCase().replace(/[^a-z]/g, '_')}`,
      type: 'momentum',
      severity,
      title: isAccelerating ? `${cat} spending rising` : `${cat} spending falling`,
      detail: isAccelerating
        ? `${cat} has accelerated ${pctChange}% — trending £${monthlyDelta} more per month`
        : `${cat} has decelerated ${pctChange}% — £${monthlyDelta}/month less than trend`,
      impact: isAccelerating ? -monthlyDelta : monthlyDelta,
      category: cat,
      confidence: Math.min(1, months.length / 6),
      relatedMoveCategory: 'spending',
    });
  }

  return signals;
}

// ── Signal 2: Income Regime Detection ──

function detectIncomeRegime(months: MonthlySpend[]): FinancialSignal | null {
  if (months.length < 3) return null;

  const incomes = months.map((m) => m.income);
  const avgIncome = mean(incomes);
  if (avgIncome <= 0) return null;

  const cv = std(incomes) / avgIncome;
  const recent = incomes.slice(-3);
  const trailing = months.length >= 6 ? mean(incomes.slice(0, -3)) : avgIncome;

  // Classify regime
  let regime: 'stable' | 'rising' | 'falling' | 'volatile';
  if (cv > 0.25) {
    regime = 'volatile';
  } else if (recent.length >= 2 && recent.every((r) => r < trailing * 0.90)) {
    regime = 'falling';
  } else if (recent.length >= 2 && recent.every((r) => r > trailing * 1.10)) {
    regime = 'rising';
  } else {
    regime = 'stable';
  }

  // Only signal non-stable regimes
  if (regime === 'stable') return null;

  const lastIncome = incomes[incomes.length - 1];
  const delta = Math.round(Math.abs(lastIncome - trailing));

  const severityMap: Record<string, SignalSeverity> = {
    falling: 'alert',
    volatile: 'watch',
    rising: 'info',
  };

  const titleMap: Record<string, string> = {
    falling: 'Income declining',
    volatile: 'Income is volatile',
    rising: 'Income growing',
  };

  const detailMap: Record<string, string> = {
    falling: `Income has dropped £${delta}/month below your trailing average — consider tightening discretionary`,
    volatile: `Income varies ${Math.round(cv * 100)}% month-to-month — budget against your floor (£${Math.round(avgIncome * (1 - cv))})`,
    rising: `Income is up £${delta}/month above trend — opportunity to accelerate savings`,
  };

  return {
    id: `income_regime_${regime}`,
    type: 'regime',
    severity: severityMap[regime],
    title: titleMap[regime],
    detail: detailMap[regime],
    impact: regime === 'falling' ? -delta : regime === 'rising' ? delta : undefined,
    confidence: Math.min(1, months.length / 8),
    relatedMoveCategory: regime === 'falling' ? 'buffer' : regime === 'rising' ? 'savings' : undefined,
  };
}

// ── Signal 3: Surplus Trajectory ──

function detectSurplusTrajectory(months: MonthlySpend[]): FinancialSignal | null {
  if (months.length < 3) return null;

  const surpluses = months.map((m) => m.income - m.total);
  const currentSurplus = surpluses[surpluses.length - 1];
  const { slope, residualStd } = linearRegression(surpluses);

  // Only signal meaningful trends (>£20/month change per month)
  if (Math.abs(slope) < 20) return null;

  const isDecreasing = slope < 0;
  const monthlyChange = Math.round(Math.abs(slope));

  // Months to zero if decreasing
  let monthsToZero: number | null = null;
  if (isDecreasing && currentSurplus > 0) {
    monthsToZero = Math.ceil(currentSurplus / Math.abs(slope));
  }

  const severity: SignalSeverity = monthsToZero !== null && monthsToZero <= 3 ? 'alert'
    : monthsToZero !== null && monthsToZero <= 6 ? 'watch'
    : isDecreasing ? 'watch' : 'info';

  const detail = isDecreasing
    ? monthsToZero !== null
      ? `Surplus shrinking £${monthlyChange}/month — hits zero in ~${monthsToZero} months at this rate`
      : `Surplus shrinking £${monthlyChange}/month — deficit is deepening`
    : `Surplus growing £${monthlyChange}/month — building momentum`;

  return {
    id: isDecreasing ? 'surplus_trajectory_falling' : 'surplus_trajectory_growing',
    type: 'trajectory',
    severity,
    title: isDecreasing ? 'Surplus trending down' : 'Surplus growing',
    detail,
    impact: isDecreasing ? -monthlyChange : monthlyChange,
    confidence: Math.min(1, months.length / 6) * Math.max(0.3, 1 - residualStd / (Math.abs(mean(surpluses)) + 1)),
    relatedMoveCategory: isDecreasing ? 'break_even' : 'savings',
  };
}

// ── Signal 4: Seasonal Spending Forecast ──

function detectSeasonalForecast(
  enriched: EnrichedTransaction[],
  months: MonthlySpend[],
  profile: FinancialProfile,
): FinancialSignal | null {
  const seasonalIndex = getSeasonalIndex(enriched);
  if (!seasonalIndex) return null; // Need 6+ months

  // Predict next month's spending
  const lastMonth = months[months.length - 1];
  if (!lastMonth) return null;

  const lastMonthNum = parseInt(lastMonth.month.slice(5, 7), 10) - 1;
  const nextMonthNum = (lastMonthNum + 1) % 12;
  const nextMultiplier = getSeasonalMultiplier(seasonalIndex, nextMonthNum);
  const avgSpend = mean(months.map((m) => m.total));

  // Only signal if next month deviates meaningfully from average (>10%)
  if (Math.abs(nextMultiplier - 1.0) < 0.10) return null;

  const predictedSpend = Math.round(avgSpend * nextMultiplier);
  const delta = Math.round(predictedSpend - avgSpend);
  const isHigher = nextMultiplier > 1.0;
  const pctDiff = Math.round(Math.abs(nextMultiplier - 1.0) * 100);

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = monthNames[nextMonthNum];

  return {
    id: `seasonal_forecast_${nextMonthNum}`,
    type: 'seasonal',
    severity: isHigher && pctDiff >= 20 ? 'watch' : 'info',
    title: isHigher ? `${monthName} spending typically higher` : `${monthName} is a lighter month`,
    detail: isHigher
      ? `${monthName} is historically ${pctDiff}% above average — budget for ~£${Math.abs(delta)} extra`
      : `${monthName} is typically ${pctDiff}% below average — opportunity to save ~£${Math.abs(delta)} extra`,
    impact: isHigher ? -Math.abs(delta) : Math.abs(delta),
    confidence: Math.min(1, months.length / 12),
    relatedMoveCategory: isHigher ? 'buffer' : 'savings',
  };
}

// ── Signal 5: Subscription Drift ──

function detectSubscriptionDrift(
  enriched: EnrichedTransaction[],
  subscriptions: RecurringItem[],
): FinancialSignal | null {
  if (!subscriptions || subscriptions.length === 0) return null;

  // Group subscription transactions by merchant
  const subMerchants = new Set(subscriptions.map((s) => s.merchant.toLowerCase()));
  const merchantPayments = new Map<string, number[]>();

  for (const tx of enriched) {
    if (tx.amount >= 0 || !tx.isSubscription) continue;
    const key = tx.merchant.toLowerCase();
    if (!subMerchants.has(key)) continue;

    const payments = merchantPayments.get(key) || [];
    payments.push(Math.abs(tx.amount));
    merchantPayments.set(key, payments);
  }

  // Detect price increases: last payment > first payment
  let totalDrift = 0;
  let driftCount = 0;

  for (const [, payments] of merchantPayments) {
    if (payments.length < 2) continue;
    const first = payments[0];
    const last = payments[payments.length - 1];
    if (last > first && first > 0) {
      const increase = last - first;
      // Only count meaningful increases (>50p, not floating-point noise)
      if (increase >= 0.50) {
        totalDrift += increase;
        driftCount++;
      }
    }
  }

  if (driftCount === 0 || totalDrift < 1) return null;

  return {
    id: 'subscription_drift',
    type: 'drift',
    severity: totalDrift >= 10 ? 'watch' : 'info',
    title: `${driftCount} subscription${driftCount > 1 ? 's' : ''} increased`,
    detail: `${driftCount} subscription${driftCount > 1 ? 's' : ''} increased in price — £${totalDrift.toFixed(2)}/month of silent drift`,
    impact: -Math.round(totalDrift),
    confidence: 0.85,
    relatedMoveCategory: 'spending',
  };
}

// ── Signal 6: Category Anomaly ──

function detectCategoryAnomalies(months: MonthlySpend[]): FinancialSignal[] {
  if (months.length < 2) return [];
  const signals: FinancialSignal[] = [];

  // Get the latest month
  const latest = months[months.length - 1];
  const history = months.slice(0, -1);
  if (history.length < 2) return [];

  // Check each category in the latest month
  for (const [cat, currentAmount] of latest.byCategory) {
    const historicalAmounts = history.map((m) => m.byCategory.get(cat) || 0);
    const avg = mean(historicalAmounts);
    if (avg < 10) continue; // Skip tiny categories

    const s = std(historicalAmounts);
    // Floor std to 10% of mean to avoid false positives on stable categories
    const effectiveStd = Math.max(s, avg * 0.1);

    const zScore = (currentAmount - avg) / effectiveStd;
    if (Math.abs(zScore) < 1.5) continue;

    const isAbove = zScore > 0;
    const delta = Math.round(Math.abs(currentAmount - avg));

    signals.push({
      id: `anomaly_${cat.toLowerCase().replace(/[^a-z]/g, '_')}`,
      type: 'anomaly',
      severity: Math.abs(zScore) >= 2.5 ? 'alert' : Math.abs(zScore) >= 2.0 ? 'watch' : 'info',
      title: isAbove ? `${cat} unusually high` : `${cat} unusually low`,
      detail: isAbove
        ? `${cat} is ${zScore.toFixed(1)}σ above average this month — £${delta} above normal`
        : `${cat} is ${Math.abs(zScore).toFixed(1)}σ below average — £${delta} below normal`,
      impact: isAbove ? -delta : delta,
      category: cat,
      confidence: Math.min(1, history.length / 4),
      relatedMoveCategory: 'spending',
    });
  }

  return signals;
}

// ── Signal 7: Cash Flow Timing Risk ──

function detectTimingRisk(
  enriched: EnrichedTransaction[],
  profile: FinancialProfile,
): FinancialSignal | null {
  // Analyse the most recent month only
  const txs = [...enriched].sort((a, b) => a.date.localeCompare(b.date));
  if (txs.length === 0) return null;

  const latestMonth = txs[txs.length - 1].date.slice(0, 7);
  const monthTxs = txs.filter((t) => t.date.slice(0, 7) === latestMonth);

  // Track daily cumulative cash flow within the month
  const dailyFlow = new Map<number, number>();
  for (const tx of monthTxs) {
    const day = parseInt(tx.date.slice(8, 10), 10);
    dailyFlow.set(day, (dailyFlow.get(day) || 0) + tx.amount);
  }

  // Compute intra-month running balance (relative to month start)
  const days = [...dailyFlow.entries()].sort((a, b) => a[0] - b[0]);
  let cumulative = 0;
  let maxNegative = 0;
  let worstDay = 0;

  for (const [day, flow] of days) {
    cumulative += flow;
    if (cumulative < maxNegative) {
      maxNegative = cumulative;
      worstDay = day;
    }
  }

  const monthlyIncome = profile.monthly.income;
  if (monthlyIncome <= 0) return null;

  const timingRisk = Math.abs(maxNegative) / monthlyIncome;
  if (timingRisk < 0.15) return null; // Below 15% of income — not risky

  // Detect if large bills hit before income
  const incomeDay = days.find(([, flow]) => flow > monthlyIncome * 0.3)?.[0] || 0;
  const largeBillDay = worstDay;

  return {
    id: 'cashflow_timing_risk',
    type: 'timing',
    severity: timingRisk >= 0.4 ? 'alert' : timingRisk >= 0.25 ? 'watch' : 'info',
    title: 'Cash flow timing gap',
    detail: largeBillDay < incomeDay
      ? `Large outflows on day ${largeBillDay} before income arrives on day ${incomeDay} — £${Math.round(Math.abs(maxNegative))} gap`
      : `Intra-month cash flow dips £${Math.round(Math.abs(maxNegative))} below breakeven around day ${worstDay}`,
    impact: -Math.round(Math.abs(maxNegative) * 0.02), // Small ongoing cost (overdraft interest/missed payments)
    confidence: 0.7,
    relatedMoveCategory: 'buffer',
  };
}

// ── Main Export: Extract All Signals ──

const SEVERITY_WEIGHT: Record<SignalSeverity, number> = {
  alert: 3.0,
  watch: 2.0,
  info: 1.0,
};

/**
 * Extract predictive financial signals from enriched transaction data.
 * Returns signals sorted by severity × confidence × |impact|.
 *
 * Cold start behavior:
 *   <2 months: anomaly + timing only
 *   2-3 months: + momentum + drift
 *   3-6 months: + regime + trajectory
 *   6+ months: + seasonal forecast
 */
export function extractSignals(
  enriched: EnrichedTransaction[],
  profile: FinancialProfile,
  identity?: UserIdentity | null,
  subscriptions?: RecurringItem[],
): FinancialSignal[] {
  const months = buildMonthlyBreakdown(enriched);
  const signals: FinancialSignal[] = [];

  // Always available (single-month signals)
  signals.push(...detectCategoryAnomalies(months));
  const timing = detectTimingRisk(enriched, profile);
  if (timing) signals.push(timing);

  // 2+ months
  if (months.length >= 2) {
    signals.push(...detectSpendingMomentum(months));
    const drift = detectSubscriptionDrift(enriched, subscriptions || profile.subscriptions || []);
    if (drift) signals.push(drift);
  }

  // 3+ months
  if (months.length >= 3) {
    const regime = detectIncomeRegime(months);
    if (regime) signals.push(regime);
    const trajectory = detectSurplusTrajectory(months);
    if (trajectory) signals.push(trajectory);
  }

  // 6+ months
  if (months.length >= 6) {
    const seasonal = detectSeasonalForecast(enriched, months, profile);
    if (seasonal) signals.push(seasonal);
  }

  // Sort by severity × confidence × |impact|
  signals.sort((a, b) => {
    const scoreA = SEVERITY_WEIGHT[a.severity] * a.confidence * Math.abs(a.impact || 0);
    const scoreB = SEVERITY_WEIGHT[b.severity] * b.confidence * Math.abs(b.impact || 0);
    return scoreB - scoreA;
  });

  return signals;
}
