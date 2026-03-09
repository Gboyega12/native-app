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
  { patterns: [/\benergy\s*bill\b/, /\belectricity\b/, /\bgas\s*bill\b/, /\benergy\b/],
    category: 'Energy', isEssential: true },
  { patterns: [/\bbroadband\b/, /\binternet\b/, /\bfibre\b/, /\bwifi\b/],
    category: 'Broadband & Phone', isEssential: true },

  // Transport essentials
  { patterns: [/\bcar\s*tax\b/, /\bvehicle\s*tax\b/, /\bdvla\b/, /\bmot\b/, /\bparking\s*permit\b/],
    category: 'Transport', isEssential: true },

  // Education
  { patterns: [/\bschool\s*fee\b/, /\btuition\b/, /\buniversity\b/, /\bcollege\b/],
    category: 'Education', isEssential: true },

  // Debt / Finance
  { patterns: [/\bhire\s*purchase\b/, /\bhp\s*payment\b/, /\bfinance\s*payment\b/, /\bfinance\s*agreement\b/, /\bcar\s*loan\b/, /\bvehicle\s*finance\b/],
    category: 'Debt Payments', isEssential: true },
  { patterns: [/\bcredit\s*card\s*payment\b/, /\bcc\s*payment\b/, /\bcard\s*repayment\b/, /\bminimum\s*payment\b/],
    category: 'Debt Payments', isEssential: true },
  { patterns: [/\bloan\s*repayment\b/, /\bdebt\s*repayment\b/, /\boverpayment\b/, /\bconsolidation\b/],
    category: 'Debt Payments', isEssential: true },

  // ── Discretionary keyword rules ──
  // Catches common spending that the merchant DB doesn't cover.

  // Eating Out / Restaurants / Street food
  { patterns: [/\brestaurant\b/, /\bbistro\b/, /\bbrasserie\b/, /\bpizzeria\b/, /\bchippy\b/, /\bfish\s*(?:&|and)\s*chips?\b/, /\btakeaway\b/, /\btake\s*away\b/, /\bgrill\b/, /\bkebab\b/, /\bchicken\s*shop\b/, /\bfried\s*chicken\b/, /\bstreet\s*food\b/, /\bfood\s*truck\b/, /\bburger\b/, /\bpizza\b/, /\bsushi\b/, /\bnoodle\b/, /\bcurry\s*house\b/, /\bindian\s*(?:restaurant|kitchen)\b/, /\bchinese\s*(?:restaurant|kitchen)\b/, /\bthai\s*(?:restaurant|kitchen)\b/],
    category: 'Eating Out', isEssential: false },

  // Coffee & Cafes
  { patterns: [/\bcafe\b/, /\bcaf[eé]\b/, /\bcoffee\b/, /\bespresso\b/, /\bbakery\b/, /\bpatisserie\b/],
    category: 'Coffee & Cafes', isEssential: false },

  // Entertainment
  { patterns: [/\bcinema\b/, /\bmovie\b/, /\btheatre\b/, /\btheater\b/, /\bconcert\b/, /\bgig\b/, /\bbowling\b/, /\barcade\b/, /\bmuseum\b/, /\bgallery\b/, /\bfestival\b/, /\bticket(?:s)?\b/],
    category: 'Entertainment', isEssential: false },

  // Fitness / Gym
  { patterns: [/\bgym\b/, /\bfitness\b/, /\byoga\b/, /\bpilates\b/, /\bcrossfit\b/, /\bswimming\s*pool\b/, /\bsports?\s*centre\b/, /\bleisure\s*centre\b/],
    category: 'Fitness', isEssential: false },

  // Personal Care
  { patterns: [/\bhairdress\w*\b/, /\bbarber\b/, /\bhaircut\b/, /\bsalon\b/, /\bbeauty\b/, /\bspa\b/, /\bnails?\b/, /\bmassage\b/, /\btattoo\b/, /\bwax(?:ing)?\b/],
    category: 'Personal Care', isEssential: false },

  // Shopping (catch-all for retail descriptions)
  { patterns: [/\boutlet\b/, /\bretail\b/, /\bfashion\b/, /\bclothing\b/, /\bjeweller\w*\b/, /\bwatches\b/, /\bgadget\b/, /\belectronics\b/, /\bflorist\b/, /\bflower\s*shop\b/, /\bflowers?\b/, /\bbouquet\b/, /\bgift\s*shop\b/, /\bcard\s*shop\b/, /\btoy\s*shop\b/, /\bbook\s*shop\b/, /\bbookstore\b/],
    category: 'Shopping', isEssential: false },

  // Delivery
  { patterns: [/\bdelivery\b/, /\btakeaway\s*order\b/, /\bonline\s*order\b/, /\bparcel\b/, /\bcourier\b/, /\bdpd\b/, /\bhermes\b/, /\bevri\b/, /\broyal\s*mail\b/, /\byodel\b/],
    category: 'Delivery', isEssential: false },

  // Gambling (discretionary, worth flagging)
  { patterns: [/\bbet365\b/, /\bpaddy\s*power\b/, /\bladbrokes\b/, /\bwilliam\s*hill\b/, /\bbetfred\b/, /\bcoral\b/, /\bskybet\b/, /\bbetting\b/, /\bcasino\b/, /\blottery\b/, /\blotto\b/, /\bgambl/],
    category: 'Gambling', isEssential: false },

  // Subscriptions / memberships (generic)
  { patterns: [/\bsubscription\b/, /\bmembership\b/, /\bmonthly\s*fee\b/, /\bannual\s*fee\b/],
    category: 'Subscriptions', isEssential: false },

  // International transfers
  { patterns: [/\binternational\s*transfer\b/, /\binternational\s*payment\b/, /\bforeign\s*transfer\b/, /\bremittance\b/, /\bmoney\s*transfer\b/],
    category: 'Transfers', isEssential: false },

  // Charity (discretionary but worth categorising)
  { patterns: [/\bcharity\b/, /\bdonat\w+\b/, /\bcancer\s*research\b/, /\boxfam\b/, /\bred\s*cross\b/, /\bsave\s*the\s*children\b/, /\bbhf\b/, /\bmacmillan\b/],
    category: 'Charity', isEssential: false },

  // Pets
  { patterns: [/\bvet\b/, /\bveterinar\w*\b/, /\bpets?\s*at\s*home\b/, /\bpet\s*shop\b/, /\bkennel\b/],
    category: 'Pets', isEssential: false },
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
  normalisedDescription?: string,
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
  // Try both raw and normalised descriptions for maximum coverage.
  const candidates = [description.toLowerCase()];
  if (normalisedDescription && normalisedDescription !== candidates[0]) {
    candidates.push(normalisedDescription);
  }

  for (const text of candidates) {
    for (const rule of KEYWORD_RULES) {
      if (rule.patterns.some((rx) => rx.test(text))) {
        return {
          category: rule.category,
          isEssential: rule.isEssential,
          confidence: 'high',
          source: 'keyword',
        };
      }
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
