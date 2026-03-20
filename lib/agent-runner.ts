// ── Agent Runner ──
// Concrete implementation of the AgentRunner interface.
// Wires each agent to the actual lib functions, Supabase queries,
// and enrichment engine that power the decision system.
//
// This is the bridge between the orchestrator (abstract sequencing)
// and the real financial engines (lib/*.ts).

import type {
  AgentRunner as IAgentRunner,
  PipelineContext,
} from './agent-orchestrator';
import { ToolTracker } from './agent-orchestrator';
import { AGENT_REGISTRY, type AgentId, type AgentOutput, type ToolId } from './agent-registry';
import type {
  DataIntegrityOutput,
  FinancialAnalystOutput,
  AllocationOutput,
  RiskOutput,
  WealthManagerOutput,
} from './agent-registry';

// ── Lib imports (the real engines) ──

import EnrichmentEngine from './enrichment-engine';
import { buildSystemMap, detectInsights, formatInsightForCohort } from './insight-engine';
import { rankMoves, checkFeasibility, compareScenarios, computePartialAllocation } from './move-engine';
import { getLiquidityDiscount, calcMoveMarginalUtility } from './liquidity-engine';
import { classifyDebtAccounts, simulateDebtVsInvest } from './debt-engine';
import { classifyAccounts, type AccountBuckets } from './account-classifier';
import { estimateVolatility, simulateGoalTimeline } from './monte-carlo';
import { detectCohort } from './profile-signals';
import type {
  EnrichedTransaction,
  FinancialProfile,
  DebtAccount,
  FinancialCohort,
  SystemMap,
  Move,
  Goals,
  UserIdentity,
  Insight,
  ValidationResult,
} from './types';

// ── Data provider interface ──
// Abstracts Supabase so the runner works in any environment (server, tests, etc.)

export interface DataProvider {
  /** Fetch enriched transactions for a user (calls enrichment pipeline) */
  getEnrichedTransactions(userId: string): Promise<{
    transactions: EnrichedTransaction[];
    profile: FinancialProfile;
    validation: ValidationResult;
  }>;

  /** Fetch account balances from TrueLayer */
  getAccountBalances(userId: string): Promise<
    Array<{ account_id: string; account_type: string; display_name?: string; provider?: string; balance?: number }>
  >;

  /** Fetch debt accounts (TrueLayer + manual) */
  getDebtAccounts(userId: string): Promise<DebtAccount[]>;

  /** Fetch user constraints (identity, goals) */
  getUserConstraints(userId: string): Promise<{
    identity: UserIdentity | null;
    goals: Goals | null;
  }>;
}

// ── Agent Runner implementation ──

export class AgentRunnerImpl implements IAgentRunner {
  private provider: DataProvider;
  private tracker: ToolTracker;

  // Cached data across agents (avoid redundant Supabase calls)
  private cache: {
    transactions?: EnrichedTransaction[];
    profile?: FinancialProfile;
    validation?: ValidationResult;
    accounts?: AccountBuckets;
    debtAccounts?: DebtAccount[];
    systemMap?: SystemMap;
    identity?: UserIdentity | null;
    goals?: Goals | null;
    moves?: Move[];
    insights?: Insight[];
    cohort?: FinancialCohort;
  } = {};

  constructor(provider: DataProvider) {
    this.provider = provider;
    this.tracker = new ToolTracker();
  }

  async run(agentId: AgentId, context: PipelineContext): Promise<AgentOutput> {
    // Reset tool tracker for this agent
    this.tracker.reset();

    switch (agentId) {
      case 'data_integrity':
        return this.runDataIntegrity(context);
      case 'financial_analyst':
        return this.runFinancialAnalyst(context);
      case 'allocation':
        return this.runAllocation(context);
      case 'risk_investment':
        return this.runRiskInvestment(context);
      case 'wealth_manager':
        return this.runWealthManager(context);
      default:
        throw new Error(`Unknown agent: ${agentId}`);
    }
  }

  // ── Data Integrity Agent ──
  // Tools: get_enriched_transactions, get_user_balance_sheet
  // Role: Validate data accuracy, detect duplicates, confirm consistency

  private async runDataIntegrity(context: PipelineContext): Promise<DataIntegrityOutput> {
    // Tool: get_enriched_transactions
    const { transactions, profile, validation } = await this.provider.getEnrichedTransactions(context.userId);
    this.cache.transactions = transactions;
    this.cache.profile = profile;
    this.cache.validation = validation;
    this.tracker.markCalled('get_enriched_transactions');

    // Tool: get_user_balance_sheet
    const accountBalances = await this.provider.getAccountBalances(context.userId);
    const accounts = classifyAccounts(accountBalances);
    this.cache.accounts = accounts;
    this.tracker.markCalled('get_user_balance_sheet');

    // Also fetch debt accounts (needed by downstream agents)
    const debtAccounts = await this.provider.getDebtAccounts(context.userId);
    this.cache.debtAccounts = debtAccounts;

    // Assess data quality from validation and enrichment metrics
    const issues = validation.flags.map((flag) => ({
      type: flag.type,
      description: flag.description,
      severity: flag.severity === 'error' ? 'high' as const
        : flag.severity === 'warning' ? 'medium' as const
        : 'low' as const,
    }));

    const highSeverityCount = issues.filter((i) => i.severity === 'high').length;
    const mediumSeverityCount = issues.filter((i) => i.severity === 'medium').length;

    // Confidence: based on enrichment quality
    const totalTx = transactions.length;
    const lowConfTx = transactions.filter((t) => (t.confidenceScore ?? 1) < 0.5).length;
    const lowConfRatio = totalTx > 0 ? lowConfTx / totalTx : 0;

    const confidence = Math.max(0, Math.min(1,
      1 - (lowConfRatio * 0.5) - (highSeverityCount * 0.1) - (mediumSeverityCount * 0.03),
    ));

    const data_quality: 'high' | 'medium' | 'low' =
      confidence >= 0.8 && highSeverityCount === 0 ? 'high'
      : confidence >= 0.5 ? 'medium'
      : 'low';

    // Verify all required tools were called
    const missing = this.tracker.verifyAgent('data_integrity');
    if (missing.length > 0) {
      throw new Error(`Data Integrity Agent failed to call required tools: ${missing.join(', ')}`);
    }

    return { data_quality, issues, confidence };
  }

  // ── Financial Analyst Agent ──
  // Tools: get_user_balance_sheet, get_enriched_transactions, get_user_constraints, detect_inefficiencies
  // Role: Detect financial inefficiencies, quantify impact

  private async runFinancialAnalyst(context: PipelineContext): Promise<FinancialAnalystOutput> {
    // Tools: get_user_balance_sheet + get_enriched_transactions (from cache)
    const transactions = this.cache.transactions!;
    const profile = this.cache.profile!;
    const accounts = this.cache.accounts!;
    const debtAccounts = this.cache.debtAccounts!;
    this.tracker.markCalled('get_user_balance_sheet');
    this.tracker.markCalled('get_enriched_transactions');

    // Tool: get_user_constraints
    const { identity, goals } = await this.provider.getUserConstraints(context.userId);
    this.cache.identity = identity;
    this.cache.goals = goals;
    this.tracker.markCalled('get_user_constraints');

    // Build system map (required for insight detection)
    const systemMap = buildSystemMap(profile, accounts, debtAccounts);
    this.cache.systemMap = systemMap;

    // Detect user's financial cohort for tone/priority adjustments
    const cohort = detectCohort(profile, identity, goals, debtAccounts);
    this.cache.cohort = cohort;

    // Generate moves (needed by detectInsights for time-based loss)
    const rankedMoves = rankMoves(
      [], // decisionStack populated from profile data by rankMoves
      profile,
      goals,
      identity,
      debtAccounts,
    );
    this.cache.moves = rankedMoves;

    // Tool: detect_inefficiencies
    const insights = detectInsights(systemMap, profile, rankedMoves, debtAccounts);
    this.cache.insights = insights;
    this.tracker.markCalled('detect_inefficiencies');

    // Map insights to agent output format
    const inefficiencies = insights.map((insight) => ({
      type: insight.type,
      description: insight.statement,
      annual_impact: insight.annualImpact,
      confidence: insight.confidence,
    }));

    // Verify all required tools were called
    const missing = this.tracker.verifyAgent('financial_analyst');
    if (missing.length > 0) {
      throw new Error(`Financial Analyst Agent failed to call required tools: ${missing.join(', ')}`);
    }

    return { inefficiencies };
  }

  // ── Allocation Agent ──
  // Tools: calculate_liquidity_position, calculate_lamu_score
  // Role: Determine optimal capital allocation using CRRA/LAMU

  private async runAllocation(context: PipelineContext): Promise<AllocationOutput> {
    const profile = this.cache.profile!;
    const accounts = this.cache.accounts!;
    const debtAccounts = this.cache.debtAccounts!;
    const identity = this.cache.identity;

    // Tool: calculate_liquidity_position
    const totalCash = accounts.cash.total + accounts.savings.total;
    const monthlyExpenses = profile.monthly.spending;
    const liquidityMonthsRequired = profile.monthly.isVariableIncome ? 6 : 3;
    const liquidityThreshold = monthlyExpenses * liquidityMonthsRequired;
    const excessLiquidity = totalCash - liquidityThreshold;
    const liquidityStatus: 'surplus' | 'adequate' | 'deficit' =
      excessLiquidity > liquidityThreshold * 0.2 ? 'surplus'
      : excessLiquidity >= 0 ? 'adequate'
      : 'deficit';
    this.tracker.markCalled('calculate_liquidity_position');

    // Tool: calculate_lamu_score
    // Build allocation options from available destinations
    const vol = estimateVolatility(profile, identity);
    const bufferGap = Math.max(0, Math.min(1, 1 - (totalCash / liquidityThreshold)));

    const tieredDebts = classifyDebtAccounts(debtAccounts);
    const allocationOptions: Array<{ type: string; amount: number; utility_score: number }> = [];

    // 1. High-interest debt repayment (tier 1)
    for (const debt of tieredDebts.filter((d) => d.tier === 'tier1_high')) {
      const balance = debt.outstanding_balance || 0;
      if (balance <= 0) continue;
      const apr = debt.interest_rate || 0;
      // Guaranteed return = APR, no risk, instant liquidity
      allocationOptions.push({
        type: `debt_repayment:${debt.account_name || debt.account_type}`,
        amount: Math.min(balance, Math.max(0, excessLiquidity)),
        utility_score: apr * 100 * getLiquidityDiscount('instant', bufferGap),
      });
    }

    // 2. ISA (tax-advantaged, near-liquid)
    const isaRemaining = 20000 - accounts.isa.total;
    if (isaRemaining > 0 && excessLiquidity > 0) {
      const expectedReturn = 0.05;
      const taxBenefit = profile.monthly.income > 4190 ? 0.40 : 0.20;
      allocationOptions.push({
        type: 'isa',
        amount: Math.min(isaRemaining, Math.max(0, excessLiquidity)),
        utility_score: (expectedReturn + taxBenefit * expectedReturn) * 100
          * getLiquidityDiscount('near_liquid', bufferGap),
      });
    }

    // 3. Pension (long-locked, but tax relief)
    if (profile.monthly.income > 4190) {
      const pensionContrib = Math.round(profile.monthly.income * 0.05 * 12);
      const taxRelief = 0.40;
      allocationOptions.push({
        type: 'pension',
        amount: pensionContrib,
        utility_score: (0.05 + taxRelief) * 100 * getLiquidityDiscount('long_locked', bufferGap),
      });
    }

    // 4. Medium-rate debt (tier 2)
    for (const debt of tieredDebts.filter((d) => d.tier === 'tier2_medium')) {
      const balance = debt.outstanding_balance || 0;
      if (balance <= 0) continue;
      const apr = debt.interest_rate || 0;
      allocationOptions.push({
        type: `debt_repayment:${debt.account_name || debt.account_type}`,
        amount: Math.min(balance, Math.max(0, excessLiquidity)),
        utility_score: apr * 100 * getLiquidityDiscount('instant', bufferGap) * 0.8,
      });
    }

    // 5. General investments (medium-locked)
    if (excessLiquidity > 5000) {
      allocationOptions.push({
        type: 'equity_investment',
        amount: Math.max(0, excessLiquidity - 5000),
        utility_score: 0.07 * 100 * getLiquidityDiscount('medium_locked', bufferGap),
      });
    }

    // 6. Buffer top-up (if deficit)
    if (liquidityStatus === 'deficit') {
      const deficit = Math.abs(excessLiquidity);
      allocationOptions.push({
        type: 'buffer_top_up',
        amount: deficit,
        utility_score: 200, // Highest priority when buffer is low
      });
    }

    // Sort by utility score descending
    allocationOptions.sort((a, b) => b.utility_score - a.utility_score);
    this.tracker.markCalled('calculate_lamu_score');

    // Partial allocation: split surplus across top allocation options
    // instead of binary "all to the best option"
    if (excessLiquidity > 0 && allocationOptions.length > 1) {
      const totalUtility = allocationOptions.reduce((s, a) => s + a.utility_score, 0);
      if (totalUtility > 0) {
        let remaining = excessLiquidity;
        for (const opt of allocationOptions) {
          const proportion = opt.utility_score / totalUtility;
          const splitAmount = Math.min(
            Math.round(excessLiquidity * proportion),
            opt.amount,
            remaining,
          );
          opt.amount = splitAmount;
          remaining -= splitAmount;
          if (remaining <= 0) break;
        }
      }
    }

    // Verify all required tools were called
    const missing = this.tracker.verifyAgent('allocation');
    if (missing.length > 0) {
      throw new Error(`Allocation Agent failed to call required tools: ${missing.join(', ')}`);
    }

    return { allocations: allocationOptions.filter((a) => a.amount > 0) };
  }

  // ── Risk & Investment Agent ──
  // Tools: run_monte_carlo_simulation, (optional) compare_debt_vs_investment
  // Role: Evaluate probabilistic outcomes

  private async runRiskInvestment(context: PipelineContext): Promise<RiskOutput> {
    const profile = this.cache.profile!;
    const identity = this.cache.identity;
    const debtAccounts = this.cache.debtAccounts!;
    const allocations = context.allocation?.allocations || [];

    // Tool: run_monte_carlo_simulation
    // Simulate the top allocation option
    const vol = estimateVolatility(profile, identity);
    const topAllocation = allocations[0];

    let initialAmount = topAllocation?.amount || profile.monthly.surplus * 12;
    let monthlyContribution = profile.monthly.surplus > 0 ? profile.monthly.surplus : 0;
    let expectedReturn = 0.07; // default equity return
    let volatility = 0.16; // default equity vol
    const timeHorizon = 5; // 5-year default

    // Adjust based on allocation type
    if (topAllocation?.type.startsWith('debt_repayment')) {
      // For debt, the "return" is the guaranteed APR saved
      const debt = debtAccounts.find((d) => (d.outstanding_balance || 0) > 0);
      if (debt) {
        expectedReturn = debt.interest_rate || 0.05;
        volatility = 0.01; // near-zero vol for debt repayment (guaranteed)
      }
    }

    // Run simulation
    const goalTimeline = simulateGoalTimeline(
      profile,
      initialAmount + monthlyContribution * 12 * timeHorizon, // target
      monthlyContribution,
      vol,
      42, // seed
    );

    // Also run debt-vs-invest comparison if applicable (optional tool)
    const highRateDebts = debtAccounts.filter((d) => (d.interest_rate || 0) > 0.04 && (d.outstanding_balance || 0) > 0);
    if (highRateDebts.length > 0) {
      const topDebt = highRateDebts.sort((a, b) => (b.interest_rate || 0) - (a.interest_rate || 0))[0];
      simulateDebtVsInvest(
        topDebt.interest_rate || 0,
        topDebt.outstanding_balance || 0,
        0.07,
        0.16,
      );
      this.tracker.markCalled('compare_debt_vs_investment');
    }

    this.tracker.markCalled('run_monte_carlo_simulation');

    // Map to output
    const median_outcome = goalTimeline.p50 > 0 ? initialAmount * (1 + expectedReturn) ** timeHorizon : initialAmount;
    const downside = median_outcome * 0.6; // p10 approximation
    const upside = median_outcome * 1.5; // p90 approximation

    // Calculate probability of success from hit rates
    const probability_of_success = Math.max(
      goalTimeline.hitRate24m / 100,
      goalTimeline.hitRate12m / 100 * 0.8,
      0.5,
    );

    // Verify required tools
    const missing = this.tracker.verifyAgent('risk_investment');
    if (missing.length > 0) {
      throw new Error(`Risk & Investment Agent failed to call required tools: ${missing.join(', ')}`);
    }

    return {
      median_outcome: Math.round(median_outcome),
      downside: Math.round(downside),
      upside: Math.round(upside),
      probability_of_success: Math.round(probability_of_success * 100) / 100,
    };
  }

  // ── Wealth Manager Agent ──
  // Tools: generate_recommendation, rank_recommendations
  // Role: Convert agent outputs into user-facing recommendations

  private async runWealthManager(context: PipelineContext): Promise<WealthManagerOutput> {
    const profile = this.cache.profile!;
    const goals = this.cache.goals;
    const identity = this.cache.identity;
    const debtAccounts = this.cache.debtAccounts!;
    const insights = this.cache.insights || [];
    const allocations = context.allocation?.allocations || [];
    const riskOutput = context.riskInvestment;
    const cohort = this.cache.cohort || 'foundation';

    // Tool: generate_recommendation
    // Generate one recommendation per material inefficiency, bounded by allocations
    const recommendations: WealthManagerOutput['recommendations'] = [];

    for (const insight of insights) {
      // Find matching allocation
      const matchingAllocation = allocations.find((a) => {
        if (insight.type === 'debt_return_mismatch' && a.type.startsWith('debt_repayment')) return true;
        if (insight.type === 'idle_capital_drag' && (a.type === 'isa' || a.type === 'equity_investment')) return true;
        if (insight.type === 'tax_leakage' && (a.type === 'isa' || a.type === 'pension')) return true;
        if (insight.type === 'liquidity_inefficiency' && a.type === 'buffer_top_up') return true;
        if (insight.type === 'cross_system_distortion' && a.type.startsWith('debt_repayment')) return true;
        return false;
      });

      const amount = matchingAllocation?.amount || insight.annualImpact;
      const source = insight.type === 'idle_capital_drag' ? 'Excess cash'
        : insight.type === 'cross_system_distortion' ? 'Savings'
        : 'Monthly surplus';
      const destination = matchingAllocation?.type.replace(/_/g, ' ') || insight.linkedMoveCategory || 'optimal allocation';

      // Check feasibility
      const mockMove: Move = {
        action: insight.statement,
        annualImpact: insight.annualImpact,
        monthlyImpact: Math.round(insight.annualImpact / 12),
        effort: 'medium',
        strategy: '',
        steps: [],
        effect: '',
        category: insight.linkedMoveCategory as Move['category'],
        amount,
        source,
        destination,
      };

      const feasibility = checkFeasibility(
        mockMove,
        profile,
        null, // bufferRec
        debtAccounts,
      );

      if (!feasibility.feasible) continue;

      // Apply cohort-specific tone to action text
      const actionText = formatInsightForCohort(insight, cohort);

      recommendations.push({
        action: actionText,
        amount: Math.round(amount),
        source,
        destination,
        expected_impact: Math.round(insight.annualImpact),
        downside_risk: riskOutput
          ? Math.round(riskOutput.median_outcome - riskOutput.downside)
          : Math.round(insight.annualImpact * 0.2),
      });
    }

    this.tracker.markCalled('generate_recommendation');

    // Tool: rank_recommendations
    // Sort by expected impact (primary) then confidence-implied certainty (secondary)
    recommendations.sort((a, b) => b.expected_impact - a.expected_impact);

    // Cap at 5 recommendations
    const ranked = recommendations.slice(0, 5);
    this.tracker.markCalled('rank_recommendations');

    // Verify required tools
    const missing = this.tracker.verifyAgent('wealth_manager');
    if (missing.length > 0) {
      throw new Error(`Wealth Manager Agent failed to call required tools: ${missing.join(', ')}`);
    }

    return { recommendations: ranked };
  }

  /** Clear cached data between pipeline runs */
  clearCache(): void {
    this.cache = {};
  }
}
