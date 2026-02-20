// ── Monte Carlo Simulation Engine ──
// Probabilistic financial projections using variance from real transaction data.
// Replaces deterministic "X months to goal" with confidence bands.
//
// Runs client-side: 1,000 sims × 60 months = 60k ops, <50ms on low-end phone.

import type { FinancialProfile, Move, UserIdentity } from './types';

// ── Simulation parameters ──

const NUM_SIMS = 1_000;
const MAX_MONTHS = 120; // 10-year horizon

/** Seeded PRNG — fast, deterministic for reproducibility (xoshiro128**) */
function createRng(seed: number) {
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 2654435761) >>> 0 || 1;
  let s2 = (seed * 2246822519) >>> 0 || 1;
  let s3 = (seed * 3266489917) >>> 0 || 1;
  return () => {
    const t = s1 << 9;
    let r = s0 * 5; r = ((r << 7) | (r >>> 25)) * 9;
    const u = s1 << 17; // eslint-disable-line @typescript-eslint/no-unused-vars
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = (s3 << 11) | (s3 >>> 21);
    return (r >>> 0) / 4294967296;
  };
}

/** Box-Muller: uniform [0,1) → standard normal */
function normalSample(rng: () => number): number {
  let u1 = rng();
  let u2 = rng();
  while (u1 === 0) u1 = rng(); // avoid log(0)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Sample from normal distribution with given mean and stddev */
function sampleNormal(rng: () => number, mean: number, sd: number): number {
  return mean + normalSample(rng) * sd;
}

/** Poisson sample via inverse CDF */
function samplePoisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

// ── Variance Estimation ──
// Derive spending/income volatility from the user's actual financial profile.

export interface VolatilityProfile {
  incomeSD: number;        // Monthly income standard deviation
  essentialSD: number;     // Essential spending SD
  discretionarySD: number; // Discretionary spending SD
  emergencyRate: number;   // Expected emergencies per month (Poisson lambda)
  emergencyCost: number;   // Average emergency cost
  incomeShockProb: number; // Monthly probability of losing income
  incomeShockDuration: number; // Average months of income loss
}

/**
 * Estimate volatility from the user's profile and identity.
 * Uses heuristics based on work setup, income pattern, and spending mix.
 */
export function estimateVolatility(
  profile: FinancialProfile,
  identity?: UserIdentity | null,
): VolatilityProfile {
  const income = profile.monthly.income;
  const essential = profile.budgetReality.nonDiscretionary.total;
  const discretionary = profile.budgetReality.discretionary.total;

  // Income volatility depends on work setup
  const work = identity?.work_setup || 'office';
  let incomeCV = 0.05; // coefficient of variation (default: salaried ≈ 5%)
  if (work === 'self_employed') incomeCV = 0.25;
  else if (work === 'multiple_jobs') incomeCV = 0.18;
  else if (work === 'student') incomeCV = 0.20;

  // Detect irregular income from source frequency
  const hasIrregular = profile.incomeSources.some(
    (s) => s.frequency === 'irregular' || s.frequency === 'weekly',
  );
  if (hasIrregular) incomeCV = Math.max(incomeCV, 0.15);

  // Essential spending: low variance (rent/mortgage are fixed, utilities predictable)
  const essentialCV = 0.08;

  // Discretionary spending: higher variance (varies by month, mood, events)
  const discretionaryCV = 0.22;

  // Emergency events: ~1 per year (car repair, appliance, medical)
  let emergencyRate = 0.083; // 1/12
  let emergencyCost = Math.max(300, essential * 0.6);

  // Households with dependents/elderly parents have higher emergency frequency
  const deps = identity?.dependents || [];
  if (deps.includes('young_children') || deps.includes('elderly_parents')) {
    emergencyRate = 0.12; // ~1.4/year
    emergencyCost *= 1.3;
  }

  // Upcoming events increase emergency probability
  const events = identity?.upcoming_events || [];
  if (events.some((e) => e === 'moving' || e === 'baby' || e === 'wedding')) {
    emergencyRate += 0.04;
  }

  // Income shock (job loss) probability
  let incomeShockProb = 0.005; // ~6% annual probability
  let incomeShockDuration = 3;  // average 3 months to recover
  if (work === 'self_employed') {
    incomeShockProb = 0.015; // freelancers face more frequent dry spells
    incomeShockDuration = 2;
  }

  return {
    incomeSD: income * incomeCV,
    essentialSD: essential * essentialCV,
    discretionarySD: discretionary * discretionaryCV,
    emergencyRate,
    emergencyCost,
    incomeShockProb,
    incomeShockDuration,
  };
}

// ── Simulation Results ──

export interface GoalConfidence {
  p10: number;       // Optimistic — 10th percentile months
  p50: number;       // Median — most likely months
  p90: number;       // Conservative — 90th percentile months
  hitRate12m: number; // % of simulations reaching goal within 12 months
  hitRate24m: number; // % reaching within 24 months
}

export interface BufferRecommendation {
  months: number;       // Recommended buffer in months of expenses
  amount: number;       // £ amount
  coverageRate: number; // % of scenarios this buffer covers
}

export interface MoveConsistency {
  expectedMonthly: number;    // Risk-adjusted monthly impact
  consistencyScore: number;   // 0-1 (1 = perfectly consistent)
  followThroughRate: number;  // Estimated % of months user actually saves
}

// ── Core Simulation: Goal Timeline ──

/**
 * Simulate goal achievement timeline with Monte Carlo.
 * Returns confidence bands (P10, P50, P90) and hit rates.
 */
export function simulateGoalTimeline(
  profile: FinancialProfile,
  targetAmount: number,
  moveImpact: number,
  volatility: VolatilityProfile,
  seed: number = 42,
): GoalConfidence {
  if (targetAmount <= 0) return { p10: 0, p50: 0, p90: 0, hitRate12m: 1, hitRate24m: 1 };

  const income = profile.monthly.income;
  const essential = profile.budgetReality.nonDiscretionary.total;
  const discretionary = profile.budgetReality.discretionary.total;
  const rng = createRng(seed);
  const results: number[] = [];

  for (let sim = 0; sim < NUM_SIMS; sim++) {
    let saved = 0;
    let inShock = 0; // months remaining in income shock
    let reachedAt = MAX_MONTHS;

    for (let m = 1; m <= MAX_MONTHS; m++) {
      // Income: normal distribution, floored at 0
      let monthIncome: number;
      if (inShock > 0) {
        monthIncome = 0; // no income during shock
        inShock--;
      } else {
        monthIncome = Math.max(0, sampleNormal(rng, income, volatility.incomeSD));
        // Check for new income shock
        if (rng() < volatility.incomeShockProb) {
          inShock = Math.max(1, Math.round(sampleNormal(rng, volatility.incomeShockDuration, 1)));
        }
      }

      // Spending: essential (low variance) + discretionary (high variance)
      const monthEssential = Math.max(0, sampleNormal(rng, essential, volatility.essentialSD));
      const monthDiscretionary = Math.max(0, sampleNormal(rng, discretionary, volatility.discretionarySD));
      const monthSpending = monthEssential + monthDiscretionary;

      // Emergency events (Poisson process)
      const emergencies = samplePoisson(rng, volatility.emergencyRate);
      const emergencyCost = emergencies * volatility.emergencyCost;

      // Net monthly contribution (move impact is additive if positive)
      const net = monthIncome - monthSpending - emergencyCost + moveImpact;
      saved += net;
      // Can't go below zero savings (no debt in this model)
      if (saved < 0) saved = 0;

      if (saved >= targetAmount) {
        reachedAt = m;
        break;
      }
    }

    results.push(reachedAt);
  }

  // Sort and extract percentiles
  results.sort((a, b) => a - b);
  const percentile = (p: number) => results[Math.floor(p * NUM_SIMS)] || MAX_MONTHS;

  const hitRate12m = results.filter((m) => m <= 12).length / NUM_SIMS;
  const hitRate24m = results.filter((m) => m <= 24).length / NUM_SIMS;

  return {
    p10: percentile(0.10),
    p50: percentile(0.50),
    p90: percentile(0.90),
    hitRate12m: Math.round(hitRate12m * 100),
    hitRate24m: Math.round(hitRate24m * 100),
  };
}

// ── Emergency Buffer Sizing ──

/**
 * Simulate income shocks and spending spikes to determine
 * the ideal emergency buffer for THIS specific user.
 */
export function simulateBufferNeed(
  profile: FinancialProfile,
  volatility: VolatilityProfile,
  seed: number = 123,
): BufferRecommendation {
  const monthlyExpenses = profile.monthly.spending;
  const rng = createRng(seed);
  const maxDrawdowns: number[] = [];

  for (let sim = 0; sim < NUM_SIMS; sim++) {
    let buffer = 0;
    let maxDraw = 0;
    let inShock = 0;

    // Simulate 24 months to capture tail risk
    for (let m = 0; m < 24; m++) {
      let income: number;
      if (inShock > 0) {
        income = 0;
        inShock--;
      } else {
        income = Math.max(0, sampleNormal(rng, profile.monthly.income, volatility.incomeSD));
        if (rng() < volatility.incomeShockProb) {
          inShock = Math.max(1, Math.round(sampleNormal(rng, volatility.incomeShockDuration, 1)));
        }
      }

      const spending = Math.max(0, sampleNormal(rng, monthlyExpenses, monthlyExpenses * 0.15));
      const emergencies = samplePoisson(rng, volatility.emergencyRate) * volatility.emergencyCost;

      const net = income - spending - emergencies;
      buffer += net;

      // Track how far into the negative we go (= how much buffer was needed)
      if (buffer < 0) {
        maxDraw = Math.max(maxDraw, Math.abs(buffer));
      }
    }

    maxDrawdowns.push(maxDraw);
  }

  // Sort and find the 90th percentile drawdown
  maxDrawdowns.sort((a, b) => a - b);
  const p90Draw = maxDrawdowns[Math.floor(0.90 * NUM_SIMS)] || 0;

  const bufferMonths = monthlyExpenses > 0 ? Math.ceil(p90Draw / monthlyExpenses) : 3;
  const clampedMonths = Math.max(1, Math.min(bufferMonths, 12)); // 1-12 month range

  return {
    months: clampedMonths,
    amount: Math.round(clampedMonths * monthlyExpenses),
    coverageRate: 90,
  };
}

// ── Move Consistency Scoring ──

/**
 * Estimate how consistently a user will follow through on a move.
 * Low-effort moves have higher follow-through; high-effort moves drop off.
 * Returns a risk-adjusted monthly impact.
 */
export function calcMoveConsistency(
  move: Move,
  volatility: VolatilityProfile,
  seed: number = 456,
): MoveConsistency {
  const rng = createRng(seed);

  // Base follow-through rate by effort level
  const baseRate: Record<string, number> = {
    low: 0.88,    // Cancel a subscription — almost certain
    medium: 0.65, // Reduce grocery spend — some months you slip
    high: 0.42,   // Major lifestyle change — hard to sustain
  };
  const rate = baseRate[move.effort] || 0.65;

  // Simulate 12 months of follow-through
  const monthlySavings: number[] = [];
  for (let sim = 0; sim < NUM_SIMS; sim++) {
    let total = 0;
    for (let m = 0; m < 12; m++) {
      // Does the user follow through this month?
      const follows = rng() < rate;
      if (follows) {
        // Actual savings vary around the stated impact
        const actual = Math.max(0, sampleNormal(rng, move.monthlyImpact, move.monthlyImpact * 0.15));
        total += actual;
      }
    }
    monthlySavings.push(total / 12); // Average monthly across the year
  }

  const mean = monthlySavings.reduce((s, v) => s + v, 0) / NUM_SIMS;
  const variance = monthlySavings.reduce((s, v) => s + (v - mean) ** 2, 0) / NUM_SIMS;
  const sd = Math.sqrt(variance);
  const consistency = mean > 0 ? Math.max(0, Math.min(1, 1 - sd / mean)) : 0;

  return {
    expectedMonthly: Math.round(mean * 100) / 100,
    consistencyScore: Math.round(consistency * 100) / 100,
    followThroughRate: Math.round(rate * 100),
  };
}
