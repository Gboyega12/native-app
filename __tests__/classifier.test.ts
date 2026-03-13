/**
 * Tests for lib/classifier.ts
 *
 * Verifies the three-layer classification pipeline:
 *   1. Merchant-DB match (high confidence)
 *   2. Keyword detection (high confidence)
 *   3. Default fallback (low confidence)
 */

import { describe, it, expect } from '@jest/globals';
import { classifyTransaction } from '../lib/classifier.js';

// ── Helper: build a MerchantMatch object with sensible defaults ──

function makeMerchantMatch(overrides: Partial<{
  merchant: string;
  category: string;
  isEssential: boolean;
  isSubscription: boolean;
  isBNPL: boolean;
  isDebt: boolean;
  isIncome: boolean;
}> = {}) {
  return {
    merchant: 'Test Merchant',
    category: 'Groceries',
    isEssential: true,
    isSubscription: false,
    isBNPL: false,
    isDebt: false,
    isIncome: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// Layer 1: Merchant-DB match
// ═══════════════════════════════════════════════════════════════

describe('Layer 1 – Merchant-DB match', () => {
  it('returns merchant category and isEssential with high confidence', () => {
    const match = makeMerchantMatch({ category: 'Groceries', isEssential: true });
    const result = classifyTransaction('TESCO STORES 1234', match);

    expect(result).toEqual({
      category: 'Groceries',
      isEssential: true,
      confidence: 'high',
      source: 'merchant_db',
    });
  });

  it('returns non-essential merchant match correctly', () => {
    const match = makeMerchantMatch({ category: 'Streaming', isEssential: false });
    const result = classifyTransaction('NETFLIX.COM', match);

    expect(result).toEqual({
      category: 'Streaming',
      isEssential: false,
      confidence: 'high',
      source: 'merchant_db',
    });
  });

  it('merchant match takes priority over keyword match', () => {
    // Description contains "rent" but merchant match should win
    const match = makeMerchantMatch({ category: 'Transfers', isEssential: false });
    const result = classifyTransaction('RENT PAYMENT TO LANDLORD', match);

    expect(result.source).toBe('merchant_db');
    expect(result.category).toBe('Transfers');
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 2: Keyword detection – Essential categories
// ═══════════════════════════════════════════════════════════════

describe('Layer 2 – Keyword detection (essential)', () => {
  it('classifies rent as essential', () => {
    const result = classifyTransaction('MONTHLY RENT PAYMENT', null);
    expect(result).toEqual({
      category: 'Rent',
      isEssential: true,
      confidence: 'high',
      source: 'keyword',
    });
  });

  it('classifies mortgage as essential', () => {
    const result = classifyTransaction('MORTGAGE DD PAYMENT', null);
    expect(result.category).toBe('Mortgage');
    expect(result.isEssential).toBe(true);
    expect(result.source).toBe('keyword');
  });

  it('classifies insurance as essential', () => {
    const result = classifyTransaction('HOME INSURANCE RENEWAL', null);
    expect(result.category).toBe('Insurance');
    expect(result.isEssential).toBe(true);
  });

  it('classifies childcare as essential', () => {
    const result = classifyTransaction('LITTLE STARS NURSERY', null);
    expect(result.category).toBe('Childcare');
    expect(result.isEssential).toBe(true);
  });

  it('classifies health/dental as essential', () => {
    const result = classifyTransaction('BUPA DENTAL CARE', null);
    expect(result.category).toBe('Health');
    expect(result.isEssential).toBe(true);
  });

  it('classifies council tax as essential', () => {
    const result = classifyTransaction('COUNCIL TAX DD', null);
    expect(result.category).toBe('Council Tax');
    expect(result.isEssential).toBe(true);
  });

  it('classifies energy as essential', () => {
    const result = classifyTransaction('BRITISH GAS ENERGY', null);
    expect(result.category).toBe('Energy');
    expect(result.isEssential).toBe(true);
  });

  it('classifies broadband as essential', () => {
    const result = classifyTransaction('BT BROADBAND', null);
    expect(result.category).toBe('Broadband & Phone');
    expect(result.isEssential).toBe(true);
  });

  it('classifies transport (DVLA) as essential', () => {
    const result = classifyTransaction('DVLA VEHICLE TAX', null);
    expect(result.category).toBe('Transport');
    expect(result.isEssential).toBe(true);
  });

  it('classifies education as essential', () => {
    const result = classifyTransaction('UNIVERSITY TUITION FEE', null);
    expect(result.category).toBe('Education');
    expect(result.isEssential).toBe(true);
  });

  it('classifies loan repayment as essential debt', () => {
    const result = classifyTransaction('LOAN REPAYMENT DD', null);
    expect(result.category).toBe('Debt Payments');
    expect(result.isEssential).toBe(true);
  });

  it('classifies credit card payment as essential debt', () => {
    const result = classifyTransaction('CREDIT CARD PAYMENT', null);
    expect(result.category).toBe('Debt Payments');
    expect(result.isEssential).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 2: Keyword detection – Discretionary categories
// ═══════════════════════════════════════════════════════════════

describe('Layer 2 – Keyword detection (discretionary)', () => {
  it('classifies restaurant as non-essential', () => {
    const result = classifyTransaction('THE ITALIAN RESTAURANT', null);
    expect(result.category).toBe('Eating Out');
    expect(result.isEssential).toBe(false);
    expect(result.source).toBe('keyword');
  });

  it('classifies coffee/cafe as non-essential', () => {
    const result = classifyTransaction('COSTA COFFEE SHOP', null);
    expect(result.category).toBe('Coffee & Cafes');
    expect(result.isEssential).toBe(false);
  });

  it('classifies cinema as non-essential entertainment', () => {
    const result = classifyTransaction('ODEON CINEMA', null);
    expect(result.category).toBe('Entertainment');
    expect(result.isEssential).toBe(false);
  });

  it('classifies gym as non-essential fitness', () => {
    const result = classifyTransaction('PURE GYM MEMBERSHIP', null);
    expect(result.category).toBe('Fitness');
    expect(result.isEssential).toBe(false);
  });

  it('classifies retail as non-essential shopping', () => {
    const result = classifyTransaction('ZARA FASHION OUTLET', null);
    expect(result.category).toBe('Shopping');
    expect(result.isEssential).toBe(false);
  });

  it('classifies betting as non-essential gambling', () => {
    const result = classifyTransaction('BET365', null);
    expect(result.category).toBe('Gambling');
    expect(result.isEssential).toBe(false);
  });

  it('classifies charity/donation as non-essential', () => {
    const result = classifyTransaction('OXFAM MONTHLY DONATION', null);
    expect(result.category).toBe('Charity');
    expect(result.isEssential).toBe(false);
  });

  it('classifies vet as non-essential pets', () => {
    const result = classifyTransaction('CITY VET PRACTICE', null);
    expect(result.category).toBe('Pets');
    expect(result.isEssential).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Layer 3: Default fallback
// ═══════════════════════════════════════════════════════════════

describe('Layer 3 – Default fallback', () => {
  it('returns Other with low confidence for unrecognised descriptions', () => {
    const result = classifyTransaction('XYZZY UNKNOWN MERCHANT 9999', null);
    expect(result).toEqual({
      category: 'Other',
      isEssential: false,
      confidence: 'low',
      source: 'default',
    });
  });

  it('returns default when description is empty', () => {
    const result = classifyTransaction('', null);
    expect(result.category).toBe('Other');
    expect(result.source).toBe('default');
  });
});

// ═══════════════════════════════════════════════════════════════
// normalisedDescription fallback
// ═══════════════════════════════════════════════════════════════

describe('normalisedDescription fallback', () => {
  it('matches keywords in normalisedDescription when raw description does not match', () => {
    // Raw description is garbled; normalised version has the keyword
    const result = classifyTransaction('DD REF 38291 ABCX', null, 'monthly rent');
    expect(result.category).toBe('Rent');
    expect(result.isEssential).toBe(true);
    expect(result.source).toBe('keyword');
  });

  it('still matches raw description first even when normalisedDescription is provided', () => {
    // Both have keywords; raw description matches first (rent before mortgage)
    const result = classifyTransaction('RENT PAYMENT', null, 'mortgage payment');
    expect(result.category).toBe('Rent');
  });

  it('ignores normalisedDescription when it equals lowercased description', () => {
    // Same value should not cause duplicate checking issues
    const result = classifyTransaction('RENT PAYMENT', null, 'rent payment');
    expect(result.category).toBe('Rent');
    expect(result.source).toBe('keyword');
  });

  it('falls through to default when neither description matches', () => {
    const result = classifyTransaction('RANDOM REF 999', null, 'unknown thing');
    expect(result.category).toBe('Other');
    expect(result.source).toBe('default');
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('is case-insensitive for keyword matching', () => {
    const result = classifyTransaction('MORTGAGE PAYMENT', null);
    expect(result.category).toBe('Mortgage');

    const result2 = classifyTransaction('mortgage payment', null);
    expect(result2.category).toBe('Mortgage');

    const result3 = classifyTransaction('Mortgage Payment', null);
    expect(result3.category).toBe('Mortgage');
  });

  it('matches word boundaries – "prevent" should not match "rent"', () => {
    const result = classifyTransaction('PREVENT FRAUD CHECK', null);
    // "rent" appears inside "prevent" but \brent\b should not match
    expect(result.category).toBe('Other');
    expect(result.source).toBe('default');
  });

  it('matches keywords embedded in longer descriptions', () => {
    const result = classifyTransaction('DIRECT DEBIT PAYMENT TO DENTIST REF 12345', null);
    expect(result.category).toBe('Health');
  });

  it('first matching keyword rule wins', () => {
    // "takeaway" appears in both Eating Out and Delivery rules;
    // Eating Out comes first in KEYWORD_RULES
    const result = classifyTransaction('KEBAB TAKEAWAY', null);
    expect(result.category).toBe('Eating Out');
  });

  it('handles descriptions with special characters', () => {
    const result = classifyTransaction('COFFEE!!! @SHOP #123', null);
    expect(result.category).toBe('Coffee & Cafes');
  });

  it('handles hire purchase as debt', () => {
    const result = classifyTransaction('HIRE PURCHASE AGREEMENT', null);
    expect(result.category).toBe('Debt Payments');
    expect(result.isEssential).toBe(true);
  });
});
