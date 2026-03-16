// ── Learned Patterns ──
// Extracts reusable classification patterns from user overrides.
// When a user categorizes "PRET A MANGER LONDON" → Coffee & Cafes,
// we extract ["pret", "manger"] as keywords. Future transactions
// containing ALL keywords auto-classify without re-asking.

import { normaliseDescription } from './normalise.js';
import type { LearnedPattern } from './types.js';

// Words too generic to be meaningful classification signals
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'from', 'and', 'at', 'in', 'on', 'for', 'of',
  'ltd', 'limited', 'plc', 'uk', 'gb', 'gbr', 'com', 'org', 'net',
  'payment', 'direct', 'debit', 'credit', 'card', 'ref', 'fee',
]);

const MIN_WORD_LEN = 3;

export interface TransactionOverrideInput {
  match_description: string;
  category: string;
  is_essential: boolean;
  direction?: 'credit' | 'debit';
}

/**
 * Extract classification patterns from user overrides.
 * Each override's description is normalised, split into words,
 * and filtered to significant keywords.
 */
export function extractLearnedPatterns(overrides: TransactionOverrideInput[]): LearnedPattern[] {
  const patterns: LearnedPattern[] = [];

  for (const override of overrides) {
    const normalised = normaliseDescription(override.match_description);
    const words = normalised
      .split(/\s+/)
      .filter((w) => w.length >= MIN_WORD_LEN && !STOP_WORDS.has(w));

    if (words.length === 0) continue;

    patterns.push({
      keywords: words,
      category: override.category,
      isEssential: override.is_essential,
      direction: override.direction,
    });
  }

  // Sort by keyword count descending — more specific patterns match first
  patterns.sort((a, b) => b.keywords.length - a.keywords.length);

  return patterns;
}

/**
 * Match a transaction description against learned patterns.
 * ALL keywords in a pattern must appear in the normalised description.
 * Returns the most specific (most keywords) matching pattern.
 */
export function matchLearnedPattern(
  _description: string,
  normalisedDescription: string,
  patterns: LearnedPattern[],
  amount?: number,
): { category: string; isEssential: boolean } | null {
  for (const pattern of patterns) {
    // Direction filter
    if (pattern.direction === 'credit' && amount !== undefined && amount <= 0) continue;
    if (pattern.direction === 'debit' && amount !== undefined && amount > 0) continue;

    // All keywords must be present
    const allMatch = pattern.keywords.every((kw) => normalisedDescription.includes(kw));
    if (allMatch) {
      return { category: pattern.category, isEssential: pattern.isEssential };
    }
  }

  return null;
}
