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
}

// ── Recurring ──

export interface RecurringItem {
  merchant: string;
  frequency: 'weekly' | 'monthly' | 'annual' | 'irregular';
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
}

// ── Goal Trajectory ──

export interface GoalTrajectory {
  goalLabel: string;
  targetAmount: number;
  currentMonths: number;
  newMonths: number;
  monthsSaved: number;
  insight: string;
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
}

// ── Chat ──

export interface ChatAction {
  type: 'plan_proposed' | 'override_saved';
  data: {
    action?: string;
    target_amount?: number | null;
    monthly_saving?: number | null;
    timeline?: string | null;
    match_description?: string;
    category?: string;
    is_essential?: boolean;
    notes?: string | null;
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
  behavioral_patterns?: string[];
  goal_trajectory?: {
    goalLabel: string;
    currentMonths: number;
    newMonths: number;
    insight: string;
  } | null;
}

// ── Flowchart Position ──

export interface FlowchartPosition {
  level: number;
  label: string;
  priority: 'break_even' | 'buffer' | 'debt' | 'spending' | 'savings' | 'invest';
}
