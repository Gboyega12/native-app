import { describe, it, expect } from '@jest/globals';
import {
  rankMoves,
  findMostMaterialMove,
  calcGoalTrajectory,
} from '../lib/move-engine.js';

// ── Test helpers ──

function makeProfile(overrides: Record<string, any> = {}) {
  const monthly = {
    income: 2500,
    spending: 2000,
    surplus: 500,
    subscriptions: 50,
    foodDelivery: 30,
    transport: 100,
    groceries: 200,
    shopping: 80,
    eatingOut: 50,
    entertainment: 30,
    debtPayments: 0,
    ...overrides.monthly,
  };
  const metrics = {
    savingsRate: 20,
    creditCardCount: 0,
    bnplCount: 0,
    debtAccountCount: 0,
    subscriptionCount: 2,
    streamingCount: 1,
    foodDelivery: 30,
    transport: 100,
    groceries: 200,
    shopping: 80,
    eatingOut: 50,
    coffeeAndCafes: 15,
    entertainment: 30,
    debtPayments: 0,
    ...overrides.metrics,
  };
  return {
    monthly,
    metrics,
    budgetReality: overrides.budgetReality ?? {
      nonDiscretionary: { total: 1000, items: [] },
      discretionary: { total: 500, items: [] },
    },
    incomeSources: overrides.incomeSources ?? [
      { source: 'Employer', frequency: 'monthly', avgAmount: 2500, monthly: 2500, isSalary: true },
    ],
    transfers: [],
    subscriptions: [],
  };
}

function makeMove(overrides: Partial<{
  action: string;
  annualImpact: number;
  monthlyImpact: number;
  effort: 'low' | 'medium' | 'high';
  strategy: string;
  steps: string[];
  effect: string;
  category: string;
}> = {}) {
  return {
    action: 'Cancel unused subscription',
    annualImpact: 120,
    monthlyImpact: 10,
    effort: 'low' as const,
    strategy: 'Reduce discretionary spend',
    steps: ['Review subscriptions', 'Cancel unused ones'],
    effect: 'Save £10/month',
    category: 'spending',
    ...overrides,
  };
}

const defaultGoals = {
  current_situation: 'building_savings',
  one_year_goal: 'save_target',
  two_year_goal: 'buy_home',
};

// ── rankMoves ──

describe('rankMoves', () => {
  it('returns empty array for empty decision stack', () => {
    const profile = makeProfile();
    const result = rankMoves([], profile, defaultGoals);
    expect(result).toEqual([]);
  });

  it('returns ranked moves with sequential rank numbers', () => {
    const profile = makeProfile();
    const moves = [
      makeMove({ action: 'Cancel Netflix', annualImpact: 120, monthlyImpact: 10 }),
      makeMove({ action: 'Switch energy provider', annualImpact: 360, monthlyImpact: 30 }),
      makeMove({ action: 'Reduce food delivery', annualImpact: 240, monthlyImpact: 20 }),
    ];
    const result = rankMoves(moves, profile, defaultGoals);
    expect(result).toHaveLength(3);
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
    expect(result[2].rank).toBe(3);
  });

  it('ranks higher-impact moves above lower-impact moves', () => {
    const profile = makeProfile();
    const moves = [
      makeMove({ action: 'Small saving', annualImpact: 60, monthlyImpact: 5 }),
      makeMove({ action: 'Big saving', annualImpact: 600, monthlyImpact: 50 }),
    ];
    const result = rankMoves(moves, profile, defaultGoals);
    expect(result[0].action).toBe('Big saving');
    expect(result[1].action).toBe('Small saving');
  });

  it('includes score, trajectory, and rank on each result', () => {
    const profile = makeProfile();
    const moves = [makeMove()];
    const result = rankMoves(moves, profile, defaultGoals);
    expect(result[0]).toHaveProperty('score');
    expect(result[0]).toHaveProperty('trajectory');
    expect(result[0]).toHaveProperty('rank');
    expect(typeof result[0].score).toBe('number');
    expect(result[0].rank).toBe(1);
  });

  it('boosts debt-category moves when user is in debt priority', () => {
    const profile = makeProfile({
      monthly: { surplus: 300, income: 2500, spending: 2200, debtPayments: 150 },
      metrics: { savingsRate: 12, debtAccountCount: 2, debtPayments: 150 },
    });
    const goals = { current_situation: 'in_debt', one_year_goal: 'clear_debt', two_year_goal: 'save_target' };
    const debtMove = makeMove({ action: 'Overpay credit card', annualImpact: 300, monthlyImpact: 25, category: 'debt' });
    const spendingMove = makeMove({ action: 'Cancel subscription', annualImpact: 300, monthlyImpact: 25, category: 'spending' });
    const result = rankMoves([spendingMove, debtMove], profile, goals);
    // Debt move should be boosted above spending move when in debt priority
    const debtRanked = result.find(m => m.action === 'Overpay credit card');
    const spendingRanked = result.find(m => m.action === 'Cancel subscription');
    expect(debtRanked!.rank).toBeLessThan(spendingRanked!.rank);
  });

  it('applies effort multiplier — low effort gets a boost', () => {
    const profile = makeProfile();
    const lowEffort = makeMove({ action: 'Easy win', annualImpact: 200, monthlyImpact: 17, effort: 'low' });
    const highEffort = makeMove({ action: 'Hard change', annualImpact: 200, monthlyImpact: 17, effort: 'high' });
    const result = rankMoves([highEffort, lowEffort], profile, defaultGoals);
    const easyRank = result.find(m => m.action === 'Easy win')!;
    const hardRank = result.find(m => m.action === 'Hard change')!;
    expect(easyRank.score).toBeGreaterThan(hardRank.score);
  });
});

// ── findMostMaterialMove ──

describe('findMostMaterialMove', () => {
  it('returns null for empty decision stack', () => {
    const profile = makeProfile();
    const result = findMostMaterialMove([], profile, defaultGoals);
    expect(result).toBeNull();
  });

  it('returns the highest-ranked move', () => {
    const profile = makeProfile();
    const moves = [
      makeMove({ action: 'Small', annualImpact: 60, monthlyImpact: 5 }),
      makeMove({ action: 'Big', annualImpact: 600, monthlyImpact: 50 }),
      makeMove({ action: 'Medium', annualImpact: 240, monthlyImpact: 20 }),
    ];
    const result = findMostMaterialMove(moves, profile, defaultGoals);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('Big');
  });
});

// ── calcGoalTrajectory ──

describe('calcGoalTrajectory', () => {
  it('calculates months saved when a move adds surplus', () => {
    const profile = makeProfile({ monthly: { surplus: 500, income: 2500, spending: 2000, debtPayments: 0 } });
    const goals = { current_situation: 'building_savings', one_year_goal: 'save_target', two_year_goal: 'buy_home' };
    const move = makeMove({ annualImpact: 1200, monthlyImpact: 100 });
    const result = calcGoalTrajectory(profile, goals, move);
    // save_target default = 5000
    // currentMonths = ceil(5000/500) = 10
    // newMonths = ceil(5000/600) ≈ 9
    expect(result.targetAmount).toBe(5000);
    expect(result.currentMonths).toBe(10);
    expect(result.newMonths).toBeLessThan(result.currentMonths);
    expect(result.monthsSaved).toBeGreaterThan(0);
  });

  it('returns -1 for currentMonths when surplus is zero', () => {
    const profile = makeProfile({
      monthly: { surplus: 0, income: 2000, spending: 2000, debtPayments: 0 },
      budgetReality: undefined,
    });
    const goals = { current_situation: 'struggling', one_year_goal: 'save_target', two_year_goal: 'buy_home' };
    const result = calcGoalTrajectory(profile, goals, null);
    expect(result.currentMonths).toBe(-1);
  });

  it('uses GOAL_DEFAULTS for target amount when not specified', () => {
    const profile = makeProfile();
    const goals = { current_situation: 'building_savings', one_year_goal: 'emergency_fund', two_year_goal: 'save_target' };
    const result = calcGoalTrajectory(profile, goals, null);
    expect(result.targetAmount).toBe(2500);
    expect(result.goalLabel).toBe('Build emergency fund');
  });

  it('uses custom target_amount when provided', () => {
    const profile = makeProfile();
    const goals = {
      current_situation: 'building_savings',
      one_year_goal: 'save_target',
      two_year_goal: 'buy_home',
      target_amount: 8000,
    };
    const result = calcGoalTrajectory(profile, goals, null);
    expect(result.targetAmount).toBe(8000);
  });

  it('includes insight text about timeline', () => {
    const profile = makeProfile({
      monthly: { surplus: 500, income: 2500, spending: 2000, debtPayments: 0 },
      budgetReality: undefined,
    });
    const goals = { current_situation: 'building_savings', one_year_goal: 'save_target', two_year_goal: 'buy_home' };
    const move = makeMove({ annualImpact: 1200, monthlyImpact: 100 });
    const result = calcGoalTrajectory(profile, goals, move);
    expect(result.insight).toBeTruthy();
    expect(typeof result.insight).toBe('string');
    expect(result.insight.length).toBeGreaterThan(0);
  });

  it('handles negative surplus with a move that creates positive cashflow', () => {
    const profile = makeProfile({
      monthly: { surplus: -100, income: 2000, spending: 2100, debtPayments: 0 },
      budgetReality: undefined,
    });
    const goals = { current_situation: 'struggling', one_year_goal: 'emergency_fund', two_year_goal: 'save_target' };
    const move = makeMove({ annualImpact: 2400, monthlyImpact: 200 });
    const result = calcGoalTrajectory(profile, goals, move);
    // surplus + moveSaving = -100 + 200 = 100, so newMonths should be positive
    expect(result.currentMonths).toBe(-1);
    expect(result.newMonths).toBeGreaterThan(0);
    // Insight may be overwritten by Monte Carlo confidence bands
    expect(result.insight).toBeTruthy();
  });
});
