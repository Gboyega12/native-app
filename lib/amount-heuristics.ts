// ── Amount & Frequency Heuristics ──
// Classifies transactions based on amount patterns and recurrence
// rather than merchant names. Catches rent (including weekly/fortnightly
// tranches), recurring bills, and ATM withdrawals that keyword/merchant
// rules miss.
//
// Supports UK pay cycles:
//   weekly (5-10 day gaps)    — gig/retail/hospitality workers
//   fortnightly (12-18 days)  — some NHS/public sector roles
//   monthly (25-38 days)      — standard salaried pay

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

type RecurrenceFrequency = 'weekly' | 'fortnightly' | 'monthly' | null;

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

// ── Frequency detection helpers ──

function countGapsInRange(entry: FrequencyEntry, minDays: number, maxDays: number): number {
  const sorted = [...entry.dates].sort((a, b) => a.getTime() - b.getTime());
  let matching = 0;
  for (let i = 1; i < sorted.length; i++) {
    const days = (sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24);
    if (days >= minDays && days <= maxDays) matching++;
  }
  return matching;
}

/** Weekly: 3+ occurrences with 5-10 day gaps */
function isWeeklyRecurring(entry: FrequencyEntry): boolean {
  return entry.count >= 3 && countGapsInRange(entry, 5, 10) >= 2;
}

/** Fortnightly: 2+ occurrences with 12-18 day gaps */
function isFortnightlyRecurring(entry: FrequencyEntry): boolean {
  return entry.count >= 2 && countGapsInRange(entry, 12, 18) >= 1;
}

/** Monthly: 2+ occurrences with 25-38 day gaps */
function isMonthlyRecurring(entry: FrequencyEntry): boolean {
  return entry.count >= 2 && countGapsInRange(entry, 25, 38) >= 1;
}

/**
 * Detect the recurrence frequency of a transaction group.
 * Checks in order: weekly → fortnightly → monthly.
 */
function detectFrequency(entry: FrequencyEntry): RecurrenceFrequency {
  if (isWeeklyRecurring(entry)) return 'weekly';
  if (isFortnightlyRecurring(entry)) return 'fortnightly';
  if (isMonthlyRecurring(entry)) return 'monthly';
  return null;
}

/**
 * Convert a per-occurrence amount to its monthly equivalent.
 * Weekly × 4.33, fortnightly × 2.17, monthly × 1.
 */
function aggregateToMonthly(amount: number, frequency: RecurrenceFrequency): number {
  switch (frequency) {
    case 'weekly': return amount * 4.33;
    case 'fortnightly': return amount * 2.17;
    case 'monthly': return amount;
    default: return amount;
  }
}

export interface AmountHeuristicResult {
  category: string;
  isEssential: boolean;
}

/**
 * Classify a transaction by amount/frequency heuristics.
 * Only called for transactions that failed all prior classification layers.
 *
 * Handles all UK pay cycles:
 *   - Monthly rent: single £500-3000 payment every 25-38 days
 *   - Weekly rent tranches: e.g. £250/week to partner = £1083/mo
 *   - Fortnightly rent: e.g. £500/fortnight to landlord = £1085/mo
 *   - Recurring bills at any frequency
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

  const frequency = detectFrequency(entry);
  if (!frequency) return null;

  const monthlyEquivalent = aggregateToMonthly(absAmount, frequency);

  // ── Rule 2: Rent heuristic (all frequencies) ──
  // Monthly equivalent must fall in £400-3000 range.
  // Covers: £1000/mo single payment, £250/week tranches, £500/fortnight, etc.
  if (isDebit && monthlyEquivalent >= 400 && monthlyEquivalent <= 3000) {
    // Per-occurrence amount must be at least £100 to avoid catching
    // small daily purchases (e.g. £5/day coffee = £217/mo)
    if (absAmount >= 100) {
      return { category: 'Rent', isEssential: true };
    }
  }

  // ── Rule 3: Recurring bill (all frequencies) ──
  // Round-number debits, £10-500/occurrence, any recurring frequency
  if (isDebit && absAmount >= 10 && absAmount <= 500 && absAmount % 5 === 0) {
    return { category: 'Bills', isEssential: true };
  }

  return null;
}
