import {
  matchMerchant, isPersonTransfer,
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
  enrich(rawCSV: string, overrides?: TransactionOverride[]): EnrichmentResult {
    const transactions = this.parseCSV(rawCSV);
    const enriched = transactions.map((tx) => this.enrichTransaction(tx, overrides));
    const recurring = this.detectRecurring(enriched);
    const profile = this.buildProfile(enriched, recurring);
    const archetype = this.determineArchetype(profile);
    const patterns = this.detectBehavioralPatterns(profile);
    const score = this.calcDecisionScore(profile);
    const stack = this.genDecisionStack(profile, enriched);

    const metrics = profile.metrics;
    const traits = Object.values(SUB_TRAITS).filter((t) => t.test(metrics, profile));
    const strengths = STRENGTH_RULES.filter((r) => r.test(metrics));
    const blindSpots = BLINDSPOT_RULES.filter((r) => r.test(metrics));

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
    // Check user overrides first — short-circuit if matched
    if (overrides?.length) {
      const descLower = tx.description.toLowerCase();
      const override = overrides.find((o) => descLower.includes(o.match_description.toLowerCase()));
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
      };
    }

    // No merchant match — classify via keyword fallback or default
    let isIncome = false;
    let category = 'Other';
    let isEssential = false;
    let confidence: EnrichedTransaction['confidence'] = 'low';

    if (isCredit) {
      if (isRefund) {
        category = 'Refunds';
      } else if (isPerson) {
        category = 'Transfers';
      } else if (isLikelyIncomeCredit(tx.description)) {
        isIncome = true;
        category = 'Income';
        confidence = 'high';
      } else {
        // Unknown credit — tentative income, validated in buildProfile
        isIncome = true;
        category = 'Income';
      }
    } else if (isSavings) {
      category = 'Savings';
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
      } else if (isPerson) {
        category = 'Transfers';
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
      else if (avgInterval >= 340 && avgInterval <= 400) frequency = 'annual';

      if (frequency !== 'irregular') {
        const avgAmount = Math.abs(txs.reduce((s, t) => s + t.amount, 0) / txs.length);
        recurring.push({
          merchant,
          frequency,
          averageAmount: avgAmount,
          category: txs[0].category,
          isSubscription: txs[0].isSubscription || frequency === 'monthly',
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
    const income = recent.filter((t) => t.isIncome && !t.isRefund && !t.isTransfer);

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
      if (src.isSalary || isLikelyIncomeCredit(src.source)) return true;
      if (src.frequency !== 'irregular' && src.avgAmount >= INCOME_THRESHOLDS.minRegularAmount) return true;
      if (
        src.avgAmount >= INCOME_THRESHOLDS.largeCreditMin &&
        src.count >= INCOME_THRESHOLDS.largeCreditMinCount &&
        src.avgInterval >= INCOME_THRESHOLDS.largeCreditIntervalMin &&
        src.avgInterval <= INCOME_THRESHOLDS.largeCreditIntervalMax
      ) return true;
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

  genDecisionStack(profile: FinancialProfile, enrichedTxs?: EnrichedTransaction[]): Move[] {
    const moves: Move[] = [];
    const m = profile.metrics;
    const p = profile.monthly;
    const subs = profile.subscriptions || [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - ANALYSIS_MONTHS);
    const txs = (enrichedTxs || []).filter((t) => new Date(t.date) >= cutoff);
    const T = MOVE_THRESHOLDS;

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
        steps: ['Review all subscriptions', 'Cancel unused ones', 'Rotate streaming services monthly'],
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
        steps: ['Batch-cook twice a week', 'Delete saved payment cards from delivery apps', 'Set a monthly delivery budget cap'],
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

    // Debt snowball
    if (m.debtAccountCount >= 2) {
      const debtSaving = Math.round(p.debtPayments * T.debtSnowballSavePct);
      const debtMerchants = this._getMerchantsByCategory(txs, 'Debt Payments');
      moves.push({
        action: `Attack ${m.debtAccountCount} debts with snowball method`,
        annualImpact: debtSaving * 12,
        monthlyImpact: debtSaving,
        effort: 'high',
        category: 'debt',
        merchants: debtMerchants,
        strategy: `${m.debtAccountCount} debt accounts costing \u00a3${Math.round(p.debtPayments)}/month.`,
        steps: ['List all debts smallest to largest', 'Pay minimums on all but smallest', 'Throw surplus at smallest debt first', 'Roll payments into next debt when cleared'],
        effect: `Saves \u00a3${debtSaving * 12}/year in interest.`,
      });
    }

    // Single debt account
    if (m.debtAccountCount === 1) {
      const debtSaving = Math.round(p.debtPayments * T.singleDebtOverpayPct);
      const debtMerchants = this._getMerchantsByCategory(txs, 'Debt Payments');
      const overpay = Math.round(Math.min(p.surplus * T.singleDebtOverpayMaxSurplusPct, T.singleDebtOverpayCap));
      moves.push({
        action: `Overpay debt by \u00a3${overpay}/month to clear faster`,
        annualImpact: debtSaving * 12,
        monthlyImpact: debtSaving,
        effort: 'medium',
        category: 'debt',
        merchants: debtMerchants,
        strategy: `1 debt account with \u00a3${Math.round(p.debtPayments)}/month in payments.`,
        steps: ['Check if overpayments are allowed without penalty', 'Set up a monthly overpayment standing order', 'Redirect any savings from other moves into debt payoff'],
        effect: `Reduces total interest paid and clears debt sooner.`,
      });
    }

    // Transport
    if (m.transport > T.transportMin) {
      const saving = Math.round(m.transport * T.transportCutPct);
      const transportMerchants = this._getMerchantsByCategory(txs, 'Transport');
      moves.push({
        action: `Cut transport from \u00a3${Math.round(m.transport)} to \u00a3${Math.round(m.transport - saving)}/month`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        category: 'spending',
        merchants: transportMerchants,
        strategy: `\u00a3${Math.round(m.transport)}/month on transport.`,
        steps: ['Check railcard or weekly cap options', 'Go car-free one day per week', 'Compare annual vs monthly tickets'],
        effect: `Saves \u00a3${saving}/month.`,
      });
    }

    // Emergency buffer
    if (m.savingsRate < T.bufferSavingsRateThreshold && p.surplus > 0) {
      const autoSave = Math.round(p.surplus * T.bufferAutoSavePct);
      const bufferTarget = Math.max(T.bufferMinTarget, Math.round(p.spending));
      const monthsToTarget = autoSave > 0 ? Math.ceil(bufferTarget / autoSave) : 0;
      moves.push({
        action: `Auto-save \u00a3${autoSave}/month to build \u00a3${bufferTarget} buffer in ${monthsToTarget} months`,
        annualImpact: autoSave * 12,
        monthlyImpact: autoSave,
        effort: 'low',
        category: 'buffer',
        merchants: [],
        strategy: `Savings rate is ${Math.round(m.savingsRate)}%. Monthly surplus is \u00a3${Math.round(p.surplus)}.`,
        steps: ['Open a separate savings pot', 'Set up standing order on payday', 'Target 1 month of expenses, then build to 3'],
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
        steps: ['Open a separate savings account with the best rate you can find', 'Auto-transfer surplus on payday', 'Review rates every 6 months and switch if needed'],
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
        steps: ['Make coffee at home 3 mornings per week', 'Keep one treat coffee day', 'Track weekly spending'],
        effect: `Saves \u00a3${saving}/month.`,
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
  rebuild(enriched: EnrichedTransaction[]): EnrichmentResult {
    const recurring = this.detectRecurring(enriched);
    const profile = this.buildProfile(enriched, recurring);
    const archetype = this.determineArchetype(profile);
    const patterns = this.detectBehavioralPatterns(profile);
    const score = this.calcDecisionScore(profile);
    const stack = this.genDecisionStack(profile, enriched);

    const metrics = profile.metrics;
    const traits = Object.values(SUB_TRAITS).filter((t) => t.test(metrics, profile));
    const strengths = STRENGTH_RULES.filter((r) => r.test(metrics));
    const blindSpots = BLINDSPOT_RULES.filter((r) => r.test(metrics));

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
    };
  },

  _getMerchantsByCategory(txs: EnrichedTransaction[], category: string): string[] {
    const counts: Record<string, number> = {};
    for (const t of txs) {
      if (t.category === category && !t.isIncome && !t.isTransfer && !t.isRefund) {
        counts[t.merchant] = (counts[t.merchant] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);
  },
};

export default EnrichmentEngine;
