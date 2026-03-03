import type { Analysis, BudgetCategory } from './types';

// ── Milestone definitions ──

export interface MilestoneContent {
  id: string;
  day: number;
  title: string;
  /** Personalised insight line — generated from analysis data */
  insight: string;
  /** Additional detail */
  detail: string | null;
  /** CTA label */
  cta: string;
  /** Where the CTA navigates */
  ctaRoute: 'plan' | 'chat';
}

// ── Sanity bounds ──
// If a number falls outside these ranges, the data point is suspect and we skip it.
const BOUNDS = {
  monthlyIncome: { min: 100, max: 50_000 },
  monthlySpend: { min: 10, max: 50_000 },
  merchantSpend: { min: 5, max: 10_000 },
  subscriptionCount: { min: 1, max: 25 },
  decisionScore: { min: 1, max: 100 },
  surplus: { max: 30_000 },
  moveCount: { min: 1, max: 20 },
  annualImpact: { min: 10, max: 50_000 },
};

function inBounds(val: number, bounds: { min?: number; max?: number }): boolean {
  if (bounds.min !== undefined && val < bounds.min) return false;
  if (bounds.max !== undefined && val > bounds.max) return false;
  return true;
}

/**
 * Returns the highest-priority milestone that hasn't been dismissed.
 * Returns null if the data isn't confident enough to show anything.
 */
export function getActiveMilestone(
  daysSinceFirstAnalysis: number,
  analysis: Analysis | null,
  dismissed: Set<string>,
): MilestoneContent | null {
  if (!analysis) return null;

  // Check from highest to lowest — show the most recent applicable.
  // If a builder returns null (data not reliable), skip to the next.
  let result: MilestoneContent | null = null;
  if (daysSinceFirstAnalysis >= 15 && !dismissed.has('day_15')) {
    result = buildDay15(analysis);
    if (result) return result;
  }
  if (daysSinceFirstAnalysis >= 7 && !dismissed.has('day_7')) {
    result = buildDay7(analysis);
    if (result) return result;
  }
  if (daysSinceFirstAnalysis >= 3 && !dismissed.has('day_3')) {
    result = buildDay3(analysis);
    if (result) return result;
  }
  return null;
}

// ── Day 3: "Your Money Snapshot" ──

function buildDay3(a: Analysis): MilestoneContent | null {
  const topMerchant = getTopMerchantSpend(a);
  const subCount = countSubscriptions(a);
  const income = Math.round(a.monthly_income || 0);

  // Build insight from the most specific data point we trust
  const parts: string[] = [];

  if (topMerchant && inBounds(topMerchant.monthly, BOUNDS.merchantSpend)) {
    parts.push(`Your biggest recurring spend is ${topMerchant.merchant} at \u00a3${topMerchant.monthly.toLocaleString()}/mo.`);
  }

  if (subCount > 0 && inBounds(subCount, BOUNDS.subscriptionCount)) {
    parts.push(`${subCount} subscription${subCount !== 1 ? 's' : ''} detected.`);
  }

  // If we have nothing specific, use income as the fallback
  if (parts.length === 0) {
    if (inBounds(income, BOUNDS.monthlyIncome)) {
      parts.push(`Bocy is tracking \u00a3${income.toLocaleString()}/mo income across your accounts.`);
    } else {
      // Not enough reliable data — don't show milestone
      return null;
    }
  }

  const detail = buildDetail(() => {
    const arch = a.archetype ? formatArchetype(a.archetype) : null;
    const pattern = a.behavioral_patterns?.[0]?.trim();
    if (!arch && !pattern) return null;
    const bits: string[] = [];
    if (arch) bits.push(`Your spending archetype is \u201c${arch}\u201d.`);
    if (pattern) bits.push(pattern);
    return bits.join(' ');
  });

  return {
    id: 'day_3',
    day: 3,
    title: 'Your money snapshot',
    insight: parts.join(' '),
    detail,
    cta: 'See your full plan',
    ctaRoute: 'plan',
  };
}

// ── Day 7: "Your First Week" ──

function buildDay7(a: Analysis): MilestoneContent | null {
  const score = a.decision_score || 0;
  const surplus = Math.round(a.surplus || 0);
  const moveCount = a.all_moves?.length || 0;
  const topMove = a.all_moves?.[0];

  const parts: string[] = [];

  if (inBounds(score, BOUNDS.decisionScore)) {
    parts.push(`Your decision score is ${score}/100.`);
  }

  if (surplus !== 0 && inBounds(Math.abs(surplus), BOUNDS.surplus)) {
    parts.push(
      surplus > 0
        ? `You have \u00a3${surplus.toLocaleString()}/mo surplus.`
        : `You're \u00a3${Math.abs(surplus).toLocaleString()}/mo over budget.`,
    );
  }

  if (inBounds(moveCount, BOUNDS.moveCount)) {
    parts.push(`${moveCount} move${moveCount !== 1 ? 's' : ''} waiting for you.`);
  }

  if (parts.length === 0) return null;

  const detail = buildDetail(() => {
    if (!topMove) return null;
    const action = truncate(stripMd(topMove.action), 60);
    const impact = topMove.annualImpact || 0;
    if (!action || !inBounds(impact, BOUNDS.annualImpact)) return null;
    return `Your #1 move \u201c${action}\u201d could save \u00a3${impact.toLocaleString()}/yr.`;
  });

  return {
    id: 'day_7',
    day: 7,
    title: 'Your first week',
    insight: parts.join(' '),
    detail,
    cta: 'Review your moves',
    ctaRoute: 'plan',
  };
}

// ── Day 15: "Two Week Check-in" ──

function buildDay15(a: Analysis): MilestoneContent | null {
  const income = Math.round(a.monthly_income || 0);
  const spending = Math.round(a.monthly_spending || 0);
  const moveCount = a.all_moves?.length || 0;
  const totalAnnualImpact = (a.all_moves || []).reduce(
    (sum, m) => sum + (m.annualImpact || 0), 0,
  );
  const goalContext = a.goal_context;

  const parts: string[] = [];

  // Show income + spending separately — more transparent than a combined "flow" number
  if (inBounds(income, BOUNDS.monthlyIncome) && inBounds(spending, BOUNDS.monthlySpend)) {
    parts.push(`Bocy is tracking \u00a3${income.toLocaleString()}/mo in and \u00a3${spending.toLocaleString()}/mo out.`);
  } else if (inBounds(income, BOUNDS.monthlyIncome)) {
    parts.push(`Bocy is tracking \u00a3${income.toLocaleString()}/mo income.`);
  } else if (inBounds(spending, BOUNDS.monthlySpend)) {
    parts.push(`Bocy is tracking \u00a3${spending.toLocaleString()}/mo spending.`);
  }

  if (inBounds(moveCount, BOUNDS.moveCount) && inBounds(totalAnnualImpact, BOUNDS.annualImpact)) {
    parts.push(`Following all ${moveCount} moves could save \u00a3${totalAnnualImpact.toLocaleString()}/yr.`);
  }

  if (parts.length === 0) return null;

  const detail = buildDetail(() => {
    if (!goalContext) return null;
    const label = goalContext.goalLabel?.trim();
    if (!label) return null;
    const months = goalContext.currentMonths;
    if (months && months > 0 && months < 600) {
      const insight = goalContext.insight?.trim();
      return insight || `Goal: ${label}. Estimated ${months} months at current pace.`;
    }
    return `Goal: ${label}.`;
  });

  return {
    id: 'day_15',
    day: 15,
    title: 'Two week check-in',
    insight: parts.join(' '),
    detail,
    cta: 'Ask Bocy for a strategy update',
    ctaRoute: 'chat',
  };
}

// ── Helpers ──

/**
 * Build detail safely — returns null if builder returns null/empty.
 */
function buildDetail(builder: () => string | null): string | null {
  const result = builder();
  return result?.trim() || null;
}

/**
 * Top spending MERCHANT from discretionary transactions only.
 * Skips non-discretionary (rent, bills) since those aren't actionable insights.
 * Filters out raw bank descriptions that wouldn't be presentable.
 */
function getTopMerchantSpend(a: Analysis): { merchant: string; monthly: number } | null {
  // Only discretionary — "Your biggest spend is Rent" isn't useful
  const items: BudgetCategory[] = a.discretionary?.items || [];

  const merchantTotals: Record<string, number> = {};
  for (const item of items) {
    for (const tx of item.transactions || []) {
      const name = cleanMerchantName(tx.merchant || tx.description || '');
      if (!name) continue;
      merchantTotals[name] = (merchantTotals[name] || 0) + Math.abs(tx.amount || 0);
    }
  }
  const entries = Object.entries(merchantTotals);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return { merchant: entries[0][0], monthly: Math.round(entries[0][1]) };
}

/**
 * Clean a merchant name for display. Returns empty string if it looks like
 * a raw bank reference rather than a real merchant name.
 */
function cleanMerchantName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length < 2) return '';
  // Skip raw bank references (all caps with numbers, card refs, direct debits)
  if (/^[A-Z0-9\s\-*]{8,}$/.test(name)) return '';
  if (/DIRECT DEBIT|CARD PAYMENT|STANDING ORDER|FP-|BGC|DD-/i.test(name)) return '';
  // Capitalise nicely if all-caps
  if (name === name.toUpperCase() && name.length > 3) {
    return name.charAt(0) + name.slice(1).toLowerCase();
  }
  return name;
}

/**
 * Count distinct subscription merchants (not transaction count).
 */
function countSubscriptions(a: Analysis): number {
  const items: BudgetCategory[] = a.discretionary?.items || [];
  const subItems = items.filter(
    (item) => item.category === 'Subscriptions' || item.category === 'Streaming',
  );
  const merchants = new Set<string>();
  for (const item of subItems) {
    for (const tx of item.transactions || []) {
      const name = cleanMerchantName(tx.merchant || tx.description || '').toLowerCase();
      if (name) merchants.add(name);
    }
  }
  return merchants.size;
}

function formatArchetype(archetype: string | undefined): string {
  if (!archetype) return '';
  return archetype
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripMd(s: string): string {
  return (s || '').replace(/\*\*/g, '');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '\u2026';
}
