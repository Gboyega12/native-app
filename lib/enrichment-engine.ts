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

  buildProfile(transactions: EnrichedTransaction[], recurring: RecurringItem[]): FinancialProfile {
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

    // Subscriptions: specific names, specific amounts
    if (m.subscriptionCount >= 4) {
      const cutCount = Math.max(2, Math.round(m.subscriptionCount * 0.3));
      const saving = Math.round(p.subscriptions * 0.3);
      const annualSave = saving * 12;
      moves.push({
        action: `Cancel or downgrade ${cutCount} subscriptions to free \u00a3${saving}/month`,
        annualImpact: annualSave,
        monthlyImpact: saving,
        effort: 'low',
        timeline: `\u00a3${annualSave} back in your pocket this year`,
        strategy: `You have ${m.subscriptionCount} active subscriptions costing \u00a3${Math.round(p.subscriptions)}/month. Cut ${cutCount} to reclaim \u00a3${saving}/month immediately.`,
        steps: [
          `Review all ${m.subscriptionCount} subscriptions — cancel any unused in the last 2 weeks`,
          'Keep one streaming service at a time — rotate monthly',
          `Set a hard cap of \u00a3${Math.round(p.subscriptions * 0.7)}/month on subscriptions`,
        ],
        effect: `Saves \u00a3${saving}/month (\u00a3${annualSave}/year) with 15 minutes of work.`,
      });
    }

    // Food delivery: specific targets
    if (m.foodDelivery > 50) {
      const saving = Math.round(m.foodDelivery * 0.4);
      const targetSpend = Math.round(m.foodDelivery - saving);
      const annualSave = saving * 12;
      moves.push({
        action: `Cut delivery spend from \u00a3${Math.round(m.foodDelivery)} to \u00a3${targetSpend}/month`,
        annualImpact: annualSave,
        monthlyImpact: saving,
        effort: 'medium',
        timeline: `Save \u00a3${annualSave} over the next 12 months`,
        strategy: `You're spending \u00a3${Math.round(m.foodDelivery)}/month on food delivery. Batch-cook twice a week and cap delivery at \u00a3${targetSpend}/month.`,
        steps: [
          'Batch-cook 2 meals every Sunday — covers 4 weeknight dinners',
          'Delete saved payment cards from Deliveroo/UberEats/JustEat',
          `Set a strict \u00a3${targetSpend}/month delivery budget — track it weekly`,
        ],
        effect: `Frees \u00a3${saving}/month (\u00a3${annualSave}/year) and improves your diet.`,
      });
    }

    // Eating out: specific reduction
    if (m.eatingOut > 80) {
      const saving = Math.round(m.eatingOut * 0.25);
      const targetSpend = Math.round(m.eatingOut - saving);
      const annualSave = saving * 12;
      moves.push({
        action: `Reduce dining out from \u00a3${Math.round(m.eatingOut)} to \u00a3${targetSpend}/month`,
        annualImpact: annualSave,
        monthlyImpact: saving,
        effort: 'medium',
        timeline: `\u00a3${annualSave} saved over the next year`,
        strategy: `You're spending \u00a3${Math.round(m.eatingOut)}/month eating out. Drop one meal out per week and bring coffee from home twice.`,
        steps: [
          'Replace one restaurant meal per week with a home-cooked alternative',
          `Bring coffee from home 2x/week — saves ~\u00a3${Math.round(m.coffeeAndCafes * 0.4 || 15)}/month alone`,
          `Cap restaurant/caf\u00e9 spending at \u00a3${targetSpend}/month`,
        ],
        effect: `Keeps your social life intact while saving \u00a3${saving}/month.`,
      });
    }

    // Shopping: specific cap with timeline
    if (m.shopping > 150) {
      const saving = Math.round(m.shopping * 0.25);
      const targetSpend = Math.round(m.shopping - saving);
      const annualSave = saving * 12;
      moves.push({
        action: `Cap non-essential shopping at \u00a3${targetSpend}/month to save \u00a3${saving}`,
        annualImpact: annualSave,
        monthlyImpact: saving,
        effort: 'low',
        timeline: `\u00a3${annualSave} redirected to your goals this year`,
        strategy: `You're spending \u00a3${Math.round(m.shopping)}/month on shopping. A 24-hour rule on purchases over \u00a330 cuts impulse buys by 25%.`,
        steps: [
          'Remove saved cards from all shopping apps',
          'Add items to a wishlist — only buy after 24 hours',
          'Unsubscribe from all marketing emails this week',
        ],
        effect: `Reduces impulse spending by 25%, saving \u00a3${saving}/month.`,
      });
    }

    // Debt snowball: specific amounts and timeline
    if (m.debtAccountCount >= 2) {
      const debtSaving = Math.round(p.debtPayments * 0.15);
      const annualSave = debtSaving * 12;
      moves.push({
        action: `Attack ${m.debtAccountCount} debts with snowball — free \u00a3${debtSaving}/month in interest`,
        annualImpact: annualSave,
        monthlyImpact: debtSaving,
        effort: 'high',
        timeline: `Clear smallest debt first, then roll payments into the next`,
        strategy: `You have ${m.debtAccountCount} debt accounts costing \u00a3${Math.round(p.debtPayments)}/month. Pay minimums on all except the smallest — throw every spare pound at it.`,
        steps: [
          'List all debts from smallest balance to largest',
          'Pay minimums on everything except the smallest debt',
          `Redirect \u00a3${Math.round(p.surplus > 0 ? Math.min(p.surplus, 200) : 50)}/month extra at the smallest balance`,
          'When cleared, roll that payment into the next smallest',
        ],
        effect: `Saves \u00a3${annualSave}/year in interest and builds momentum toward debt freedom.`,
      });
    }

    // Transport: specific savings
    if (m.transport > 100) {
      const saving = Math.round(m.transport * 0.2);
      const annualSave = saving * 12;
      moves.push({
        action: `Cut transport from \u00a3${Math.round(m.transport)} to \u00a3${Math.round(m.transport - saving)}/month`,
        annualImpact: annualSave,
        monthlyImpact: saving,
        effort: 'medium',
        timeline: `\u00a3${annualSave} saved over 12 months`,
        strategy: `You're spending \u00a3${Math.round(m.transport)}/month on transport. A railcard, weekly cap, or one car-free day per week cuts this by 20%.`,
        steps: [
          'Check if a railcard or weekly Oyster cap saves money vs daily fares',
          'Go car-free or ride-free one day per week',
          'Compare annual vs monthly ticket pricing — annual saves 10-15%',
        ],
        effect: `Reduces a major fixed cost by \u00a3${saving}/month without changing your commute.`,
      });
    }

    // Emergency buffer: specific target and timeline
    if (m.savingsRate < 10 && p.surplus > 0) {
      const autoSave = Math.round(p.surplus * 0.5);
      const bufferTarget = Math.max(500, Math.round(p.spending));
      const monthsToTarget = autoSave > 0 ? Math.ceil(bufferTarget / autoSave) : 0;
      const annualSave = autoSave * 12;
      moves.push({
        action: `Auto-save \u00a3${autoSave}/month to build \u00a3${bufferTarget} buffer in ${monthsToTarget} months`,
        annualImpact: annualSave,
        monthlyImpact: autoSave,
        effort: 'low',
        timeline: `\u00a3${bufferTarget} emergency fund in ${monthsToTarget} months`,
        strategy: `Your savings rate is only ${Math.round(m.savingsRate)}%. Auto-transfer \u00a3${autoSave} to a separate pot on payday — before you can spend it.`,
        steps: [
          'Open a separate instant-access savings pot today',
          `Set up a \u00a3${autoSave} standing order for the day after payday`,
          `Target \u00a3${bufferTarget} (1 month of expenses) — then build to 3 months`,
        ],
        effect: `\u00a3${bufferTarget} safety net in ${monthsToTarget} months — no more relying on credit for emergencies.`,
      });
    }

    // High savers: specific interest gains
    if (m.savingsRate >= 15) {
      const surplusAnnual = Math.round(p.surplus * 12);
      const interestGain = Math.round(surplusAnnual * 0.045);
      const monthlyGain = Math.round(interestGain / 12);
      moves.push({
        action: `Move \u00a3${Math.round(p.surplus)}/month surplus to 4.5% savings — earn \u00a3${interestGain}/year`,
        annualImpact: interestGain,
        monthlyImpact: monthlyGain,
        effort: 'low',
        timeline: `\u00a3${interestGain} in interest over the next 12 months`,
        strategy: `You're saving well (${Math.round(m.savingsRate)}% rate). Make your surplus work harder — a 4.5% easy-access account or S&S ISA adds \u00a3${interestGain}/year passively.`,
        steps: [
          'Open a high-interest easy-access account (Chase, Chip, or Monzo offer 4%+)',
          `Auto-transfer \u00a3${Math.round(p.surplus)} on payday`,
          'Consider a stocks & shares ISA for any savings you won\'t need for 5+ years',
        ],
        effect: `\u00a3${interestGain}/year in passive interest — compounding from day one.`,
      });
    }

    // Coffee specific move if spending is high
    if (m.coffeeAndCafes > 40) {
      const saving = Math.round(m.coffeeAndCafes * 0.5);
      const annualSave = saving * 12;
      moves.push({
        action: `Halve caf\u00e9 spending from \u00a3${Math.round(m.coffeeAndCafes)} to \u00a3${Math.round(m.coffeeAndCafes - saving)}/month`,
        annualImpact: annualSave,
        monthlyImpact: saving,
        effort: 'low',
        timeline: `\u00a3${annualSave} saved this year`,
        strategy: `You're spending \u00a3${Math.round(m.coffeeAndCafes)}/month on coffee and caf\u00e9s. Bring coffee from home 3 days a week to halve this.`,
        steps: [
          'Buy a reusable cup and make coffee at home 3 mornings per week',
          'Keep one "treat" coffee day per week — make it intentional',
          `Track caf\u00e9 spending weekly to stay under \u00a3${Math.round(m.coffeeAndCafes - saving)}/month`,
        ],
        effect: `Saves \u00a3${saving}/month without giving up coffee entirely.`,
      });
    }

    moves.sort((a, b) => b.annualImpact - a.annualImpact);
    return moves;
  },
};

export default EnrichmentEngine;
