import { matchMerchant, isPersonTransfer } from './merchant-db';
import { ARCHETYPES, SUB_TRAITS, STRENGTH_RULES, BLINDSPOT_RULES } from './archetypes';
import { UK_BENCHMARKS, ESSENTIAL_CATEGORIES } from './constants';
import type {
  RawTransaction,
  EnrichedTransaction,
  RecurringItem,
  FinancialProfile,
  Archetype,
  DecisionScore,
  Move,
  EnrichmentResult,
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

const EnrichmentEngine = {
  enrich(rawCSV: string): EnrichmentResult {
    const transactions = this.parseCSV(rawCSV);
    const enriched = transactions.map((tx) => this.enrichTransaction(tx));
    const recurring = this.detectRecurring(enriched);
    const profile = this.buildProfile(enriched, recurring);
    const archetype = this.determineArchetype(profile);
    const patterns = this.detectBehavioralPatterns(profile);
    const score = this.calcDecisionScore(profile);
    const stack = this.genDecisionStack(profile);

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
    const descIdx = cols.findIndex((c) => c.includes('desc') || c.includes('narr') || c.includes('memo') || c.includes('reference'));
    const amountIdx = cols.findIndex((c) => c === 'amount' || c.includes('amount'));
    const debitIdx = cols.findIndex((c) => c.includes('debit'));
    const creditIdx = cols.findIndex((c) => c.includes('credit'));

    const transactions: RawTransaction[] = [];
    const now = new Date();
    const fourMonthsAgo = new Date(now);
    fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = splitCSVLine(line);
      const dateStr = parts[dateIdx >= 0 ? dateIdx : 0] || '';
      const desc = parts[descIdx >= 0 ? descIdx : 1] || '';
      const date = parseDate(dateStr);
      if (!date || date < fourMonthsAgo) continue;

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

  enrichTransaction(tx: RawTransaction): EnrichedTransaction {
    const match = matchMerchant(tx.description);
    const isPerson = isPersonTransfer(tx.description);
    const isIncome = tx.amount > 0;
    const isRefund = isIncome && tx.description.toLowerCase().includes('refund');
    const isSavings = !!(tx.description.toLowerCase().match(/\bsaving|isa\b/i) && tx.amount < 0);

    if (match) {
      return {
        ...tx,
        merchant: match.merchant,
        category: isIncome && !match.isIncome ? 'Refunds' : match.category,
        isSubscription: match.isSubscription,
        isBNPL: match.isBNPL,
        isDebt: match.isDebt,
        isIncome: match.isIncome || isIncome,
        isTransfer: isPerson,
        isRefund,
        isSavings,
        confidence: 'high',
      };
    }

    let category = 'Other';
    if (isIncome) category = isRefund ? 'Refunds' : 'Income';
    else if (isPerson) category = 'Transfers';
    else if (isSavings) category = 'Savings';

    return {
      ...tx,
      merchant: tx.description,
      category,
      isSubscription: false,
      isBNPL: false,
      isDebt: false,
      isIncome,
      isTransfer: isPerson,
      isRefund,
      isSavings,
      confidence: 'low',
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

  buildProfile(transactions: EnrichedTransaction[], recurring: RecurringItem[]): any {
    const spending = transactions.filter((t) => t.amount < 0 && !t.isTransfer && !t.isRefund && !t.isSavings);
    const income = transactions.filter((t) => t.isIncome && !t.isRefund);

    const dates = transactions.map((t) => new Date(t.date).getTime()).filter(Boolean);
    const span = dates.length >= 2
      ? (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24 * 30)
      : 1;
    const months = Math.max(span, 1);

    const totalIncome = income.reduce((s, t) => s + t.amount, 0);
    const totalSpending = Math.abs(spending.reduce((s, t) => s + t.amount, 0));
    const monthlyIncome = totalIncome / months;
    const monthlySpending = totalSpending / months;
    const surplus = monthlyIncome - monthlySpending;

    const catTotals: Record<string, { total: number; count: number }> = {};
    for (const tx of spending) {
      const cat = tx.category || 'Other';
      if (!catTotals[cat]) catTotals[cat] = { total: 0, count: 0 };
      catTotals[cat].total += Math.abs(tx.amount);
      catTotals[cat].count++;
    }

    const nonDiscItems: any[] = [];
    const discItems: any[] = [];
    for (const [cat, d] of Object.entries(catTotals)) {
      const item = { category: cat, monthly: d.total / months, txs: d.count };
      if (ESSENTIAL_CATEGORIES.has(cat)) nonDiscItems.push(item);
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
      const isSalary = source.toLowerCase().includes('salary') || source.toLowerCase().includes('payroll');
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
      return { source, frequency, avgAmount, monthly, isSalary };
    });

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
      foodDelivery: catMonthly('Food Delivery'),
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
        nonDiscretionary: { total: nonDiscTotal, items: nonDiscItems.sort((a: any, b: any) => b.monthly - a.monthly) },
        discretionary: { total: discTotal, items: discItems.sort((a: any, b: any) => b.monthly - a.monthly) },
      },
      incomeSources,
      subscriptions,
      metrics,
    };
  },

  determineArchetype(profile: any): Archetype {
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

  detectBehavioralPatterns(profile: any): { pattern: string; detail: string }[] {
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

  calcDecisionScore(profile: any): DecisionScore {
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

    const hasSalary = profile.incomeSources.some((s: any) => s.isSalary);
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

  genDecisionStack(profile: any): Move[] {
    const moves: Move[] = [];
    const m = profile.metrics;
    const p = profile.monthly;

    if (m.subscriptionCount >= 4) {
      const saving = Math.round(p.subscriptions * 0.3);
      moves.push({
        action: `Audit your ${m.subscriptionCount} subscriptions`,
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        strategy: 'Cancel unused, rotate streaming services month-to-month.',
        steps: ['List all active subscriptions', 'Cancel any unused for 2+ weeks', 'Rotate streaming services'],
        effect: 'Frees up cash for savings or debt repayment.',
      });
    }

    if (m.foodDelivery > 50) {
      const saving = Math.round(m.foodDelivery * 0.4);
      moves.push({
        action: 'Reduce food delivery spending',
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        strategy: 'Batch-cook 2 meals per week, set a delivery budget cap.',
        steps: ['Plan 2 batch-cook sessions weekly', 'Delete delivery app payment cards', 'Set \u00a330/month delivery cap'],
        effect: 'Healthier eating and significant monthly savings.',
      });
    }

    if (m.eatingOut > 80) {
      const saving = Math.round(m.eatingOut * 0.25);
      moves.push({
        action: 'Cut back on dining out',
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        strategy: 'One fewer restaurant meal per week. Swap for home-cooked.',
        steps: ['Track cafe and restaurant visits', 'Replace one outing per week with a home meal', 'Bring coffee from home twice a week'],
        effect: 'Keeps social life intact while reducing spend.',
      });
    }

    if (m.shopping > 150) {
      const saving = Math.round(m.shopping * 0.25);
      moves.push({
        action: 'Apply a 24-hour rule to non-essential purchases',
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        strategy: 'Wait 24 hours before any purchase over \u00a330.',
        steps: ['Remove saved cards from shopping apps', 'Use a wishlist \u2014 buy after 24 hours', 'Unsubscribe from marketing emails'],
        effect: 'Reduces impulse spending by 20-30%.',
      });
    }

    if (m.debtAccountCount >= 2) {
      moves.push({
        action: 'Start a debt snowball',
        annualImpact: Math.round(p.debtPayments * 0.15) * 12,
        monthlyImpact: Math.round(p.debtPayments * 0.15),
        effort: 'high',
        strategy: 'Pay minimums on all but smallest debt. Throw surplus at smallest first.',
        steps: ['List all debts smallest to largest', 'Pay minimums on all but smallest', 'Put any extra surplus into smallest debt', 'When cleared, roll payment into next smallest'],
        effect: 'Faster debt payoff with psychological momentum.',
      });
    }

    if (m.transport > 100) {
      const saving = Math.round(m.transport * 0.2);
      moves.push({
        action: 'Optimise transport costs',
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'medium',
        strategy: 'Consider weekly caps, season tickets, or cycling one day/week.',
        steps: ['Check if a weekly Oyster cap or railcard saves money', 'Try one car-free/ride-free day per week', 'Compare annual vs monthly ticket pricing'],
        effect: 'Reduces a major fixed cost.',
      });
    }

    if (m.savingsRate < 10 && p.surplus > 0) {
      const saving = Math.round(p.surplus * 0.5);
      moves.push({
        action: 'Start a \u00a3500 emergency buffer',
        annualImpact: saving * 12,
        monthlyImpact: saving,
        effort: 'low',
        strategy: 'Auto-transfer 50% of surplus to a separate savings pot on payday.',
        steps: ['Open a separate savings pot', 'Set up standing order for payday', 'Target \u00a3500 first, then 1 month of expenses'],
        effect: 'Protection against unexpected bills without taking on debt.',
      });
    }

    if (m.savingsRate >= 15) {
      moves.push({
        action: 'Optimise where your savings sit',
        annualImpact: Math.round(p.surplus * 0.04 * 12),
        monthlyImpact: Math.round(p.surplus * 0.04),
        effort: 'low',
        strategy: 'Move savings to a high-interest account or S&S ISA.',
        steps: ['Compare easy-access savings rates', 'Consider a stocks & shares ISA for long-term', 'Max out annual ISA allowance if possible'],
        effect: 'Compound growth on existing savings.',
      });
    }

    moves.sort((a, b) => b.annualImpact - a.annualImpact);
    return moves;
  },
};

export default EnrichmentEngine;
