// ── Transactions ──

export interface RawTransaction {
  date: string;
  description: string;
  amount: number;
}

/** Economic type: what role this transaction plays in the user's financial system */
export type EconomicType =
  | 'income'
  | 'fixed_essential'
  | 'variable_essential'
  | 'discretionary'
  | 'debt_repayment'
  | 'asset_transfer'
  | 'internal_transfer'
  | 'investment'
  | 'tax_related'
  | 'anomalous';

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
  /** Numeric confidence score 0-1 for gating (Phase 1B) — stamped after enrichment */
  confidenceScore?: number;
  /** Which classification layer resolved this transaction */
  classifiedBy?: 'user_override' | 'merchant_db' | 'fuzzy_match' | 'keyword' | 'claude_ai' | 'default';
  /** Economic classification: what financial role this transaction plays (Phase 1A) */
  economicType?: EconomicType;
  /** Whether this is a fixed/recurring expense vs variable (Phase 1D) */
  isFixed?: boolean;
  /** Financial system role (Phase 1D) */
  financialRole?: 'obligation' | 'discretionary' | 'transfer' | 'investment' | 'income';
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
  /** Coefficient of variation (SD / mean) — higher = more variable */
  variability?: number;
  /** Individual transactions behind this income source */
  transactions?: TransactionDetail[];
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
    /** Monthly savings/investment outflows (ISA, pension, SIPP, premium bonds) */
    savings?: number;
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
  /** Person-to-person transfer debits (e.g. rent to partner) — excluded from spending but surfaced for manual recategorisation */
  transfers?: { date: string; merchant: string; description: string; amount: number }[];
  /** Irregular incoming person credits (repayments, gifts) — not income, not spending */
  incomingTransfers?: { date: string; merchant: string; description: string; amount: number }[];
  /** Savings/investment category items tracked separately from spending */
  savingsCategories?: BudgetCategory[];
  /** Monthly savings/investment total */
  monthlySavings?: number;
  /** Monthly-normalised transfer total */
  monthlyTransferTotal?: number;
  /** Analysis window in months */
  months?: number;
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

// ── Segment ──
// Replaces the old archetype system. Only two meaningful segments:
// 'structured' (SHE) and 'unstructured' (UHE) savings optimisers,
// plus 'default' for everyone else.

export type Segment = 'structured' | 'unstructured' | 'default';

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
  category?: 'break_even' | 'buffer' | 'debt' | 'spending' | 'savings' | 'invest' | 'allocate';
  merchants?: string[];
  /** Structured sub-goals derived from real data at generation time */
  subGoals?: MoveSubGoal[];
  /** Mathematical proof string showing the calculation behind the impact */
  proof?: string;
  /** Source account/bucket for reallocation moves (Phase 3B) */
  source?: string;
  /** Destination account/bucket for reallocation moves (Phase 3B) */
  destination?: string;
  /** Exact £ amount for the move (Phase 3B) */
  amount?: number;
  /** Type of recommendation (Phase 3B) */
  recommendationType?: 'reallocation' | 'reduction' | 'optimization' | 'timing';
  /** Whether this move was suppressed by a feasibility check (Phase 3A) */
  suppressed?: boolean;
  /** Reason for suppression (Phase 3A) */
  suppressedReason?: string;
  /** Scenario comparison: current vs recommended outcome (Phase 3C) */
  scenario?: ScenarioComparison;
}

/**
 * Resolve a human-readable name for a debt account.
 * Tries: account_name → institution → provider_name → merchantFallback → type-based fallback.
 * Never returns generic "Debt 1" style names.
 */
export function resolveDebtDisplayName(d: any, merchantFallback?: string): string {
  if (d?.account_name && d.account_name !== 'Card' && d.account_name !== 'card') return d.account_name;
  if (d?.institution) return d.institution;
  if (d?.provider_name) return d.provider_name;
  if (merchantFallback) return merchantFallback;
  // Type-based fallback
  const accType = d?.account_type || d?.type || '';
  if (/credit/i.test(accType)) return 'Credit card';
  if (/loan/i.test(accType)) return 'Loan';
  return 'Debt account';
}

/**
 * Derive sub-goals from a Move. Returns the move's own subGoals if present,
 * otherwise synthesises them from the action text / merchants / debt accounts
 * for older analyses.
 */
export function hydrateSubGoals(move: Move, debtAccounts?: any[]): MoveSubGoal[] | undefined {
  if (move.subGoals && move.subGoals.length > 0) return move.subGoals;

  const action = (move.action || '').toLowerCase();
  const cat = move.category;

  // Debt moves — use real debt accounts when available
  if (cat === 'debt') {
    const activeDebts = (debtAccounts || []).filter((d: any) => (d.outstanding_balance || 0) > 0);
    const merchants = move.merchants || [];
    if (activeDebts.length > 0) {
      return activeDebts.map((d: any, i: number) => ({
        type: 'debt_clear' as const,
        target: resolveDebtDisplayName(d, merchants[i]),
        startValue: Math.round(d.outstanding_balance || 0),
        targetValue: 0,
      }));
    }
    // Fallback for when no debt accounts are connected — use merchant names from move
    const countMatch = action.match(/(\d+)\s*debt/);
    if (countMatch) {
      const count = parseInt(countMatch[1], 10);
      return Array.from({ length: count }, (_, i) => ({
        type: 'debt_clear' as const,
        target: merchants[i] || `Debt account ${i + 1}`,
        startValue: 0,
        targetValue: 0,
      }));
    }
    if (action.includes('overpay') || action.includes('clear')) {
      return [{ type: 'debt_clear' as const, target: merchants[0] || 'Debt account', startValue: 0, targetValue: 0 }];
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

/**
 * Repair stale persisted sub-goals that have placeholder data (generic names,
 * zero balances) by backfilling from real debt accounts. Returns the original
 * sub-goals unchanged if they already have real data.
 */
export function repairDebtSubGoals(sgs: MoveSubGoal[], debtAccounts: any[]): MoveSubGoal[] {
  const activeDebts = debtAccounts.filter((d: any) => (d.outstanding_balance || 0) > 0);
  if (activeDebts.length === 0) return sgs;

  const debtSgs = sgs.filter((sg) => sg.type === 'debt_clear');
  // Only repair if ALL debt sub-goals have placeholder names and zero startValues
  const allPlaceholder = debtSgs.length > 0 && debtSgs.every(
    (sg) => sg.startValue === 0 && /^Debt(\s+\d+)?$/.test(sg.target),
  );
  if (!allPlaceholder) return sgs;

  // Replace placeholder debt sub-goals with real account data
  const nonDebtSgs = sgs.filter((sg) => sg.type !== 'debt_clear');
  const repairedDebtSgs: MoveSubGoal[] = activeDebts.map((d: any) => ({
    type: 'debt_clear' as const,
    target: resolveDebtDisplayName(d),
    startValue: Math.round(d.outstanding_balance || 0),
    targetValue: 0,
  }));
  return [...repairedDebtSgs, ...nonDebtSgs];
}

// ── Scenario Comparison (Phase 3C) ──

export interface ScenarioComparison {
  current: { median: number; p10: number; p90: number };
  recommended: { median: number; p10: number; p90: number };
  netDifference: number;
  /** % of simulations where recommended beats current */
  probability: number;
}

// ── Insight Types (Phase 2) ──

export type InsightType =
  | 'idle_capital_drag'
  | 'tax_leakage'
  | 'debt_return_mismatch'
  | 'liquidity_inefficiency'
  | 'cross_system_distortion'
  | 'time_based_loss';

export interface Insight {
  type: InsightType;
  /** BOCY-level statement: "£X earning Y% is reducing your net outcome by ~£Z/year" */
  statement: string;
  /** Annual £ impact */
  annualImpact: number;
  /** Long-term compounding impact (5-year) */
  longTermImpact?: number;
  /** Root cause */
  cause: string;
  /** What happens if no action taken */
  implication: string;
  /** Which move category addresses this */
  linkedMoveCategory?: string;
  /** 0-1 confidence */
  confidence: number;
  /** Display priority (lower = more important) */
  priority: number;
}

// ── System Map (Phase 2A) ──

export interface SystemMap {
  assets: {
    cash: number;
    savings: number;
    isa: number;
    pension: number;
    investments: number;
  };
  liabilities: {
    mortgage: number;
    loans: number;
    creditCards: number;
    bnpl: number;
  };
  constraints: {
    liquidityNeed: number;
    taxWrapperCapacity: number;
    incomeStability: number;
  };
}

// ── Debt Tier (Phase 4A) ──

export type DebtTier = 'tier1_high' | 'tier2_medium' | 'tier3_low';

export interface TieredDebtAccount extends DebtAccount {
  tier: DebtTier;
  /** Tier-appropriate language for display */
  tierLabel: string;
}

// ── Validation Result (Phase 1C) ──

export interface ValidationResult {
  flags: ValidationFlag[];
  reclassified: number;
  confidenceDowngrades: number;
}

export interface ValidationFlag {
  type: 'consistency' | 'balance' | 'cross_account';
  description: string;
  transactionIndex?: number;
  severity: 'info' | 'warning' | 'error';
}

// ── Decision Score ──

export interface DecisionScore {
  score: number;
  verdict: 'Strong' | 'Balanced' | 'Needs Attention' | 'At Risk';
  breakdown: { factor: string; impact: number }[];
}

// ── Goals ──

export type IncomeBand = 'under_30k' | '30k_50k' | '50k_100k' | 'over_100k';
export type GoalTimeline = '6_months' | '1_year' | '2_years' | '3_5_years';
export type UpcomingEventWithTimeline = { type: string; monthsAway: number | null };

export type FinancialCohort = 'crisis' | 'debt_focus' | 'foundation' | 'accumulator' | 'optimizer' | 'coasting';

export interface Goals {
  id?: string;
  user_id?: string;
  current_situation: string;
  one_year_goal: string;
  two_year_goal: string;
  target_amount?: number;
  goal_timeline?: GoalTimeline;
}

// ── Analysis (stored in Supabase) ──

export interface Analysis {
  id?: string;
  user_id?: string;
  segment: string;
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
  /** Person-to-person transfer debits surfaced for manual recategorisation */
  person_transfers?: { date: string; merchant: string; description: string; amount: number }[];
  /** Savings/investment outflows tracked separately from spending */
  savings_categories?: BudgetCategory[];
  /** Monthly savings total (ISA, pension, SIPP etc.) */
  monthly_savings?: number;
  /** Irregular incoming person credits (repayments, gifts) — not income, not spending */
  incoming_transfers?: { date: string; merchant: string; description: string; amount: number }[];
  /** Enrichment metrics preserved for move recomputation */
  enrichment_metrics?: {
    subscriptionCount: number;
    streamingCount: number;
    creditCardCount: number;
    bnplCount: number;
  };
  /** Analysis window in months — needed for optimistic UI to maintain monthly normalization */
  analysis_months?: number;
  /** Detected insights from the insight engine (Phase 2) */
  insights?: Insight[];
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
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'irregular';
  /** Last payment amount seen */
  lastPayment: number;
  /** Date of last payment */
  lastPaymentDate: string;
  /** Number of payments found in transaction history */
  paymentCount: number;
}

export interface EnrichmentResult {
  profile: FinancialProfile;
  segment: Segment;
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
  type: 'plan_proposed' | 'override_saved' | 'goal_update_proposed' | 'plan_error' | 'budget_item_saved' | 'income_summary';
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
    // income summary fields
    income_sources?: { source: string; frequency: string; monthly: number; isSalary: boolean }[];
    essentials_total?: number;
    lifestyle_total?: number;
    surplus?: number;
    monthly_income?: number;
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
  segment?: string;
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
  debt_accounts?: { name: string; type: string; balance: number | null; limit: number | null; interest_rate?: number | null; minimum_payment?: number | null }[];
  /** Transactions the enrichment engine could not categorize — surfaced for user review */
  uncategorized_transactions?: { description: string; amount: number; date: string; count: number }[];
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
  /** Phase 5D: Active insights for proactive injection into chat */
  active_insights?: { statement: string; annualImpact: number; linkedMoveCategory?: string }[];
  /** §14n: Capital allocation context for high-earner cohorts */
  cohort?: 'crisis' | 'debt_focus' | 'foundation' | 'accumulator' | 'optimizer' | 'coasting';
  high_earner_cohort?: 'unstructured_high_earner' | 'structured_high_earner' | null;
  account_summary?: { cash: number; savings: number; isa: number; pension: number; investments: number };
  idle_capital?: number;
  isa_remaining?: number;
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
  upcoming_events: (UpcomingEvent | { type: string; months_away: number })[];
  dependents: Dependent[];
  income_band?: IncomeBand;
  created_at?: string;
  updated_at?: string;
}

// ── Debt Accounts (TrueLayer + manual) ──

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
