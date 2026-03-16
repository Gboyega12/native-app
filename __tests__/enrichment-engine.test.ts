/**
 * Tests for the EnrichmentEngine — the core financial analysis engine.
 *
 * Covers:
 * 1. CSV parsing (date formats, quoted fields, edge cases)
 * 2. Transaction enrichment (merchant matching, overrides, unknown merchants)
 * 3. Full enrich() pipeline with realistic multi-transaction CSV
 * 4. Enrichment metrics calculation
 * 5. Decision score calculation
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import EnrichmentEngine from '../lib/enrichment-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a date string that is guaranteed to be within the 1-year parseCSV window. */
function recentDate(monthsAgo: number = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(Math.min(d.getDate(), 28)).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Shorthand to build a CSV string from rows using recent dates. */
function buildCSV(
  rows: Array<{ date?: string; description: string; amount: number }>,
): string {
  const header = 'date,description,amount';
  const lines = rows.map((r) => {
    const date = r.date ?? recentDate(0);
    return `${date},${r.description},${r.amount}`;
  });
  return [header, ...lines].join('\n');
}

/**
 * Build the realistic sample CSV from the spec, but with recent dates.
 * Convention: positive amounts = credits (income), negative = debits (spending).
 * The engine uses `tx.amount > 0` to identify credits.
 */
function buildSampleCSV(): string {
  return buildCSV([
    { date: recentDate(2), description: 'SALARY DEPOSIT', amount: 2500.0 },
    { date: recentDate(2), description: 'TESCO STORES', amount: -45.5 },
    { date: recentDate(2), description: 'NETFLIX', amount: -12.99 },
    { date: recentDate(2), description: 'TFL TRAVEL', amount: -35.0 },
    { date: recentDate(2), description: 'DELIVEROO', amount: -18.5 },
    { date: recentDate(2), description: 'RENT PAYMENT', amount: -850.0 },
    { date: recentDate(2), description: 'UBER', amount: -22.0 },
    { date: recentDate(2), description: 'GREGGS', amount: -4.5 },
    { date: recentDate(2), description: 'COUNCIL TAX', amount: -125.0 },
    { date: recentDate(2), description: 'AMAZON MARKETPLACE', amount: -67.99 },
    { date: recentDate(1), description: 'SALARY DEPOSIT', amount: 2500.0 },
    { date: recentDate(1), description: 'TESCO STORES', amount: -52.3 },
    { date: recentDate(1), description: 'NETFLIX', amount: -12.99 },
    { date: recentDate(1), description: 'STARBUCKS', amount: -5.8 },
    { date: recentDate(1), description: 'VODAFONE', amount: -35.0 },
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CSV PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine.parseCSV', () => {
  it('parses YYYY-MM-DD date format', () => {
    const csv = `date,description,amount\n${recentDate(0)},TESCO,10.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('TESCO');
    expect(result[0].amount).toBe(10);
  });

  it('parses DD/MM/YYYY date format', () => {
    const now = new Date();
    const dd = String(Math.min(now.getDate(), 28)).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;
    const csv = `date,description,amount\n${dateStr},SAINSBURYS,15.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('SAINSBURYS');
    expect(result[0].amount).toBe(15);
  });

  it('parses "15 Jan 2025"-style named date format', () => {
    // Use a recent date in named format
    const now = new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dateStr = `${Math.min(now.getDate(), 28)} ${months[now.getMonth()]} ${now.getFullYear()}`;
    const csv = `date,description,amount\n${dateStr},ASDA,20.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('ASDA');
  });

  it('handles quoted fields containing commas', () => {
    const csv = `date,description,amount\n${recentDate(0)},"TESCO STORES, LONDON",25.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('TESCO STORES, LONDON');
    expect(result[0].amount).toBe(25);
  });

  it('returns empty array for header-only CSV', () => {
    const csv = 'date,description,amount';
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    const result = EnrichmentEngine.parseCSV('');
    expect(result).toHaveLength(0);
  });

  it('skips rows with empty descriptions', () => {
    const csv = `date,description,amount\n${recentDate(0)},,50.00\n${recentDate(0)},LIDL,30.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('LIDL');
  });

  it('skips rows with zero amount', () => {
    const csv = `date,description,amount\n${recentDate(0)},TESCO,0.00\n${recentDate(0)},LIDL,12.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('LIDL');
  });

  it('skips rows with dates older than 1 year', () => {
    const csv = `date,description,amount\n2020-01-01,OLD TRANSACTION,50.00\n${recentDate(0)},RECENT,10.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('RECENT');
  });

  it('handles negative amounts as credits', () => {
    const csv = `date,description,amount\n${recentDate(0)},SALARY DEPOSIT,-2500.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(-2500);
  });

  it('handles debit/credit split columns', () => {
    const csv = `date,description,debit,credit\n${recentDate(0)},TESCO,45.50,\n${recentDate(0)},SALARY,,2500.00`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(2);
    // Debit should become negative amount (spending)
    const tesco = result.find((t) => t.description === 'TESCO');
    const salary = result.find((t) => t.description === 'SALARY');
    expect(tesco).toBeDefined();
    expect(salary).toBeDefined();
    // debit col → -amount, credit col → +amount
    expect(tesco!.amount).toBeLessThan(0);
    expect(salary!.amount).toBeGreaterThan(0);
  });

  it('parses multiple transactions correctly', () => {
    const csv = buildCSV([
      { description: 'TESCO', amount: 45.5 },
      { description: 'NETFLIX', amount: 12.99 },
      { description: 'SALARY', amount: -3000 },
    ]);
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(3);
  });

  it('recognises alternative header names (narrative, memo, value)', () => {
    const csv = `date,narrative,value\n${recentDate(0)},TESCO STORES,45.50`;
    const result = EnrichmentEngine.parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('TESCO STORES');
    expect(result[0].amount).toBe(45.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TRANSACTION ENRICHMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine.enrichTransaction', () => {
  it('enriches a known grocery merchant (TESCO)', () => {
    const tx = { date: recentDate(0), description: 'TESCO STORES', amount: -45.5 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.merchant).toBeDefined();
    expect(enriched.category).not.toBe('Other');
    expect(enriched.confidence).toBe('high');
    expect(enriched.classifiedBy).toBe('merchant_db');
  });

  it('enriches a known subscription merchant (NETFLIX)', () => {
    const tx = { date: recentDate(0), description: 'NETFLIX', amount: -12.99 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.isSubscription).toBe(true);
    expect(enriched.confidence).toBe('high');
  });

  it('enriches a salary deposit as income', () => {
    const tx = { date: recentDate(0), description: 'SALARY DEPOSIT', amount: 2500 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.isIncome).toBe(true);
    expect(enriched.category).toBe('Income');
  });

  it('enriches a known transport merchant (TFL)', () => {
    const tx = { date: recentDate(0), description: 'TFL TRAVEL', amount: -35 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.category).toMatch(/Transport/i);
  });

  it('enriches a delivery service (DELIVEROO)', () => {
    const tx = { date: recentDate(0), description: 'DELIVEROO', amount: -18.5 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.confidence).not.toBe('low');
    // Deliveroo should be recognized as a known merchant
    expect(['merchant_db', 'fuzzy_match', 'keyword']).toContain(enriched.classifiedBy);
  });

  it('assigns low confidence to unknown merchants', () => {
    const tx = { date: recentDate(0), description: 'XYZZY OBSCURE SHOP 12345', amount: -10 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.confidence).toBe('low');
  });

  it('applies user overrides with highest priority', () => {
    const tx = { date: recentDate(0), description: 'TESCO STORES', amount: -45 };
    const overrides = [
      { match_description: 'TESCO', category: 'Household Essentials', is_essential: true },
    ];
    const enriched = EnrichmentEngine.enrichTransaction(tx, overrides);
    expect(enriched.category).toBe('Household Essentials');
    expect(enriched.isEssential).toBe(true);
    expect(enriched.classifiedBy).toBe('user_override');
    expect(enriched.confidence).toBe('high');
  });

  it('override with direction=credit only matches credits', () => {
    const debitTx = { date: recentDate(0), description: 'REFUND FROM TESCO', amount: -20 };
    const creditTx = { date: recentDate(0), description: 'REFUND FROM TESCO', amount: 20 };
    const overrides = [
      { match_description: 'REFUND FROM TESCO', category: 'Refund', is_essential: false, direction: 'credit' as const },
    ];
    const enrichedDebit = EnrichmentEngine.enrichTransaction(debitTx, overrides);
    const enrichedCredit = EnrichmentEngine.enrichTransaction(creditTx, overrides);
    // The debit should NOT match because the override is credit-only
    expect(enrichedDebit.classifiedBy).not.toBe('user_override');
    // The credit should match
    expect(enrichedCredit.classifiedBy).toBe('user_override');
    expect(enrichedCredit.category).toBe('Refund');
  });

  it('marks refunds correctly', () => {
    const tx = { date: recentDate(0), description: 'REFUND AMAZON', amount: 25 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.isRefund).toBe(true);
  });

  it('preserves original date, description, and amount', () => {
    const tx = { date: recentDate(0), description: 'ALDI SUPERMARKET', amount: -30 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.date).toBe(tx.date);
    expect(enriched.description).toBe(tx.description);
    expect(enriched.amount).toBe(tx.amount);
  });

  it('sets all required boolean flags', () => {
    const tx = { date: recentDate(0), description: 'TESCO', amount: -20 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(typeof enriched.isEssential).toBe('boolean');
    expect(typeof enriched.isSubscription).toBe('boolean');
    expect(typeof enriched.isBNPL).toBe('boolean');
    expect(typeof enriched.isDebt).toBe('boolean');
    expect(typeof enriched.isIncome).toBe('boolean');
    expect(typeof enriched.isTransfer).toBe('boolean');
    expect(typeof enriched.isRefund).toBe('boolean');
    expect(typeof enriched.isSavings).toBe('boolean');
  });

  it('enriches UBER as transport', () => {
    const tx = { date: recentDate(0), description: 'UBER', amount: -22 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.category).toMatch(/Transport|Delivery/i);
    expect(enriched.confidence).not.toBe('low');
  });

  it('does not mark spending as income', () => {
    const tx = { date: recentDate(0), description: 'GREGGS', amount: -4.5 };
    const enriched = EnrichmentEngine.enrichTransaction(tx);
    expect(enriched.isIncome).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. FULL enrich() PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine.enrich (full pipeline)', () => {
  let result: ReturnType<typeof EnrichmentEngine.enrich>;

  beforeAll(() => {
    result = EnrichmentEngine.enrich(buildSampleCSV());
  });

  it('returns an EnrichmentResult with all required top-level keys', () => {
    expect(result).toHaveProperty('profile');
    expect(result).toHaveProperty('archetype');
    expect(result).toHaveProperty('traits');
    expect(result).toHaveProperty('strengths');
    expect(result).toHaveProperty('blindSpots');
    expect(result).toHaveProperty('decisionScore');
    expect(result).toHaveProperty('decisionStack');
    expect(result).toHaveProperty('behavioralPatterns');
    expect(result).toHaveProperty('enrichedTransactions');
    expect(result).toHaveProperty('enrichmentMetrics');
  });

  it('enriches all 15 transactions from the sample CSV', () => {
    expect(result.enrichedTransactions).toHaveLength(15);
  });

  it('identifies salary deposits as income', () => {
    const salaries = result.enrichedTransactions.filter((t) => t.isIncome);
    // At least the two SALARY DEPOSIT rows (amount > 0 means credit in enriched form)
    expect(salaries.length).toBeGreaterThanOrEqual(2);
  });

  it('detects recurring transactions (TESCO, NETFLIX appear twice)', () => {
    const recurring = result.profile.subscriptions;
    // NETFLIX should appear as a recurring subscription
    const netflix = recurring?.find((r) =>
      r.merchant.toLowerCase().includes('netflix'),
    );
    expect(netflix).toBeDefined();
    expect(netflix!.isSubscription).toBe(true);
  });

  it('profile has positive monthly income', () => {
    expect(result.profile.monthly.income).toBeGreaterThan(0);
  });

  it('profile has positive monthly spending', () => {
    expect(result.profile.monthly.spending).toBeGreaterThan(0);
  });

  it('archetype has required fields', () => {
    expect(result.archetype).toHaveProperty('key');
    expect(result.archetype).toHaveProperty('name');
    expect(result.archetype).toHaveProperty('emoji');
    expect(result.archetype).toHaveProperty('color');
    expect(result.archetype).toHaveProperty('description');
    expect(typeof result.archetype.key).toBe('string');
    expect(typeof result.archetype.name).toBe('string');
  });

  it('decision score is within 0-100 range', () => {
    expect(result.decisionScore.score).toBeGreaterThanOrEqual(0);
    expect(result.decisionScore.score).toBeLessThanOrEqual(100);
  });

  it('decision score has a valid verdict', () => {
    expect(['Strong', 'Balanced', 'Needs Attention', 'At Risk']).toContain(
      result.decisionScore.verdict,
    );
  });

  it('decision score has breakdown factors', () => {
    expect(Array.isArray(result.decisionScore.breakdown)).toBe(true);
    expect(result.decisionScore.breakdown.length).toBeGreaterThan(0);
    for (const item of result.decisionScore.breakdown) {
      expect(item).toHaveProperty('factor');
      expect(item).toHaveProperty('impact');
      expect(typeof item.factor).toBe('string');
      expect(typeof item.impact).toBe('number');
    }
  });

  it('budgetReality splits into discretionary and non-discretionary', () => {
    const br = result.profile.budgetReality;
    expect(br).toHaveProperty('nonDiscretionary');
    expect(br).toHaveProperty('discretionary');
    expect(br.nonDiscretionary).toHaveProperty('total');
    expect(br.nonDiscretionary).toHaveProperty('items');
    expect(br.discretionary).toHaveProperty('total');
    expect(br.discretionary).toHaveProperty('items');
  });

  it('enrichment metrics total matches transaction count', () => {
    const m = result.enrichmentMetrics;
    expect(m.totalTransactions).toBe(15);
    expect(m.highConfidence + m.mediumConfidence + m.lowConfidence).toBe(15);
  });

  it('no enriched transaction has undefined category', () => {
    for (const tx of result.enrichedTransactions) {
      expect(tx.category).toBeDefined();
      expect(typeof tx.category).toBe('string');
      expect(tx.category.length).toBeGreaterThan(0);
    }
  });

  it('no enriched transaction has undefined confidence', () => {
    for (const tx of result.enrichedTransactions) {
      expect(['high', 'medium', 'low']).toContain(tx.confidence);
    }
  });

  it('accepts overrides and applies them in full pipeline', () => {
    const overrides = [
      { match_description: 'GREGGS', category: 'Treats', is_essential: false },
    ];
    const resultWithOverrides = EnrichmentEngine.enrich(buildSampleCSV(), overrides);
    const greggs = resultWithOverrides.enrichedTransactions.find(
      (t) => t.description === 'GREGGS',
    );
    expect(greggs).toBeDefined();
    expect(greggs!.category).toBe('Treats');
    expect(greggs!.classifiedBy).toBe('user_override');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ENRICHMENT METRICS
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine._computeEnrichmentMetrics', () => {
  it('correctly counts confidence levels', () => {
    const enriched = [
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Groceries' },
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Subscriptions' },
      { confidence: 'medium', classifiedBy: 'fuzzy_match', category: 'Shopping' },
      { confidence: 'low', classifiedBy: 'default', category: 'Other' },
    ] as any;

    const metrics = EnrichmentEngine._computeEnrichmentMetrics(enriched);
    expect(metrics.totalTransactions).toBe(4);
    expect(metrics.highConfidence).toBe(2);
    expect(metrics.mediumConfidence).toBe(1);
    expect(metrics.lowConfidence).toBe(1);
  });

  it('calculates otherRate as percentage', () => {
    const enriched = [
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Groceries' },
      { confidence: 'low', classifiedBy: 'default', category: 'Other' },
      { confidence: 'low', classifiedBy: 'default', category: 'Other' },
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Transport' },
    ] as any;

    const metrics = EnrichmentEngine._computeEnrichmentMetrics(enriched);
    expect(metrics.otherRate).toBe(50); // 2 out of 4 = 50%
  });

  it('counts sources correctly (bySource)', () => {
    const enriched = [
      { confidence: 'high', classifiedBy: 'user_override', category: 'Groceries' },
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Groceries' },
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Transport' },
      { confidence: 'medium', classifiedBy: 'fuzzy_match', category: 'Shopping' },
      { confidence: 'high', classifiedBy: 'keyword', category: 'Income' },
      { confidence: 'low', classifiedBy: 'default', category: 'Other' },
      { confidence: 'low', category: 'Other' }, // no classifiedBy → unresolved
    ] as any;

    const metrics = EnrichmentEngine._computeEnrichmentMetrics(enriched);
    expect(metrics.bySource.userOverride).toBe(1);
    expect(metrics.bySource.merchantDb).toBe(2);
    expect(metrics.bySource.fuzzyMatch).toBe(1);
    expect(metrics.bySource.keyword).toBe(1);
    expect(metrics.bySource.unresolved).toBe(2);
  });

  it('handles empty transaction list', () => {
    const metrics = EnrichmentEngine._computeEnrichmentMetrics([]);
    expect(metrics.totalTransactions).toBe(0);
    expect(metrics.highConfidence).toBe(0);
    expect(metrics.mediumConfidence).toBe(0);
    expect(metrics.lowConfidence).toBe(0);
    expect(metrics.otherRate).toBe(0);
    expect(metrics.bySource.userOverride).toBe(0);
    expect(metrics.bySource.merchantDb).toBe(0);
    expect(metrics.bySource.fuzzyMatch).toBe(0);
    expect(metrics.bySource.keyword).toBe(0);
    expect(metrics.bySource.unresolved).toBe(0);
  });

  it('otherRate is 0 when no transactions are categorised as Other', () => {
    const enriched = [
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Groceries' },
      { confidence: 'high', classifiedBy: 'merchant_db', category: 'Transport' },
    ] as any;
    const metrics = EnrichmentEngine._computeEnrichmentMetrics(enriched);
    expect(metrics.otherRate).toBe(0);
  });

  it('otherRate is 100 when all transactions are Other', () => {
    const enriched = [
      { confidence: 'low', classifiedBy: 'default', category: 'Other' },
      { confidence: 'low', classifiedBy: 'default', category: 'Other' },
    ] as any;
    const metrics = EnrichmentEngine._computeEnrichmentMetrics(enriched);
    expect(metrics.otherRate).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. DECISION SCORE
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine.calcDecisionScore', () => {
  it('returns Strong verdict for a healthy financial profile', () => {
    const profile = {
      monthly: {
        income: 3000,
        spending: 1500,
        surplus: 1500,
        subscriptions: 20,
        foodDelivery: 10,
        transport: 50,
        groceries: 200,
        shopping: 50,
        eatingOut: 30,
        entertainment: 20,
        debtPayments: 0,
        incomeFloor: 3000,
        isVariableIncome: false,
        incomeCV: 0,
      },
      budgetReality: { nonDiscretionary: { total: 800, items: [] }, discretionary: { total: 700, items: [] } },
      incomeSources: [{ source: 'SALARY', frequency: 'monthly', avgAmount: 3000, monthly: 3000, isSalary: true, count: 3, avgInterval: 30, recentAmounts: [3000], amountSD: 0, variability: 0 }],
      transfers: [],
      subscriptions: [],
      metrics: {
        savingsRate: 50, // Very high savings
        creditCardCount: 0,
        bnplCount: 0,
        debtAccountCount: 0,
        subscriptionCount: 2,
        streamingCount: 1,
        foodDelivery: 10,
        transport: 50,
        groceries: 200,
        shopping: 50,
        eatingOut: 30,
        coffeeAndCafes: 5,
        entertainment: 20,
        debtPayments: 0,
      },
    } as any;

    const score = EnrichmentEngine.calcDecisionScore(profile);
    expect(score.score).toBeGreaterThanOrEqual(75);
    expect(score.verdict).toBe('Strong');
  });

  it('returns At Risk for a struggling profile', () => {
    const profile = {
      monthly: {
        income: 1500,
        spending: 1800,
        surplus: -300,
        subscriptions: 100,
        foodDelivery: 120,
        transport: 80,
        groceries: 200,
        shopping: 150,
        eatingOut: 150,
        entertainment: 60,
        debtPayments: 200,
        incomeFloor: 1500,
        isVariableIncome: false,
        incomeCV: 0,
      },
      budgetReality: { nonDiscretionary: { total: 600, items: [] }, discretionary: { total: 1200, items: [] } },
      incomeSources: [],
      transfers: [],
      subscriptions: [],
      metrics: {
        savingsRate: -20,
        creditCardCount: 2,
        bnplCount: 3,
        debtAccountCount: 4,
        subscriptionCount: 10,
        streamingCount: 4,
        foodDelivery: 120,
        transport: 80,
        groceries: 200,
        shopping: 150,
        eatingOut: 150,
        coffeeAndCafes: 30,
        entertainment: 60,
        debtPayments: 200,
      },
    } as any;

    const score = EnrichmentEngine.calcDecisionScore(profile);
    expect(score.score).toBeLessThanOrEqual(35);
    expect(score.verdict).toBe('At Risk');
  });

  it('score is always between 0 and 100', () => {
    // Build extreme profiles and verify clamping
    const extremeGood = {
      monthly: { income: 10000, spending: 1000, surplus: 9000, subscriptions: 0, foodDelivery: 0, transport: 0, groceries: 0, shopping: 0, eatingOut: 0, entertainment: 0, debtPayments: 0, incomeFloor: 10000, isVariableIncome: false, incomeCV: 0 },
      budgetReality: { nonDiscretionary: { total: 0, items: [] }, discretionary: { total: 0, items: [] } },
      incomeSources: [{ source: 'SALARY', isSalary: true, count: 12, avgAmount: 10000, monthly: 10000, frequency: 'monthly', avgInterval: 30, recentAmounts: [], amountSD: 0, variability: 0 }],
      transfers: [],
      subscriptions: [],
      metrics: { savingsRate: 90, creditCardCount: 0, bnplCount: 0, debtAccountCount: 0, subscriptionCount: 0, streamingCount: 0, foodDelivery: 0, transport: 0, groceries: 0, shopping: 0, eatingOut: 0, coffeeAndCafes: 0, entertainment: 0, debtPayments: 0 },
    } as any;

    const extremeBad = {
      monthly: { income: 500, spending: 2000, surplus: -1500, subscriptions: 300, foodDelivery: 200, transport: 100, groceries: 100, shopping: 200, eatingOut: 200, entertainment: 100, debtPayments: 500, incomeFloor: 500, isVariableIncome: false, incomeCV: 0 },
      budgetReality: { nonDiscretionary: { total: 0, items: [] }, discretionary: { total: 0, items: [] } },
      incomeSources: [],
      transfers: [],
      subscriptions: [],
      metrics: { savingsRate: -200, creditCardCount: 5, bnplCount: 5, debtAccountCount: 5, subscriptionCount: 15, streamingCount: 6, foodDelivery: 200, transport: 100, groceries: 100, shopping: 200, eatingOut: 200, coffeeAndCafes: 50, entertainment: 100, debtPayments: 500 },
    } as any;

    const goodScore = EnrichmentEngine.calcDecisionScore(extremeGood);
    const badScore = EnrichmentEngine.calcDecisionScore(extremeBad);

    expect(goodScore.score).toBeGreaterThanOrEqual(0);
    expect(goodScore.score).toBeLessThanOrEqual(100);
    expect(badScore.score).toBeGreaterThanOrEqual(0);
    expect(badScore.score).toBeLessThanOrEqual(100);
  });

  it('breakdown items all have factor and impact', () => {
    const profile = {
      monthly: { income: 2000, spending: 1000, surplus: 1000, subscriptions: 50, foodDelivery: 30, transport: 50, groceries: 200, shopping: 50, eatingOut: 30, entertainment: 20, debtPayments: 0, incomeFloor: 2000, isVariableIncome: false, incomeCV: 0 },
      budgetReality: { nonDiscretionary: { total: 500, items: [] }, discretionary: { total: 500, items: [] } },
      incomeSources: [{ source: 'SALARY', isSalary: true, count: 3, avgAmount: 2000, monthly: 2000, frequency: 'monthly', avgInterval: 30, recentAmounts: [], amountSD: 0, variability: 0 }],
      transfers: [],
      subscriptions: [],
      metrics: { savingsRate: 50, creditCardCount: 0, bnplCount: 0, debtAccountCount: 0, subscriptionCount: 2, streamingCount: 1, foodDelivery: 30, transport: 50, groceries: 200, shopping: 50, eatingOut: 30, coffeeAndCafes: 5, entertainment: 20, debtPayments: 0 },
    } as any;

    const score = EnrichmentEngine.calcDecisionScore(profile);
    for (const item of score.breakdown) {
      expect(typeof item.factor).toBe('string');
      expect(typeof item.impact).toBe('number');
      expect(item.factor.length).toBeGreaterThan(0);
    }
  });

  it('stable salary adds positive impact', () => {
    const withSalary = {
      monthly: { income: 2000, spending: 1500, surplus: 500, subscriptions: 50, foodDelivery: 30, transport: 50, groceries: 200, shopping: 50, eatingOut: 30, entertainment: 20, debtPayments: 0, incomeFloor: 2000, isVariableIncome: false, incomeCV: 0 },
      budgetReality: { nonDiscretionary: { total: 800, items: [] }, discretionary: { total: 700, items: [] } },
      incomeSources: [{ source: 'SALARY', isSalary: true, count: 3, avgAmount: 2000, monthly: 2000, frequency: 'monthly', avgInterval: 30, recentAmounts: [], amountSD: 0, variability: 0 }],
      transfers: [],
      subscriptions: [],
      metrics: { savingsRate: 25, creditCardCount: 0, bnplCount: 0, debtAccountCount: 0, subscriptionCount: 2, streamingCount: 1, foodDelivery: 30, transport: 50, groceries: 200, shopping: 50, eatingOut: 30, coffeeAndCafes: 5, entertainment: 20, debtPayments: 0 },
    } as any;

    const withoutSalary = {
      ...withSalary,
      incomeSources: [],
    };

    const scoreWith = EnrichmentEngine.calcDecisionScore(withSalary);
    const scoreWithout = EnrichmentEngine.calcDecisionScore(withoutSalary);
    expect(scoreWith.score).toBeGreaterThan(scoreWithout.score);

    const salaryFactor = scoreWith.breakdown.find((b) => b.factor === 'Stable salary');
    expect(salaryFactor).toBeDefined();
    expect(salaryFactor!.impact).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. RECURRING DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine.detectRecurring', () => {
  it('detects monthly recurring transactions', () => {
    const txs = [
      { date: recentDate(3), description: 'NETFLIX', amount: -12.99, merchant: 'Netflix', category: 'Subscriptions', isEssential: false, isSubscription: true, isBNPL: false, isDebt: false, isIncome: false, isTransfer: false, isRefund: false, isSavings: false, confidence: 'high' as const, classifiedBy: 'merchant_db' as const },
      { date: recentDate(2), description: 'NETFLIX', amount: -12.99, merchant: 'Netflix', category: 'Subscriptions', isEssential: false, isSubscription: true, isBNPL: false, isDebt: false, isIncome: false, isTransfer: false, isRefund: false, isSavings: false, confidence: 'high' as const, classifiedBy: 'merchant_db' as const },
      { date: recentDate(1), description: 'NETFLIX', amount: -12.99, merchant: 'Netflix', category: 'Subscriptions', isEssential: false, isSubscription: true, isBNPL: false, isDebt: false, isIncome: false, isTransfer: false, isRefund: false, isSavings: false, confidence: 'high' as const, classifiedBy: 'merchant_db' as const },
    ];

    const recurring = EnrichmentEngine.detectRecurring(txs);
    const netflix = recurring.find((r) => r.merchant === 'Netflix');
    expect(netflix).toBeDefined();
    expect(netflix!.frequency).toBe('monthly');
    expect(netflix!.isSubscription).toBe(true);
    expect(netflix!.averageAmount).toBeCloseTo(12.99, 1);
  });

  it('excludes income transactions from recurring detection', () => {
    const txs = [
      { date: recentDate(2), description: 'SALARY', amount: 2500, merchant: 'SALARY', category: 'Income', isEssential: false, isSubscription: false, isBNPL: false, isDebt: false, isIncome: true, isTransfer: false, isRefund: false, isSavings: false, confidence: 'high' as const, classifiedBy: 'keyword' as const },
      { date: recentDate(1), description: 'SALARY', amount: 2500, merchant: 'SALARY', category: 'Income', isEssential: false, isSubscription: false, isBNPL: false, isDebt: false, isIncome: true, isTransfer: false, isRefund: false, isSavings: false, confidence: 'high' as const, classifiedBy: 'keyword' as const },
    ];

    const recurring = EnrichmentEngine.detectRecurring(txs);
    const salary = recurring.find((r) => r.merchant === 'SALARY');
    expect(salary).toBeUndefined();
  });

  it('returns empty array for no transactions', () => {
    const recurring = EnrichmentEngine.detectRecurring([]);
    expect(recurring).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. REBUILD
// ═══════════════════════════════════════════════════════════════════════════

describe('EnrichmentEngine.rebuild', () => {
  it('rebuilds profile from pre-enriched transactions', () => {
    // First enrich normally
    const original = EnrichmentEngine.enrich(buildSampleCSV());
    // Then rebuild from the enriched transactions
    const rebuilt = EnrichmentEngine.rebuild(original.enrichedTransactions);

    expect(rebuilt).toHaveProperty('profile');
    expect(rebuilt).toHaveProperty('archetype');
    expect(rebuilt).toHaveProperty('decisionScore');
    expect(rebuilt).toHaveProperty('enrichedTransactions');
    expect(rebuilt).toHaveProperty('enrichmentMetrics');

    // Same transactions should produce same metrics
    expect(rebuilt.enrichmentMetrics.totalTransactions).toBe(
      original.enrichmentMetrics.totalTransactions,
    );
  });
});
