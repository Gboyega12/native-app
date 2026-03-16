import { describe, it, expect } from '@jest/globals';
import {
  matchMerchant,
  fuzzyMatchMerchant,
  isPersonTransfer,
  matchesSalaryKeywords,
  matchesEmployerPattern,
  matchesBenefitKeywords,
  isLikelyIncomeCredit,
  extractCreditCardBrand,
} from '../lib/merchant-db.js';

// ─── matchMerchant ──────────────────────────────────────────────────────────

describe('matchMerchant', () => {
  it('matches a known merchant (case-insensitive)', () => {
    const result = matchMerchant('TESCO STORES 1234');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Tesco');
    expect(result!.category).toBe('Groceries');
    expect(result!.isEssential).toBe(true);
  });

  it('returns null for an unknown description', () => {
    expect(matchMerchant('some random shop xyz')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(matchMerchant('')).toBeNull();
  });

  it('matches subscription merchants and sets isSubscription', () => {
    const result = matchMerchant('Netflix monthly payment');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Netflix');
    expect(result!.category).toBe('Streaming');
    expect(result!.isSubscription).toBe(true);
    expect(result!.isEssential).toBe(false);
  });

  it('matches BNPL merchants and sets isBNPL', () => {
    const result = matchMerchant('KLARNA PAYMENT');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Klarna');
    expect(result!.isBNPL).toBe(true);
  });

  it('matches debt merchants and sets isDebt', () => {
    const result = matchMerchant('BARCLAYCARD REPAYMENT');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Barclaycard');
    expect(result!.isDebt).toBe(true);
    expect(result!.isEssential).toBe(true);
  });

  it('matches income entries and sets isIncome', () => {
    const result = matchMerchant('SALARY CREDIT FROM EMPLOYER');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Salary');
    expect(result!.isIncome).toBe(true);
  });

  it('prefers the longest matching pattern (tesco credit > tesco)', () => {
    const result = matchMerchant('TESCO CREDIT CARD PAYMENT');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Tesco Bank');
    expect(result!.category).toBe('Debt Payments');
    expect(result!.isDebt).toBe(true);
  });

  it('prefers the longest pattern (student loan > loan)', () => {
    const result = matchMerchant('STUDENT LOAN COMPANY SLC');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Student Loan');
    expect(result!.category).toBe('Debt Payments');
  });

  it('uses normalisedDescription as fallback', () => {
    const result = matchMerchant('CARD PAYMENT 12345', 'deliveroo');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Deliveroo');
  });

  it('short patterns use word-boundary matching (bp does not match "ebook purchase")', () => {
    expect(matchMerchant('ebook purchase')).toBeNull();
  });

  it('short patterns match when used as a whole word', () => {
    const result = matchMerchant('BP PETROL STATION');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('BP');
  });

  it('ee does not match "coffee shop"', () => {
    // "ee" is a 2-char pattern that should word-boundary match only
    const result = matchMerchant('coffee shop');
    // Should not match EE
    if (result !== null) {
      expect(result.merchant).not.toBe('EE');
    }
  });

  it('matches with leading/trailing whitespace', () => {
    const result = matchMerchant('  netflix  ');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Netflix');
  });

  it('handles special characters in patterns (m&s)', () => {
    const result = matchMerchant('M&S FOOD HALL');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('M&S');
    expect(result!.category).toBe('Groceries');
  });

  it('defaults boolean flags to false when not set on entry', () => {
    const result = matchMerchant('DELIVEROO ORDER');
    expect(result).not.toBeNull();
    expect(result!.isEssential).toBe(false);
    expect(result!.isSubscription).toBe(false);
    expect(result!.isBNPL).toBe(false);
    expect(result!.isDebt).toBe(false);
    expect(result!.isIncome).toBe(false);
  });
});

// ─── fuzzyMatchMerchant ─────────────────────────────────────────────────────

describe('fuzzyMatchMerchant', () => {
  it('matches a misspelled merchant name', () => {
    const result = fuzzyMatchMerchant('DELIVERRO ORDER');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Deliveroo');
  });

  it('returns null for a completely unrelated string', () => {
    expect(fuzzyMatchMerchant('xyz random gibberish nothing')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(fuzzyMatchMerchant('')).toBeNull();
  });

  it('skips patterns shorter than 4 characters', () => {
    // "kfc" is 3 chars, fuzzy should skip it
    // A slight misspelling like "kfx" should NOT fuzzy-match
    const result = fuzzyMatchMerchant('kfx meal deal');
    if (result !== null) {
      expect(result.merchant).not.toBe('KFC');
    }
  });

  it('matches with minor typo in longer pattern', () => {
    const result = fuzzyMatchMerchant('STARBUKCS COFFEE');
    expect(result).not.toBeNull();
    // Should match Starbucks (via "starbucks" pattern — close enough)
  });

  it('uses normalisedDescription as fallback for fuzzy', () => {
    const result = fuzzyMatchMerchant('CARD PMT 99887', 'netflixx');
    expect(result).not.toBeNull();
    expect(result!.merchant).toBe('Netflix');
  });

  it('does not match when similarity is below 0.75 threshold', () => {
    // "abcdefgh" vs "deliveroo" — very different
    const result = fuzzyMatchMerchant('abcdefgh');
    expect(result).toBeNull();
  });

  it('matches patterns with correct boolean flags', () => {
    const result = fuzzyMatchMerchant('NETFLIIX');
    expect(result).not.toBeNull();
    expect(result!.isSubscription).toBe(true);
    expect(result!.isEssential).toBe(false);
  });
});

// ─── isPersonTransfer ───────────────────────────────────────────────────────

describe('isPersonTransfer', () => {
  it('detects "Mr" prefix as person transfer', () => {
    expect(isPersonTransfer('MR JOHN SMITH')).toBe(true);
  });

  it('detects "Mrs" prefix as person transfer', () => {
    expect(isPersonTransfer('Mrs Jane Doe')).toBe(true);
  });

  it('detects "Dr" prefix as person transfer', () => {
    expect(isPersonTransfer('Dr Ahmad Patel')).toBe(true);
  });

  it('detects "faster payment" keyword', () => {
    expect(isPersonTransfer('FASTER PAYMENT RECEIVED')).toBe(true);
  });

  it('detects "bank transfer" keyword', () => {
    expect(isPersonTransfer('BANK TRANSFER FROM ACCOUNT')).toBe(true);
  });

  it('detects "transfer to" keyword', () => {
    expect(isPersonTransfer('TRANSFER TO SAVINGS')).toBe(true);
  });

  it('detects standing order to non-company', () => {
    expect(isPersonTransfer('STANDING ORDER ALICE JONES')).toBe(true);
  });

  it('does NOT treat standing order to a company as person transfer', () => {
    expect(isPersonTransfer('STANDING ORDER BRITISH GAS DIRECT')).toBe(false);
  });

  it('detects 2-word alphabetic names after cleaning', () => {
    expect(isPersonTransfer('JOHN SMITH')).toBe(true);
  });

  it('detects 3-word alphabetic names', () => {
    expect(isPersonTransfer('SARAH JANE WILLIAMS')).toBe(true);
  });

  it('rejects single-word descriptions (too ambiguous)', () => {
    expect(isPersonTransfer('ALDI')).toBe(false);
  });

  it('rejects descriptions with company indicators (ltd)', () => {
    expect(isPersonTransfer('ACME LTD')).toBe(false);
  });

  it('rejects descriptions with .com in them', () => {
    expect(isPersonTransfer('amazon.com purchase')).toBe(false);
  });

  it('rejects descriptions containing digits', () => {
    expect(isPersonTransfer('REF123 JOHN SMITH')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isPersonTransfer('')).toBe(false);
  });

  it('handles bank prefix codes before a person name', () => {
    // "FPO-" prefix should be stripped, leaving "MARIA GONZALEZ"
    expect(isPersonTransfer('FPO- MARIA GONZALEZ')).toBe(true);
  });

  it('strips trailing reference numbers before checking', () => {
    // After stripping trailing ref, should detect "ALICE BROWN"
    expect(isPersonTransfer('ALICE BROWN REF 98765')).toBe(true);
  });
});

// ─── matchesSalaryKeywords ──────────────────────────────────────────────────

describe('matchesSalaryKeywords', () => {
  it('matches "salary" keyword', () => {
    expect(matchesSalaryKeywords('MONTHLY SALARY')).toBe(true);
  });

  it('matches "wages" keyword', () => {
    expect(matchesSalaryKeywords('WAGES PAYMENT')).toBe(true);
  });

  it('matches "payroll" keyword', () => {
    expect(matchesSalaryKeywords('PAYROLL CREDIT')).toBe(true);
  });

  it('matches "pension" keyword', () => {
    expect(matchesSalaryKeywords('STATE PENSION PAYMENT')).toBe(true);
  });

  it('matches "net pay" keyword', () => {
    expect(matchesSalaryKeywords('NET PAY FROM EMPLOYER')).toBe(true);
  });

  it('matches "commission" keyword', () => {
    expect(matchesSalaryKeywords('COMMISSION PAYOUT')).toBe(true);
  });

  it('does NOT match unrelated description', () => {
    expect(matchesSalaryKeywords('TESCO GROCERIES')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(matchesSalaryKeywords('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(matchesSalaryKeywords('Salary Credit')).toBe(true);
  });
});

// ─── matchesEmployerPattern ─────────────────────────────────────────────────

describe('matchesEmployerPattern', () => {
  it('matches "ltd" as employer indicator', () => {
    expect(matchesEmployerPattern('ACME LTD')).toBe(true);
  });

  it('matches "plc" as employer indicator', () => {
    expect(matchesEmployerPattern('BARCLAYS PLC')).toBe(true);
  });

  it('matches "limited" as employer indicator', () => {
    expect(matchesEmployerPattern('WIDGETS LIMITED')).toBe(true);
  });

  it('matches "council" as employer indicator', () => {
    expect(matchesEmployerPattern('BIRMINGHAM COUNCIL')).toBe(true);
  });

  it('matches "nhs" as employer indicator', () => {
    expect(matchesEmployerPattern('NHS TRUST PAYMENT')).toBe(true);
  });

  it('matches "university" as employer indicator', () => {
    expect(matchesEmployerPattern('UNIVERSITY OF OXFORD')).toBe(true);
  });

  it('matches "holdings" as employer indicator', () => {
    expect(matchesEmployerPattern('MEGA HOLDINGS GROUP')).toBe(true);
  });

  it('does NOT match a plain person name', () => {
    expect(matchesEmployerPattern('JOHN SMITH')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(matchesEmployerPattern('')).toBe(false);
  });
});

// ─── matchesBenefitKeywords ─────────────────────────────────────────────────

describe('matchesBenefitKeywords', () => {
  it('matches "hmrc"', () => {
    expect(matchesBenefitKeywords('HMRC TAX REBATE')).toBe(true);
  });

  it('matches "dwp"', () => {
    expect(matchesBenefitKeywords('DWP PAYMENT')).toBe(true);
  });

  it('matches "universal credit"', () => {
    expect(matchesBenefitKeywords('UNIVERSAL CREDIT PAYMENT')).toBe(true);
  });

  it('matches "child benefit"', () => {
    expect(matchesBenefitKeywords('CHILD BENEFIT PAYMENT')).toBe(true);
  });

  it('matches "jobseekers" (with optional s)', () => {
    expect(matchesBenefitKeywords('JOBSEEKERS ALLOWANCE')).toBe(true);
    expect(matchesBenefitKeywords('JOBSEEKER ALLOWANCE')).toBe(true);
  });

  it('matches "pip" (personal independence payment)', () => {
    expect(matchesBenefitKeywords('PIP PAYMENT')).toBe(true);
  });

  it('matches "state pension"', () => {
    expect(matchesBenefitKeywords('STATE PENSION')).toBe(true);
  });

  it('matches "disability"', () => {
    expect(matchesBenefitKeywords('DISABILITY BENEFIT')).toBe(true);
  });

  it('does NOT match unrelated description', () => {
    expect(matchesBenefitKeywords('NETFLIX SUBSCRIPTION')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(matchesBenefitKeywords('')).toBe(false);
  });
});

// ─── isLikelyIncomeCredit ───────────────────────────────────────────────────

describe('isLikelyIncomeCredit', () => {
  it('returns true for salary keywords', () => {
    expect(isLikelyIncomeCredit('MONTHLY SALARY')).toBe(true);
  });

  it('returns true for employer patterns', () => {
    expect(isLikelyIncomeCredit('ACME LTD')).toBe(true);
  });

  it('returns true for benefit keywords', () => {
    expect(isLikelyIncomeCredit('HMRC TAX CREDIT')).toBe(true);
  });

  it('returns false when none match', () => {
    expect(isLikelyIncomeCredit('TESCO GROCERIES')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isLikelyIncomeCredit('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isLikelyIncomeCredit('wages from employer')).toBe(true);
  });

  it('matches compound descriptions with multiple signals', () => {
    expect(isLikelyIncomeCredit('PAYROLL FROM ACME LTD')).toBe(true);
  });
});

// ─── extractCreditCardBrand ─────────────────────────────────────────────────

describe('extractCreditCardBrand', () => {
  it('extracts Amex / American Express', () => {
    expect(extractCreditCardBrand('My Amex Card')).toBe('American Express');
    expect(extractCreditCardBrand('American Express Gold')).toBe('American Express');
  });

  it('extracts Barclaycard', () => {
    expect(extractCreditCardBrand('Barclaycard Visa')).toBe('Barclaycard');
  });

  it('extracts MBNA', () => {
    expect(extractCreditCardBrand('MBNA Credit Card')).toBe('MBNA');
  });

  it('extracts Capital One', () => {
    expect(extractCreditCardBrand("John's Capital One Card")).toBe('Capital One');
  });

  it('extracts Vanquis', () => {
    expect(extractCreditCardBrand('Vanquis Visa')).toBe('Vanquis');
  });

  it('extracts HSBC', () => {
    expect(extractCreditCardBrand('HSBC Credit Card')).toBe('HSBC');
  });

  it('extracts Monzo', () => {
    expect(extractCreditCardBrand('Monzo Current Account')).toBe('Monzo');
  });

  it('extracts Starling', () => {
    expect(extractCreditCardBrand('Starling Bank Card')).toBe('Starling');
  });

  it('extracts Revolut', () => {
    expect(extractCreditCardBrand('Revolut GBP')).toBe('Revolut');
  });

  it('extracts Chase', () => {
    expect(extractCreditCardBrand('Chase Current Account')).toBe('Chase');
  });

  it('returns null for unknown account name', () => {
    expect(extractCreditCardBrand('My Random Bank')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractCreditCardBrand('')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(extractCreditCardBrand('hsbc visa')).toBe('HSBC');
  });

  it('extracts Aqua from various patterns', () => {
    expect(extractCreditCardBrand('Aqua Card')).toBe('Aqua');
    expect(extractCreditCardBrand('Aqua Credit')).toBe('Aqua');
  });
});
