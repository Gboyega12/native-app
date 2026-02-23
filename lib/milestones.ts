import type { Analysis } from './types';

// ── Milestone definitions ──

export interface MilestoneContent {
  id: string;
  day: number;
  title: string;
  /** Personalised insight line — generated from analysis data */
  insight: string;
  /** Additional detail for Pro subscribers */
  proDetail: string | null;
  /** CTA label */
  cta: string;
  /** Where the CTA navigates */
  ctaRoute: 'plan' | 'chat' | 'paywall';
}

/**
 * Returns the highest-priority milestone that hasn't been dismissed.
 * Checks in reverse order (day 15 → 7 → 3) so older milestones are
 * replaced by newer ones automatically.
 */
export function getActiveMilestone(
  daysSinceFirstAnalysis: number,
  analysis: Analysis | null,
  isPro: boolean,
  dismissed: Set<string>,
): MilestoneContent | null {
  if (!analysis) return null;

  // Check from highest to lowest — show the most recent applicable
  if (daysSinceFirstAnalysis >= 15 && !dismissed.has('day_15')) {
    return buildDay15(analysis, isPro);
  }
  if (daysSinceFirstAnalysis >= 7 && !dismissed.has('day_7')) {
    return buildDay7(analysis, isPro);
  }
  if (daysSinceFirstAnalysis >= 3 && !dismissed.has('day_3')) {
    return buildDay3(analysis, isPro);
  }
  return null;
}

// ── Day 3: "Your Money Snapshot" ──

function buildDay3(a: Analysis, isPro: boolean): MilestoneContent {
  const topCategory = getTopSpendingCategory(a);
  const subCount = countSubscriptions(a);
  const income = Math.round(a.monthly_income || 0);

  const insight = topCategory
    ? `Your biggest spend is ${topCategory.category} at \u00a3${topCategory.monthly}/mo.${subCount > 0 ? ` ${subCount} active subscriptions detected.` : ''}`
    : `Bocy is tracking \u00a3${income.toLocaleString()}/mo income across your accounts.`;

  const proDetail = isPro
    ? `Your spending archetype is "${formatArchetype(a.archetype)}". ${a.behavioral_patterns?.[0] || ''}`
    : null;

  return {
    id: 'day_3',
    day: 3,
    title: 'Your money snapshot',
    insight,
    proDetail,
    cta: isPro ? 'See your full plan' : 'Unlock your full analysis',
    ctaRoute: isPro ? 'plan' : 'paywall',
  };
}

// ── Day 7: "Your First Week" ──

function buildDay7(a: Analysis, isPro: boolean): MilestoneContent {
  const score = a.decision_score || 0;
  const surplus = Math.round(a.surplus || 0);
  const moveCount = a.all_moves?.length || 0;
  const topMove = a.all_moves?.[0];

  const insight = `Your decision score is ${score}/100. ${
    surplus >= 0
      ? `You have \u00a3${surplus.toLocaleString()}/mo surplus.`
      : `You're \u00a3${Math.abs(surplus).toLocaleString()}/mo over budget.`
  }${moveCount > 0 ? ` ${moveCount} moves waiting for you.` : ''}`;

  const proDetail = isPro && topMove
    ? `Your #1 move "${stripMd(topMove.action)}" could save \u00a3${(topMove.annualImpact || 0).toLocaleString()}/yr.`
    : null;

  return {
    id: 'day_7',
    day: 7,
    title: 'Your first week',
    insight,
    proDetail,
    cta: isPro ? 'Review your moves' : 'Unlock personalised moves',
    ctaRoute: isPro ? 'plan' : 'paywall',
  };
}

// ── Day 15: "Two Week Check-in" ──

function buildDay15(a: Analysis, isPro: boolean): MilestoneContent {
  const totalTracked = Math.round((a.monthly_spending || 0) + (a.monthly_income || 0));
  const moveCount = a.all_moves?.length || 0;
  const totalAnnualImpact = (a.all_moves || []).reduce((sum, m) => sum + (m.annualImpact || 0), 0);
  const goalContext = a.goal_context;

  const insight = `Bocy has tracked \u00a3${totalTracked.toLocaleString()} in monthly flow.${
    totalAnnualImpact > 0
      ? ` Following all ${moveCount} moves would save \u00a3${totalAnnualImpact.toLocaleString()}/yr.`
      : ''
  }`;

  const proDetail = isPro && goalContext
    ? `Goal: ${goalContext.goalLabel || 'your target'}. ${goalContext.insight || `Estimated ${goalContext.currentMonths || '?'} months at current pace.`}`
    : null;

  return {
    id: 'day_15',
    day: 15,
    title: 'Two week check-in',
    insight,
    proDetail,
    cta: isPro ? 'Ask Bocy for a strategy update' : 'Unlock goal tracking',
    ctaRoute: isPro ? 'chat' : 'paywall',
  };
}

// ── Helpers ──

function getTopSpendingCategory(a: Analysis): { category: string; monthly: number } | null {
  const items = [
    ...(a.non_discretionary?.items || []),
    ...(a.discretionary?.items || []),
  ];
  if (items.length === 0) return null;
  items.sort((x, y) => (y.monthly || 0) - (x.monthly || 0));
  return { category: items[0].category, monthly: Math.round(items[0].monthly) };
}

function countSubscriptions(a: Analysis): number {
  const items = a.discretionary?.items || [];
  const subItems = items.filter(
    (item: { category: string }) =>
      item.category === 'Subscriptions' || item.category === 'Streaming',
  );
  return subItems.reduce((n: number, item: { txs?: number }) => n + (item.txs || 1), 0);
}

function formatArchetype(archetype: string | undefined): string {
  if (!archetype) return 'Unclassified';
  return archetype
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripMd(s: string): string {
  return (s || '').replace(/\*\*/g, '');
}
