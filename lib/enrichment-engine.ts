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
          isBNPL: false,
          isDebt: override.category === 'Debt Payments',
          isIncome: tx.amount > 0,
          isTransfer: false,
          isRefund: false,
          isSavings: override.category === 'Savings',
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
    const isSavings = !!(tx.description.toLowerCase().match(/\bsaving|isa\b/i) && tx.amount < 0);

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

      return {
        ...tx,
        merchant: merchantMatch.merchant,
        category: isIncome ? merchantMatch.category : (isCredit && !merchantMatch.isIncome ? 'Refunds' : classification.category),
        isEssential: classification.isEssential,
        isSubscription: merchantMatch.isSubscription,
        isBNPL: merchantMatch.isBNPL,
        isDebt: merchantMatch.isDebt,
        isIncome,
        isTransfer: false, // Merchant DB match overrides person-name heuristic
        isRefund,
        isSavings,
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
          isSavings,
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

    return {
      ...tx,
      merchant: tx.description,
      category,
      isEssential,
      isSubscription: false,
      isBNPL: false,
      isDebt: false,
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
      return { source, frequency, avgAmount, monthly, isSalary, count: txs.length, avgInterval: avgInt };
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

    // Subscriptions — attach actual merchant names
    if (m.subscriptionCount >= T.subscriptionMinCount) {
      const subNames = subs.map((s) => s.merchant).filter(Boolean);
      const cutCount = Math.max(2, Math.round(m.subscriptionCount * T.subscriptionCutPct));
      const saving = Math.round(p.subscriptions * T.subscriptionCutPct);
      moves.push({
        action: `Cancel or downgrade ${cutCount} subscriptions to free \u00a3${saving}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        category: 'spending',
        merchants: subNames,
        strategy: `${m.subscriptionCount} active subscriptions costing \u00a3${Math.round(p.subscriptions)}/month total.`,
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
    // Check connected debt accounts for utilization rates
    const connectedDebts = debtAccounts || [];
    const totalLimit = connectedDebts.reduce((s: number, d: any) => s + (d.credit_limit || 0), 0);
    const totalBalance = connectedDebts.reduce((s: number, d: any) => s + (d.outstanding_balance || 0), 0);
    const overallUtil = totalLimit > 0 ? (totalBalance / totalLimit) * 100 : -1;
    const isGoodDebt = overallUtil >= 0 && overallUtil <= 30;
    const isMediumUtil = overallUtil > 30 && overallUtil <= 75;
    const isHighUtil = overallUtil > 75;

    // Debt snowball — only for bad/medium debt, not for good debt users
    if (m.debtAccountCount >= 2) {
      const debtMerchants = this._getMerchantsByCategory(txs, 'Debt Payments');
      if (isGoodDebt) {
        // Low utilization, paying on time — good debt for points
        moves.push({
          action: `Maximise credit card rewards across ${m.debtAccountCount} cards`,
          annualImpact: Math.round(totalBalance * 0.02), // ~2% rewards
          monthlyImpact: Math.round(totalBalance * 0.02 / 12),
          effort: 'low',
          category: 'savings',
          merchants: debtMerchants,
          strategy: `${m.debtAccountCount} credit cards with ${Math.round(overallUtil)}% utilisation — well managed. Focus on maximising points and cashback.`,
          steps: ['Route all regular spending through your rewards card', 'Always pay in full to avoid interest', 'Review whether your card gives the best rewards for your spend', 'I\'ll flag if utilisation creeps up'],
          effect: `Earn more from spending you're already doing.`,
        });
      } else {
        const debtSaving = Math.round(p.debtPayments * T.debtSnowballSavePct);
        moves.push({
          action: `Attack ${m.debtAccountCount} debts with snowball method`,
          annualImpact: debtSaving * 12,
          monthlyImpact: debtSaving,
          effort: 'high',
          category: 'debt',
          merchants: debtMerchants,
          strategy: `${m.debtAccountCount} debt accounts costing \u00a3${Math.round(p.debtPayments)}/month.${isHighUtil ? ` Utilisation at ${Math.round(overallUtil)}% — this is hurting your credit score.` : ''}`,
          steps: ['List all debts smallest to largest', 'Pay minimums on all but smallest', 'Direct your surplus at the smallest debt first', 'When it\'s cleared, I\'ll roll payments into the next one'],
          effect: `Saves \u00a3${debtSaving * 12}/year in interest.`,
        });
      }
    }

    // Single debt account
    if (m.debtAccountCount === 1) {
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

    // ── High-level intelligent moves for financially healthy users ──
    if (m.savingsRate >= 20 && m.debtAccountCount <= 1 && (isGoodDebt || m.debtAccountCount === 0)) {
      // ISA maximization
      const isaLimit = 20000;
      const annualSurplus = Math.round(p.surplus * 12);
      if (annualSurplus > 3000) {
        const isaContribution = Math.min(annualSurplus, isaLimit);
        const isaReturn = Math.round(isaContribution * 0.05); // ~5% return estimate
        moves.push({
          action: `Max out your ISA with \u00a3${Math.round(isaContribution / 12)}/month tax-free`,
          annualImpact: isaReturn,
          monthlyImpact: Math.round(isaReturn / 12),
          effort: 'low',
          category: 'invest',
          merchants: [],
          strategy: `You have \u00a3${Math.round(p.surplus)}/month surplus and a ${Math.round(m.savingsRate)}% savings rate. Your ISA allowance is \u00a3${isaLimit.toLocaleString()}/year — this grows tax-free.`,
          steps: ['Open a Stocks & Shares ISA if you don\'t have one', 'Set up monthly direct debit on payday', 'Choose a global index fund for long-term growth', 'I\'ll track your ISA utilisation'],
          effect: `\u00a3${isaReturn.toLocaleString()}/year in tax-free returns (estimated at 5%).`,
        });
      }

      // Salary sacrifice pension
      if (p.income > 2500) {
        const pensionExtra = Math.round(p.surplus * 0.15);
        const taxRelief = Math.round(pensionExtra * 0.25); // Basic rate relief
        moves.push({
          action: `Boost pension by \u00a3${pensionExtra}/month via salary sacrifice`,
          annualImpact: taxRelief * 12,
          monthlyImpact: taxRelief,
          effort: 'medium',
          category: 'invest',
          merchants: [],
          strategy: `Salary sacrifice reduces your taxable income. Every \u00a3100 you contribute costs you \u00a3${p.income > 4167 ? '60' : '80'} after tax relief. Free money from HMRC.`,
          steps: ['Check your employer\'s salary sacrifice scheme', 'Calculate how much extra you can afford', 'Request the change through HR/payroll', 'I\'ll factor the reduced take-home into your budget'],
          effect: `\u00a3${(taxRelief * 12).toLocaleString()}/year in tax relief + employer NI savings.`,
        });
      }

      // Premium bonds for emergency fund
      if (p.surplus > 200) {
        moves.push({
          action: 'Move emergency fund to Premium Bonds for tax-free prizes',
          annualImpact: Math.round(p.surplus * 12 * 0.04),
          monthlyImpact: Math.round(p.surplus * 0.04),
          effort: 'low',
          category: 'savings',
          merchants: [],
          strategy: `Your emergency fund can work harder. Premium Bonds offer prize rates equivalent to ~4% — all tax-free. Max \u00a350,000.`,
          steps: ['Open an NS&I account if you don\'t have one', 'Transfer your emergency fund into Premium Bonds', 'Keep 1 month of expenses in easy access for true emergencies', 'I\'ll track any prizes you win'],
          effect: 'Tax-free returns on money you\'d keep in savings anyway.',
        });
      }

      // Income growth / career move
      if (p.income > 0) {
        const raiseTarget = Math.round(p.income * 0.1);
        moves.push({
          action: `Target a \u00a3${raiseTarget}/month raise or income boost`,
          annualImpact: raiseTarget * 12,
          monthlyImpact: raiseTarget,
          effort: 'high',
          category: 'savings',
          merchants: [],
          strategy: `Your spending is well-managed. The biggest lever now is increasing income. A 10% raise or side income would add \u00a3${raiseTarget}/month.`,
          steps: ['Research market rate for your role on Glassdoor/LinkedIn', 'Document your achievements for a pay review conversation', 'Consider freelance or side income opportunities', 'I\'ll model the impact of any income change on your goals'],
          effect: `\u00a3${(raiseTarget * 12).toLocaleString()}/year extra to invest, save, or enjoy.`,
        });
      }

      // Smart spending: cashback & rewards optimization
      moves.push({
        action: 'Optimise cashback and rewards across all spending',
        annualImpact: Math.round(p.spending * 12 * 0.015),
        monthlyImpact: Math.round(p.spending * 0.015),
        effort: 'low',
        category: 'savings',
        merchants: [],
        strategy: `You spend \u00a3${Math.round(p.spending)}/month. Even 1-2% back across all spending adds up to \u00a3${Math.round(p.spending * 12 * 0.015)}/year.`,
        steps: ['Use a rewards credit card for all spending and pay in full', 'Stack cashback sites (TopCashback/Quidco) for online purchases', 'Review if your current cards offer the best rewards for your categories', 'I\'ll track your rewards earnings'],
        effect: `\u00a3${Math.round(p.spending * 12 * 0.015)}/year in cashback and rewards.`,
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

    console.log(`[enrichment] Metrics: ${total} transactions — ${high} high (${total > 0 ? Math.round((high / total) * 100) : 0}%), ${medium} medium, ${low} low. Other rate: ${metrics.otherRate}%`);
    console.log(`[enrichment] Sources: override=${bySource.userOverride}, merchant_db=${bySource.merchantDb}, fuzzy=${bySource.fuzzyMatch}, keyword=${bySource.keyword}, unresolved=${bySource.unresolved}`);

    return metrics;
  },
};

export default EnrichmentEngine;
