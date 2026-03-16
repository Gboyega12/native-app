// ── Amount & Frequency Heuristics ──
// Classifies transactions based on amount patterns and recurrence
// rather than merchant names. Catches rent, recurring bills, and
// ATM withdrawals that keyword/merchant rules miss.

import { normaliseDescription } from './normalise.js';
import type { RawTransaction } from './types.js';

// ── ATM / Cash patterns ──
const CASH_PATTERNS = [
  /\batm\b/,
  /\bcash\s*(?:withdrawal|machine|point)\b/,
  /\bwithdrawal\b/,
  /\bcashpoint\b/,
  /\blink\b.*\batm\b/,
];

export interface FrequencyEntry {
  count: number;
  amounts: number[];
  dates: Date[];
}

export type FrequencyMap = Map<string, FrequencyEntry>;

/**
 * Build a frequency map grouping transactions by normalised description.
 * Called once per enrichment run, then referenced per-transaction.
 */
export function buildFrequencyMap(transactions: RawTransaction[]): FrequencyMap {
  const map: FrequencyMap = new Map();

  for (const tx of transactions) {
    const key = normaliseDescription(tx.description);
    if (!key) continue;

    const entry = map.get(key);
    const date = new Date(tx.date);

    if (entry) {
      entry.count++;
      entry.amounts.push(tx.amount);
      entry.dates.push(date);
    } else {
      map.set(key, { count: 1, amounts: [tx.amount], dates: [date] });
    }
  }

  return map;
}

/**
 * Check if a transaction group recurs approximately monthly.
 * Looks for 2+ occurrences with ~25-35 day intervals.
 */
function isMonthlyRecurring(entry: FrequencyEntry): boolean {
  if (entry.count < 2) return false;

  const sorted = [...entry.dates].sort((a, b) => a.getTime() - b.getTime());
  let monthlyGaps = 0;

  for (let i = 1; i < sorted.length; i++) {
    const daysBetween = (sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24);
    if (daysBetween >= 25 && daysBetween <= 38) {
      monthlyGaps++;
    }
  }

  // At least one monthly-ish gap
  return monthlyGaps >= 1;
}

export interface AmountHeuristicResult {
  category: string;
  isEssential: boolean;
}

/**
 * Classify a transaction by amount/frequency heuristics.
 * Only called for transactions that failed all prior classification layers.
 */
export function classifyByAmountHeuristic(
  tx: RawTransaction,
  normalisedDescription: string,
  frequencyMap?: FrequencyMap,
): AmountHeuristicResult | null {
  const isDebit = tx.amount < 0;
  const absAmount = Math.abs(tx.amount);

  // ── Rule 1: ATM / Cash withdrawals ──
  if (isDebit && CASH_PATTERNS.some((rx) => rx.test(normalisedDescription))) {
    return { category: 'Cash', isEssential: false };
  }

  if (!frequencyMap) return null;

  const entry = frequencyMap.get(normalisedDescription);
  if (!entry) return null;

  const isMonthly = isMonthlyRecurring(entry);

  // ── Rule 2: Rent heuristic ──
  // Debit, £500-3000, recurring monthly
  if (isDebit && absAmount >= 500 && absAmount <= 3000 && isMonthly) {
    return { category: 'Rent', isEssential: true };
  }

  // ── Rule 3: Round-number recurring bill ──
  // Debit, divisible by 5, £20-500, recurring monthly
  if (isDebit && absAmount >= 20 && absAmount <= 500 && absAmount % 5 === 0 && isMonthly) {
    return { category: 'Bills', isEssential: true };
  }

  return null;
}
