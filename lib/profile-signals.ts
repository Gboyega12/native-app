// ── Profile Signals ──
// Pure functions that compute personalization signals from identity + financial data.
// Replaces the UKPF flowchart with a richer, identity-driven system.
// Zero side effects, fully testable.

import type {
  FinancialCohort,
  FinancialProfile,
  Goals,
  UserIdentity,
  DebtAccount,
  UpcomingEventWithTimeline,
  IncomeBand,
} from './types';

// ── Public Interface ──

export interface ProfileSignals {
  cohort: FinancialCohort;
  sophisticationLevel: number; // 0-1
  categoryAffinity: Record<string, number>; // move category → ranking multiplier
  timePressure: { event: string; monthsAway: number; urgency: number }[];
  riskGammaShift: number; // CRRA adjustment
  incomeBand: IncomeBand | null;
}

// ── 15a: Cohort Detection ──

export function detectCohort(
  profile: FinancialProfile,
  identity: UserIdentity | null,
  goals: Goals | null,
  debtAccounts: DebtAccount[],
): FinancialCohort {
  const surplus = profile.monthly?.surplus ?? 0;
  const savingsRate = profile.metrics?.savingsRate ?? 0;
  const debtCount = profile.metrics?.debtAccountCount ?? 0;
  const situation = goals?.current_situation || '';

  // Check for expensive debt (APR > 8%)
  const hasExpensiveDebt = debtAccounts.some(
    (d) => (d.interest_rate || 0) > 0.08 && (d.outstanding_balance || 0) > 0,
  );

  // crisis: surplus < 0 OR (3+ debts AND situation='in_debt')
  if (surplus < 0 || (debtCount >= 3 && situation === 'in_debt')) {
    return 'crisis';
  }

  // debt_focus: has expensive debt with positive balance
  if (hasExpensiveDebt) {
    return 'debt_focus';
  }

  // foundation: low savings rate, positive surplus, no expensive debt
  if (savingsRate < 15 && surplus > 0) {
    return 'foundation';
  }

  // accumulator: moderate savings, minimal debt
  if (savingsRate >= 15 && savingsRate <= 30 && debtCount <= 1) {
    return 'accumulator';
  }

  // coasting: high savings, no debt, no urgency signals
  const hasUrgentEvents = identity?.upcoming_events?.some((e) => {
    if (typeof e === 'string') return e !== 'none';
    return e.type !== 'none' && (e.months_away ?? 99) < 12;
  }) ?? false;

  if (savingsRate > 30 && debtCount === 0 && !hasUrgentEvents) {
    return 'coasting';
  }

  // optimizer: high savings, positive surplus
  if (savingsRate > 30 && surplus > 500) {
    return 'optimizer';
  }

  // Default to foundation
  return 'foundation';
}

// ── 15b: Sophistication Level ──

export function calcSophisticationLevel(experience: string | undefined): number {
  switch (experience) {
    case 'beginner': return 0.25;
    case 'basics': return 0.50;
    case 'confident': return 0.75;
    case 'advanced': return 1.00;
    default: return 0.50;
  }
}

// ── 15c: Category Affinity Multipliers ──

type MoveCategory = string;
type AffinityTable = Record<MoveCategory, number>;

const RISK_AFFINITY: Record<string, AffinityTable> = {
  conservative: { buffer: 1.3, debt: 1.1, spending: 1.0, savings: 1.1, invest: 0.7 },
  balanced:     { buffer: 1.0, debt: 1.0, spending: 1.0, savings: 1.0, invest: 1.0 },
  growth:       { buffer: 0.8, debt: 1.0, spending: 1.0, savings: 1.0, invest: 1.3 },
};

const PRIORITY_AFFINITY: Record<string, AffinityTable> = {
  security:    { buffer: 1.3, debt: 1.2, spending: 1.0, savings: 1.0, invest: 0.9 },
  freedom:     { buffer: 1.2, debt: 1.3, spending: 0.8, savings: 1.0, invest: 1.0 },
  growth:      { buffer: 0.9, debt: 1.0, spending: 1.0, savings: 1.2, invest: 1.4 },
  experiences: { buffer: 1.0, debt: 1.0, spending: 0.7, savings: 1.0, invest: 1.0 },
  family:      { buffer: 1.3, debt: 1.1, spending: 1.0, savings: 1.1, invest: 0.9 },
};

const EVENT_BOOSTS: Record<string, { category: MoveCategory; maxBoost: number; horizon: number }> = {
  first_home:    { category: 'savings', maxBoost: 0.5, horizon: 24 },
  baby:          { category: 'buffer',  maxBoost: 0.4, horizon: 24 },
  retirement:    { category: 'invest',  maxBoost: 0.4, horizon: 36 },
  career_change: { category: 'buffer',  maxBoost: 0.3, horizon: 12 },
};

const WORK_BOOSTS: Record<string, AffinityTable> = {
  self_employed:  { buffer: 1.2 },
  multiple_jobs:  { buffer: 1.1 },
};

export function calcCategoryAffinity(
  identity: UserIdentity | null,
  goals: Goals | null,
  cohort: FinancialCohort,
  events: UpcomingEventWithTimeline[],
): Record<string, number> {
  const affinity: Record<string, number> = {};
  const cats = ['buffer', 'debt', 'spending', 'savings', 'invest', 'allocate'];
  for (const c of cats) affinity[c] = 1.0;

  if (!identity) return affinity;

  // Risk appetite
  const riskTable = RISK_AFFINITY[identity.risk_appetite] || RISK_AFFINITY.balanced;
  for (const [cat, mult] of Object.entries(riskTable)) {
    affinity[cat] = (affinity[cat] || 1) * mult;
  }

  // Priorities (multiply all)
  for (const p of (identity.priorities || [])) {
    const table = PRIORITY_AFFINITY[p];
    if (!table) continue;
    for (const [cat, mult] of Object.entries(table)) {
      affinity[cat] = (affinity[cat] || 1) * mult;
    }
  }

  // Event urgency boosts
  for (const event of events) {
    const boost = EVENT_BOOSTS[event.type];
    if (!boost) continue;
    const monthsAway = event.monthsAway ?? boost.horizon;
    const urgency = Math.max(0, 1 - monthsAway / boost.horizon);
    affinity[boost.category] = (affinity[boost.category] || 1) * (1 + boost.maxBoost * urgency);
  }

  // Work setup
  const workTable = WORK_BOOSTS[identity.work_setup];
  if (workTable) {
    for (const [cat, mult] of Object.entries(workTable)) {
      affinity[cat] = (affinity[cat] || 1) * mult;
    }
  }

  // Clamp all values to [0.5, 2.0]
  for (const cat of Object.keys(affinity)) {
    affinity[cat] = Math.max(0.5, Math.min(2.0, affinity[cat]));
  }

  return affinity;
}

// ── 15d: Event Timeline Normalization ──

export function normalizeUpcomingEvents(
  events: (string | { type: string; months_away: number })[],
): UpcomingEventWithTimeline[] {
  if (!events || !Array.isArray(events)) return [];
  return events
    .filter((e) => {
      if (typeof e === 'string') return e !== 'none';
      return e.type !== 'none';
    })
    .map((e) =>
      typeof e === 'string'
        ? { type: e, monthsAway: null }
        : { type: e.type, monthsAway: e.months_away },
    );
}

// ── Compute All Signals ──

export function computeProfileSignals(
  profile: FinancialProfile,
  identity: UserIdentity | null,
  goals: Goals | null,
  debtAccounts: DebtAccount[],
): ProfileSignals {
  const cohort = detectCohort(profile, identity, goals, debtAccounts);
  const sophisticationLevel = calcSophisticationLevel(identity?.financial_experience);
  const events = normalizeUpcomingEvents(identity?.upcoming_events || []);
  const categoryAffinity = calcCategoryAffinity(identity, goals, cohort, events);

  const timePressure = events
    .filter((e) => e.monthsAway != null)
    .map((e) => {
      const boost = EVENT_BOOSTS[e.type];
      const horizon = boost?.horizon || 24;
      const urgency = Math.max(0, 1 - (e.monthsAway! / horizon));
      return { event: e.type, monthsAway: e.monthsAway!, urgency };
    })
    .filter((e) => e.urgency > 0);

  // CRRA gamma shift based on risk appetite
  const riskGammaShift = identity?.risk_appetite === 'conservative' ? 0.3
    : identity?.risk_appetite === 'growth' ? -0.3
    : 0;

  return {
    cohort,
    sophisticationLevel,
    categoryAffinity,
    timePressure,
    riskGammaShift,
    incomeBand: identity?.income_band || null,
  };
}
