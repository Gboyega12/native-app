// ── Transactions ──

export interface RawTransaction {
  date: string;
  description: string;
  amount: number;
}

export interface EnrichedTransaction extends RawTransaction {
  merchant: string;
  category: string;
  isEssential: boolean;
  isSubscription: boolean;
  isBNPL: boolean;
  isDebt: boolean;
  isIncome: boolean;
  isTransfer: boolean;
  isRefund: boolean;
  isSavings: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** Which classification layer resolved this transaction */
  classifiedBy?: 'user_override' | 'merchant_db' | 'fuzzy_match' | 'keyword' | 'claude_ai' | 'default';
}

// ── Recurring ──

export interface RecurringItem {
  merchant: string;
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'irregular';
  averageAmount: number;
  category: string;
  isSubscription: boolean;
  count: number;
}

// ── Profile ──

export interface CategoryBreakdown {
  [category: string]: number;
}

export interface TransactionDetail {
  date: string;
  merchant: string;
  description: string;
  amount: number;
}

export interface BudgetCategory {
  category: string;
  monthly: number;
  txs: number;
  transactions: TransactionDetail[];
}

export interface BudgetSection {
  total: number;
  items: BudgetCategory[];
}

export interface IncomeSource {
  source: string;
  frequency: string;
  avgAmount: number;
  monthly: number;
  isSalary: boolean;
  /** Individual amounts observed for this source (most recent N periods) */
  recentAmounts?: number[];
  /** Standard deviation of payment amounts */
  amountSD?: number;
  /** Coefficient of variation (SD / mean) — higher = more variable */
  variability?: number;
}

export interface FinancialProfile {
  monthly: {
    income: number;
    spending: number;
    surplus: number;
    subscriptions: number;
    foodDelivery: number;
    transport: number;
    groceries: number;
    shopping: number;
    eatingOut: number;
    entertainment: number;
    debtPayments: number;
    /** Conservative income estimate (p25 — what to budget against for variable earners) */
    incomeFloor?: number;
    /** Whether income is classified as variable (CV > 10%) */
    isVariableIncome?: boolean;
    /** Income coefficient of variation across all sources (0-1 scale) */
    incomeCV?: number;
  };
  budgetReality: {
    nonDiscretionary: BudgetSection;
    discretionary: BudgetSection;
  };
  incomeSources: IncomeSource[];
  subscriptions: RecurringItem[];
  metrics: {
    savingsRate: number;
    creditCardCount: number;
    bnplCount: number;
    debtAccountCount: number;
    subscriptionCount: number;
    streamingCount: number;
    foodDelivery: number;
    transport: number;
    groceries: number;
    shopping: number;
    eatingOut: number;
    coffeeAndCafes: number;
    entertainment: number;
    debtPayments: number;
  };
}

// ── Archetype ──

export interface Archetype {
  key: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  savingsOpportunity: string;
}

// ── Moves ──

export interface Move {
  action: string;
  annualImpact: number;
  monthlyImpact: number;
  effort: 'low' | 'medium' | 'high';
  strategy: string;
  steps: string[];
  effect: string;
  timeline?: string;
  category?: 'break_even' | 'buffer' | 'debt' | 'spending' | 'savings' | 'invest';
  merchants?: string[];
}

// ── Decision Score ──

export interface DecisionScore {
  score: number;
  verdict: 'Strong' | 'Balanced' | 'Needs Attention' | 'At Risk';
  breakdown: { factor: string; impact: number }[];
}

// ── Goals ──

export interface Goals {
  id?: string;
  user_id?: string;
  current_situation: string;
  one_year_goal: string;
  two_year_goal: string;
  target_amount?: number;
}

// ── Analysis (stored in Supabase) ──

export interface Analysis {
  id?: string;
  user_id?: string;
  archetype: string;
  decision_score: number;
  monthly_income: number;
  monthly_spending: number;
  surplus: number;
  non_discretionary: BudgetSection;
  discretionary: BudgetSection;
  income_sources: IncomeSource[];
  top_move: Move;
  all_moves: Move[];
  behavioral_patterns: string[];
  goal_context?: GoalTrajectory | null;
  created_at?: string;
  /** Conservative income estimate for variable earners (p25) */
  income_floor?: number;
  /** Whether income is classified as variable (CV > 10%) */
  is_variable_income?: boolean;
  /** Income coefficient of variation (0-1 scale) */
  income_cv?: number;
}

// ── Goal Trajectory ──

export interface GoalTrajectory {
  goalLabel: string;
  targetAmount: number;
  currentMonths: number;
  newMonths: number;
  monthsSaved: number;
  insight: string;
  /** Monte Carlo confidence bands — probabilistic timeline */
  confidence?: {
    p10: number;        // Optimistic — 10th percentile
    p50: number;        // Most likely — median
    p90: number;        // Conservative — 90th percentile
    hitRate12m: number; // % chance of reaching goal within 12 months
    hitRate24m: number; // % chance of reaching goal within 24 months
  };
  /** Personalized emergency buffer recommendation */
  bufferRecommendation?: {
    months: number;        // Recommended buffer in months of expenses
    amount: number;        // £ amount
    coverageRate: number;  // % of scenarios this buffer covers
  };
}

// ── Enrichment Metrics ──

export interface EnrichmentMetrics {
  totalTransactions: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  /** Percentage of transactions classified as 'Other' (unresolved) */
  otherRate: number;
  /** Which classification layer resolved each transaction */
  bySource: {
    userOverride: number;
    merchantDb: number;
    fuzzyMatch: number;
    keyword: number;
    unresolved: number;
  };
}

// ── Enrichment Engine Output ──

export interface EnrichmentResult {
  profile: FinancialProfile;
  archetype: Archetype;
  traits: string[];
  strengths: string[];
  blindSpots: string[];
  decisionScore: DecisionScore;
  decisionStack: Move[];
  behavioralPatterns: string[];
  enrichedTransactions: EnrichedTransaction[];
  enrichmentMetrics: EnrichmentMetrics;
}

// ── Chat ──

export interface ChatAction {
  type: 'plan_proposed' | 'override_saved' | 'goal_update_proposed' | 'plan_error' | 'budget_item_saved';
  data: {
    id?: string;
    action?: string;
    target_amount?: number | null;
    monthly_saving?: number | null;
    timeline?: string | null;
    match_description?: string;
    category?: string;
    is_essential?: boolean;
    notes?: string | null;
    error?: string | null;
    // budget item fields
    description?: string;
    monthly_amount?: number | null;
    // goal update fields
    reason?: string;
    new_situation?: string;
    new_one_year_goal?: string;
    new_two_year_goal?: string;
    new_target_amount?: number | null;
  };
  status?: 'pending' | 'approved' | 'dismissed';
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: ChatAction[];
}

export interface ChatContext {
  monthly_income?: number;
  monthly_spending?: number;
  surplus?: number;
  /** Whether income is classified as variable */
  is_variable_income?: boolean;
  /** Conservative income estimate for budgeting (p25) */
  income_floor?: number;
  /** Income coefficient of variation */
  income_cv?: number;
  archetype?: string;
  decision_score?: number;
  goals?: {
    current_situation?: string;
    one_year_goal?: string;
    two_year_goal?: string;
    target_amount?: number;
  };
  top_move?: { action: string; monthlyImpact: number };
  all_moves?: { action: string; monthlyImpact: number; effort: string }[];
  subscriptions?: { merchant: string; amount: number }[];
  spending_by_category?: { category: string; monthly: number }[];
  recent_transfers?: { description: string; amount: number; date: string }[];
  recent_transactions?: { description: string; amount: number; date: string; category: string; essential: boolean }[];
  debt_accounts?: { name: string; type: string; balance: number | null; limit: number | null }[];
  budget_adjustments?: { description: string; category: string; amount: number; essential: boolean }[];
  behavioral_patterns?: string[];
  payday_context?: {
    incomeArrivedThisWeek: boolean;
    incomeEvents: { source: string; amount: number; date: string; frequency: string }[];
    committedThisWeek: number;
    discretionaryThisWeek: number;
    adaptiveBudget: number;
    staticBudget: number;
  };
  budget_line?: {
    real_spending_power: number;
    essentials_total: number;
    lifestyle_total: number;
    left_to_decide: number;
    essentials_pct: number;
    over_budget: boolean;
    over_amount: number;
    essentials_change_pct: number | null;
    top_lifestyle_category: string | null;
    top_lifestyle_amount: number | null;
    /** Budget solver output: how efficiently the current allocation matches the optimal */
    allocation_efficiency?: number;
    /** Biggest single reallocation suggestion from the solver */
    top_reallocation?: {
      from: string;
      to: string;
      amount: number;
      utility_gain: string;
    } | null;
  };
  household_cashflow?: {
    joint_surplus: number;
    buffer_adequacy: number;
    shared_expense_ratio: number;
    scenarios: {
      label: string;
      probability: number;
      monthly_impact: number;
      description: string;
    }[];
  } | null;
  goal_trajectory?: {
    goalLabel: string;
    currentMonths: number;
    newMonths: number;
    insight: string;
    /** Monte Carlo confidence bands */
    confidence?: {
      p10: number;
      p50: number;
      p90: number;
      hitRate12m: number;
      hitRate24m: number;
    };
    bufferRecommendation?: {
      months: number;
      amount: number;
      coverageRate: number;
    };
  } | null;
}

// ── Flowchart Position ──

export interface FlowchartPosition {
  level: number;
  label: string;
  priority: 'break_even' | 'buffer' | 'debt' | 'spending' | 'savings' | 'invest';
}

// ── User Identity (onboarding discovery) ──

export type WorkSetup = 'office' | 'hybrid' | 'remote' | 'self_employed' | 'student' | 'multiple_jobs';
export type HouseholdType = 'single' | 'couple_shared' | 'couple_separate' | 'family' | 'single_parent' | 'shared_house';
export type HousingStatus = 'renting' | 'mortgage' | 'with_family' | 'shared_house' | 'council';
export type FinancialExperience = 'beginner' | 'basics' | 'confident' | 'advanced';
export type RiskAppetite = 'conservative' | 'balanced' | 'growth';
export type Priority = 'security' | 'freedom' | 'growth' | 'experiences' | 'family';
export type UpcomingEvent = 'moving' | 'baby' | 'wedding' | 'career_change' | 'first_home' | 'business' | 'retirement' | 'none';
export type Dependent = 'none' | 'young_children' | 'teenagers' | 'elderly_parents' | 'pets';

export interface UserIdentity {
  user_id?: string;
  work_setup: WorkSetup;
  household: HouseholdType;
  housing: HousingStatus;
  financial_experience: FinancialExperience;
  risk_appetite: RiskAppetite;
  priorities: Priority[];
  upcoming_events: UpcomingEvent[];
  dependents: Dependent[];
  created_at?: string;
  updated_at?: string;
}
