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
  /** True when the description matches a person-name pattern (P2P payment).
   *  Does NOT necessarily mean it's an internal transfer — see isTransfer. */
  isPersonTransfer?: boolean;
  isRefund: boolean;
  isSavings: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** Which classification layer resolved this transaction */
  classifiedBy?: 'user_override' | 'merchant_db' | 'fuzzy_match' | 'keyword' | 'claude_ai' | 'default';
}

// ── Recurring ──

export interface RecurringItem {
  merchant: string;
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'irregular';
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
  /** Preserved from enrichment so the dashboard can filter truly unclassifiable items */
  confidence?: 'high' | 'medium' | 'low';
  classifiedBy?: 'user_override' | 'merchant_db' | 'fuzzy_match' | 'keyword' | 'claude_ai' | 'default';
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
  /** Frequency-aware monthly normalisation (weekly × 4.33, fortnightly × 2.17, monthly × 1) */
  monthly: number;
  /** Frequency-aware annual income (weekly × 52, fortnightly × 26, monthly × 12) */
  annualIncome: number;
  isSalary: boolean;
  /** Detection confidence: high (regular + low variability + 3+ data points),
   *  medium (regular + fewer points), low (irregular or high variability) */
  confidence: 'high' | 'medium' | 'low';
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
  /** Transfers (person-to-person, internal) — excluded from income/spending totals but visible in UI */
  transfers: { date: string; merchant: string; description: string; amount: number; category: string }[];
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

// ── Move Sub-Goals ──
// Structured, typed sub-goals attached at move generation time.
// Each sub-goal maps to a real data entity (debt account, subscription, category)
// and is verified directly against source data — no fuzzy text matching.

export type MoveSubGoalType =
  | 'debt_clear'       // Clear a specific debt account
  | 'sub_cancel'       // Cancel a specific subscription
  | 'spending_reduce'  // Reduce spending in a category
  | 'savings_reach'    // Reach a savings target
  | 'buffer_build';    // Build emergency buffer to target

export interface MoveSubGoal {
  type: MoveSubGoalType;
  /** Human-readable label: merchant name, debt account name, or category */
  target: string;
  /** Value at move creation: balance, monthly spend, etc. */
  startValue: number;
  /** Goal value: 0 for debt clear/sub cancel, reduced amount for spending */
  targetValue: number;
  /** Updated each sync from real data */
  currentValue?: number;
  /** ISO timestamp when this sub-goal was verified complete */
  completedAt?: string | null;
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
  /** Structured sub-goals derived from real data at generation time */
  subGoals?: MoveSubGoal[];
  /** Mathematical proof: human-readable breakdown showing exactly how the numbers were derived */
  proof?: string;
  /** Per-category spending CV (coefficient of variation) from month-to-month transaction data.
   *  Attached by the enrichment engine for spending moves; used by Monte Carlo for follow-through. */
  spendingCV?: number;
}

/**
 * Derive sub-goals from a Move. Returns the move's own subGoals if present,
 * otherwise synthesises them from the action text / merchants for older analyses.
 */
/** Minimal debt account shape for hydration (avoids importing full DB type). */
export interface DebtAccountInfo {
  account_name: string;
  account_type?: string;
  outstanding_balance?: number;
  interest_rate?: number;
  minimum_payment?: number;
}

/**
 * Derive sub-goals from a Move. Returns the move's own subGoals if present,
 * otherwise synthesises them from the action text / merchants / debt accounts.
 *
 * When `debtAccounts` is provided, debt moves get real account names, balances,
 * and APRs instead of generic "Debt 1", "Debt 2" labels.
 */
export function hydrateSubGoals(move: Move, debtAccounts?: DebtAccountInfo[]): MoveSubGoal[] | undefined {
  if (move.subGoals && move.subGoals.length > 0) return move.subGoals;

  const action = (move.action || '').toLowerCase();
  const cat = move.category;

  // Debt moves — use real accounts when available
  if (cat === 'debt') {
    const activeDebts = (debtAccounts || []).filter((d) => (d.outstanding_balance || 0) > 0);
    if (activeDebts.length > 0) {
      return activeDebts.map((d) => ({
        type: 'debt_clear' as const,
        target: d.account_name || 'Debt',
        startValue: Math.round(d.outstanding_balance || 0),
        targetValue: 0,
      }));
    }
    // Fallback: parse count from action text
    const countMatch = action.match(/(\d+)\s*debt/);
    if (countMatch) {
      const count = parseInt(countMatch[1], 10);
      return Array.from({ length: count }, (_, i) => ({
        type: 'debt_clear' as const, target: `Debt ${i + 1}`, startValue: 0, targetValue: 0,
      }));
    }
    if (action.includes('overpay') || action.includes('clear')) {
      return [{ type: 'debt_clear' as const, target: 'Debt', startValue: 0, targetValue: 0 }];
    }
  }

  // Subscription moves
  if (action.includes('cancel') || action.includes('subscript')) {
    const merchants = move.merchants || [];
    if (merchants.length > 0) {
      return merchants.slice(0, 4).map((m) => ({
        type: 'sub_cancel' as const, target: m, startValue: 0, targetValue: 0,
      }));
    }
  }

  // Spending reduction moves
  if (cat === 'spending' && !action.includes('cancel') && !action.includes('subscript')) {
    const amountMatch = action.match(/£(\d+).*?(?:to|at)\s*£(\d+)/i);
    const category = action.includes('delivery') ? 'Delivery'
      : action.includes('dining') || action.includes('eating') ? 'Eating Out'
      : action.includes('shopping') ? 'Shopping'
      : action.includes('transport') ? 'Transport'
      : action.includes('caf') || action.includes('coffee') ? 'Coffee & Cafes'
      : null;
    if (category) {
      return [{
        type: 'spending_reduce' as const, target: category,
        startValue: amountMatch ? parseInt(amountMatch[1], 10) : 0,
        targetValue: amountMatch ? parseInt(amountMatch[2], 10) : 0,
      }];
    }
  }

  // Buffer moves
  if (cat === 'buffer') {
    const targetMatch = action.match(/£([\d,]+)\s*buffer/i);
    return [{
      type: 'buffer_build' as const,
      target: action.includes('parental') ? 'Parental leave runway'
        : action.includes('career') ? 'Career change runway' : 'Emergency buffer',
      startValue: 0,
      targetValue: targetMatch ? parseInt(targetMatch[1].replace(/,/g, ''), 10) : 0,
    }];
  }

  // Savings moves
  if (cat === 'savings' && (action.includes('surplus') || action.includes('saving') || action.includes('deposit'))) {
    const targetMatch = action.match(/£([\d,]+)/);
    return [{
      type: 'savings_reach' as const,
      target: action.includes('deposit') ? 'House deposit' : 'Savings',
      startValue: 0,
      targetValue: targetMatch ? parseInt(targetMatch[1].replace(/,/g, ''), 10) : 0,
    }];
  }

  return undefined;
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
  /** Essentials expected from identity but not found in transaction data */
  essential_gaps?: EssentialGap[];
  /** Bills verified from actual transaction data with exact amounts */
  verified_bills?: VerifiedBill[];
  /** Person-to-person transfers (excluded from income/spending but visible in UI) */
  person_transfers?: { date: string; merchant: string; description: string; amount: number; category: string }[];
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

/** An essential expense expected from user's identity but missing from transaction data */
export interface EssentialGap {
  /** What's missing (e.g. "Rent", "Council Tax", "Energy") */
  category: string;
  /** Why we expect it (e.g. "You said you're renting") */
  reason: string;
  /** Typical UK monthly cost range for this category */
  typicalRange: { low: number; high: number };
  /** How confident we are this is genuinely missing vs paid another way */
  confidence: 'high' | 'medium' | 'low';
}

/** A bill verified from actual transaction data — exact amounts from recognized merchants */
export interface VerifiedBill {
  /** Category (e.g. "Energy", "Water", "Council Tax") */
  category: string;
  /** Recognized merchant name (e.g. "British Gas", "Thames Water") */
  merchant: string;
  /** Verified monthly amount (annualized from actual payments) */
  monthlyAmount: number;
  /** How often the bill is paid */
  frequency: 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'irregular';
  /** Last payment amount seen */
  lastPayment: number;
  /** Date of last payment */
  lastPaymentDate: string;
  /** Number of payments found in transaction history */
  paymentCount: number;
}

export interface EnrichmentResult {
  profile: FinancialProfile;
  archetype: Archetype;
  traits: { name: string; insight: string }[];
  strengths: { label: string; detail: string }[];
  blindSpots: { label: string; detail: string }[];
  decisionScore: DecisionScore;
  decisionStack: Move[];
  behavioralPatterns: string[];
  enrichedTransactions: EnrichedTransaction[];
  enrichmentMetrics: EnrichmentMetrics;
  /** Essentials expected from identity but not found in transactions */
  essentialGaps?: EssentialGap[];
  /** Bills verified from actual transaction data with exact amounts */
  verifiedBills?: VerifiedBill[];
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
  status?: 'pending' | 'approved' | 'dismissed' | 'deleted';
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
  income_sources?: { source: string; frequency: string; avgAmount: number; monthly: number; isSalary: boolean }[];
  essential_gaps?: EssentialGap[];
  verified_bills?: { category: string; merchant: string; monthlyAmount: number; frequency: string; lastPayment: number; lastPaymentDate: string }[];
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
export type UpcomingEventType = 'moving' | 'baby' | 'wedding' | 'career_change' | 'first_home' | 'business' | 'retirement' | 'none';

/** Backwards-compatible: a string event name OR a structured event with timeline */
export type UpcomingEvent = UpcomingEventType | { type: UpcomingEventType; months_away?: number | null };

/** Helper: extract event type from either string or structured event */
export function getEventType(e: UpcomingEvent): UpcomingEventType {
  return typeof e === 'string' ? e : e.type;
}

/** Helper: extract months_away from structured event (null if string or unset) */
export function getEventMonths(e: UpcomingEvent): number | null {
  return typeof e === 'object' && e.months_away != null ? e.months_away : null;
}
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

// ── Debt Account (synced from TrueLayer or manually added) ──

export interface DebtAccount {
  account_name?: string;
  account_type?: string;
  outstanding_balance?: number;
  credit_limit?: number;
  interest_rate?: number;
  minimum_payment?: number;
  is_default_apr?: boolean;
  institution?: string;
  provider_name?: string;
  connection_id?: string;
  account_id?: string;
}

// ── Budget Adjustment (user-added manual budget items) ──

export interface BudgetAdjustment {
  description?: string;
  category?: string;
  monthly_amount?: number;
  is_essential?: boolean;
}
