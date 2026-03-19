// ── Debt Intelligence Engine ──
// Phase 4: Formal debt tier classification, debt-vs-invest Monte Carlo comparison,
// and liquidity override gate.

import type { DebtAccount, DebtTier, TieredDebtAccount } from './types';

// ── Phase 4A: Formal Tier Classification ──

export function classifyDebtTier(apr: number): DebtTier {
  if (apr > 0.08) return 'tier1_high';
  if (apr >= 0.04) return 'tier2_medium';
  return 'tier3_low';
}

export function tierLabel(tier: DebtTier): string {
  switch (tier) {
    case 'tier1_high': return 'High-cost debt — clear ASAP';
    case 'tier2_medium': return 'Medium-cost debt — steady repayment';
    case 'tier3_low': return 'Low-cost debt — often optimal to maintain';
  }
}

export function classifyDebtAccounts(debtAccounts: DebtAccount[]): TieredDebtAccount[] {
  return debtAccounts.map((d) => {
    const apr = d.interest_rate || 0;
    const tier = classifyDebtTier(apr);
    return {
      ...d,
      tier,
      tierLabel: tierLabel(tier),
    };
  });
}

// ── Phase 4B: Debt vs Investment Monte Carlo ──

export interface DebtInvestComparison {
  /** % of simulations where investing beats debt repayment */
  probabilityInvestWins: number;
  /** Median gain from investing vs paying debt (negative = debt wins) */
  medianGain: number;
  /** Downside scenario: 10th percentile investment outcome */
  downsideScenario: number;
  /** Years to break even on investing vs debt repayment */
  breakEvenYears: number;
}

const NUM_SIMS = 1000;
const YEARS = 10;

export function simulateDebtVsInvest(
  debtAPR: number,
  investAmount: number,
  expectedReturn: number = 0.07,
  volatility: number = 0.16, // equity market vol
  seed: number = 789,
): DebtInvestComparison {
  if (investAmount <= 0 || debtAPR <= 0) {
    return { probabilityInvestWins: 0, medianGain: 0, downsideScenario: 0, breakEvenYears: YEARS };
  }

  // Use seeded PRNG for reproducibility
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 2654435761) >>> 0 || 1;
  let s2 = (seed * 2246822519) >>> 0 || 1;
  let s3 = (seed * 3266489917) >>> 0 || 1;
  const rng = () => {
    const t = s1 << 9;
    let r = s0 * 5; r = ((r << 7) | (r >>> 25)) * 9;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3;
    s2 ^= t; s3 = (s3 << 11) | (s3 >>> 21);
    return (r >>> 0) / 4294967296;
  };

  const normalSample = () => {
    let u1 = rng();
    let u2 = rng();
    while (u1 === 0) u1 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const investResults: number[] = [];
  const debtSavings = investAmount * debtAPR * YEARS; // guaranteed return from paying debt

  // Track per-year break-even
  const yearlyInvestWins: number[] = new Array(YEARS).fill(0);

  for (let sim = 0; sim < NUM_SIMS; sim++) {
    let portfolio = investAmount;

    for (let year = 0; year < YEARS; year++) {
      // Annual return with log-normal distribution
      const annualReturn = expectedReturn + volatility * normalSample();
      portfolio *= (1 + annualReturn);

      // Check if investing wins at this year
      const debtSavingsAtYear = investAmount * debtAPR * (year + 1);
      if (portfolio - investAmount > debtSavingsAtYear) {
        yearlyInvestWins[year]++;
      }
    }

    investResults.push(portfolio - investAmount); // net gain from investing
  }

  investResults.sort((a, b) => a - b);

  const investWins = investResults.filter((g) => g > debtSavings).length;
  const medianGain = investResults[Math.floor(NUM_SIMS / 2)] - debtSavings;
  const downsideScenario = investResults[Math.floor(NUM_SIMS * 0.1)];

  // Break-even year: first year where >50% of sims have investing winning
  let breakEvenYears = YEARS;
  for (let y = 0; y < YEARS; y++) {
    if (yearlyInvestWins[y] / NUM_SIMS > 0.5) {
      breakEvenYears = y + 1;
      break;
    }
  }

  return {
    probabilityInvestWins: Math.round((investWins / NUM_SIMS) * 100),
    medianGain: Math.round(medianGain),
    downsideScenario: Math.round(downsideScenario),
    breakEvenYears,
  };
}

// ── Phase 4C: Liquidity Override Gate ──
// When buffer is dangerously low, suppress all debt moves except Tier 1.

export function applyLiquidityOverride(
  moves: Array<{ category?: string; suppressed?: boolean; suppressedReason?: string }>,
  bufferMonths: number,
  tieredDebts: TieredDebtAccount[],
): void {
  if (bufferMonths >= 3) return; // Buffer is adequate

  const hasTier1 = tieredDebts.some((d) => d.tier === 'tier1_high' && (d.outstanding_balance || 0) > 0);

  for (const move of moves) {
    if (move.category !== 'debt') continue;

    // Only keep Tier 1 debt moves when buffer is low
    if (!hasTier1) {
      move.suppressed = true;
      move.suppressedReason = 'Buffer below safety threshold — prioritizing liquidity';
    }
  }
}
