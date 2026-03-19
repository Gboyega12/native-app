// ── Monte Carlo Simulation Engine ──
// Probabilistic financial projections using variance from real transaction data.
// Replaces deterministic "X months to goal" with confidence bands.
//
// Runs client-side: 1,000 sims × 60 months = 60k ops, <50ms on low-end phone.

import type { FinancialProfile, Move, UserIdentity, UpcomingEvent, EnrichedTransaction } from './types.js';

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

  // Income volatility: prefer the real CV computed from transaction data,
  // fall back to heuristic estimates from work setup / frequency detection.
  const work = identity?.work_setup || 'office';
  let incomeCV = profile.monthly.incomeCV ?? 0;
  if (incomeCV <= 0) {
    // Heuristic fallback when transaction data is insufficient
    incomeCV = 0.05; // default: salaried ≈ 5%
    if (work === 'self_employed') incomeCV = 0.25;
    else if (work === 'multiple_jobs') incomeCV = 0.18;
    else if (work === 'student') incomeCV = 0.20;

    // Detect irregular income from source frequency
    const hasIrregular = profile.incomeSources.some(
      (s) => s.frequency === 'irregular' || s.frequency === 'weekly',
    );
    if (hasIrregular) incomeCV = Math.max(incomeCV, 0.15);
  }

  // Spending CVs: heuristic estimates by category type.
  // Note: budget reality items are per-category averages, not month-to-month data,
  // so computing temporal variance from them would be meaningless (cross-category ≠ temporal).
  // Real month-to-month CV requires transaction-level grouping which happens in the
  // enrichment engine's _dataDrivenCutPct() instead.
  const essentialCV = 0.08; // low variance (rent/mortgage are fixed, utilities predictable)
  const discretionaryCV = 0.22; // higher variance (varies by month, mood, events)

  // Emergency events: ~1 per year (car repair, appliance, medical)
  let emergencyRate = 0.083; // 1/12
  let emergencyCost = Math.max(300, essential * 0.6);

  // Households with dependents/elderly parents have higher emergency frequency
  const deps = identity?.dependents || [];
  if (deps.includes('young_children') || deps.includes('elderly_parents')) {
    emergencyRate = 0.12; // ~1.4/year
    emergencyCost *= 1.3;
  }

  // Note: Baby, moving, wedding are deterministic planned events — NOT stochastic emergencies.
  // They are modelled as CashflowScenario objects in buildScenarios() and flow into
  // buffer recommendations via the enrichment engine's timeline-scaled move generation.
  // Do NOT bump emergencyRate here — that conflates planned spending with random shocks.

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

/**
 * Enhanced volatility estimation: tries empirical data first, falls back to heuristic.
 * Import is dynamic to avoid circular dependency.
 */
export function estimateVolatilityEnhanced(
  profile: FinancialProfile,
  identity?: UserIdentity | null,
  enriched?: EnrichedTransaction[] | null,
): VolatilityProfile {
  if (enriched && enriched.length > 0) {
    // Dynamic import workaround: inline the empirical estimation
    // to avoid circular dependency with spending-forecast.ts
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { estimateEmpiricalVolatility } = require('./spending-forecast.js');
      const empirical = estimateEmpiricalVolatility(enriched, profile, identity);
      if (empirical) return empirical;
    } catch {
      // Fall through to heuristic
    }
  }
  return estimateVolatility(profile, identity);
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
  categoryCV?: number,
): MoveConsistency {
  const rng = createRng(seed);

  // Follow-through rate: prefer data-derived from category spending variance.
  // High CV = spending already fluctuates = easier to change = higher follow-through.
  // Low CV = steady spend = harder to change = lower follow-through.
  let rate: number;
  if (categoryCV != null && categoryCV > 0 && move.category === 'spending') {
    // Formula: 0.5 base + 0.4 scaled by CV (capped at CV=1.0)
    rate = Math.min(0.9, 0.5 + 0.4 * Math.min(1.0, categoryCV));
  } else {
    // Fallback: effort-based base rates
    const baseRate: Record<string, number> = {
      low: 0.88,    // Cancel a subscription — almost certain
      medium: 0.65, // Reduce grocery spend — some months you slip
      high: 0.42,   // Major lifestyle change — hard to sustain
    };
    rate = baseRate[move.effort] || 0.65;
  }

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

// ── Household Cash Flow Simulation ──
// Extends the individual Monte Carlo model to household-level analysis.
// Accounts for joint incomes, shared expenses, partner income shocks,
// and life-event cost scenarios specific to the household type.

export interface CashflowScenario {
  label: string;
  probability: number;       // annual probability (0-100)
  monthlyImpact: number;     // £/month impact (negative = cost)
  description: string;
}

export interface HouseholdCashflowResult {
  jointSurplus: number;
  sharedExpenseRatio: number; // 0-100
  bufferAdequacy: number;     // 0-100 (how well current buffer covers simulated shocks)
  scenarios: CashflowScenario[];
}

/**
 * Simulate household-level cash flow with Monte Carlo.
 * For couples: models both incomes + correlated spending shocks.
 * For families: adds dependent-related cost scenarios.
 * For singles: wraps the individual model with scenario analysis.
 */
export function simulateHouseholdCashflow(
  profile: FinancialProfile,
  identity: UserIdentity | null,
  volatility: VolatilityProfile,
  seed: number = 789,
): HouseholdCashflowResult {
  const household = identity?.household || 'single';
  const rng = createRng(seed);

  // ── Shared expense ratio by household type ──
  let sharedRatio = 0;
  let partnerIncomeFactor = 0; // multiplier of user income for partner
  switch (household) {
    case 'couple_shared':
      sharedRatio = 0.65;
      partnerIncomeFactor = 0.85;
      break;
    case 'couple_separate':
      sharedRatio = 0.35;
      partnerIncomeFactor = 0.85;
      break;
    case 'family':
      sharedRatio = 0.70;
      partnerIncomeFactor = 0.75;
      break;
    case 'single_parent':
      sharedRatio = 0.80; // most expenses are shared with dependents
      partnerIncomeFactor = 0;
      break;
    case 'shared_house':
      sharedRatio = 0.40;
      partnerIncomeFactor = 0;
      break;
    default: // single
      sharedRatio = 0;
      partnerIncomeFactor = 0;
  }

  const partnerIncome = profile.monthly.income * partnerIncomeFactor;
  const jointIncome = profile.monthly.income + partnerIncome;
  const sharedExpenses = profile.monthly.spending * sharedRatio;
  const personalExpenses = profile.monthly.spending * (1 - sharedRatio);
  const jointSurplus = jointIncome - sharedExpenses - personalExpenses;

  // ── Buffer adequacy via simulation ──
  // Run 1,000 sims of 24-month household cash flow to find how often
  // current estimated buffer covers all shocks.
  const estimatedBuffer = Math.max(0, profile.monthly.surplus * 3);
  let covered = 0;

  for (let sim = 0; sim < NUM_SIMS; sim++) {
    let balance = estimatedBuffer;
    let inShock = 0;
    let partnerInShock = 0;

    for (let m = 0; m < 24; m++) {
      // User income
      let mIncome: number;
      if (inShock > 0) {
        mIncome = 0;
        inShock--;
      } else {
        mIncome = Math.max(0, sampleNormal(rng, profile.monthly.income, volatility.incomeSD));
        if (rng() < volatility.incomeShockProb) {
          inShock = Math.max(1, Math.round(sampleNormal(rng, volatility.incomeShockDuration, 1)));
        }
      }

      // Partner income (if applicable)
      let mPartner = 0;
      if (partnerIncome > 0) {
        if (partnerInShock > 0) {
          mPartner = 0;
          partnerInShock--;
        } else {
          mPartner = Math.max(0, sampleNormal(rng, partnerIncome, partnerIncome * 0.08));
          // Partner has their own shock risk (slightly lower — uncorrelated)
          if (rng() < volatility.incomeShockProb * 0.7) {
            partnerInShock = Math.max(1, Math.round(sampleNormal(rng, volatility.incomeShockDuration, 1)));
          }
        }
      }

      // Spending
      const mEssential = Math.max(0, sampleNormal(rng, profile.budgetReality.nonDiscretionary.total, volatility.essentialSD));
      const mDisc = Math.max(0, sampleNormal(rng, profile.budgetReality.discretionary.total, volatility.discretionarySD));
      const emergencies = samplePoisson(rng, volatility.emergencyRate) * volatility.emergencyCost;

      balance += (mIncome + mPartner) - mEssential - mDisc - emergencies;
    }

    if (balance >= 0) covered++;
  }

  const bufferAdequacy = Math.round((covered / NUM_SIMS) * 100);

  // ── Scenario analysis ──
  const scenarios = buildScenarios(profile, identity, volatility);

  return {
    jointSurplus: Math.round(jointSurplus),
    sharedExpenseRatio: Math.round(sharedRatio * 100),
    bufferAdequacy,
    scenarios,
  };
}

function buildScenarios(
  profile: FinancialProfile,
  identity: UserIdentity | null,
  vol: VolatilityProfile,
): CashflowScenario[] {
  const scenarios: CashflowScenario[] = [];
  const events = identity?.upcoming_events || [];
  const deps = identity?.dependents || [];
  const household = identity?.household || 'single';

  // Income disruption — universal
  scenarios.push({
    label: 'Income disruption',
    probability: Math.round(vol.incomeShockProb * 12 * 100),
    monthlyImpact: -Math.round(profile.monthly.income),
    description: `${Math.round(vol.incomeShockProb * 12 * 100)}% annual chance of ${vol.incomeShockDuration}-month income gap`,
  });

  // Emergency expense — universal
  scenarios.push({
    label: 'Emergency expense',
    probability: Math.round(Math.min(100, vol.emergencyRate * 12 * 100)),
    monthlyImpact: -Math.round(vol.emergencyCost),
    description: `~${Math.max(1, Math.round(vol.emergencyRate * 12))} emergencies/year averaging £${Math.round(vol.emergencyCost)}`,
  });

  // Partner income loss (couple households)
  if (household === 'couple_shared' || household === 'couple_separate' || household === 'family') {
    const partnerIncome = Math.round(profile.monthly.income * 0.85);
    scenarios.push({
      label: 'Partner income loss',
      probability: Math.round(vol.incomeShockProb * 0.7 * 12 * 100),
      monthlyImpact: -partnerIncome,
      description: `${Math.round(vol.incomeShockProb * 0.7 * 12 * 100)}% annual chance — household income halves`,
    });
  }

  // Life events
  if (events.includes('baby')) {
    const babyCost = Math.round(profile.monthly.spending * 0.25);
    scenarios.push({
      label: 'New baby costs',
      probability: 90,
      monthlyImpact: -babyCost,
      description: `Estimated £${babyCost}/month increase in nappies, childcare, and essentials`,
    });
  }

  if (events.includes('moving')) {
    const movingCost = Math.round(profile.monthly.spending * 2);
    scenarios.push({
      label: 'Moving costs',
      probability: 80,
      monthlyImpact: -movingCost,
      description: `One-off ~£${movingCost} for deposits, removals, and setup (amortised)`,
    });
  }

  if (events.includes('career_change')) {
    scenarios.push({
      label: 'Career transition gap',
      probability: 70,
      monthlyImpact: -Math.round(profile.monthly.income * 0.5),
      description: 'Potential 50% income reduction during 3-6 month transition',
    });
  }

  if (events.includes('wedding')) {
    scenarios.push({
      label: 'Wedding costs',
      probability: 85,
      monthlyImpact: -Math.round(1500), // ~£18k spread over 12 months
      description: 'UK average wedding ~£18k — ~£1,500/month if saving over 12 months',
    });
  }

  // Dependent scenarios
  if (deps.includes('elderly_parents')) {
    scenarios.push({
      label: 'Care contribution',
      probability: 40,
      monthlyImpact: -300,
      description: 'Potential £300/month contribution to elderly parent care needs',
    });
  }

  if (deps.includes('young_children')) {
    scenarios.push({
      label: 'Childcare cost increase',
      probability: 30,
      monthlyImpact: -Math.round(200),
      description: 'Holiday clubs, activity costs, or childcare price increases',
    });
  }

  return scenarios;
}
