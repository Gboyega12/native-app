// ── Agent Registry ──
// Maps each agent to its tools, skills, required inputs, expected outputs,
// and hard constraints. The orchestrator uses this to wire agents correctly.

// ── Agent identifiers ──

export type AgentId =
  | 'data_integrity'
  | 'financial_analyst'
  | 'allocation'
  | 'risk_investment'
  | 'tax_estate'
  | 'wealth_manager'
  | 'growth';

// ── Tool identifiers (from decision-engine-tools.json) ──

export type ToolId =
  | 'get_user_balance_sheet'
  | 'get_enriched_transactions'
  | 'get_user_constraints'
  | 'calculate_liquidity_position'
  | 'calculate_lamu_score'
  | 'run_monte_carlo_simulation'
  | 'compare_debt_vs_investment'
  | 'detect_inefficiencies'
  | 'quantify_opportunity_cost'
  | 'calculate_tax_position'
  | 'simulate_estate_iht'
  | 'generate_recommendation'
  | 'rank_recommendations'
  | 'generate_growth_report';

// ── Skill identifiers (from skills/*.md) ──

export type SkillId =
  | 'transaction_enrichment'
  | 'insight_engine'
  | 'recommendation_engine'
  | 'financial_models'
  | 'debt_intelligence'
  | 'bocy_philosophy'
  | 'tone'
  | 'user_cohorts'
  | 'app_behaviour'
  | 'chat_engine'
  | 'growth_product'
  | 'tax_optimisation'
  | 'estate_planning'
  | 'quant_models';

// ── Agent output schemas (for contract validation) ──

export interface DataIntegrityOutput {
  data_quality: 'high' | 'medium' | 'low';
  issues: Array<{
    type: string;
    description: string;
    severity: 'low' | 'medium' | 'high';
  }>;
  confidence: number;
}

export interface Inefficiency {
  type: string;
  description: string;
  annual_impact: number;
  confidence: number;
}

export interface FinancialAnalystOutput {
  inefficiencies: Inefficiency[];
}

export interface Allocation {
  type: string;
  amount: number;
  utility_score: number;
}

export interface AllocationOutput {
  allocations: Allocation[];
}

export interface RiskOutput {
  median_outcome: number;
  downside: number;
  upside: number;
  probability_of_success: number;
}

export interface Recommendation {
  action: string;
  amount: number;
  source: string;
  destination: string;
  expected_impact: number;
  downside_risk: number;
}

export interface WealthManagerOutput {
  recommendations: Recommendation[];
}

export interface GrowthReportInsight {
  insight: string;
  impact: number;
}

export interface GrowthAgentOutput {
  report: {
    headline: string;
    system_progress: {
      net_improvement: number;
      drivers: string[];
    };
    key_insights: GrowthReportInsight[];
    forward_outlook: {
      projected_gain: number;
      time_horizon: string;
    };
    next_actions: Array<{
      action: string;
      impact: number;
    }>;
  };
}

export interface TaxOptimisationOpportunity {
  type: string;
  description: string;
  annual_tax_saving: number;
  confidence: number;
}

export interface ActivePET {
  amount: number;
  date: string;
  years_remaining: number;
  taper_relief_pct: number;
}

export interface GiftingRecommendation {
  action: string;
  amount: number;
  iht_saving: number;
  time_horizon: string;
}

export interface TaxEstateOutput {
  tax_analysis: {
    effective_tax_rate: number;
    annual_tax_drag: number;
    wrapper_utilisation: {
      isa_used: number;
      isa_remaining: number;
      pension_contributed: number;
      pension_relief_captured: number;
    };
    cgt_position: {
      realised_gains: number;
      unrealised_gains: number;
      allowance_remaining: number;
      losses_available: number;
    };
    optimisation_opportunities: TaxOptimisationOpportunity[];
  };
  estate_analysis: {
    estimated_estate_value: number;
    iht_liability: number;
    nil_rate_band_available: number;
    residence_nil_rate_band_available: number;
    active_pets: ActivePET[];
    gifting_recommendations: GiftingRecommendation[];
  };
}

// ── Agent output union ──

export type AgentOutput =
  | DataIntegrityOutput
  | FinancialAnalystOutput
  | AllocationOutput
  | RiskOutput
  | TaxEstateOutput
  | WealthManagerOutput
  | GrowthAgentOutput;

// ── Agent definition ──

export interface AgentDefinition {
  id: AgentId;
  name: string;
  role: string;

  /** Tools this agent is REQUIRED to call */
  requiredTools: ToolId[];

  /** Tools this agent MAY call if conditions warrant */
  optionalTools: ToolId[];

  /** Skills this agent must load for context */
  skills: SkillId[];

  /** Which agents must complete before this one runs */
  dependsOn: AgentId[];

  /** Hard constraints — things this agent must NEVER do */
  hardRules: string[];

  /** Validates the agent's output conforms to its contract */
  validateOutput: (output: unknown) => { valid: boolean; errors: string[] };
}

// ── Output validators ──

function validateDataIntegrity(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };
  if (!['high', 'medium', 'low'].includes(o.data_quality as string)) {
    errors.push('data_quality must be high | medium | low');
  }
  if (!Array.isArray(o.issues)) errors.push('issues must be an array');
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) {
    errors.push('confidence must be a number between 0 and 1');
  }
  return { valid: errors.length === 0, errors };
}

function validateFinancialAnalyst(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };
  if (!Array.isArray(o.inefficiencies)) {
    errors.push('inefficiencies must be an array');
  } else {
    for (const item of o.inefficiencies as Record<string, unknown>[]) {
      if (typeof item.annual_impact !== 'number') errors.push('Each inefficiency must have annual_impact as number');
      if (typeof item.confidence !== 'number') errors.push('Each inefficiency must have confidence as number');
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateAllocation(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };
  if (!Array.isArray(o.allocations)) {
    errors.push('allocations must be an array');
  } else {
    for (const item of o.allocations as Record<string, unknown>[]) {
      if (typeof item.utility_score !== 'number') errors.push('Each allocation must have utility_score as number');
      if (typeof item.amount !== 'number') errors.push('Each allocation must have amount as number');
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateRiskInvestment(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };
  const required = ['median_outcome', 'downside', 'upside', 'probability_of_success'];
  for (const key of required) {
    if (typeof o[key] !== 'number') errors.push(`${key} must be a number`);
  }
  return { valid: errors.length === 0, errors };
}

function validateWealthManager(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };
  if (!Array.isArray(o.recommendations)) {
    errors.push('recommendations must be an array');
  } else {
    for (const item of o.recommendations as Record<string, unknown>[]) {
      if (typeof item.action !== 'string') errors.push('Each recommendation must have action as string');
      if (typeof item.amount !== 'number') errors.push('Each recommendation must have amount as number');
      if (typeof item.expected_impact !== 'number') errors.push('Each recommendation must have expected_impact as number');
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateGrowthAgent(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };
  const report = o.report as Record<string, unknown> | undefined;
  if (!report || typeof report !== 'object') {
    errors.push('report must be an object');
    return { valid: false, errors };
  }
  if (typeof report.headline !== 'string') errors.push('report.headline must be a string');
  const sp = report.system_progress as Record<string, unknown> | undefined;
  if (!sp || typeof sp !== 'object') {
    errors.push('report.system_progress must be an object');
  } else {
    if (typeof sp.net_improvement !== 'number') errors.push('system_progress.net_improvement must be a number');
    if (!Array.isArray(sp.drivers)) errors.push('system_progress.drivers must be an array');
  }
  if (!Array.isArray(report.key_insights)) {
    errors.push('report.key_insights must be an array');
  } else {
    for (const item of report.key_insights as Record<string, unknown>[]) {
      if (typeof item.insight !== 'string') errors.push('Each key_insight must have insight as string');
      if (typeof item.impact !== 'number') errors.push('Each key_insight must have impact as number');
    }
  }
  const outlook = report.forward_outlook as Record<string, unknown> | undefined;
  if (!outlook || typeof outlook !== 'object') {
    errors.push('report.forward_outlook must be an object');
  } else {
    if (typeof outlook.projected_gain !== 'number') errors.push('forward_outlook.projected_gain must be a number');
    if (typeof outlook.time_horizon !== 'string') errors.push('forward_outlook.time_horizon must be a string');
  }
  if (!Array.isArray(report.next_actions)) {
    errors.push('report.next_actions must be an array');
  } else {
    for (const item of report.next_actions as Record<string, unknown>[]) {
      if (typeof item.action !== 'string') errors.push('Each next_action must have action as string');
      if (typeof item.impact !== 'number') errors.push('Each next_action must have impact as number');
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateTaxEstate(output: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const o = output as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['Output must be an object'] };

  // Validate tax_analysis
  const tax = o.tax_analysis as Record<string, unknown> | undefined;
  if (!tax || typeof tax !== 'object') {
    errors.push('tax_analysis must be an object');
  } else {
    if (typeof tax.effective_tax_rate !== 'number') errors.push('tax_analysis.effective_tax_rate must be a number');
    if (typeof tax.annual_tax_drag !== 'number') errors.push('tax_analysis.annual_tax_drag must be a number');
    const wrapper = tax.wrapper_utilisation as Record<string, unknown> | undefined;
    if (!wrapper || typeof wrapper !== 'object') {
      errors.push('tax_analysis.wrapper_utilisation must be an object');
    } else {
      if (typeof wrapper.isa_used !== 'number') errors.push('wrapper_utilisation.isa_used must be a number');
      if (typeof wrapper.isa_remaining !== 'number') errors.push('wrapper_utilisation.isa_remaining must be a number');
    }
    const cgt = tax.cgt_position as Record<string, unknown> | undefined;
    if (!cgt || typeof cgt !== 'object') {
      errors.push('tax_analysis.cgt_position must be an object');
    } else {
      if (typeof cgt.allowance_remaining !== 'number') errors.push('cgt_position.allowance_remaining must be a number');
    }
    if (!Array.isArray(tax.optimisation_opportunities)) {
      errors.push('tax_analysis.optimisation_opportunities must be an array');
    } else {
      for (const opp of tax.optimisation_opportunities as Record<string, unknown>[]) {
        if (typeof opp.annual_tax_saving !== 'number') errors.push('Each opportunity must have annual_tax_saving as number');
        if (typeof opp.confidence !== 'number') errors.push('Each opportunity must have confidence as number');
      }
    }
  }

  // Validate estate_analysis
  const estate = o.estate_analysis as Record<string, unknown> | undefined;
  if (!estate || typeof estate !== 'object') {
    errors.push('estate_analysis must be an object');
  } else {
    if (typeof estate.estimated_estate_value !== 'number') errors.push('estate_analysis.estimated_estate_value must be a number');
    if (typeof estate.iht_liability !== 'number') errors.push('estate_analysis.iht_liability must be a number');
    if (typeof estate.nil_rate_band_available !== 'number') errors.push('estate_analysis.nil_rate_band_available must be a number');
    if (!Array.isArray(estate.active_pets)) errors.push('estate_analysis.active_pets must be an array');
    if (!Array.isArray(estate.gifting_recommendations)) errors.push('estate_analysis.gifting_recommendations must be an array');
  }

  return { valid: errors.length === 0, errors };
}

// ── Registry ──

export const AGENT_REGISTRY: Record<AgentId, AgentDefinition> = {
  data_integrity: {
    id: 'data_integrity',
    name: 'Data Integrity Agent',
    role: 'Audit layer — validates financial data accuracy and consistency',
    requiredTools: ['get_enriched_transactions', 'get_user_balance_sheet'],
    optionalTools: [],
    skills: ['transaction_enrichment'],
    dependsOn: [],
    hardRules: [
      'Do NOT generate insights',
      'Do NOT suggest actions',
      'Do NOT interpret financial meaning beyond validation',
    ],
    validateOutput: validateDataIntegrity,
  },

  financial_analyst: {
    id: 'financial_analyst',
    name: 'Financial Analyst Agent',
    role: 'Diagnostic engine — detects financial inefficiencies',
    requiredTools: [
      'get_user_balance_sheet',
      'get_enriched_transactions',
      'get_user_constraints',
      'detect_inefficiencies',
    ],
    optionalTools: ['quantify_opportunity_cost'],
    skills: ['insight_engine', 'financial_models'],
    dependsOn: ['data_integrity'],
    hardRules: [
      'No recommendations',
      'No allocation decisions',
      'No user-facing communication',
    ],
    validateOutput: validateFinancialAnalyst,
  },

  allocation: {
    id: 'allocation',
    name: 'Allocation Agent',
    role: 'Portfolio allocation engine — determines where each marginal £ goes',
    requiredTools: [
      'calculate_liquidity_position',
      'calculate_lamu_score',
    ],
    optionalTools: [],
    skills: ['financial_models', 'debt_intelligence'],
    dependsOn: ['financial_analyst'],
    hardRules: [
      'Do NOT communicate with user',
      'Do NOT simulate outcomes',
      'Do NOT generate recommendations',
    ],
    validateOutput: validateAllocation,
  },

  risk_investment: {
    id: 'risk_investment',
    name: 'Risk & Investment Agent',
    role: 'Risk and simulation engine — evaluates probabilistic outcomes',
    requiredTools: ['run_monte_carlo_simulation'],
    optionalTools: ['compare_debt_vs_investment'],
    skills: ['financial_models', 'debt_intelligence'],
    dependsOn: ['allocation'],
    hardRules: [
      'No recommendations',
      'No allocation decisions',
      'No simplification of uncertainty',
    ],
    validateOutput: validateRiskInvestment,
  },

  tax_estate: {
    id: 'tax_estate',
    name: 'Tax & Estate Planning Agent',
    role: 'Tax and estate intelligence layer — evaluates tax efficiency and IHT exposure',
    requiredTools: [
      'get_user_balance_sheet',
      'get_enriched_transactions',
      'calculate_tax_position',
      'simulate_estate_iht',
    ],
    optionalTools: ['get_user_constraints', 'calculate_liquidity_position'],
    skills: ['tax_optimisation', 'estate_planning', 'quant_models', 'financial_models'],
    dependsOn: ['financial_analyst', 'allocation'],
    hardRules: [
      'No user-facing communication (Wealth Manager role)',
      'No allocation decisions (Allocation Agent role)',
      'No risk simulation (Risk Agent role)',
      'Must not override tax wrapper priority: ISA > Pension > GIA',
      'Must comply with HMRC regulations — no avoidance schemes',
      'All descriptions must be observations, not directives (no "use", "make", "maximise")',
      'All outputs are informational — not financial, tax, or legal advice',
      'Must include confidence/uncertainty qualifiers on all opportunity descriptions',
    ],
    validateOutput: validateTaxEstate,
  },

  wealth_manager: {
    id: 'wealth_manager',
    name: 'Wealth Manager Agent',
    role: 'Decision layer — converts system outputs into actionable recommendations',
    requiredTools: ['generate_recommendation', 'rank_recommendations'],
    optionalTools: [],
    skills: ['recommendation_engine', 'bocy_philosophy', 'tone', 'user_cohorts'],
    dependsOn: ['financial_analyst', 'allocation', 'risk_investment', 'tax_estate'],
    hardRules: [
      'Only agent allowed to produce user-facing output',
      'No raw data exposure',
      'No unstructured reasoning',
    ],
    validateOutput: validateWealthManager,
  },

  growth: {
    id: 'growth',
    name: 'Growth Agent',
    role: 'Growth decision engine — generates forward-looking personalised growth reports',
    requiredTools: ['generate_growth_report'],
    optionalTools: ['get_user_balance_sheet', 'get_enriched_transactions'],
    skills: ['growth_product', 'tone'],
    dependsOn: ['wealth_manager'],
    hardRules: [
      'Do NOT generate content directly — only trigger and structure growth outputs',
      'Do NOT exaggerate improvements',
      'Do NOT create artificial engagement',
      'All improvements must be backed by real financial data',
    ],
    validateOutput: validateGrowthAgent,
  },
};

// ── Execution order (topologically sorted) ──

export const EXECUTION_ORDER: AgentId[] = [
  'data_integrity',
  'financial_analyst',
  'allocation',
  'risk_investment',
  'tax_estate',
  'wealth_manager',
  'growth',
];

// ── Helper: get all tools an agent needs ──

export function getAgentTools(agentId: AgentId): ToolId[] {
  const def = AGENT_REGISTRY[agentId];
  return [...def.requiredTools, ...def.optionalTools];
}

// ── Helper: get all skills an agent needs ──

export function getAgentSkills(agentId: AgentId): SkillId[] {
  return AGENT_REGISTRY[agentId].skills;
}
