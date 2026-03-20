// ── Agent Registry ──
// Maps each agent to its tools, skills, required inputs, expected outputs,
// and hard constraints. The orchestrator uses this to wire agents correctly.

// ── Agent identifiers ──

export type AgentId =
  | 'data_integrity'
  | 'financial_analyst'
  | 'allocation'
  | 'risk_investment'
  | 'wealth_manager';

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
  | 'generate_recommendation'
  | 'rank_recommendations';

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
  | 'chat_engine';

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

// ── Agent output union ──

export type AgentOutput =
  | DataIntegrityOutput
  | FinancialAnalystOutput
  | AllocationOutput
  | RiskOutput
  | WealthManagerOutput;

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

  wealth_manager: {
    id: 'wealth_manager',
    name: 'Wealth Manager Agent',
    role: 'Decision layer — converts system outputs into actionable recommendations',
    requiredTools: ['generate_recommendation', 'rank_recommendations'],
    optionalTools: [],
    skills: ['recommendation_engine', 'bocy_philosophy', 'tone', 'user_cohorts'],
    dependsOn: ['financial_analyst', 'allocation', 'risk_investment'],
    hardRules: [
      'Only agent allowed to produce user-facing output',
      'No raw data exposure',
      'No unstructured reasoning',
    ],
    validateOutput: validateWealthManager,
  },
};

// ── Execution order (topologically sorted) ──

export const EXECUTION_ORDER: AgentId[] = [
  'data_integrity',
  'financial_analyst',
  'allocation',
  'risk_investment',
  'wealth_manager',
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
