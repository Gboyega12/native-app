// ── Account Classifier ──
// Classifies TrueLayer bank accounts into functional buckets
// and detects UHE/SHE cohorts for capital allocation moves.

import type { DebtAccount } from './types';

// ── Types ──

export interface AccountSnapshot {
  name: string;
  type: string;
  balance: number;
  provider: string;
}

export interface AccountBuckets {
  cash: { total: number; accounts: AccountSnapshot[] };
  savings: { total: number; accounts: AccountSnapshot[] };
  isa: { total: number; accounts: AccountSnapshot[] };
  pension: { total: number; estimated: boolean };
  investments: { total: number; accounts: AccountSnapshot[] };
}

export type HighEarnerCohort = 'unstructured_high_earner' | 'structured_high_earner' | null;

// ── 14b: Classify Accounts ──

export function classifyAccounts(
  accountBalances: Array<{ account_id: string; account_type: string; display_name?: string; provider?: string; balance?: number }>,
): AccountBuckets {
  const buckets: AccountBuckets = {
    cash: { total: 0, accounts: [] },
    savings: { total: 0, accounts: [] },
    isa: { total: 0, accounts: [] },
    pension: { total: 0, estimated: true },
    investments: { total: 0, accounts: [] },
  };

  for (const acc of accountBalances) {
    const name = (acc.display_name || '').toLowerCase();
    const type = (acc.account_type || '').toLowerCase();
    const balance = acc.balance || 0;
    const snapshot: AccountSnapshot = {
      name: acc.display_name || acc.account_id,
      type: acc.account_type || 'unknown',
      balance,
      provider: acc.provider || '',
    };

    // ISA detection
    if (name.includes('isa') || name.includes('stocks & shares') || name.includes('cash isa')) {
      buckets.isa.total += balance;
      buckets.isa.accounts.push(snapshot);
    }
    // Pension detection
    else if (name.includes('sipp') || name.includes('pension')) {
      buckets.pension.total += balance;
      buckets.pension.estimated = false;
    }
    // Savings detection
    else if (type === 'savings' || name.includes('savings') || name.includes('saver')) {
      buckets.savings.total += balance;
      buckets.savings.accounts.push(snapshot);
    }
    // Current account = cash
    else if (type === 'current' || type === 'transaction') {
      buckets.cash.total += balance;
      buckets.cash.accounts.push(snapshot);
    }
    // Default to cash
    else {
      buckets.cash.total += balance;
      buckets.cash.accounts.push(snapshot);
    }
  }

  return buckets;
}

// ── 14c: Detect High Earner Cohort ──

export function detectHighEarnerCohort(
  monthlyIncome: number,
  savingsRate: number,
  accounts: AccountBuckets,
  monthlySpending: number,
  debtAccounts: DebtAccount[],
  hasInvestmentTxs: boolean,
  hasMortgage: boolean,
  isFullPayer: boolean,
): HighEarnerCohort {
  // Income gate: ≥£4,000/month net (≈£58k gross)
  if (monthlyIncome < 4000) return null;

  // UHE triggers (need 2 of 3)
  let uheScore = 0;
  // 1. Cash-to-income ratio > 3x monthly income in current accounts
  if (accounts.cash.total > monthlyIncome * 3) uheScore++;
  // 2. Savings rate < 15% despite high income
  if (savingsRate < 15) uheScore++;
  // 3. No ISA/pension/investment activity
  if (accounts.isa.total === 0 && accounts.pension.total === 0 && !hasInvestmentTxs) uheScore++;

  if (uheScore >= 2) return 'unstructured_high_earner';

  // SHE triggers (need 2 of 3)
  let sheScore = 0;
  // 1. Active investment platform transactions
  if (hasInvestmentTxs) sheScore++;
  // 2. Mortgage present
  if (hasMortgage) sheScore++;
  // 3. Credit card full-payer pattern
  if (isFullPayer) sheScore++;

  if (sheScore >= 2) return 'structured_high_earner';

  return null;
}

// ── 14d: Idle Capital Detection ──

export interface CapitalAllocationMove {
  action: string;
  annualImpact: number;
  monthlyImpact: number;
  effort: 'low' | 'medium' | 'high';
  category: 'allocate';
  proof: string;
  strategy: string;
  steps: string[];
  effect: string;
}

export function generateCapitalMoves(
  accounts: AccountBuckets,
  monthlySpending: number,
  monthlyIncome: number,
  savingsRate: number,
  debtAccounts: DebtAccount[],
  riskAppetite: string,
): CapitalAllocationMove[] {
  const moves: CapitalAllocationMove[] = [];

  // ── 14d: Idle Capital Drag ──
  const bufferNeeded = monthlySpending * 3; // 3 months buffer
  const idleCapital = Math.max(0, accounts.cash.total - bufferNeeded);
  if (idleCapital > 5000) {
    const achievableRate = 0.045;
    const currentRate = 0.01;
    const annualDrag = Math.round(idleCapital * (achievableRate - currentRate));
    moves.push({
      action: `\u00a3${idleCapital.toLocaleString()} of your cash is earning <1%. Reallocating could generate ~\u00a3${annualDrag.toLocaleString()}/year.`,
      annualImpact: annualDrag,
      monthlyImpact: Math.round(annualDrag / 12),
      effort: 'low',
      category: 'allocate',
      proof: `\u00a3${accounts.cash.total.toLocaleString()} cash across ${accounts.cash.accounts.length} account${accounts.cash.accounts.length !== 1 ? 's' : ''} | 3-month buffer = \u00a3${bufferNeeded.toLocaleString()} | \u00a3${idleCapital.toLocaleString()} idle \u00d7 (${(achievableRate * 100).toFixed(1)}% - ${(currentRate * 100).toFixed(1)}%) = \u00a3${annualDrag.toLocaleString()}/yr`,
      strategy: `Move excess cash beyond your 3-month emergency buffer to a high-yield savings account.`,
      steps: ['Confirm your 3-month buffer amount', 'Open a high-yield savings account', 'Transfer the idle portion', 'Set up regular transfers for future excess'],
      effect: `~\u00a3${annualDrag.toLocaleString()}/year in additional interest.`,
    });
  }

  // ── 14e: Tax Shield (ISA) ──
  // Estimate ISA usage — rough approximation from ISA account balance changes
  const remainingIsaAllowance = 20000; // Assume unused for now — needs historical tracking
  if (remainingIsaAllowance > 5000 && (accounts.cash.total + accounts.savings.total) > 10000) {
    const expectedReturn = 0.05;
    const marginalTaxRate = monthlyIncome > 4190 ? 0.40 : 0.20; // ~£50k gross
    const annualTaxSaving = Math.round(remainingIsaAllowance * expectedReturn * marginalTaxRate);
    moves.push({
      action: `You have ~\u00a3${remainingIsaAllowance.toLocaleString()} ISA allowance remaining. Using it protects future gains from tax.`,
      annualImpact: annualTaxSaving,
      monthlyImpact: Math.round(annualTaxSaving / 12),
      effort: 'medium',
      category: 'allocate',
      proof: `\u00a3${remainingIsaAllowance.toLocaleString()} allowance \u00d7 ${(expectedReturn * 100).toFixed(0)}% return \u00d7 ${(marginalTaxRate * 100).toFixed(0)}% tax = \u00a3${annualTaxSaving}/yr protected`,
      strategy: `Use your remaining ISA allowance before the tax year ends. Every pound inside an ISA grows tax-free.`,
      steps: ['Check your current ISA contributions this tax year', 'Transfer from savings to ISA', 'Consider stocks & shares ISA for long-term growth', 'Tax year ends 5 April'],
      effect: `~\u00a3${annualTaxSaving}/year in tax savings, compounding over time.`,
    });
  }

  // ── 14e: Pension (higher rate relief) ──
  if (monthlyIncome > 4190) { // ~£50k gross → higher rate taxpayer
    const pensionContribution = Math.round(monthlyIncome * 0.05);
    const taxRelief = Math.round(pensionContribution * 12 * 0.40);
    moves.push({
      action: `Increase pension by \u00a3${pensionContribution}/month to capture ~\u00a3${taxRelief.toLocaleString()}/year in higher-rate relief.`,
      annualImpact: taxRelief,
      monthlyImpact: Math.round(taxRelief / 12),
      effort: 'medium',
      category: 'allocate',
      proof: `\u00a3${pensionContribution}/mo \u00d7 12 = \u00a3${(pensionContribution * 12).toLocaleString()}/yr | marginal rate 40% | tax relief = \u00a3${taxRelief.toLocaleString()}/yr`,
      strategy: `Higher-rate taxpayers get 40p back for every \u00a31 into a pension. Consider salary sacrifice for additional NI savings.`,
      steps: ['Check current pension contribution rate', 'Increase to at least capture full employer match', 'Consider salary sacrifice vs net pay', 'Review annually as income changes'],
      effect: `\u00a3${taxRelief.toLocaleString()}/year in tax relief, plus employer contributions.`,
    });
  }

  // ── 14f: Structural Misallocation ──
  const totalAssets = accounts.cash.total + accounts.savings.total + accounts.isa.total + accounts.investments.total + accounts.pension.total;
  if (totalAssets > 20000) {
    const cashPct = (accounts.cash.total / totalAssets) * 100;
    const benchmarkCash = riskAppetite === 'conservative' ? 30 : riskAppetite === 'growth' ? 10 : 20;

    if (cashPct > benchmarkCash + 15) {
      const excessCash = Math.round(accounts.cash.total - totalAssets * (benchmarkCash / 100));
      const annualDrag = Math.round(excessCash * 0.06); // 7% invested - 1% cash = ~6% drag
      moves.push({
        action: `Your allocation is ${Math.round(cashPct)}% cash. Rebalancing could improve returns by ~\u00a3${annualDrag.toLocaleString()}/year.`,
        annualImpact: annualDrag,
        monthlyImpact: Math.round(annualDrag / 12),
        effort: 'high',
        category: 'allocate',
        proof: `\u00a3${accounts.cash.total.toLocaleString()} cash (${Math.round(cashPct)}%) vs benchmark ${benchmarkCash}% | \u00a3${excessCash.toLocaleString()} excess \u00d7 6% drag = \u00a3${annualDrag}/yr`,
        strategy: `Your cash allocation is ${Math.round(cashPct - benchmarkCash)}% above your risk-appropriate benchmark. Consider moving excess into ISA or investment wrappers.`,
        steps: ['Review your risk tolerance', 'Keep 3-month buffer in easy-access cash', 'Move excess to ISA or investment account', 'Rebalance annually'],
        effect: `~\u00a3${annualDrag.toLocaleString()}/year in improved returns through better allocation.`,
      });
    }
  }

  // ── 14i: Net Yield Mismatch ──
  // Cash > £10k AND debt with APR > savings rate
  const debtWithRate = debtAccounts.filter((d) => (d.interest_rate || 0) > 0.02 && (d.outstanding_balance || 0) > 0);
  if (accounts.cash.total > 10000 && debtWithRate.length > 0) {
    const highestDebt = debtWithRate.sort((a, b) => (b.interest_rate || 0) - (a.interest_rate || 0))[0];
    const debtAPR = highestDebt.interest_rate || 0;
    const cashRate = 0.01;
    const matchedAmount = Math.min(accounts.cash.total - bufferNeeded, highestDebt.outstanding_balance || 0);
    if (matchedAmount > 1000) {
      const mismatchCost = Math.round(matchedAmount * (debtAPR - cashRate));
      moves.push({
        action: `You hold \u00a3${Math.round(accounts.cash.total).toLocaleString()} cash while paying ${(debtAPR * 100).toFixed(1)}% on debt \u2192 costing ~\u00a3${mismatchCost}/yr net.`,
        annualImpact: mismatchCost,
        monthlyImpact: Math.round(mismatchCost / 12),
        effort: 'medium',
        category: 'allocate',
        proof: `min(\u00a3${Math.round(accounts.cash.total - bufferNeeded).toLocaleString()} excess, \u00a3${Math.round(highestDebt.outstanding_balance || 0).toLocaleString()} debt) = \u00a3${matchedAmount.toLocaleString()} \u00d7 (${(debtAPR * 100).toFixed(1)}% - ${(cashRate * 100).toFixed(1)}%) = \u00a3${mismatchCost}/yr`,
        strategy: `Holding low-yield cash while paying higher interest on debt costs you the difference. Consider using excess cash to reduce the debt.`,
        steps: ['Confirm your emergency buffer is covered', 'Use excess cash to pay down highest-rate debt', 'Keep minimum 3 months expenses in cash', 'Redirect freed-up debt payments to savings'],
        effect: `\u00a3${mismatchCost}/year guaranteed return by eliminating the yield mismatch.`,
      });
    }
  }

  return moves;
}
