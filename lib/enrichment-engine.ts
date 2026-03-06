import {
  matchMerchant, fuzzyMatchMerchant, isPersonTransfer,
  isLikelyIncomeCredit, matchesSalaryKeywords,
} from './merchant-db';
import { classifyTransaction } from './classifier';
import { normaliseDescription } from './normalise';
import { ARCHETYPES, SUB_TRAITS, STRENGTH_RULES, BLINDSPOT_RULES } from './archetypes';
import { UK_BENCHMARKS, MOVE_THRESHOLDS, INCOME_THRESHOLDS, ANALYSIS_MONTHS } from './constants';
import type {
  RawTransaction,
  EnrichedTransaction,
  RecurringItem,
  FinancialProfile,
  Archetype,
  DecisionScore,
  Move,
  EnrichmentResult,
  EnrichmentMetrics,
  BudgetCategory,
  EssentialGap,
  VerifiedBill,
} from './types';

function splitCSVLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

function parseDate(str: string): Date | null {
  if (!str) return null;
  const s = str.trim().replace(/"/g, '');

  // DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);

  // YYYY-MM-DD
  const ymd = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);

  // "15 Jan 2025" style
  const named = new Date(s);
  return isNaN(named.getTime()) ? null : named;
}

export type TransactionOverride = {
  match_description: string;
  category: string;
  is_essential: boolean;
};

const EnrichmentEngine = {
  enrich(rawCSV: string, overrides?: TransactionOverride[], debtAccounts?: any[], identity?: any): EnrichmentResult {
    const transactions = this.parseCSV(rawCSV);
    const enriched = transactions.map((tx) => this.enrichTransaction(tx, overrides));

    // Reclassify credit card payoffs for full-payers.
    // Users who use credit cards for points and pay off in full each month
    // should not have those payoffs counted as "Debt Payments" — they are
    // internal transfers between the user's own accounts.
    this._reclassifyCreditCardPayoffs(enriched, debtAccounts);

    const recurring = this.detectRecurring(enriched);
    const profile = this.buildProfile(enriched, recurring);
    const archetype = this.determineArchetype(profile);
    const patterns = this.detectBehavioralPatterns(profile);
    const score = this.calcDecisionScore(profile);
    const stack = this.genDecisionStack(profile, enriched, debtAccounts, identity);

    const metrics = profile.metrics;
    const traits = Object.values(SUB_TRAITS).filter((t) => t.test(metrics, profile));
    const strengths = STRENGTH_RULES.filter((r) => r.test(metrics));
    const blindSpots = BLINDSPOT_RULES.filter((r) => r.test(metrics));
    const enrichmentMetrics = this._computeEnrichmentMetrics(enriched);

    // Verify bills from recognized merchants (exact amounts from transaction data)
    const verifiedBills = this.verifyBillsFromTransactions(enriched);

    // Detect essential gaps if identity is available — verified bills reduce false gaps
    const essentialGaps = identity
      ? this.detectEssentialGaps(profile, identity, debtAccounts, undefined, verifiedBills)
      : undefined;

    return {
      profile,
      archetype,
      traits: traits.map((t) => ({ name: t.name, insight: t.insight })) as any,
      strengths: strengths.map((s) => ({ label: s.label, detail: s.detail })) as any,
      blindSpots: blindSpots.map((b) => ({ label: b.label, detail: b.detail })) as any,
      decisionScore: score,
      decisionStack: stack,
      behavioralPatterns: patterns.map((p: any) => p.pattern || p),
      enrichedTransactions: enriched,
      enrichmentMetrics,
      essentialGaps,
      verifiedBills: verifiedBills.length > 0 ? verifiedBills : undefined,
    };
  },

  parseCSV(raw: string): RawTransaction[] {
    const lines = raw.trim().split('\n');
    if (lines.length < 2) return [];

    const header = lines[0].toLowerCase();
    const cols = header.split(',').map((c) => c.trim());
    const dateIdx = cols.findIndex((c) => c.includes('date'));
    const descIdx = cols.findIndex((c) =>
      c.includes('desc') || c.includes('narr') || c.includes('memo')
      || c.includes('reference') || c.includes('detail') || c.includes('particular')
    );
    const amountIdx = cols.findIndex((c) =>
      c === 'amount' || c.includes('amount') || c === 'value'
    );
    const debitIdx = cols.findIndex((c) =>
      c.includes('debit') || c.includes('money out') || c.includes('paid out')
    );
    const creditIdx = cols.findIndex((c) =>
      c.includes('credit') || c.includes('money in') || c.includes('paid in')
    );

    // Validate that we found at least a date and description column.
    // Without these, positional fallback is unreliable and may misalign data.
    const hasDateCol = dateIdx >= 0;
    const hasDescCol = descIdx >= 0;
    const hasAmountCol = amountIdx >= 0 || (debitIdx >= 0 && creditIdx >= 0);

    if (!hasDateCol && !hasDescCol && !hasAmountCol) {
      console.warn('[enrichment] CSV header not recognised. Columns found:', cols.join(', '));
      console.warn('[enrichment] Expected columns containing: date, description/narrative/memo, amount/debit/credit');
      return [];
    }
    if (!hasDateCol || !hasDescCol) {
      console.warn(`[enrichment] Missing critical columns — date:${hasDateCol}, desc:${hasDescCol}, amount:${hasAmountCol}. Header: ${cols.join(', ')}`);
    }

    const transactions: RawTransaction[] = [];
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = splitCSVLine(line);
      const dateStr = parts[dateIdx >= 0 ? dateIdx : 0] || '';
      const desc = parts[descIdx >= 0 ? descIdx : 1] || '';
      const date = parseDate(dateStr);
      if (!date || date < cutoff) continue;

      let amount = 0;
      if (debitIdx >= 0 && creditIdx >= 0) {
        const debit = parseFloat((parts[debitIdx] || '').replace(/[^0-9.\-]/g, '')) || 0;
        const credit = parseFloat((parts[creditIdx] || '').replace(/[^0-9.\-]/g, '')) || 0;
        amount = credit > 0 ? credit : -debit;
      } else {
        amount = parseFloat((parts[amountIdx >= 0 ? amountIdx : 2] || '').replace(/[^0-9.\-]/g, '')) || 0;
      }

      if (desc && amount !== 0) {
        transactions.push({ date: date.toISOString(), description: desc.trim(), amount });
      }
    }
    return transactions;
  },

  enrichTransaction(tx: RawTransaction, overrides?: TransactionOverride[]): EnrichedTransaction {
    // Check user overrides first — try both raw and normalised descriptions
    if (overrides?.length) {
      const descLower = tx.description.toLowerCase();
      const normDesc = normaliseDescription(tx.description);
      const override = overrides.find((o) => {
        const pattern = o.match_description.toLowerCase();
        return descLower.includes(pattern) || normDesc.includes(pattern);
      });
      if (override) {
        return {
          date: tx.date,
          description: tx.description,
          amount: tx.amount,
          merchant: tx.description,
          category: override.category,
          isEssential: override.is_essential,
          isSubscription: false,
          isBNPL: override.category === 'BNPL',
          isDebt: override.category === 'Debt Payments',
          isIncome: tx.amount > 0,
          isTransfer: false,
          isRefund: false,
          isSavings: override.category === 'Savings' || override.category === 'Investments',
          confidence: 'high' as const,
          classifiedBy: 'user_override' as const,
        };
      }
    }

    const normalised = normaliseDescription(tx.description);
    const merchantMatch = matchMerchant(tx.description, normalised);
    let isPerson = isPersonTransfer(tx.description);
    const isCredit = tx.amount > 0;
    const isRefund = isCredit && tx.description.toLowerCase().includes('refund');
    const isSavings = !!(tx.amount < 0 && tx.description.toLowerCase().match(/\bsaving|isa\b|premium bond|ns&i/i));
    const isInvestment = !!(tx.amount < 0 && !isSavings && tx.description.toLowerCase().match(/\binvest|pension|sipp|stocks?\s*(?:&|and)\s*shares?/i));

    // ── Income decision tree ──
    // Credit comes in → determine if it's real income or a person transfer
    //   1. Known merchant flagged as income (salary/HMRC/DWP) → income
    //   2. Matches salary/employer/benefit keywords → income
    //   3. Person name pattern (1-3 alpha words, no brand) → EXCLUDED (transfer)
    //   4. Refund → not income
    //   5. Other credit → tentative income (validated in buildProfile via regularity check)

    if (merchantMatch) {
      const isIncome = merchantMatch.isIncome || (isCredit && !isPerson && !isRefund && isLikelyIncomeCredit(tx.description));

      // Use the classifier for category + essentiality
      const classification = classifyTransaction(tx.description, merchantMatch);

      // Savings & Investments are both excluded from spending
      const catFromDb = isIncome ? merchantMatch.category : (isCredit && !merchantMatch.isIncome ? 'Refunds' : classification.category);
      const isSavingsOrInvest = isSavings || isInvestment || catFromDb === 'Savings' || catFromDb === 'Investments';

      return {
        ...tx,
        merchant: merchantMatch.merchant,
        category: catFromDb,
        isEssential: classification.isEssential,
        isSubscription: merchantMatch.isSubscription,
        isBNPL: merchantMatch.isBNPL,
        isDebt: merchantMatch.isDebt,
        isIncome,
        isTransfer: false, // Merchant DB match overrides person-name heuristic
        isRefund,
        isSavings: isSavingsOrInvest,
        confidence: 'high',
        classifiedBy: 'merchant_db' as const,
      };
    }

    // ── Fuzzy merchant matching fallback ──
    // Only for spending transactions (not credits) to avoid misclassifying income.
    // Uses Levenshtein distance to catch typos and merchant name variations.
    if (!isCredit) {
      const fuzzyMatch = fuzzyMatchMerchant(tx.description, normalised);
      if (fuzzyMatch) {
        const classification = classifyTransaction(tx.description, fuzzyMatch);
        const fuzzySavings = isSavings || isInvestment || classification.category === 'Savings' || classification.category === 'Investments';
        return {
          ...tx,
          merchant: fuzzyMatch.merchant,
          category: classification.category,
          isEssential: classification.isEssential,
          isSubscription: fuzzyMatch.isSubscription,
          isBNPL: fuzzyMatch.isBNPL,
          isDebt: fuzzyMatch.isDebt,
          isIncome: false,
          isTransfer: false,
          isRefund: false,
          isSavings: fuzzySavings,
          confidence: 'medium',
          classifiedBy: 'fuzzy_match' as const,
        };
      }
    }

    // No merchant match — classify via keyword fallback or default
    let isIncome = false;
    let category = 'Other';
    let isEssential = false;
    let confidence: EnrichedTransaction['confidence'] = 'low';
    let classifiedBy: EnrichedTransaction['classifiedBy'] = 'default';

    if (isCredit) {
      if (isRefund) {
        category = 'Refunds';
        classifiedBy = 'keyword';
      } else if (this._isCreditCardRepayment(tx.description)) {
        // Credit card repayment received — NOT income
        category = 'Debt Payments';
        isEssential = true;
        confidence = 'high';
        classifiedBy = 'keyword';
      } else if (isPerson) {
        category = 'Transfers';
        classifiedBy = 'keyword';
      } else if (this._isInternationalTransfer(tx.description)) {
        // Inbound international transfer — NOT income
        category = 'Transfers';
        classifiedBy = 'keyword';
      } else if (isLikelyIncomeCredit(tx.description)) {
        isIncome = true;
        category = 'Income';
        confidence = 'high';
        classifiedBy = 'keyword';
      } else {
        // Unknown credit — tentative income, validated in buildProfile
        isIncome = true;
        category = 'Income';
      }
    } else if (isSavings) {
      category = 'Savings';
      classifiedBy = 'keyword';
    } else if (isInvestment) {
      category = 'Investments';
      classifiedBy = 'keyword';
    } else {
      // Spending transaction with no merchant match — run keyword classifier
      // BEFORE person-transfer heuristic, so that descriptions like
      // "barbershop" or "restaurant" get categorised instead of being
      // misclassified as person transfers.
      const classification = classifyTransaction(tx.description, null, normalised);
      if (classification.source !== 'default') {
        // Keyword classifier matched — trust it over person-name heuristic
        category = classification.category;
        isEssential = classification.isEssential;
        confidence = classification.confidence;
        isPerson = false;
        classifiedBy = 'keyword';
      } else if (isPerson) {
        category = 'Transfers';
        classifiedBy = 'keyword';
      } else {
        category = classification.category;
        isEssential = classification.isEssential;
        confidence = classification.confidence;
      }
    }

    // Derive isBNPL / isDebt from the resolved category so that
    // reconcileDebtPayments() can match these transactions to manual debts
    // even when no merchant-DB entry exists.
    const detectedBNPL = category === 'BNPL';
    const detectedDebt = category === 'Debt Payments';

    return {
      ...tx,
      merchant: tx.description,
      category,
      isEssential,
      isSubscription: false,
      isBNPL: detectedBNPL,
      isDebt: detectedDebt,
      isIncome,
      isTransfer: isPerson,
      isRefund,
      isSavings,
      confidence,
      classifiedBy,
    };
  },

  detectRecurring(transactions: EnrichedTransaction[]): RecurringItem[] {
    const groups: Record<string, EnrichedTransaction[]> = {};
    for (const tx of transactions) {
      if (tx.isIncome || tx.isTransfer || tx.isRefund) continue;
      const key = tx.merchant || tx.description;
      if (!groups[key]) groups[key] = [];
      groups[key].push(tx);
    }

    const recurring: RecurringItem[] = [];
    for (const [merchant, txs] of Object.entries(groups)) {
      // Flag single transactions from known subscription merchants
      if (txs.length === 1 && txs[0].isSubscription) {
        recurring.push({
          merchant,
          frequency: 'monthly', // Assume monthly for known subscription merchants
          averageAmount: Math.abs(txs[0].amount),
          category: txs[0].category,
          isSubscription: true,
          count: 1,
        });
        continue;
      }

      if (txs.length < 2) continue;
      const sorted = txs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        intervals.push((new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / (1000 * 60 * 60 * 24));
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      let frequency: RecurringItem['frequency'] = 'irregular';
      if (avgInterval >= 5 && avgInterval <= 10) frequency = 'weekly';
      else if (avgInterval >= 25 && avgInterval <= 35) frequency = 'monthly';
      else if (avgInterval >= 80 && avgInterval <= 100) frequency = 'quarterly';
      else if (avgInterval >= 170 && avgInterval <= 200) frequency = 'semi_annual';
      else if (avgInterval >= 340 && avgInterval <= 400) frequency = 'annual';

      if (frequency !== 'irregular') {
        const avgAmount = Math.abs(txs.reduce((s, t) => s + t.amount, 0) / txs.length);
        // Only mark as subscription if already flagged by merchant DB, OR
        // recurring monthly/quarterly AND not a category that is clearly not a subscription.
        const NON_SUB_CATEGORIES = new Set([
          'Debt Payments', 'Groceries', 'Savings', 'Transfers', 'Transport',
          'Rent', 'Mortgage', 'Bills', 'Insurance', 'Income', 'Refunds',
          'Childcare', 'Education', 'Charity',
        ]);
        const firstTx = txs[0];
        const isSub = firstTx.isSubscription ||
          ((frequency === 'monthly' || frequency === 'quarterly') &&
           !NON_SUB_CATEGORIES.has(firstTx.category) &&
           !firstTx.isDebt && !firstTx.isSavings && !firstTx.isTransfer);
        recurring.push({
          merchant,
          frequency,
          averageAmount: avgAmount,
          category: txs[0].category,
          isSubscription: isSub,
          count: txs.length,
        });
      }
    }
    return recurring;
  },

  buildProfile(transactions: EnrichedTransaction[], recurring: RecurringItem[]): FinancialProfile {
    // Use only the most recent N months for income & spending calculations
    // so figures reflect the user's current financial picture (especially
    // important for weekly/fortnightly earners over long data windows).
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - ANALYSIS_MONTHS);
    const recent = transactions.filter((t) => new Date(t.date) >= cutoff);

    const spending = recent.filter((t) => t.amount < 0 && !t.isTransfer && !t.isRefund && !t.isSavings);
    const income = recent.filter((t) => t.isIncome && !t.isRefund && !t.isTransfer && !t.isDebt);

    const dates = recent.map((t) => new Date(t.date).getTime()).filter(Boolean);
    const span = dates.length >= 2
      ? (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24 * 30)
      : 1;
    const months = Math.max(span, 1);

    const totalIncome = income.reduce((s, t) => s + t.amount, 0);
    const totalSpending = Math.abs(spending.reduce((s, t) => s + t.amount, 0));
    const monthlyIncome = totalIncome / months;
    const monthlySpending = totalSpending / months;
    const surplus = monthlyIncome - monthlySpending;

    // Group spending by category for budget card display
    const catTotals: Record<string, { total: number; count: number; transactions: { date: string; merchant: string; description: string; amount: number }[] }> = {};
    for (const tx of spending) {
      const cat = tx.category || 'Other';
      if (!catTotals[cat]) catTotals[cat] = { total: 0, count: 0, transactions: [] };
      catTotals[cat].total += Math.abs(tx.amount);
      catTotals[cat].count++;
      catTotals[cat].transactions.push({
        date: tx.date,
        merchant: tx.merchant || tx.description,
        description: tx.description,
        amount: tx.amount,
      });
    }

    // ── Essential vs discretionary split ──
    // Uses per-transaction isEssential flag (description-first, category-fallback)
    // instead of the old flat ESSENTIAL_CATEGORIES set.
    const nonDiscItems: BudgetCategory[] = [];
    const discItems: BudgetCategory[] = [];

    for (const [cat, d] of Object.entries(catTotals)) {
      const sortedTxs = d.transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const item: BudgetCategory = { category: cat, monthly: d.total / months, txs: d.count, transactions: sortedTxs };

      // Determine essentiality from the transactions in this category.
      // If the majority of spend in this category is from essential transactions,
      // the whole category goes into non-discretionary.
      const catSpending = spending.filter((t) => (t.category || 'Other') === cat);
      const essentialSpend = catSpending.filter((t) => t.isEssential).reduce((s, t) => s + Math.abs(t.amount), 0);
      const totalCatSpend = catSpending.reduce((s, t) => s + Math.abs(t.amount), 0);
      const isEssentialCategory = totalCatSpend > 0 && (essentialSpend / totalCatSpend) > 0.5;

      if (isEssentialCategory) nonDiscItems.push(item);
      else discItems.push(item);
    }

    const nonDiscTotal = nonDiscItems.reduce((s, i) => s + i.monthly, 0);
    const discTotal = discItems.reduce((s, i) => s + i.monthly, 0);

    const incomeGroups: Record<string, EnrichedTransaction[]> = {};
    for (const tx of income) {
      const key = tx.merchant || tx.description;
      if (!incomeGroups[key]) incomeGroups[key] = [];
      incomeGroups[key].push(tx);
    }
    const incomeSources = Object.entries(incomeGroups).map(([source, txs]) => {
      const monthly = txs.reduce((s, t) => s + t.amount, 0) / months;
      const avgAmount = txs.reduce((s, t) => s + t.amount, 0) / txs.length;
      const isSalary = matchesSalaryKeywords(source);
      const sorted = txs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        intervals.push((new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / (1000 * 60 * 60 * 24));
      }
      const avgInt = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
      let frequency = 'irregular';
      if (avgInt >= 25 && avgInt <= 35) frequency = 'monthly';
      else if (avgInt >= 12 && avgInt <= 17) frequency = 'fortnightly';
      else if (avgInt >= 5 && avgInt <= 9) frequency = 'weekly';
      // Compute per-source variability from individual payment amounts
      const amounts = txs.map((t) => t.amount);
      const recentAmounts = sorted.slice(-8).map((t) => t.amount); // last 8 payments
      let amountSD = 0;
      let variability = 0;
      if (amounts.length >= 2) {
        const mean = avgAmount;
        const variance = amounts.reduce((s, a) => s + Math.pow(a - mean, 2), 0) / amounts.length;
        amountSD = Math.sqrt(variance);
        variability = mean > 0 ? amountSD / mean : 0;
      }
      return { source, frequency, avgAmount, monthly, isSalary, count: txs.length, avgInterval: avgInt, recentAmounts, amountSD, variability };
    })
    .filter((src) => {
      // Known salary/employer/benefit keywords → always income
      if (src.isSalary || isLikelyIncomeCredit(src.source)) return true;

      // Regular credits: require 3+ occurrences and minimum amount
      if (
        src.frequency !== 'irregular' &&
        src.avgAmount >= INCOME_THRESHOLDS.minRegularAmount &&
        src.count >= INCOME_THRESHOLDS.minRegularCount
      ) return true;

      // Large recurring credits: require 3+ with regular intervals
      if (
        src.avgAmount >= INCOME_THRESHOLDS.largeCreditMin &&
        src.count >= INCOME_THRESHOLDS.largeCreditMinCount &&
        src.avgInterval >= INCOME_THRESHOLDS.largeCreditIntervalMin &&
        src.avgInterval <= INCOME_THRESHOLDS.largeCreditIntervalMax
      ) return true;

      // One-off large credits below windfall threshold with only 1-2 occurrences
      // are NOT income (likely refunds, gifts, or one-off transfers)
      if (src.count <= 2 && src.avgAmount >= INCOME_THRESHOLDS.windfallMin) return false;

      return false;
    })
    .sort((a, b) => b.monthly - a.monthly);

    if (incomeSources.length > 0 && !incomeSources.some((s) => s.isSalary)) {
      incomeSources[0].isSalary = true;
    }

    const catMonthly = (name: string) => (catTotals[name]?.total || 0) / months;
    const subscriptions = recurring.filter((r) => r.isSubscription);
    const subMonthly = subscriptions.reduce((s, r) => s + r.averageAmount, 0);

    const metrics = {
      savingsRate: monthlyIncome > 0 ? (surplus / monthlyIncome) * 100 : 0,
      creditCardCount: spending.filter((t) => t.isDebt && t.merchant === 'Credit Card').length > 0 ? 1 : 0,
      bnplCount: spending.filter((t) => t.isBNPL).length,
      debtAccountCount: new Set(spending.filter((t) => t.isDebt).map((t) => t.merchant)).size,
      subscriptionCount: subscriptions.length,
      streamingCount: subscriptions.filter((r) =>
        ['Netflix', 'Spotify', 'Disney+', 'YouTube Premium', 'NOW TV', 'Crunchyroll', 'Audible', 'Apple Services'].includes(r.merchant)
      ).length,
      foodDelivery: catMonthly('Delivery'),
      transport: catMonthly('Transport'),
      groceries: catMonthly('Groceries'),
      shopping: catMonthly('Shopping'),
      eatingOut: catMonthly('Eating Out') + catMonthly('Coffee & Cafes'),
      coffeeAndCafes: catMonthly('Coffee & Cafes'),
      entertainment: catMonthly('Entertainment'),
      debtPayments: catMonthly('Debt Payments'),
    };

    // ── Income volatility: compute overall CV and conservative floor ──
    // Aggregate variability across all income sources, weighted by contribution.
    // For variable earners (CV > 10%), the budget should use a conservative
    // estimate (p25 ≈ mean - 0.67·SD) so the budget doesn't assume a good week.
    let overallIncomeCV = 0;
    let incomeFloor = monthlyIncome;
    const isVariableIncome = (() => {
      if (incomeSources.length === 0 || monthlyIncome <= 0) return false;
      // Weighted average CV across sources (weighted by monthly contribution)
      let weightedCV = 0;
      let totalWeight = 0;
      for (const src of incomeSources) {
        const w = Math.abs(src.monthly);
        weightedCV += (src.variability || 0) * w;
        totalWeight += w;
      }
      overallIncomeCV = totalWeight > 0 ? weightedCV / totalWeight : 0;
      // Variable if CV > 10% (salaried workers typically have < 5% variation)
      if (overallIncomeCV > 0.10) {
        // Conservative floor = mean - 0.67 * SD (≈ 25th percentile assuming normal)
        const incomeSD = overallIncomeCV * monthlyIncome;
        incomeFloor = Math.max(0, monthlyIncome - 0.67 * incomeSD);
        return true;
      }
      return false;
    })();

    return {
      monthly: {
        income: monthlyIncome,
        spending: monthlySpending,
        surplus,
        subscriptions: subMonthly,
        foodDelivery: metrics.foodDelivery,
        transport: metrics.transport,
        groceries: metrics.groceries,
        shopping: metrics.shopping,
        eatingOut: metrics.eatingOut,
        entertainment: metrics.entertainment,
        debtPayments: metrics.debtPayments,
        incomeFloor: Math.round(incomeFloor),
        isVariableIncome,
        incomeCV: Math.round(overallIncomeCV * 100) / 100,
      },
      budgetReality: {
        nonDiscretionary: { total: nonDiscTotal, items: nonDiscItems.sort((a, b) => b.monthly - a.monthly) },
        discretionary: { total: discTotal, items: discItems.sort((a, b) => b.monthly - a.monthly) },
      },
      incomeSources,
      subscriptions,
      metrics,
    };
  },

  determineArchetype(profile: FinancialProfile): Archetype {
    const m = profile.metrics;
    const ordered = [
      'debt_juggler', 'edge_walker', 'subscription_collector',
      'impulse_surfer', 'convenience_seeker', 'comfort_spender',
      'lifestyle_investor', 'side_hustler', 'quiet_builder',
      'balanced_realist',
    ];
    for (const key of ordered) {
      const arch = ARCHETYPES[key];
      if (arch.triggers(m, profile)) {
        return {
          key: arch.key,
          name: arch.name,
          emoji: arch.emoji,
          color: arch.color,
          description: arch.genPlaybook(profile),
          savingsOpportunity: '',
        };
      }
    }
    const fallback = ARCHETYPES.balanced_realist;
    return {
      key: fallback.key,
      name: fallback.name,
      emoji: fallback.emoji,
      color: fallback.color,
      description: fallback.genPlaybook(profile),
      savingsOpportunity: '',
    };
  },

  detectBehavioralPatterns(profile: FinancialProfile): { pattern: string; detail: string }[] {
    const patterns: { pattern: string; detail: string }[] = [];
    const m = profile.metrics;
    if (m.foodDelivery > UK_BENCHMARKS.foodDelivery) {
      patterns.push({
        pattern: 'High delivery spend',
        detail: `\u00a3${Math.round(m.foodDelivery)}/month vs UK average \u00a3${UK_BENCHMARKS.foodDelivery}.`,
      });
    }
    if (m.subscriptionCount > UK_BENCHMARKS.subscriptions.count) {
      patterns.push({
        pattern: 'Subscription overload',
        detail: `${m.subscriptionCount} active vs UK average ${UK_BENCHMARKS.subscriptions.count}.`,
      });
    }
    if (m.savingsRate < UK_BENCHMARKS.savingsRate) {
      patterns.push({
        pattern: 'Below-average savings rate',
        detail: `${Math.round(m.savingsRate)}% vs UK average ${UK_BENCHMARKS.savingsRate}%.`,
      });
    }
    if (m.eatingOut > 100) {
      patterns.push({
        pattern: 'Frequent dining out',
        detail: `\u00a3${Math.round(m.eatingOut)}/month on restaurants and caf\u00e9s.`,
      });
    }
    return patterns;
  },

  /**
   * Scan enriched transactions for recognized bill merchants and extract
   * verified payment amounts. Groups by category + merchant, detects payment
   * frequency from intervals, and computes a reliable monthly equivalent.
   *
   * This replaces estimated ranges with real amounts for bills like British Gas,
   * Thames Water, Council Tax, etc. — even quarterly or irregular ones.
   */
  verifyBillsFromTransactions(transactions: EnrichedTransaction[]): VerifiedBill[] {
    // Categories where we want to verify bill amounts from merchant data
    const billCategories = new Set([
      'energy', 'water', 'council tax', 'insurance', 'rent', 'mortgage',
      'broadband & phone', 'tv licence', 'debt payments',
    ]);

    // Group spending by category + merchant for bill categories
    const spending = transactions.filter((t) => t.amount < 0 && !t.isTransfer && !t.isRefund);
    const merchantGroups: Record<string, EnrichedTransaction[]> = {};

    for (const tx of spending) {
      const cat = (tx.category || '').toLowerCase();
      if (!billCategories.has(cat)) continue;
      if (!tx.merchant || tx.confidence === 'low') continue; // skip unrecognized

      const key = `${cat}::${tx.merchant}`;
      if (!merchantGroups[key]) merchantGroups[key] = [];
      merchantGroups[key].push(tx);
    }

    const bills: VerifiedBill[] = [];

    for (const [key, txs] of Object.entries(merchantGroups)) {
      const [category, merchant] = key.split('::');
      const sorted = txs.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      const lastTx = sorted[sorted.length - 1];

      // Compute payment frequency from intervals between payments
      const intervals: number[] = [];
      for (let i = 1; i < sorted.length; i++) {
        const days = (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / (1000 * 60 * 60 * 24);
        if (days > 0) intervals.push(days);
      }

      let frequency: VerifiedBill['frequency'] = 'irregular';
      let monthlyAmount: number;

      if (intervals.length >= 1) {
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

        if (avgInterval >= 5 && avgInterval <= 10) frequency = 'weekly';
        else if (avgInterval >= 25 && avgInterval <= 35) frequency = 'monthly';
        else if (avgInterval >= 80 && avgInterval <= 100) frequency = 'quarterly';
        else if (avgInterval >= 170 && avgInterval <= 200) frequency = 'semi_annual';
        else if (avgInterval >= 340 && avgInterval <= 400) frequency = 'annual';

        // Monthly equivalent: use average payment amount ÷ interval in months
        const avgPayment = txs.reduce((s, t) => s + Math.abs(t.amount), 0) / txs.length;
        const intervalMonths = avgInterval / 30.44;
        monthlyAmount = Math.round(avgPayment / Math.max(intervalMonths, 1));
      } else {
        // Single payment — estimate monthly from amount and likely frequency
        const amount = Math.abs(lastTx.amount);
        // Heuristic: large single bills are likely quarterly/annual
        if (amount > 300) {
          frequency = 'quarterly';
          monthlyAmount = Math.round(amount / 3);
        } else if (amount > 100) {
          frequency = 'monthly';
          monthlyAmount = Math.round(amount);
        } else {
          frequency = 'monthly';
          monthlyAmount = Math.round(amount);
        }
      }

      // Capitalize category for display
      const displayCategory = category.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

      bills.push({
        category: displayCategory,
        merchant,
        monthlyAmount,
        frequency,
        lastPayment: Math.abs(lastTx.amount),
        lastPaymentDate: lastTx.date,
        paymentCount: txs.length,
      });
    }

    return bills.sort((a, b) => b.monthlyAmount - a.monthlyAmount);
  },

  /**
   * Detect essential expenses expected from the user's identity but missing
   * from their transaction data. Cross-references housing status, household
   * type, and dependents against detected spending categories.
   *
   * Now also checks verified bills — if a bill merchant is found in transactions,
   * that category is NOT flagged as a gap (even for quarterly/irregular payments).
   *
   * This enables the chat to ask targeted questions about variable or
   * externally-paid costs (rent via partner, cash payments, quarterly bills)
   * rather than guessing or ignoring them.
   */
  detectEssentialGaps(
    profile: FinancialProfile,
    identity: any,
    debtAccounts?: any[],
    budgetAdjustments?: any[],
    verifiedBills?: VerifiedBill[],
  ): EssentialGap[] {
    if (!identity) return [];
    const gaps: EssentialGap[] = [];

    // Build a set of categories that have meaningful spend (>£5/mo)
    const nonDisc = profile.budgetReality?.nonDiscretionary?.items || [];
    const disc = profile.budgetReality?.discretionary?.items || [];
    const allItems = [...nonDisc, ...disc];
    const detectedCategories = new Set<string>();
    for (const item of allItems) {
      if (item.monthly > 5) {
        detectedCategories.add(item.category.toLowerCase());
      }
    }

    // Also check budget adjustments (manual items already added by user)
    const manualCategories = new Set<string>();
    if (budgetAdjustments) {
      for (const adj of budgetAdjustments) {
        if (adj.category) manualCategories.add(adj.category.toLowerCase());
        if (adj.description) manualCategories.add(adj.description.toLowerCase());
      }
    }

    // Check verified bills — even quarterly/annual bills count as present
    const verifiedCategories = new Set<string>();
    if (verifiedBills) {
      for (const bill of verifiedBills) {
        verifiedCategories.add(bill.category.toLowerCase());
      }
    }

    const has = (cat: string) =>
      detectedCategories.has(cat.toLowerCase()) ||
      manualCategories.has(cat.toLowerCase()) ||
      verifiedCategories.has(cat.toLowerCase());

    // ── Housing costs ──
    const housing = identity.housing;
    if (housing === 'renting' || housing === 'shared_house' || housing === 'council') {
      if (!has('rent') && !has('housing')) {
        gaps.push({
          category: 'Rent',
          reason: housing === 'council'
            ? 'You mentioned council housing — rent may be paid separately'
            : 'You mentioned you\'re renting',
          typicalRange: housing === 'council' ? { low: 300, high: 800 } : { low: 500, high: 1500 },
          confidence: 'high',
        });
      }
    } else if (housing === 'mortgage') {
      if (!has('mortgage')) {
        gaps.push({
          category: 'Mortgage',
          reason: 'You mentioned having a mortgage',
          typicalRange: { low: 500, high: 2000 },
          confidence: 'high',
        });
      }
    }

    // ── Council Tax (everyone except students and some living with family) ──
    const isStudent = identity.work_setup === 'student';
    if (!isStudent && housing !== 'with_family') {
      if (!has('council tax') && !has('council')) {
        gaps.push({
          category: 'Council Tax',
          reason: 'Most UK households pay council tax',
          typicalRange: { low: 100, high: 250 },
          confidence: housing === 'with_family' ? 'low' : 'medium',
        });
      }
    }

    // ── Energy (gas + electric) ──
    if (housing !== 'with_family') {
      if (!has('energy') && !has('bills') && !has('utilities') && !has('gas') && !has('electric')) {
        gaps.push({
          category: 'Energy',
          reason: 'Energy bills may be paid quarterly, by a partner, or via prepayment',
          typicalRange: { low: 80, high: 250 },
          confidence: 'medium',
        });
      }
    }

    // ── Water ──
    if (housing !== 'with_family') {
      if (!has('water') && !has('sewerage')) {
        gaps.push({
          category: 'Water',
          reason: 'Water bills are often quarterly or paid by another household member',
          typicalRange: { low: 25, high: 60 },
          confidence: 'low',
        });
      }
    }

    // ── Childcare ──
    const hasYoungChildren = (identity.dependents || []).includes('young_children');
    if (hasYoungChildren) {
      if (!has('childcare') && !has('nursery')) {
        gaps.push({
          category: 'Childcare',
          reason: 'You have young children — childcare may be paid in cash or by a partner',
          typicalRange: { low: 400, high: 1500 },
          confidence: 'medium',
        });
      }
    }

    // ── Insurance (contents/buildings) ──
    if ((housing === 'renting' || housing === 'mortgage') && !has('insurance')) {
      gaps.push({
        category: 'Insurance',
        reason: housing === 'mortgage'
          ? 'Buildings insurance is usually required with a mortgage'
          : 'Contents insurance is common for renters',
        typicalRange: housing === 'mortgage' ? { low: 30, high: 80 } : { low: 10, high: 30 },
        confidence: 'low',
      });
    }

    // ── Debt minimums ──
    if (debtAccounts && debtAccounts.length > 0) {
      const totalDebt = debtAccounts.reduce((s: number, d: any) => s + (d.outstanding_balance || 0), 0);
      if (totalDebt > 0 && !has('debt payments') && !has('debt') && !has('loan')) {
        gaps.push({
          category: 'Debt Payments',
          reason: `You have £${Math.round(totalDebt).toLocaleString()} in debt — minimum payments may not be visible`,
          typicalRange: { low: Math.round(totalDebt * 0.02), high: Math.round(totalDebt * 0.05) },
          confidence: 'medium',
        });
      }
    }

    return gaps;
  },

  calcDecisionScore(profile: FinancialProfile): DecisionScore {
    const m = profile.metrics;
    let score = 50;
    const breakdown: { factor: string; impact: number }[] = [];

    if (m.savingsRate >= 20) { score += 15; breakdown.push({ factor: 'Savings rate', impact: +15 }); }
    else if (m.savingsRate >= 10) { score += 8; breakdown.push({ factor: 'Savings rate', impact: +8 }); }
    else if (m.savingsRate < 5) { score -= 10; breakdown.push({ factor: 'Savings rate', impact: -10 }); }

    if (m.debtAccountCount === 0) { score += 10; breakdown.push({ factor: 'Debt-free', impact: +10 }); }
    else if (m.debtAccountCount >= 3) { score -= 12; breakdown.push({ factor: 'Multiple debts', impact: -12 }); }

    if (m.subscriptionCount <= 3) { score += 5; breakdown.push({ factor: 'Lean subscriptions', impact: +5 }); }
    else if (m.subscriptionCount >= 7) { score -= 8; breakdown.push({ factor: 'Subscription creep', impact: -8 }); }

    if (m.foodDelivery > UK_BENCHMARKS.foodDelivery) {
      score -= 5; breakdown.push({ factor: 'High delivery spend', impact: -5 });
    }

    const hasSalary = profile.incomeSources.some((s) => s.isSalary);
    if (hasSalary) { score += 8; breakdown.push({ factor: 'Stable salary', impact: +8 }); }

    if (m.bnplCount >= 2) { score -= 8; breakdown.push({ factor: 'BNPL usage', impact: -8 }); }

    score = Math.max(0, Math.min(100, score));
    let verdict: DecisionScore['verdict'] = 'Balanced';
    if (score >= 75) verdict = 'Strong';
    else if (score >= 55) verdict = 'Balanced';
    else if (score >= 35) verdict = 'Needs Attention';
    else verdict = 'At Risk';

    return { score, verdict, breakdown };
  },

  genDecisionStack(profile: FinancialProfile, enrichedTxs?: EnrichedTransaction[], debtAccounts?: any[], identity?: any): Move[] {
    const moves: Move[] = [];
    const m = profile.metrics;
    const p = profile.monthly;
    const subs = profile.subscriptions || [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - ANALYSIS_MONTHS);
    const txs = (enrichedTxs || []).filter((t) => new Date(t.date) >= cutoff);
    const T = MOVE_THRESHOLDS;

    // ── Identity-aware modifiers ──
    const id = identity || {};
    const isRemote = id.work_setup === 'remote';
    const isHybrid = id.work_setup === 'hybrid';
    const isSelfEmployed = id.work_setup === 'self_employed';
    const isStudent = id.work_setup === 'student';
    const isSingleParent = id.household === 'single_parent';
    const hasChildren = isSingleParent || id.household === 'family' || (id.dependents || []).some((d: string) => d === 'young_children' || d === 'teenagers');
    const isRenting = id.housing === 'renting' || id.housing === 'shared_house';
    const hasMortgage = id.housing === 'mortgage';
    const wantsSecurity = (id.priorities || []).includes('security');
    const wantsGrowth = (id.priorities || []).includes('growth');
    const wantsFreedom = (id.priorities || []).includes('freedom');
    const wantsExperiences = (id.priorities || []).includes('experiences');
    const buyingHome = (id.upcoming_events || []).includes('first_home');
    const havingBaby = (id.upcoming_events || []).includes('baby');
    const changingCareer = (id.upcoming_events || []).includes('career_change');
    const isAdvanced = id.financial_experience === 'confident' || id.financial_experience === 'advanced';

    // Subscriptions — single consolidated recommendation (not per-merchant)
    if (m.subscriptionCount >= T.subscriptionMinCount) {
      const subNames = subs.map((s) => s.merchant).filter(Boolean);
      const cutCount = Math.max(2, Math.round(m.subscriptionCount * T.subscriptionCutPct));
      const saving = Math.round(p.subscriptions * T.subscriptionCutPct);
      const topSubs = subs
        .filter((s) => s.merchant && s.averageAmount >= 5)
        .sort((a, b) => b.averageAmount - a.averageAmount)
        .slice(0, 4);
      const subBreakdown = topSubs.map((s) => `${s.merchant} \u00a3${Math.round(s.averageAmount)}/mo`).join(', ');
      moves.push({
        action: `Cancel or downgrade ${cutCount} subscriptions to free \u00a3${saving}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        category: 'spending',
        merchants: subNames,
        strategy: `${m.subscriptionCount} active subscriptions costing \u00a3${Math.round(p.subscriptions)}/month total. Biggest: ${subBreakdown}.`,
        steps: ['Review your subscriptions — I\'ve listed them below', 'Cancel the ones you haven\'t used in 30 days', 'Rotate streaming services monthly — I\'ll remind you'],
        effect: `Saves \u00a3${saving}/month (\u00a3${saving * 12}/year).`,
      });
    }

    // Food delivery
    if (m.foodDelivery > T.foodDeliveryMin) {
      const saving = Math.round(m.foodDelivery * T.foodDeliveryCutPct);
      const deliveryMerchants = this._getMerchantsByCategory(txs, 'Delivery');
      moves.push({
        action: `Cut delivery spend from \u00a3${Math.round(m.foodDelivery)} to \u00a3${Math.round(m.foodDelivery - saving)}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        category: 'spending',
        merchants: deliveryMerchants,
        strategy: `\u00a3${Math.round(m.foodDelivery)}/month on food delivery.`,
        steps: ['Batch-cook twice a week', 'Delete saved payment cards from delivery apps', 'I\'ll track your delivery spend weekly'],
        effect: `Frees \u00a3${saving}/month.`,
      });
    }

    // Eating out
    if (m.eatingOut > T.eatingOutMin) {
      const saving = Math.round(m.eatingOut * T.eatingOutCutPct);
      const eatingMerchants = this._getMerchantsByCategory(txs, 'Eating Out');
      const coffeeMerchants = this._getMerchantsByCategory(txs, 'Coffee & Cafes');
      moves.push({
        action: `Reduce dining out from \u00a3${Math.round(m.eatingOut)} to \u00a3${Math.round(m.eatingOut - saving)}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        category: 'spending',
        merchants: [...eatingMerchants, ...coffeeMerchants],
        strategy: `\u00a3${Math.round(m.eatingOut)}/month on restaurants and caf\u00e9s.`,
        steps: ['Replace one meal out per week with home-cooked', 'Bring coffee from home 2x per week'],
        effect: `Saves \u00a3${saving}/month.`,
      });
    }

    // Shopping
    if (m.shopping > T.shoppingMin) {
      const saving = Math.round(m.shopping * T.shoppingCutPct);
      const shopMerchants = this._getMerchantsByCategory(txs, 'Shopping');
      moves.push({
        action: `Cap non-essential shopping at \u00a3${Math.round(m.shopping - saving)}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        category: 'spending',
        merchants: shopMerchants,
        strategy: `\u00a3${Math.round(m.shopping)}/month on shopping.`,
        steps: ['Apply 24-hour rule on purchases over \u00a330', 'Remove saved cards from shopping apps', 'Unsubscribe from marketing emails'],
        effect: `Saves \u00a3${saving}/month.`,
      });
    }

    // ── Debt analysis with good/bad debt differentiation ──
    // Include both synced and manual debt accounts for holistic view
    const connectedDebts = debtAccounts || [];
    const totalLimit = connectedDebts.reduce((s: number, d: any) => s + (d.credit_limit || 0), 0);
    const totalBalance = connectedDebts.reduce((s: number, d: any) => s + (d.outstanding_balance || 0), 0);
    const overallUtil = totalLimit > 0 ? (totalBalance / totalLimit) * 100 : -1;
    const isGoodDebt = overallUtil >= 0 && overallUtil <= 30;
    const isMediumUtil = overallUtil > 30 && overallUtil <= 75;
    const isHighUtil = overallUtil > 75;

    // Use the higher of transaction-detected debt count or actual debt accounts
    // This ensures manually-added debts (without matching transactions) are counted
    const actualDebtCount = Math.max(m.debtAccountCount, connectedDebts.length);

    // Debt snowball — only for bad/medium debt, not for good debt users
    if (actualDebtCount >= 2) {
      const debtMerchants = this._getMerchantsByCategory(txs, 'Debt Payments');
      if (isGoodDebt) {
        // Low utilization, paying on time — good debt for points
        moves.push({
          action: `Maximise credit card rewards across ${actualDebtCount} cards`,
          annualImpact: Math.round(totalBalance * 0.02), // ~2% rewards
          monthlyImpact: Math.round(totalBalance * 0.02 / 12),
          effort: 'low',
          category: 'savings',
          merchants: debtMerchants,
          strategy: `${actualDebtCount} credit cards with ${Math.round(overallUtil)}% utilisation — well managed. Focus on maximising points and cashback.`,
          steps: ['Route all regular spending through your rewards card', 'Always pay in full to avoid interest', 'Review whether your card gives the best rewards for your spend', 'I\'ll flag if utilisation creeps up'],
          effect: `Earn more from spending you're already doing.`,
        });
      } else {
        const debtSaving = Math.round(p.debtPayments * T.debtSnowballSavePct);
        moves.push({
          action: `Attack ${actualDebtCount} debts with snowball method`,
          annualImpact: debtSaving * 12,
          monthlyImpact: debtSaving,
          effort: 'high',
          category: 'debt',
          merchants: debtMerchants,
          strategy: `${actualDebtCount} debt accounts costing \u00a3${Math.round(p.debtPayments)}/month.${isHighUtil ? ` Utilisation at ${Math.round(overallUtil)}% — this is hurting your credit score.` : ''}`,
          steps: ['List all debts smallest to largest', 'Pay minimums on all but smallest', 'Direct your surplus at the smallest debt first', 'When it\'s cleared, I\'ll roll payments into the next one'],
          effect: `Saves \u00a3${debtSaving * 12}/year in interest.`,
        });
      }
    }

    // Single debt account
    if (actualDebtCount === 1) {
      const debtMerchants = this._getMerchantsByCategory(txs, 'Debt Payments');
      if (isGoodDebt) {
        moves.push({
          action: 'Keep using your credit card strategically for rewards',
          annualImpact: Math.round(totalBalance * 0.02),
          monthlyImpact: Math.round(totalBalance * 0.02 / 12),
          effort: 'low',
          category: 'savings',
          merchants: debtMerchants,
          strategy: `1 card with ${Math.round(overallUtil)}% utilisation — excellent management. You're earning rewards without paying interest.`,
          steps: ['Keep paying the full balance each month', 'Use this card for all eligible spending', 'Check if a different rewards card offers better value', 'I\'ll track your utilisation'],
          effect: 'Continue earning rewards on responsible credit card use.',
        });
      } else {
        const debtSaving = Math.round(p.debtPayments * T.singleDebtOverpayPct);
        const overpay = Math.round(Math.min(p.surplus * T.singleDebtOverpayMaxSurplusPct, T.singleDebtOverpayCap));
        moves.push({
          action: `Overpay debt by \u00a3${overpay}/month to clear faster`,
          annualImpact: debtSaving * 12,
          monthlyImpact: debtSaving,
          effort: 'medium',
          category: 'debt',
          merchants: debtMerchants,
          strategy: `1 debt account with \u00a3${Math.round(p.debtPayments)}/month in payments.${isHighUtil ? ` Utilisation at ${Math.round(overallUtil)}% — priority to reduce this.` : ''}`,
          steps: ['Check if overpayments are allowed without penalty', 'Set up a monthly overpayment standing order', 'I\'ll redirect savings from other moves into this automatically'],
          effect: `Reduces total interest paid and clears debt sooner.`,
        });
      }
    }

    // Transport — adjusted for work setup
    if (m.transport > T.transportMin && !isRemote) {
      const cutPct = isHybrid ? T.transportCutPct * 0.5 : T.transportCutPct; // Hybrid workers already commute less
      const saving = Math.round(m.transport * cutPct);
      const transportMerchants = this._getMerchantsByCategory(txs, 'Transport');
      const steps = isHybrid
        ? ['Check if 2-3 day travelcards are cheaper than pay-as-you-go', 'Batch office days to reduce trips', 'Compare cycle-to-work scheme for office days']
        : ['Check railcard or weekly cap options', 'Go car-free one day per week', 'Compare annual vs monthly tickets'];
      moves.push({
        action: `Cut transport from \u00a3${Math.round(m.transport)} to \u00a3${Math.round(m.transport - saving)}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        category: 'spending',
        merchants: transportMerchants,
        strategy: `\u00a3${Math.round(m.transport)}/month on transport.${isHybrid ? ' As a hybrid worker, you already commute less — but there may be cheaper options for your pattern.' : ''}`,
        steps,
        effect: `Saves \u00a3${saving}/month.`,
      });
    }

    // Emergency buffer — adjusted for life situation
    if (m.savingsRate < T.bufferSavingsRateThreshold && p.surplus > 0) {
      const autoSave = Math.round(p.surplus * T.bufferAutoSavePct);
      const bufferMonths = isSelfEmployed ? 6 : (isSingleParent || hasChildren) ? 3 : 1;
      const bufferTarget = Math.max(T.bufferMinTarget, Math.round(p.spending * bufferMonths));
      const monthsToTarget = autoSave > 0 ? Math.ceil(bufferTarget / autoSave) : 0;
      const reason = isSelfEmployed
        ? 'As self-employed, you need a larger runway for income gaps.'
        : isSingleParent
          ? 'As a single parent, a bigger buffer protects your family from surprises.'
          : hasChildren
            ? 'With children, unexpected costs come up — a solid buffer is essential.'
            : '';
      moves.push({
        action: `Auto-save \u00a3${autoSave}/month to build \u00a3${bufferTarget} buffer in ${monthsToTarget} months`,
        annualImpact: autoSave * 12,
        monthlyImpact: autoSave,
        effort: 'low',
        category: 'buffer',
        merchants: [],
        strategy: `Savings rate is ${Math.round(m.savingsRate)}%. Monthly surplus is \u00a3${Math.round(p.surplus)}.${reason ? ' ' + reason : ''} Target: ${bufferMonths} month${bufferMonths > 1 ? 's' : ''} of expenses.`,
        steps: ['Set aside this amount on payday — I\'ll track it', `Target ${bufferMonths} month${bufferMonths > 1 ? 's' : ''} of expenses (\u00a3${bufferTarget})`, 'I\'ll update your progress each month'],
        effect: `\u00a3${bufferTarget} safety net in ${monthsToTarget} months.`,
      });
    }

    // High savers
    if (m.savingsRate >= T.highSaverThreshold) {
      const surplusAnnual = Math.round(p.surplus * 12);
      const interestGain = Math.round(surplusAnnual * T.highSaverInterestRate);
      moves.push({
        action: `Put \u00a3${Math.round(p.surplus)}/month surplus to work in a savings account`,
        annualImpact: interestGain,
        monthlyImpact: Math.round(interestGain / 12),
        effort: 'low',
        category: 'savings',
        merchants: [],
        strategy: `Savings rate is ${Math.round(m.savingsRate)}%. Surplus is \u00a3${Math.round(p.surplus)}/month.`,
        steps: ['Put surplus into a savings account on payday', 'Automate the transfer so it\'s hands-free', 'I\'ll flag when it\'s time to review your rate'],
        effect: `\u00a3${interestGain}/year in passive interest.`,
      });
    }

    // Coffee
    if (m.coffeeAndCafes > T.coffeeMin) {
      const saving = Math.round(m.coffeeAndCafes * T.coffeeCutPct);
      const coffeeMerchants = this._getMerchantsByCategory(txs, 'Coffee & Cafes');
      moves.push({
        action: `Halve caf\u00e9 spending from \u00a3${Math.round(m.coffeeAndCafes)} to \u00a3${Math.round(m.coffeeAndCafes - saving)}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        category: 'spending',
        merchants: coffeeMerchants,
        strategy: `\u00a3${Math.round(m.coffeeAndCafes)}/month on coffee and caf\u00e9s.`,
        steps: ['Make coffee at home 3 mornings per week', 'Keep one treat coffee day', 'I\'ll track your weekly café spend'],
        effect: `Saves \u00a3${saving}/month.`,
      });
    }

    // ── Identity-driven life event moves ──
    if (buyingHome && p.surplus > 0) {
      const depositTarget = Math.round(p.income * 12 * 3); // rough 3x annual income
      const monthsToDeposit = p.surplus > 0 ? Math.ceil(depositTarget * 0.1 / p.surplus) : 0;
      moves.push({
        action: `Build a house deposit — save \u00a3${Math.round(p.surplus * 0.6)}/month toward \u00a3${Math.round(depositTarget * 0.1)}`,
        annualImpact: Math.round(p.surplus * 0.6 * 12),
        monthlyImpact: Math.round(p.surplus * 0.6),
        effort: 'medium',
        category: 'savings',
        merchants: [],
        strategy: `You're saving for your first home. A 10% deposit on a typical property for your income would be ~\u00a3${Math.round(depositTarget * 0.1).toLocaleString()}.`,
        steps: ['Open a Lifetime ISA for the 25% government bonus (max \u00a34,000/year)', 'Set up automatic monthly transfers on payday', 'I\'ll track your deposit progress and project your timeline'],
        effect: `Deposit ready in ~${monthsToDeposit} months with current surplus.`,
      });
    }

    if (havingBaby && p.surplus > 0) {
      const parentalRunway = Math.round(p.spending * 3);
      moves.push({
        action: `Build a \u00a3${parentalRunway.toLocaleString()} parental leave runway`,
        annualImpact: Math.round(parentalRunway),
        monthlyImpact: Math.round(parentalRunway / 12),
        effort: 'medium',
        category: 'buffer',
        merchants: [],
        strategy: 'With a baby on the way, you\'ll want 3 months of expenses saved to cover reduced income during parental leave.',
        steps: ['Calculate your expected statutory/employer maternity/paternity pay', 'Work out the monthly shortfall vs current spending', 'Set aside the difference now while you can', 'I\'ll model the income change for you'],
        effect: `\u00a3${parentalRunway.toLocaleString()} runway covers 3 months of expenses.`,
      });
    }

    if (changingCareer && p.surplus > 0) {
      const runwayTarget = Math.round(p.spending * 6);
      moves.push({
        action: `Build a \u00a3${runwayTarget.toLocaleString()} career change runway`,
        annualImpact: Math.round(runwayTarget),
        monthlyImpact: Math.round(runwayTarget / 12),
        effort: 'high',
        category: 'buffer',
        merchants: [],
        strategy: 'A career change means potential income gaps. 6 months of expenses gives you freedom to transition without financial pressure.',
        steps: ['Calculate 6 months of essential expenses', 'Redirect surplus into a dedicated transition fund', 'Consider freelance income during the transition', 'I\'ll track your runway and flag when you\'re ready'],
        effect: `\u00a3${runwayTarget.toLocaleString()} gives you 6 months to transition.`,
      });
    }

    if (isSelfEmployed && p.surplus > 0) {
      const taxSetAside = Math.round(p.income * 0.25);
      moves.push({
        action: `Set aside \u00a3${taxSetAside}/month for tax (25% of income)`,
        annualImpact: taxSetAside * 12,
        monthlyImpact: taxSetAside,
        effort: 'low',
        category: 'buffer',
        merchants: [],
        strategy: 'As self-employed, your tax isn\'t deducted automatically. Setting aside 25% prevents a January surprise.',
        steps: ['Open a separate savings account for tax', 'Transfer 25% of every payment received', 'I\'ll track your tax reserve vs estimated liability'],
        effect: 'No tax bill shock — always prepared for self-assessment.',
      });
    }

    // ── Mathematical insights for financially healthy users ──
    // These surface tax and return facts — not product recommendations.
    // The user sees the numbers; the ranking reflects the tax math.
    if (m.savingsRate >= 20 && m.debtAccountCount <= 1 && (isGoodDebt || m.debtAccountCount === 0)) {
      // ISA allowance utilisation
      const isaLimit = 20000;
      const annualSurplus = Math.round(p.surplus * 12);
      if (annualSurplus > 3000) {
        const isaCapacity = Math.min(annualSurplus, isaLimit);
        const taxFreeGrowth = Math.round(isaCapacity * 0.05);
        moves.push({
          action: `\u00a3${isaCapacity.toLocaleString()}/year of surplus falls within the ISA allowance`,
          annualImpact: taxFreeGrowth,
          monthlyImpact: Math.round(taxFreeGrowth / 12),
          effort: 'low',
          category: 'invest',
          merchants: [],
          strategy: `Your annual surplus of \u00a3${annualSurplus.toLocaleString()} is within the \u00a3${isaLimit.toLocaleString()} ISA allowance. Growth inside an ISA is not subject to capital gains tax or income tax on dividends.`,
          steps: ['Your ISA allowance resets each 6 April', 'Unused allowance does not carry over', 'You can hold one of each ISA type per tax year'],
          effect: `At 5% growth, \u00a3${isaCapacity.toLocaleString()}/year generates \u00a3${taxFreeGrowth.toLocaleString()}/year tax-free.`,
        });
      }

      // Pension tax relief arithmetic
      if (p.income > 2500) {
        const pensionExtra = Math.round(p.surplus * 0.15);
        const isHigherRate = p.income > 4167; // ~£50k/year
        const netCostPer100 = isHigherRate ? 60 : 80;
        const reliefRate = isHigherRate ? 40 : 20;
        const annualRelief = Math.round(pensionExtra * 12 * (reliefRate / 100));
        moves.push({
          action: `\u00a3${pensionExtra}/month into pension costs \u00a3${Math.round(pensionExtra * netCostPer100 / 100)} net after ${reliefRate}% tax relief`,
          annualImpact: annualRelief,
          monthlyImpact: Math.round(annualRelief / 12),
          effort: 'medium',
          category: 'invest',
          merchants: [],
          strategy: `At your income level, each \u00a3100 directed to a pension has a net cost of \u00a3${netCostPer100} after ${reliefRate}% tax relief. Via salary sacrifice, NI savings reduce this further.`,
          steps: ['Tax relief is ${reliefRate}% at your marginal rate', 'Salary sacrifice also saves ${isHigherRate ? 2 : 8}% in National Insurance', 'Annual pension allowance is \u00a360,000 (including employer contributions)'],
          effect: `\u00a3${annualRelief.toLocaleString()}/year in tax relief on \u00a3${(pensionExtra * 12).toLocaleString()}/year of contributions.`,
        });
      }

      // Tax-free savings threshold
      if (p.surplus > 200) {
        const annualSavingsInterest = Math.round(p.surplus * 12 * 0.04);
        const isHigherRate = p.income > 4167;
        const psa = isHigherRate ? 500 : 1000;
        const taxOnInterest = annualSavingsInterest > psa
          ? Math.round((annualSavingsInterest - psa) * (isHigherRate ? 0.40 : 0.20))
          : 0;
        moves.push({
          action: `\u00a3${annualSavingsInterest.toLocaleString()}/year savings interest ${annualSavingsInterest > psa ? 'exceeds' : 'is within'} your \u00a3${psa} personal savings allowance`,
          annualImpact: taxOnInterest > 0 ? taxOnInterest : Math.round(p.surplus * 12 * 0.04),
          monthlyImpact: taxOnInterest > 0 ? Math.round(taxOnInterest / 12) : Math.round(p.surplus * 0.04),
          effort: 'low',
          category: 'savings',
          merchants: [],
          strategy: taxOnInterest > 0
            ? `At 4% interest, your surplus generates ~\u00a3${annualSavingsInterest}/year. Your personal savings allowance is \u00a3${psa} (${isHigherRate ? 'higher' : 'basic'} rate). Interest above this is taxed at ${isHigherRate ? 40 : 20}%. Tax-free wrappers avoid this.`
            : `At 4% interest, your surplus generates ~\u00a3${annualSavingsInterest}/year — within your \u00a3${psa} personal savings allowance, so no tax is due.`,
          steps: [`Your personal savings allowance is \u00a3${psa} as a ${isHigherRate ? 'higher' : 'basic'} rate taxpayer`, 'Interest from ISAs and Premium Bonds does not count against this', 'This allowance is separate from the ISA allowance'],
          effect: taxOnInterest > 0
            ? `\u00a3${taxOnInterest}/year in tax on savings interest above the allowance.`
            : `All \u00a3${annualSavingsInterest}/year in interest is within your tax-free allowance.`,
        });
      }

      // Surplus growth potential
      if (p.income > 0) {
        const tenPct = Math.round(p.income * 0.1);
        moves.push({
          action: `A 10% income increase would add \u00a3${tenPct}/month (\u00a3${(tenPct * 12).toLocaleString()}/year) to surplus`,
          annualImpact: tenPct * 12,
          monthlyImpact: tenPct,
          effort: 'high',
          category: 'savings',
          merchants: [],
          strategy: `Your spending is well-managed at ${Math.round(m.savingsRate)}% savings rate. At this level, income growth has a larger impact than further spending cuts.`,
          steps: ['Each extra \u00a31 of income keeps ~\u00a3' + Math.round((p.income > 4167 ? 0.58 : 0.72) * 100) / 100 + ' after tax and NI', 'Pension contributions reduce taxable income', 'Bonus income may be taxed at a higher marginal rate'],
          effect: `\u00a3${(tenPct * 12).toLocaleString()}/year additional surplus, of which ~\u00a3${Math.round(tenPct * 12 * (p.income > 4167 ? 0.58 : 0.72)).toLocaleString()} after tax.`,
        });
      }

      // Spending efficiency
      const cashbackEstimate = Math.round(p.spending * 12 * 0.015);
      moves.push({
        action: `1-2% back on \u00a3${Math.round(p.spending * 12).toLocaleString()}/year spending = \u00a3${cashbackEstimate}/year`,
        annualImpact: cashbackEstimate,
        monthlyImpact: Math.round(p.spending * 0.015),
        effort: 'low',
        category: 'savings',
        merchants: [],
        strategy: `Your annual spending is \u00a3${Math.round(p.spending * 12).toLocaleString()}. Cashback and rewards programmes typically return 1-2% of spend. This is money you're spending anyway.`,
        steps: ['Cashback is typically treated as a discount, not taxable income', 'Stacking cashback sources can increase the effective rate', 'The value depends on whether you pay balances in full each month'],
        effect: `\u00a3${cashbackEstimate}/year from spending that already happens.`,
      });
    }

    // Break-even move if in deficit
    if (p.surplus < 0) {
      const deficit = Math.abs(Math.round(p.surplus));
      const topDiscItems = profile.budgetReality?.discretionary?.items || [];
      const topCuts = topDiscItems.slice(0, 3).map((i) => i.category);
      moves.push({
        action: `Close \u00a3${deficit}/month deficit by cutting discretionary spending`,
        annualImpact: deficit * 12,
        monthlyImpact: deficit,
        effort: 'high',
        category: 'break_even',
        merchants: topCuts,
        strategy: `Spending \u00a3${deficit}/month more than income. Top discretionary categories: ${topCuts.join(', ') || 'unknown'}.`,
        steps: ['Freeze all non-essential spending for 30 days', 'Cancel unnecessary subscriptions immediately', 'Switch to cash/prepaid for discretionary spending'],
        effect: `Stops the bleed and creates a foundation for saving.`,
      });
    }

    moves.sort((a, b) => b.annualImpact - a.annualImpact);
    return moves;
  },

  /**
   * Rebuild the full analysis from updated enriched transactions.
   * Used after Claude AI verification upgrades low-confidence "Other"
   * transactions into proper categories — the profile, archetype, score,
   * and moves all recompute with the improved data.
   */
  rebuild(enriched: EnrichedTransaction[], debtAccounts?: any[], identity?: any): EnrichmentResult {
    const recurring = this.detectRecurring(enriched);
    const profile = this.buildProfile(enriched, recurring);
    const archetype = this.determineArchetype(profile);
    const patterns = this.detectBehavioralPatterns(profile);
    const score = this.calcDecisionScore(profile);
    const stack = this.genDecisionStack(profile, enriched, debtAccounts, identity);

    const metrics = profile.metrics;
    const traits = Object.values(SUB_TRAITS).filter((t) => t.test(metrics, profile));
    const strengths = STRENGTH_RULES.filter((r) => r.test(metrics));
    const blindSpots = BLINDSPOT_RULES.filter((r) => r.test(metrics));
    const enrichmentMetrics = this._computeEnrichmentMetrics(enriched);
    const verifiedBills = this.verifyBillsFromTransactions(enriched);
    const essentialGaps = identity
      ? this.detectEssentialGaps(profile, identity, debtAccounts, undefined, verifiedBills)
      : undefined;

    return {
      profile,
      archetype,
      traits: traits.map((t) => ({ name: t.name, insight: t.insight })) as any,
      strengths: strengths.map((s) => ({ label: s.label, detail: s.detail })) as any,
      blindSpots: blindSpots.map((b) => ({ label: b.label, detail: b.detail })) as any,
      decisionScore: score,
      decisionStack: stack,
      behavioralPatterns: patterns.map((p: any) => p.pattern || p),
      enrichedTransactions: enriched,
      enrichmentMetrics,
      essentialGaps,
      verifiedBills: verifiedBills.length > 0 ? verifiedBills : undefined,
    };
  },

  _isCreditCardRepayment(description: string): boolean {
    const lower = description.toLowerCase();
    const patterns = [
      /\bpayment\s*received\b/,
      /\bpayment\s*thank\s*you\b/,
      /\bcredit\s*card\s*payment\b/,
      /\bcard\s*repayment\b/,
      /\bcard\s*payment\s*received\b/,
      /\bdebt\s*repayment\b/,
      /\bdirect\s*debit\s*payment\b.*(?:amex|barclaycard|capital\s*one|mbna|vanquis|aqua|newday)/,
      /\b(?:amex|american\s*express|barclaycard|capital\s*one|mbna|vanquis|aqua|newday)\b.*\bpayment\b/,
      /\bminimum\s*payment\b/,
      /\boverpayment\b/,
      /\bcc\s*payment\b/,
      /\bcredit\s*balance\s*transfer\b/,
    ];
    return patterns.some((rx) => rx.test(lower));
  },

  /**
   * Detect credit card full-payers and reclassify their payoff transactions.
   *
   * Problem: users who use credit cards for points/rewards and pay off in full
   * have their spending double-counted — once when the card spending appears in
   * the merged CSV, and again when the bank-account payment to the card issuer
   * (e.g. "AMEX", "BARCLAYCARD") is classified as "Debt Payments".
   *
   * Detection strategy:
   *   1. Low utilization: if a TrueLayer-synced credit card has balance < 15%
   *      of credit limit, the user is clearly paying it off regularly.
   *   2. Payment-to-spending ratio: if monthly payments to a card issuer are
   *      within 30% of the monthly card spending, the user pays in full.
   *
   * When detected, the payoff transactions are reclassified as internal
   * transfers (isTransfer=true, isDebt=false) so they don't inflate spending
   * or create a false negative surplus.
   */
  _reclassifyCreditCardPayoffs(enriched: EnrichedTransaction[], debtAccounts?: any[]): void {
    // Known credit card issuer merchants (must match merchant-db entries)
    const CC_ISSUERS = new Set([
      'American Express', 'Barclaycard', 'MBNA', 'Capital One', 'Vanquis',
      'Aqua', 'NewDay', 'Virgin Money', 'Tesco Bank', "Sainsbury's Bank",
    ]);

    // Step 1: Check debtAccounts from TrueLayer for low-utilization cards
    const fullPayerIssuers = new Set<string>();

    if (debtAccounts && debtAccounts.length > 0) {
      for (const acct of debtAccounts) {
        if (acct.account_type !== 'credit_card' && acct.account_type !== 'credit') continue;
        const balance = acct.outstanding_balance ?? 0;
        const limit = acct.credit_limit ?? 0;
        // If we have a credit limit and utilization is under 15%, this is a full-payer card
        if (limit > 0 && (balance / limit) < 0.15) {
          fullPayerIssuers.add((acct.account_name || '').toLowerCase());
        }
      }
    }

    // Step 2: Analyse transaction patterns to detect full-payer behavior
    // even without card balance data. Compare monthly outgoing payments to
    // each CC issuer vs total card spending in the same period.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - ANALYSIS_MONTHS);
    const recent = enriched.filter((t) => new Date(t.date) >= cutoff);

    // Find payments TO credit card issuers (outgoing debits flagged as debt)
    const ccPayments: Record<string, number> = {};
    const ccPaymentTxs: EnrichedTransaction[] = [];
    for (const tx of recent) {
      if (!tx.isDebt || tx.amount >= 0) continue;
      if (!CC_ISSUERS.has(tx.merchant)) continue;
      const key = tx.merchant;
      ccPayments[key] = (ccPayments[key] || 0) + Math.abs(tx.amount);
      ccPaymentTxs.push(tx);
    }

    // If no CC payments found, nothing to reclassify
    if (ccPaymentTxs.length === 0) return;

    // Calculate total spending on credit-card-like categories
    // (all spending that isn't itself a CC payment, transfer, savings, refund)
    const totalSpending = recent
      .filter((t) => t.amount < 0 && !t.isDebt && !t.isTransfer && !t.isSavings && !t.isRefund)
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    const totalCCPayments = Object.values(ccPayments).reduce((s, v) => s + v, 0);

    // Heuristic: if total CC payments are within 30% of total other spending,
    // this strongly suggests the user routes most spending through cards and
    // pays them off. The payments are duplicates of the card spending.
    const paymentToSpendRatio = totalSpending > 0 ? totalCCPayments / totalSpending : 0;
    const isLikelyFullPayer = paymentToSpendRatio >= 0.5 && paymentToSpendRatio <= 1.5;

    // Build the set of issuer merchants to reclassify
    const issuersToReclassify = new Set<string>();

    // From balance data (highest confidence)
    for (const issuerName of fullPayerIssuers) {
      for (const merchant of CC_ISSUERS) {
        if (merchant.toLowerCase().includes(issuerName) || issuerName.includes(merchant.toLowerCase())) {
          issuersToReclassify.add(merchant);
        }
      }
    }

    // From spending ratio analysis
    if (isLikelyFullPayer) {
      for (const merchant of Object.keys(ccPayments)) {
        issuersToReclassify.add(merchant);
      }
    }

    if (issuersToReclassify.size === 0) return;

    // Step 3: Reclassify matching transactions in-place
    for (const tx of enriched) {
      if (!tx.isDebt || tx.amount >= 0) continue;
      if (!issuersToReclassify.has(tx.merchant)) continue;

      // Reclassify: this is an internal transfer, not debt spending
      tx.isDebt = false;
      tx.isTransfer = true;
      tx.category = 'Credit Card Payoff';
      tx.isEssential = false;
    }
  },

  _isInternationalTransfer(description: string): boolean {
    const lower = description.toLowerCase();
    const patterns = [
      /\blemfi\b/, /\bwise\b/, /\btransferwise\b/, /\bremitly\b/,
      /\bworld\s*remit\b/, /\bwestern\s*union\b/, /\bmoneygram\b/,
      /\binternational\s*(?:transfer|payment)\b/, /\bforeign\s*(?:transfer|payment)\b/,
      /\bremittance\b/,
    ];
    return patterns.some((rx) => rx.test(lower));
  },

  _getMerchantsByCategory(txs: EnrichedTransaction[], category: string): string[] {
    // Count occurrences per normalised merchant name
    const counts: Record<string, { count: number; bestName: string }> = {};
    for (const t of txs) {
      if (t.category === category && !t.isIncome && !t.isTransfer && !t.isRefund) {
        // Use normalised description as the dedup key
        const raw = t.merchant || t.description;
        const key = normaliseDescription(raw);
        if (!key) continue;
        if (!counts[key]) counts[key] = { count: 0, bestName: raw };
        counts[key].count++;
        // Prefer shorter names (more likely to be a clean merchant name)
        if (raw.length < counts[key].bestName.length) counts[key].bestName = raw;
      }
    }

    return Object.entries(counts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([, { bestName }]) => this._titleCase(normaliseDescription(bestName)));
  },

  /** Title-case a normalised merchant name: "deliveroo london" → "Deliveroo London" */
  _titleCase(s: string): string {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
  },

  /** Compute enrichment confidence and source distribution metrics */
  _computeEnrichmentMetrics(enriched: EnrichedTransaction[]): EnrichmentMetrics {
    const total = enriched.length;
    const high = enriched.filter((t) => t.confidence === 'high').length;
    const medium = enriched.filter((t) => t.confidence === 'medium').length;
    const low = enriched.filter((t) => t.confidence === 'low').length;
    const other = enriched.filter((t) => t.category === 'Other').length;

    const bySource = {
      userOverride: enriched.filter((t) => t.classifiedBy === 'user_override').length,
      merchantDb: enriched.filter((t) => t.classifiedBy === 'merchant_db').length,
      fuzzyMatch: enriched.filter((t) => t.classifiedBy === 'fuzzy_match').length,
      keyword: enriched.filter((t) => t.classifiedBy === 'keyword').length,
      unresolved: enriched.filter((t) => t.classifiedBy === 'default' || !t.classifiedBy).length,
    };

    const metrics: EnrichmentMetrics = {
      totalTransactions: total,
      highConfidence: high,
      mediumConfidence: medium,
      lowConfidence: low,
      otherRate: total > 0 ? Math.round((other / total) * 100) : 0,
      bySource,
    };

    return metrics;
  },
};

export default EnrichmentEngine;
