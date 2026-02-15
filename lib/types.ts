// ── Transactions ──

export interface RawTransaction {
  date: string;
  description: string;
  amount: number;
}

export interface EnrichedTransaction extends RawTransaction {
  merchant: string;
  category: string;
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

export interface IncomeSource {
  name: string;
  amount: number;
  frequency: string;
}

export interface FinancialProfile {
  monthlyIncome: number;
  monthlySpending: number;
  surplus: number;
  categoryBreakdown: CategoryBreakdown;
  discretionary: CategoryBreakdown;
  nonDiscretionary: CategoryBreakdown;
  incomeSources: IncomeSource[];
  subscriptionTotal: number;
  metrics: {
    savingsRate: number;
    debtAccounts: number;
    bnplUsage: number;
    subscriptionCount: number;
    streamingServices: number;
    deliverySpend: number;
    eatingOutSpend: number;
    transportSpend: number;
    shoppingSpend: number;
    grocerySpend: number;
    coffeeSpend: number;
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
  non_discretionary: CategoryBreakdown;
  discretionary: CategoryBreakdown;
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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatContext {
  monthly_income?: number;
  monthly_spending?: number;
  surplus?: number;
  archetype?: string;
  goals?: {
    current_situation?: string;
    one_year_goal?: string;
    two_year_goal?: string;
  };
  top_move?: { action: string };
}

// ── Flowchart Position ──

export interface FlowchartPosition {
  level: number;
  label: string;
}
