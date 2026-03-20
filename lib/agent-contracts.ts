// ── Agent Contracts ──
// Enforces that each agent stays within its boundaries:
// 1. Only calls tools it's allowed to call
// 2. Only reads skills it's assigned
// 3. Only produces output matching its schema
// 4. Never violates its hard rules
//
// The orchestrator calls these checks before and after each agent run.

import {
  AGENT_REGISTRY,
  type AgentId,
  type AgentOutput,
  type ToolId,
} from './agent-registry';

// ── Pre-flight checks ──
// Run BEFORE an agent executes to ensure preconditions are met.

export interface PreflightResult {
  ready: boolean;
  errors: string[];
  warnings: string[];
}

export function preflightCheck(
  agentId: AgentId,
  availableTools: ToolId[],
  completedAgents: AgentId[],
): PreflightResult {
  const def = AGENT_REGISTRY[agentId];
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Verify all required tools are available
  for (const tool of def.requiredTools) {
    if (!availableTools.includes(tool)) {
      errors.push(`Required tool "${tool}" is not available for ${def.name}`);
    }
  }

  // 2. Verify all dependencies have completed
  for (const dep of def.dependsOn) {
    if (!completedAgents.includes(dep)) {
      errors.push(`Dependency "${dep}" has not completed — ${def.name} cannot run`);
    }
  }

  // 3. Warn if optional tools are missing
  for (const tool of def.optionalTools) {
    if (!availableTools.includes(tool)) {
      warnings.push(`Optional tool "${tool}" is not available — ${def.name} may produce limited results`);
    }
  }

  return { ready: errors.length === 0, errors, warnings };
}

// ── Post-flight checks ──
// Run AFTER an agent executes to validate its output.

export interface PostflightResult {
  valid: boolean;
  contractViolations: string[];
  boundaryViolations: string[];
}

export function postflightCheck(
  agentId: AgentId,
  output: AgentOutput,
  toolsCalled: ToolId[],
): PostflightResult {
  const def = AGENT_REGISTRY[agentId];
  const contractViolations: string[] = [];
  const boundaryViolations: string[] = [];

  // 1. Validate output schema
  const validation = def.validateOutput(output);
  if (!validation.valid) {
    contractViolations.push(...validation.errors);
  }

  // 2. Verify all required tools were actually called
  for (const tool of def.requiredTools) {
    if (!toolsCalled.includes(tool)) {
      contractViolations.push(`Required tool "${tool}" was not called by ${def.name}`);
    }
  }

  // 3. Verify no unauthorized tools were called
  const allAllowed = new Set([...def.requiredTools, ...def.optionalTools]);
  for (const tool of toolsCalled) {
    if (!allAllowed.has(tool)) {
      boundaryViolations.push(`${def.name} called unauthorized tool "${tool}"`);
    }
  }

  // 4. Check hard-rule-specific output violations
  const ruleViolations = checkHardRules(agentId, output);
  boundaryViolations.push(...ruleViolations);

  return {
    valid: contractViolations.length === 0 && boundaryViolations.length === 0,
    contractViolations,
    boundaryViolations,
  };
}

// ── Hard rule enforcement ──
// Inspects output for content that violates an agent's hard rules.

function checkHardRules(agentId: AgentId, output: AgentOutput): string[] {
  const violations: string[] = [];

  switch (agentId) {
    case 'data_integrity': {
      // Must NOT contain insights, actions, or interpretations
      const o = output as Record<string, unknown>;
      if ('insights' in o) violations.push('Data Integrity Agent must NOT generate insights');
      if ('recommendations' in o) violations.push('Data Integrity Agent must NOT suggest actions');
      if ('actions' in o) violations.push('Data Integrity Agent must NOT suggest actions');
      break;
    }

    case 'financial_analyst': {
      // Must NOT contain recommendations or user-facing text
      const o = output as Record<string, unknown>;
      if ('recommendations' in o) violations.push('Financial Analyst must NOT produce recommendations');
      if ('allocations' in o) violations.push('Financial Analyst must NOT make allocation decisions');
      if ('user_message' in o) violations.push('Financial Analyst must NOT communicate with user');
      break;
    }

    case 'allocation': {
      // Must NOT contain user communication or simulations
      const o = output as Record<string, unknown>;
      if ('recommendations' in o) violations.push('Allocation Agent must NOT generate recommendations');
      if ('user_message' in o) violations.push('Allocation Agent must NOT communicate with user');
      if ('simulations' in o) violations.push('Allocation Agent must NOT simulate outcomes');
      break;
    }

    case 'risk_investment': {
      // Must NOT contain recommendations or deterministic conclusions
      const o = output as Record<string, unknown>;
      if ('recommendations' in o) violations.push('Risk Agent must NOT produce recommendations');
      if ('allocations' in o) violations.push('Risk Agent must NOT make allocation decisions');
      break;
    }

    case 'wealth_manager': {
      // Must NOT expose raw data
      const o = output as Record<string, unknown>;
      if ('raw_transactions' in o) violations.push('Wealth Manager must NOT expose raw data');
      if ('raw_balance_sheet' in o) violations.push('Wealth Manager must NOT expose raw data');
      // Every recommendation must have required fields
      if (Array.isArray(o.recommendations)) {
        for (const rec of o.recommendations as Record<string, unknown>[]) {
          if (!rec.action || typeof rec.action !== 'string') {
            violations.push('Each recommendation must have an action string');
          }
          if (typeof rec.amount !== 'number') {
            violations.push('Each recommendation must have a quantified amount');
          }
          if (typeof rec.expected_impact !== 'number') {
            violations.push('Each recommendation must have quantified expected_impact');
          }
        }
      }
      break;
    }
  }

  return violations;
}

// ── Cross-agent boundary check ──
// Ensures no agent is doing another agent's job.

export function checkAgentBoundary(
  agentId: AgentId,
  outputKeys: string[],
): string[] {
  const violations: string[] = [];

  // Define which output keys belong exclusively to which agent
  const exclusiveKeys: Record<string, AgentId> = {
    data_quality: 'data_integrity',
    inefficiencies: 'financial_analyst',
    allocations: 'allocation',
    median_outcome: 'risk_investment',
    probability_of_success: 'risk_investment',
    recommendations: 'wealth_manager',
  };

  for (const key of outputKeys) {
    const owner = exclusiveKeys[key];
    if (owner && owner !== agentId) {
      violations.push(
        `${AGENT_REGISTRY[agentId].name} produced "${key}" which belongs exclusively to ${AGENT_REGISTRY[owner].name}`,
      );
    }
  }

  return violations;
}
