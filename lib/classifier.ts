// ── Transaction Classifier ──
// Pluggable classification function. Determines category + essentiality
// for a spending transaction.
//
// Pipeline:
//   1. Merchant-DB match → category + isEssential (high confidence)
//   2. Keyword detection  → category + isEssential (high confidence)
//   3. No match           → 'Other', isEssential false (low confidence)
//
// This is the seam where a tree model / SLM can slot in later.

import type { MerchantMatch } from './merchant-db';

export interface ClassificationResult {
  category: string;
  isEssential: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** Which layer produced this result */
  source: 'merchant_db' | 'keyword' | 'default';
}

interface KeywordRule {
  patterns: RegExp[];
  category: string;
  isEssential: boolean;
}

// ── Layer 2: Keyword-based essential detection ──
// Catches essential spending that the merchant-DB misses.
// Ordered by specificity — more specific patterns first to avoid false positives.

const KEYWORD_RULES: KeywordRule[] = [
  // Housing
  { patterns: [/\brent\b/, /\btenancy\b/, /\bopenrent\b/, /\bgoodlord\b/, /\bground\s*rent\b/, /\bservice\s*charge\b/],
    category: 'Rent', isEssential: true },
  { patterns: [/\bmortgage\b/],
    category: 'Mortgage', isEssential: true },

  // Insurance
  { patterns: [/\binsurance\b/, /\binsure\b/, /\bunderwrit/],
    category: 'Insurance', isEssential: true },

  // Childcare
  { patterns: [/\bchildcare\b/, /\bnursery\b/, /\bchildminder\b/, /\bafter\s*school\s*club\b/, /\bbreakfast\s*club\b/],
    category: 'Childcare', isEssential: true },

  // Health & Medical
  { patterns: [/\bdentist\b/, /\bdental\b/, /\boptician\b/, /\bphysio\b/, /\bclinic\b/, /\bprescription\b/, /\bhospital\b/],
    category: 'Health', isEssential: true },

  // Utilities (catch-all for descriptions that didn't match merchant DB)
  { patterns: [/\bcouncil\s*tax\b/],
    category: 'Council Tax', isEssential: true },
  { patterns: [/\bwater\s*bill\b/, /\bsewerage\b/],
    category: 'Water', isEssential: true },
  { patterns: [/\benergy\s*bill\b/, /\belectricity\b/, /\bgas\s*bill\b/],
    category: 'Energy', isEssential: true },
  { patterns: [/\bbroadband\b/, /\binternet\b/, /\bfibre\b/, /\bwifi\b/],
    category: 'Broadband & Phone', isEssential: true },

  // Transport essentials
  { patterns: [/\bcar\s*tax\b/, /\bvehicle\s*tax\b/, /\bdvla\b/, /\bmot\b/, /\bparking\s*permit\b/],
    category: 'Transport', isEssential: true },

  // Education
  { patterns: [/\bschool\s*fee\b/, /\btuition\b/, /\buniversity\b/, /\bcollege\b/],
    category: 'Education', isEssential: true },
];

/**
 * Classify a spending transaction.
 *
 * @param description  Raw bank description
 * @param merchantMatch  Result from matchMerchant(), if any
 * @returns Classification with category, essentiality, confidence, and source layer
 */
export function classifyTransaction(
  description: string,
  merchantMatch: MerchantMatch | null,
): ClassificationResult {
  // ── Layer 1: Merchant-DB match ──
  if (merchantMatch) {
    return {
      category: merchantMatch.category,
      isEssential: merchantMatch.isEssential,
      confidence: 'high',
      source: 'merchant_db',
    };
  }

  // ── Layer 2: Keyword detection ──
  const lower = description.toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.some((rx) => rx.test(lower))) {
      return {
        category: rule.category,
        isEssential: rule.isEssential,
        confidence: 'high',
        source: 'keyword',
      };
    }
  }

  // ── Layer 3: Default ──
  return {
    category: 'Other',
    isEssential: false,
    confidence: 'low',
    source: 'default',
  };
}
