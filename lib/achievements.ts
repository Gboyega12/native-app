// ── Achievement Engine ──
// Detects financial milestones and awards achievements.
// Achievements are checked after each analysis run and stored in Supabase.
//
// Categories:
//   - Onboarding: First steps (connect bank, set goals, etc.)
//   - Progress: Improving metrics over time (score up, spending down)
//   - Streaks: Consistent app engagement
//   - Milestones: Absolute thresholds (debt-free, savings target hit)

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  category: 'onboarding' | 'progress' | 'streak' | 'milestone';
}

export interface UserAchievement {
  user_id: string;
  achievement_key: string;
  unlocked_at: string;
  notified: boolean;
}

export interface ScoreSnapshot {
  decision_score: number;
  monthly_income: number;
  monthly_spending: number;
  surplus: number;
  savings_rate: number;
  subscription_count: number;
  debt_account_count: number;
}

// ── Achievement definitions ──

export const ACHIEVEMENTS: Achievement[] = [
  // Onboarding
  { key: 'first_analysis', name: 'First Look', description: 'Completed your first financial analysis', icon: 'B', category: 'onboarding' },
  { key: 'goals_set', name: 'Goal Setter', description: 'Set your financial goals', icon: 'G', category: 'onboarding' },
  { key: 'first_override', name: 'Sharp Eye', description: 'Corrected a transaction category', icon: 'E', category: 'onboarding' },
  { key: 'first_plan', name: 'Action Taker', description: 'Approved your first financial plan', icon: 'P', category: 'onboarding' },

  // Progress
  { key: 'score_up_5', name: 'Momentum', description: 'Decision score improved by 5+ points', icon: '+', category: 'progress' },
  { key: 'score_up_10', name: 'Serious Progress', description: 'Decision score improved by 10+ points', icon: '!', category: 'progress' },
  { key: 'score_up_20', name: 'Transformation', description: 'Decision score improved by 20+ points', icon: '*', category: 'progress' },
  { key: 'spending_down_10', name: 'Trimmer', description: 'Reduced monthly spending by 10%+', icon: '-', category: 'progress' },
  { key: 'surplus_doubled', name: 'Surplus Surge', description: 'Doubled your monthly surplus', icon: '2', category: 'progress' },

  // Streaks
  { key: 'streak_7', name: 'Week Warrior', description: 'Used Bocy 7 days in a row', icon: '7', category: 'streak' },
  { key: 'streak_30', name: 'Monthly Habit', description: 'Used Bocy for 30 days', icon: '3', category: 'streak' },
  { key: 'streak_60', name: 'Committed', description: 'Used Bocy for 60 days', icon: '6', category: 'streak' },

  // Milestones
  { key: 'debt_free', name: 'Debt Free', description: 'Zero outstanding debt accounts', icon: '0', category: 'milestone' },
  { key: 'savings_rate_10', name: 'Saver', description: 'Savings rate reached 10%+', icon: 'S', category: 'milestone' },
  { key: 'savings_rate_20', name: 'Super Saver', description: 'Savings rate reached 20%+', icon: '$', category: 'milestone' },
  { key: 'score_strong', name: 'Strong Position', description: 'Decision score reached 75+', icon: 'A', category: 'milestone' },
  { key: 'all_moves_done', name: 'Completionist', description: 'Completed all recommended moves', icon: 'V', category: 'milestone' },
  { key: 'sub_audit', name: 'Sub Slayer', description: 'Reduced subscription count by 2+', icon: 'X', category: 'milestone' },
];

/**
 * Check which new achievements a user has earned based on current + historical data.
 * Returns only NEW achievements (not already unlocked).
 */
export function checkAchievements(
  current: ScoreSnapshot,
  previous: ScoreSnapshot | null,
  existingAchievements: string[],
  context: {
    hasGoals: boolean;
    hasOverrides: boolean;
    hasPlans: boolean;
    planCompletedCount: number;
    totalMoveCount: number;
    streakDays: number;
  },
): string[] {
  const newAchievements: string[] = [];

  function award(key: string) {
    if (!existingAchievements.includes(key) && !newAchievements.includes(key)) {
      newAchievements.push(key);
    }
  }

  // Onboarding
  award('first_analysis');
  if (context.hasGoals) award('goals_set');
  if (context.hasOverrides) award('first_override');
  if (context.hasPlans) award('first_plan');

  // Progress (requires previous snapshot)
  if (previous) {
    const scoreDelta = current.decision_score - previous.decision_score;
    if (scoreDelta >= 5) award('score_up_5');
    if (scoreDelta >= 10) award('score_up_10');
    if (scoreDelta >= 20) award('score_up_20');

    if (previous.monthly_spending > 0) {
      const spendReduction = (previous.monthly_spending - current.monthly_spending) / previous.monthly_spending;
      if (spendReduction >= 0.1) award('spending_down_10');
    }

    if (previous.surplus > 0 && current.surplus >= previous.surplus * 2) {
      award('surplus_doubled');
    }

    if (previous.subscription_count - current.subscription_count >= 2) {
      award('sub_audit');
    }
  }

  // Streaks
  if (context.streakDays >= 7) award('streak_7');
  if (context.streakDays >= 30) award('streak_30');
  if (context.streakDays >= 60) award('streak_60');

  // Milestones
  if (current.debt_account_count === 0) award('debt_free');
  if (current.savings_rate >= 10) award('savings_rate_10');
  if (current.savings_rate >= 20) award('savings_rate_20');
  if (current.decision_score >= 75) award('score_strong');
  if (context.totalMoveCount > 0 && context.planCompletedCount >= context.totalMoveCount) {
    award('all_moves_done');
  }

  return newAchievements;
}

/** Get the achievement definition by key */
export function getAchievement(key: string): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.key === key);
}
