// ── Empirical Volatility & Seasonal Decomposition ──
// Replaces hardcoded CVs in monte-carlo.ts with real variance from transactions.
// Bayesian shrinkage blends empirical estimates with identity-based priors
// so 3 months of data don't overfit while 12+ months converge to actuals.

import type { EnrichedTransaction, FinancialProfile, UserIdentity } from './types.js';
import type { VolatilityProfile } from './monte-carlo.js';
import { estimateVolatility } from './monte-carlo.js';

// ── Monthly Bucket Helpers ──

interface MonthBucket {
  income: number;
  essential: number;
  discretionary: number;
}

/**
 * Group enriched transactions into calendar-month buckets.
 * Returns a Map<'YYYY-MM', MonthBucket> sorted chronologically.
 */
function bucketByMonth(enriched: EnrichedTransaction[]): Map<string, MonthBucket> {
  const buckets = new Map<string, MonthBucket>();

  for (const tx of enriched) {
    const month = tx.date.slice(0, 7); // 'YYYY-MM'
    if (!month || month.length !== 7) continue;

    let bucket = buckets.get(month);
    if (!bucket) {
      bucket = { income: 0, essential: 0, discretionary: 0 };
      buckets.set(month, bucket);
    }

    if (tx.isIncome || tx.isTransfer || tx.isRefund || tx.isSavings) continue;

    if (tx.amount > 0) {
      // Credit that's not income/transfer/refund — skip
      continue;
    }

    const abs = Math.abs(tx.amount);
    if (tx.isEssential) {
      bucket.essential += abs;
    } else {
      bucket.discretionary += abs;
    }
  }

  // Add income separately (positive amounts flagged as income)
  for (const tx of enriched) {
    if (!tx.isIncome) continue;
    const month = tx.date.slice(0, 7);
    let bucket = buckets.get(month);
    if (!bucket) {
      bucket = { income: 0, essential: 0, discretionary: 0 };
      buckets.set(month, bucket);
    }
    bucket.income += Math.abs(tx.amount);
  }

  return new Map([...buckets.entries()].sort());
}

/**
 * Compute mean and standard deviation from an array of numbers.
 */
function meanAndStd(values: number[]): { mean: number; std: number; cv: number } {
  if (values.length === 0) return { mean: 0, std: 0, cv: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean <= 0) return { mean, std: 0, cv: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  return { mean, std, cv: std / mean };
}

// ── Empirical Volatility ──

/**
 * Estimate volatility from actual transaction data with Bayesian shrinkage.
 * Requires at least 3 months of data; returns null if insufficient.
 *
 * Blends empirical estimates with identity-based priors:
 *   σ_final = w × σ_empirical + (1-w) × σ_prior
 * where w = min(1, months / 12)
 */
export function estimateEmpiricalVolatility(
  enriched: EnrichedTransaction[],
  profile: FinancialProfile,
  identity?: UserIdentity | null,
): VolatilityProfile | null {
  const buckets = bucketByMonth(enriched);
  const months = [...buckets.values()];

  // Need at least 3 months for meaningful variance estimation
  if (months.length < 3) return null;

  // Compute empirical statistics
  const incomeStats = meanAndStd(months.map((m) => m.income));
  const essentialStats = meanAndStd(months.map((m) => m.essential));
  const discretionaryStats = meanAndStd(months.map((m) => m.discretionary));

  // Get identity-based prior (the existing heuristic)
  const prior = estimateVolatility(profile, identity);

  // Bayesian shrinkage weight: 0 at 0 months → 1.0 at 12 months
  const w = Math.min(1.0, months.length / 12);

  // Blend empirical SD with prior SD
  const incomeSD = w * incomeStats.std + (1 - w) * prior.incomeSD;
  const essentialSD = w * essentialStats.std + (1 - w) * prior.essentialSD;
  const discretionarySD = w * discretionaryStats.std + (1 - w) * prior.discretionarySD;

  return {
    incomeSD,
    essentialSD,
    discretionarySD,
    // Keep prior emergency/shock rates — these are calibrated from population data,
    // not derivable from a single user's transactions
    emergencyRate: prior.emergencyRate,
    emergencyCost: prior.emergencyCost,
    incomeShockProb: prior.incomeShockProb,
    incomeShockDuration: prior.incomeShockDuration,
  };
}

// ── Per-Category CV ──

/**
 * Compute coefficient of variation per spending category from transactions.
 * Requires 3+ months; categories with fewer months are omitted.
 */
export function computeCategoryCVs(enriched: EnrichedTransaction[]): Map<string, number> {
  // Group by category → month → total
  const categoryMonths = new Map<string, Map<string, number>>();

  for (const tx of enriched) {
    if (tx.isIncome || tx.isTransfer || tx.isRefund || tx.isSavings) continue;
    if (tx.amount >= 0) continue; // only debits

    const month = tx.date.slice(0, 7);
    if (!month || month.length !== 7) continue;

    let months = categoryMonths.get(tx.category);
    if (!months) {
      months = new Map();
      categoryMonths.set(tx.category, months);
    }
    months.set(month, (months.get(month) || 0) + Math.abs(tx.amount));
  }

  const cvMap = new Map<string, number>();
  for (const [category, months] of categoryMonths) {
    const values = [...months.values()];
    if (values.length < 3) continue;
    const { cv } = meanAndStd(values);
    cvMap.set(category, cv);
  }

  return cvMap;
}

// ── Seasonal Decomposition ──

/**
 * Compute month-of-year spending index from transaction data.
 * Requires 6+ months of data for meaningful seasonal patterns.
 * Returns a Map<monthNumber (0-11), multiplier> where 1.0 = average.
 *
 * Uses total spending (essential + discretionary) per calendar month,
 * then normalizes each month-of-year by the overall average.
 */
export function getSeasonalIndex(enriched: EnrichedTransaction[]): Map<number, number> | null {
  const buckets = bucketByMonth(enriched);
  if (buckets.size < 6) return null;

  // Aggregate spending by month-of-year
  const monthOfYearTotals = new Map<number, number[]>();

  for (const [key, bucket] of buckets) {
    const monthNum = parseInt(key.slice(5, 7), 10) - 1; // 0-indexed
    const total = bucket.essential + bucket.discretionary;
    const existing = monthOfYearTotals.get(monthNum) || [];
    existing.push(total);
    monthOfYearTotals.set(monthNum, existing);
  }

  // Overall average monthly spending
  const allMonths = [...buckets.values()];
  const overallAvg = allMonths.reduce((s, b) => s + b.essential + b.discretionary, 0) / allMonths.length;
  if (overallAvg <= 0) return null;

  // Compute index per month-of-year
  const index = new Map<number, number>();
  for (const [monthNum, values] of monthOfYearTotals) {
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    index.set(monthNum, avg / overallAvg);
  }

  return index;
}

/**
 * Get the seasonal multiplier for a specific category and month.
 * Falls back to UK ONS-derived defaults when empirical data is unavailable.
 */
export function getSeasonalMultiplier(
  seasonalIndex: Map<number, number> | null,
  targetMonth: number,
): number {
  if (seasonalIndex && seasonalIndex.has(targetMonth)) {
    return seasonalIndex.get(targetMonth)!;
  }

  // UK ONS defaults for total household spending (approximations)
  const ONS_DEFAULTS: Record<number, number> = {
    0: 0.95,  // January — post-Christmas tightening
    1: 0.92,  // February — lowest spending month
    2: 0.97,  // March — spring begins
    3: 1.00,  // April — tax year start, Easter
    4: 1.02,  // May — bank holidays
    5: 1.03,  // June — summer starts
    6: 1.05,  // July — holidays begin
    7: 1.08,  // August — peak holiday season
    8: 1.00,  // September — back to school
    9: 0.98,  // October — pre-Christmas lull
    10: 1.05, // November — Black Friday
    11: 1.25, // December — Christmas peak
  };

  return ONS_DEFAULTS[targetMonth] ?? 1.0;
}
