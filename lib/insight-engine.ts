// ── Insight Engine ──
// Detects 6 structural financial insights from the user's system map and profile.
// Each insight is quantified with annual £ impact and linked to actionable moves.
//
// Insight types:
//   1. Idle Capital Drag — cash earning below baseline return
//   2. Tax Leakage — unused ISA/pension allowances
//   3. Debt-Return Mismatch — debt APR vs investment return spread
//   4. Liquidity Inefficiency — buffer too small or too large
//   5. Cross-System Distortion — saving while carrying high-interest debt
//   6. Time-Based Loss — unacted moves compounding cost of delay

import type {
  Insight,
  InsightType,
  SystemMap,
  FinancialProfile,
  Move,
  DebtAccount,
} from './types';
import type { AccountBuckets } from './account-classifier';

// ── Phase 2A: Build System Map ──

export function buildSystemMap(
  profile: FinancialProfile,
  accounts: AccountBuckets | null,
  debtAccounts: DebtAccount[],
): SystemMap {
  const assets = {
    cash: accounts?.cash.total ?? 0,
    savings: accounts?.savings.total ?? 0,
    isa: accounts?.isa.total ?? 0,
    pension: accounts?.pension.total ?? 0,
    investments: accounts?.investments.total ?? 0,
  };

  const liabilities = {
    mortgage: 0,
    loans: 0,
    creditCards: 0,
    bnpl: 0,
  };

  for (const d of debtAccounts) {
    const bal = d.outstanding_balance || 0;
    const type = (d.account_type || '').toLowerCase();
    if (type.includes('mortgage')) liabilities.mortgage += bal;
    else if (type.includes('credit') || type.includes('card')) liabilities.creditCards += bal;
    else if (type.includes('bnpl') || type.includes('buy now')) liabilities.bnpl += bal;
    else liabilities.loans += bal;
  }

  // Constraints
  const monthlyExpenses = profile.monthly.spending;
  const liquidityNeed = monthlyExpenses * 3; // 3-month buffer
  const taxWrapperCapacity = 20000; // ISA allowance (simplified)
  const incomeStability = profile.monthly.isVariableIncome ? 0.6 : 0.9;

  return {
    assets,
    liabilities,
    constraints: { liquidityNeed, taxWrapperCapacity, incomeStability },
  };
}

// ── Phase 2B: Six Insight Detection Functions ──

const MATERIALITY_THRESHOLD = 50; // £50/year minimum to surface an insight
const BASELINE_RETURN = 0.045; // 4.5% achievable savings rate
const CASH_YIELD = 0.01; // typical current account yield

function detectIdleCapitalDrag(systemMap: SystemMap, profile: FinancialProfile): Insight | null {
  const buffer = systemMap.constraints.liquidityNeed;
  const idleCash = Math.max(0, systemMap.assets.cash - buffer);
  if (idleCash < 1000) return null;

  const annualDrag = Math.round(idleCash * (BASELINE_RETURN - CASH_YIELD));
  if (annualDrag < MATERIALITY_THRESHOLD) return null;

  return {
    type: 'idle_capital_drag',
    statement: `£${idleCash.toLocaleString()} earning ~${(CASH_YIELD * 100).toFixed(1)}% is reducing your net outcome by ~£${annualDrag.toLocaleString()}/year vs optimal allocation`,
    annualImpact: annualDrag,
    longTermImpact: annualDrag * 5,
    cause: `Cash beyond your 3-month buffer (£${buffer.toLocaleString()}) sits in low-yield accounts`,
    implication: `Over 5 years, this costs ~£${(annualDrag * 5).toLocaleString()} in forgone returns`,
    linkedMoveCategory: 'allocate',
    confidence: systemMap.assets.cash > 0 ? 0.9 : 0.5,
    priority: 1,
  };
}

function detectTaxLeakage(systemMap: SystemMap, profile: FinancialProfile): Insight | null {
  const monthlyIncome = profile.monthly.income;
  const insights: Insight[] = [];

  // ISA allowance unused
  const isaBalance = systemMap.assets.isa;
  const isaAllowance = systemMap.constraints.taxWrapperCapacity;
  const investableAssets = systemMap.assets.cash + systemMap.assets.savings - systemMap.constraints.liquidityNeed;

  if (investableAssets > 5000 && isaBalance < isaAllowance) {
    const expectedReturn = 0.05;
    const marginalRate = monthlyIncome > 4190 ? 0.40 : 0.20;
    const taxablePortion = Math.min(investableAssets, isaAllowance - isaBalance);
    const annualTaxSaving = Math.round(taxablePortion * expectedReturn * marginalRate);

    if (annualTaxSaving >= MATERIALITY_THRESHOLD) {
      return {
        type: 'tax_leakage',
        statement: `~£${annualTaxSaving.toLocaleString()}/year in tax on investment gains is unprotected — sheltering inside an ISA eliminates this`,
        annualImpact: annualTaxSaving,
        longTermImpact: annualTaxSaving * 5,
        cause: `£${taxablePortion.toLocaleString()} of investable assets sit outside tax wrappers`,
        implication: `Each year outside an ISA, ${(marginalRate * 100)}% of gains go to HMRC`,
        linkedMoveCategory: 'allocate',
        confidence: 0.85,
        priority: 2,
      };
    }
  }

  // Pension: higher-rate relief missed
  if (monthlyIncome > 4190) {
    const pensionContrib = Math.round(monthlyIncome * 0.05);
    const annualRelief = Math.round(pensionContrib * 12 * 0.40);
    if (annualRelief >= MATERIALITY_THRESHOLD) {
      return {
        type: 'tax_leakage',
        statement: `£${annualRelief.toLocaleString()}/year in higher-rate pension relief unclaimed`,
        annualImpact: annualRelief,
        cause: 'Higher-rate taxpayer without salary sacrifice or additional pension contributions',
        implication: 'Every £1 into a pension costs only 60p — the government adds 40p',
        linkedMoveCategory: 'allocate',
        confidence: 0.75,
        priority: 3,
      };
    }
  }

  return null;
}

function detectDebtReturnMismatch(systemMap: SystemMap, debtAccounts: DebtAccount[]): Insight | null {
  const investReturnExpected = 0.07; // long-term equity average

  for (const d of debtAccounts) {
    const apr = d.interest_rate || 0;
    const balance = d.outstanding_balance || 0;
    if (balance <= 0 || apr <= 0) continue;

    const spread = Math.abs(apr - investReturnExpected);
    const annualCost = Math.round(balance * spread);

    if (annualCost >= MATERIALITY_THRESHOLD && apr > investReturnExpected) {
      return {
        type: 'debt_return_mismatch',
        statement: `Debt at ${(apr * 100).toFixed(1)}% APR vs ${(investReturnExpected * 100)}% investment return — £${annualCost.toLocaleString()}/year guaranteed loss`,
        annualImpact: annualCost,
        cause: `£${balance.toLocaleString()} debt costing ${(apr * 100).toFixed(1)}% exceeds any realistic investment return`,
        implication: 'Paying down this debt delivers a guaranteed return equal to the APR',
        linkedMoveCategory: 'debt',
        confidence: 0.95,
        priority: 1,
      };
    }

    // Low-rate debt where investing might win
    if (apr < investReturnExpected && apr > 0.02) {
      const expectedGain = Math.round(balance * (investReturnExpected - apr));
      if (expectedGain >= MATERIALITY_THRESHOLD) {
        return {
          type: 'debt_return_mismatch',
          statement: `${(apr * 100).toFixed(1)}% debt is below expected investment returns — redirecting overpayments to investments nets ~£${expectedGain.toLocaleString()}/year more`,
          annualImpact: expectedGain,
          cause: `Debt APR (${(apr * 100).toFixed(1)}%) is below expected investment returns (${(investReturnExpected * 100)}%)`,
          implication: 'Overpaying low-rate debt has an opportunity cost',
          linkedMoveCategory: 'invest',
          confidence: 0.7,
          priority: 4,
        };
      }
    }
  }
  return null;
}

function detectLiquidityInefficiency(systemMap: SystemMap, profile: FinancialProfile): Insight | null {
  const buffer = systemMap.assets.cash + systemMap.assets.savings;
  const monthlyExpenses = profile.monthly.spending;
  const bufferMonths = monthlyExpenses > 0 ? buffer / monthlyExpenses : 0;

  // Under-buffered
  if (bufferMonths < 3 && monthlyExpenses > 0) {
    const deficit = Math.round((3 - bufferMonths) * monthlyExpenses);
    return {
      type: 'liquidity_inefficiency',
      statement: `Buffer covers ${bufferMonths.toFixed(1)} months — ${(3 - bufferMonths).toFixed(1)} months short of safety threshold`,
      annualImpact: Math.round(deficit * 0.1), // rough cost of being forced to borrow
      cause: `£${buffer.toLocaleString()} liquid assets vs £${Math.round(monthlyExpenses * 3).toLocaleString()} needed`,
      implication: 'An income shock could force expensive borrowing or asset liquidation',
      linkedMoveCategory: 'buffer',
      confidence: 0.9,
      priority: 1,
    };
  }

  // Over-buffered
  if (bufferMonths > 12 && buffer > 20000) {
    const excess = Math.round(buffer - monthlyExpenses * 6);
    const opportunityCost = Math.round(excess * (BASELINE_RETURN - CASH_YIELD));
    if (opportunityCost >= MATERIALITY_THRESHOLD) {
      return {
        type: 'liquidity_inefficiency',
        statement: `${bufferMonths.toFixed(0)} months of buffer — £${excess.toLocaleString()} excess costing ~£${opportunityCost.toLocaleString()}/year in opportunity`,
        annualImpact: opportunityCost,
        cause: `Buffer significantly exceeds the recommended 3-6 months`,
        implication: 'Deploying excess cash into ISAs or investments captures higher returns',
        linkedMoveCategory: 'allocate',
        confidence: 0.8,
        priority: 3,
      };
    }
  }

  return null;
}

function detectCrossSystemDistortion(systemMap: SystemMap, profile: FinancialProfile, debtAccounts: DebtAccount[]): Insight | null {
  // Saving while carrying high-interest debt
  const savings = profile.monthly.savings || 0;
  const highRateDebt = debtAccounts.filter((d) => (d.interest_rate || 0) > 0.06 && (d.outstanding_balance || 0) > 0);

  if (savings > 50 && highRateDebt.length > 0) {
    const highestAPR = Math.max(...highRateDebt.map((d) => d.interest_rate || 0));
    const totalHighDebt = highRateDebt.reduce((s, d) => s + (d.outstanding_balance || 0), 0);
    const savingsReturn = 0.045;
    const annualLoss = Math.round(savings * 12 * (highestAPR - savingsReturn));

    if (annualLoss >= MATERIALITY_THRESHOLD) {
      return {
        type: 'cross_system_distortion',
        statement: `Saving £${Math.round(savings)}/month while paying ${(highestAPR * 100).toFixed(1)}% on £${totalHighDebt.toLocaleString()} debt — net loss ~£${annualLoss.toLocaleString()}/year`,
        annualImpact: annualLoss,
        cause: 'Savings earn less than debt costs — redirecting would close the gap',
        implication: `Every £1 saved at 4.5% while owing at ${(highestAPR * 100).toFixed(1)}% loses ${((highestAPR - savingsReturn) * 100).toFixed(1)}p/year`,
        linkedMoveCategory: 'debt',
        confidence: 0.9,
        priority: 1,
      };
    }
  }

  // Investing while buffer is inadequate
  const buffer = systemMap.assets.cash + systemMap.assets.savings;
  const bufferMonths = profile.monthly.spending > 0 ? buffer / profile.monthly.spending : 99;
  const investments = systemMap.assets.investments + systemMap.assets.isa;

  if (bufferMonths < 2 && investments > 5000) {
    return {
      type: 'cross_system_distortion',
      statement: `£${investments.toLocaleString()} invested but only ${bufferMonths.toFixed(1)} months of buffer — sequencing risk`,
      annualImpact: Math.round(investments * 0.03), // risk of forced liquidation at bad time
      cause: 'Investments locked up while liquid buffer is dangerously low',
      implication: 'A cash crunch could force selling investments at a loss',
      linkedMoveCategory: 'buffer',
      confidence: 0.85,
      priority: 2,
    };
  }

  return null;
}

function detectTimeBasedLoss(moves: Move[]): Insight | null {
  // Note: In a full implementation, this would check move creation dates against
  // current date. For now, we surface this for any high-impact unacted moves.
  const highImpactMoves = moves.filter((m) => m.annualImpact >= 200 && !m.suppressed);

  if (highImpactMoves.length > 0) {
    const totalUnactedImpact = highImpactMoves.reduce((s, m) => s + m.annualImpact, 0);
    // Assume 30 days of delay as baseline
    const delayDays = 30;
    const dailyCost = Math.round(totalUnactedImpact / 365);
    const delayCost = dailyCost * delayDays;

    if (delayCost >= MATERIALITY_THRESHOLD) {
      return {
        type: 'time_based_loss',
        statement: `${highImpactMoves.length} unacted moves worth £${totalUnactedImpact.toLocaleString()}/year — each day of delay costs ~£${dailyCost}/day`,
        annualImpact: delayCost * 12, // annualize the delay cost
        cause: `${highImpactMoves.length} recommendations awaiting action`,
        implication: `30 days of inaction on these moves has cost ~£${delayCost.toLocaleString()}`,
        linkedMoveCategory: highImpactMoves[0].category || 'spending',
        confidence: 0.7,
        priority: 5,
      };
    }
  }

  return null;
}

// ── Phase 2B: Main Detection Function ──

export function detectInsights(
  systemMap: SystemMap,
  profile: FinancialProfile,
  moves: Move[],
  debtAccounts: DebtAccount[],
): Insight[] {
  const detectors = [
    () => detectIdleCapitalDrag(systemMap, profile),
    () => detectTaxLeakage(systemMap, profile),
    () => detectDebtReturnMismatch(systemMap, debtAccounts),
    () => detectLiquidityInefficiency(systemMap, profile),
    () => detectCrossSystemDistortion(systemMap, profile, debtAccounts),
    () => detectTimeBasedLoss(moves),
  ];

  const insights: Insight[] = [];
  for (const detect of detectors) {
    const insight = detect();
    if (insight && insight.annualImpact >= MATERIALITY_THRESHOLD) {
      insights.push(insight);
    }
  }

  // Phase 2C: Quality enforcement — reject insights missing required fields
  const valid = insights.filter((i) =>
    i.statement && i.annualImpact > 0 && i.cause && i.implication,
  );

  // Sort by priority (lower = more important), then by annual impact
  valid.sort((a, b) => a.priority - b.priority || b.annualImpact - a.annualImpact);

  return valid;
}

// ── Phase 2C: Insight Formatting ──

export function formatInsight(insight: Insight): string {
  return `${insight.statement}\n` +
    `Cause: ${insight.cause}\n` +
    `Impact: £${insight.annualImpact.toLocaleString()}/year` +
    (insight.longTermImpact ? ` (£${insight.longTermImpact.toLocaleString()} over 5 years)` : '') +
    `\nImplication: ${insight.implication}`;
}

// ── Phase 6C: Cohort-Specific Language ──
// Adjusts insight framing based on the user's financial cohort.

type FinancialCohort = 'crisis' | 'debt_focus' | 'foundation' | 'accumulator' | 'optimizer' | 'coasting';

const COHORT_FRAMINGS: Record<string, { prefix: string; tone: string }> = {
  crisis: { prefix: 'Urgent:', tone: 'Clear, immediate action needed' },
  debt_focus: { prefix: 'Priority:', tone: 'Focused debt clearing' },
  foundation: { prefix: 'Building blocks:', tone: 'Foundation-level progress' },
  accumulator: { prefix: 'Growth opportunity:', tone: 'Steady optimisation' },
  optimizer: { prefix: 'Fine-tuning:', tone: 'System-level optimisation' },
  coasting: { prefix: 'Maintenance:', tone: 'Protection and preservation' },
};

export function formatInsightForCohort(insight: Insight, cohort: FinancialCohort): string {
  const framing = COHORT_FRAMINGS[cohort] || COHORT_FRAMINGS.foundation;

  // UHE-style framing: clear, immediate, urgency
  if (cohort === 'crisis' || cohort === 'debt_focus') {
    return `${framing.prefix} ${insight.statement}\n` +
      `This costs you £${insight.annualImpact.toLocaleString()}/year right now.\n` +
      `Action: ${insight.implication}`;
  }

  // SHE-style framing: non-obvious trade-off, system-level
  if (cohort === 'optimizer' || cohort === 'coasting') {
    return `${framing.prefix} ${insight.statement}\n` +
      `Annual impact: £${insight.annualImpact.toLocaleString()}/year` +
      (insight.longTermImpact ? ` → £${insight.longTermImpact.toLocaleString()} over 5 years` : '') +
      `\nTrade-off: ${insight.cause}`;
  }

  // Default: balanced framing
  return `${framing.prefix} ${insight.statement}\n` +
    `Impact: £${insight.annualImpact.toLocaleString()}/year\n` +
    `Why: ${insight.cause}`;
}

// ── Phase 6B: Delay Cost Quantification ──

export function quantifyDelayCost(annualImpact: number, delayDays: number): {
  dailyCost: number;
  totalCost: number;
  compoundingCost: number;
} {
  const dailyCost = Math.round((annualImpact / 365) * 100) / 100;
  const totalCost = Math.round(dailyCost * delayDays * 100) / 100;
  // Compounding effect: daily rate ^ days
  const dailyRate = annualImpact / (365 * 100); // as decimal fraction of £100 base
  const compoundingCost = Math.round(annualImpact * (Math.pow(1 + dailyRate, delayDays / 365) - 1));

  return { dailyCost, totalCost, compoundingCost };
}

