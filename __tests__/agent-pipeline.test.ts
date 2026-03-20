import { describe, it, expect, beforeEach } from '@jest/globals';
import { AgentOrchestrator, type AgentRunner, type PipelineContext } from '../lib/agent-orchestrator.js';
import {
  AGENT_REGISTRY,
  EXECUTION_ORDER,
  type AgentId,
  type AgentOutput,
  type DataIntegrityOutput,
  type FinancialAnalystOutput,
  type AllocationOutput,
  type RiskOutput,
  type WealthManagerOutput,
} from '../lib/agent-registry.js';
import { preflightCheck, postflightCheck, checkAgentBoundary } from '../lib/agent-contracts.js';

// ── Mock outputs ──

const mockDataIntegrity: DataIntegrityOutput = {
  data_quality: 'high',
  issues: [],
  confidence: 0.92,
};

const mockFinancialAnalyst: FinancialAnalystOutput = {
  inefficiencies: [
    { type: 'idle_capital_drag', description: '£15,000 idle cash', annual_impact: 525, confidence: 0.9 },
    { type: 'tax_leakage', description: 'ISA allowance unused', annual_impact: 200, confidence: 0.85 },
  ],
};

const mockAllocation: AllocationOutput = {
  allocations: [
    { type: 'isa', amount: 10000, utility_score: 8.5 },
    { type: 'debt_repayment:credit_card', amount: 3000, utility_score: 12.0 },
  ],
};

const mockRisk: RiskOutput = {
  median_outcome: 15000,
  downside: 9000,
  upside: 22000,
  probability_of_success: 0.72,
};

const mockWealth: WealthManagerOutput = {
  recommendations: [
    {
      action: 'Move £10,000 into ISA',
      amount: 10000,
      source: 'Excess cash',
      destination: 'ISA',
      expected_impact: 525,
      downside_risk: 100,
    },
  ],
};

// ── Mock runner ──

function createMockRunner(overrides?: Partial<Record<AgentId, AgentOutput | Error>>): AgentRunner {
  const outputs: Record<AgentId, AgentOutput> = {
    data_integrity: mockDataIntegrity,
    financial_analyst: mockFinancialAnalyst,
    allocation: mockAllocation,
    risk_investment: mockRisk,
    wealth_manager: mockWealth,
    ...Object.fromEntries(
      Object.entries(overrides || {}).filter(([, v]) => !(v instanceof Error)),
    ),
  } as Record<AgentId, AgentOutput>;

  const errors = Object.fromEntries(
    Object.entries(overrides || {}).filter(([, v]) => v instanceof Error),
  ) as Record<string, Error>;

  return {
    async run(agentId: AgentId, _context: PipelineContext): Promise<AgentOutput> {
      if (errors[agentId]) throw errors[agentId];
      return outputs[agentId];
    },
  };
}

// Suppress console output during tests
const silentLogger = { log: () => {} };

// ── Tests ──

describe('Agent Registry', () => {
  it('defines all 5 agents', () => {
    expect(Object.keys(AGENT_REGISTRY)).toHaveLength(5);
    for (const id of EXECUTION_ORDER) {
      expect(AGENT_REGISTRY[id]).toBeDefined();
      expect(AGENT_REGISTRY[id].name).toBeTruthy();
      expect(AGENT_REGISTRY[id].role).toBeTruthy();
    }
  });

  it('every agent has required tools', () => {
    for (const id of EXECUTION_ORDER) {
      expect(AGENT_REGISTRY[id].requiredTools.length).toBeGreaterThan(0);
    }
  });

  it('every agent has hard rules', () => {
    for (const id of EXECUTION_ORDER) {
      expect(AGENT_REGISTRY[id].hardRules.length).toBeGreaterThan(0);
    }
  });

  it('execution order is topologically sorted', () => {
    const completed: AgentId[] = [];
    for (const id of EXECUTION_ORDER) {
      for (const dep of AGENT_REGISTRY[id].dependsOn) {
        expect(completed).toContain(dep);
      }
      completed.push(id);
    }
  });

  it('validates correct DataIntegrityOutput', () => {
    const result = AGENT_REGISTRY.data_integrity.validateOutput(mockDataIntegrity);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid DataIntegrityOutput', () => {
    const result = AGENT_REGISTRY.data_integrity.validateOutput({ data_quality: 'invalid' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates correct WealthManagerOutput', () => {
    const result = AGENT_REGISTRY.wealth_manager.validateOutput(mockWealth);
    expect(result.valid).toBe(true);
  });

  it('rejects WealthManagerOutput with missing fields', () => {
    const bad = { recommendations: [{ action: 'do something' }] };
    const result = AGENT_REGISTRY.wealth_manager.validateOutput(bad);
    expect(result.valid).toBe(false);
  });
});

describe('Agent Orchestrator', () => {
  it('runs full pipeline successfully', async () => {
    const runner = createMockRunner();
    const orchestrator = new AgentOrchestrator(runner, { logger: silentLogger });

    const result = await orchestrator.execute({ userId: 'test-user' });

    expect(result.status).toBe('completed');
    expect(result.recommendations).toBeTruthy();
    expect(result.recommendations!.recommendations).toHaveLength(1);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);

    // All agents should have run
    for (const id of EXECUTION_ORDER) {
      expect(result.results[id].status).toBe('success');
    }
  });

  it('halts pipeline when data confidence is low', async () => {
    const lowConfidence: DataIntegrityOutput = {
      data_quality: 'low',
      issues: [{ type: 'balance', description: 'Major inconsistency', severity: 'high' }],
      confidence: 0.3,
    };

    const runner = createMockRunner({ data_integrity: lowConfidence });
    const orchestrator = new AgentOrchestrator(runner, { logger: silentLogger });

    const result = await orchestrator.execute({ userId: 'test-user' });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toContain('confidence');
    expect(result.results.data_integrity.status).toBe('halted');
    expect(result.results.financial_analyst.status).toBe('skipped');
  });

  it('uses quick_check sequence when intent is quick_check', async () => {
    const runner = createMockRunner();
    const orchestrator = new AgentOrchestrator(runner, { logger: silentLogger });

    const result = await orchestrator.execute({ userId: 'test-user', queryIntent: 'quick_check' });

    expect(result.status).toBe('completed');
    // allocation and risk_investment should not have run
    expect(result.results.allocation).toBeUndefined();
    expect(result.results.risk_investment).toBeUndefined();
  });

  it('retries on agent failure', async () => {
    let attempts = 0;
    const flaky: AgentRunner = {
      async run(agentId: AgentId, _context: PipelineContext): Promise<AgentOutput> {
        if (agentId === 'financial_analyst') {
          attempts++;
          if (attempts <= 1) throw new Error('Transient error');
        }
        return createMockRunner().run(agentId, _context);
      },
    };

    const orchestrator = new AgentOrchestrator(flaky, { logger: silentLogger, maxRetries: 2, retryDelayMs: 10 });
    const result = await orchestrator.execute({ userId: 'test-user' });

    expect(result.status).toBe('completed');
    expect(result.results.financial_analyst.status).toBe('success');
    expect(result.results.financial_analyst.retries).toBe(1);
  });

  it('halts on critical agent permanent failure', async () => {
    const runner = createMockRunner({
      data_integrity: new Error('Database unreachable') as any,
    });
    const orchestrator = new AgentOrchestrator(runner, { logger: silentLogger, maxRetries: 0 });

    const result = await orchestrator.execute({ userId: 'test-user' });

    expect(result.status).toBe('halted');
    expect(result.haltReason).toContain('Data Integrity');
    expect(result.recommendations).toBeNull();
  });

  it('degrades gracefully for non-critical agent failure', async () => {
    const runner = createMockRunner({
      risk_investment: new Error('Monte Carlo timeout') as any,
    });
    const orchestrator = new AgentOrchestrator(runner, { logger: silentLogger, maxRetries: 0 });

    const result = await orchestrator.execute({ userId: 'test-user' });

    // Pipeline should still complete — risk is non-critical
    expect(result.status).toBe('completed');
    expect(result.results.risk_investment.status).toBe('failed');
    expect(result.results.wealth_manager.status).toBe('success');
  });

  it('produces pipeline log entries', async () => {
    const runner = createMockRunner();
    const orchestrator = new AgentOrchestrator(runner, { logger: silentLogger });

    const result = await orchestrator.execute({ userId: 'test-user' });

    expect(result.log.length).toBeGreaterThan(0);
    expect(result.log[0].level).toBe('info');
    expect(result.log[0].message).toContain('Pipeline starting');
    expect(result.log[result.log.length - 1].message).toContain('Pipeline finished');
  });
});

describe('Agent Contracts', () => {
  it('preflight passes when all tools available and deps met', () => {
    const allTools = AGENT_REGISTRY.financial_analyst.requiredTools;
    const result = preflightCheck('financial_analyst', allTools, ['data_integrity']);
    expect(result.ready).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('preflight fails when required tool missing', () => {
    const result = preflightCheck('financial_analyst', [], ['data_integrity']);
    expect(result.ready).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('preflight fails when dependency not met', () => {
    const tools = AGENT_REGISTRY.financial_analyst.requiredTools;
    const result = preflightCheck('financial_analyst', tools, []);
    expect(result.ready).toBe(false);
    expect(result.errors[0]).toContain('data_integrity');
  });

  it('postflight passes for valid output with correct tools', () => {
    const tools = AGENT_REGISTRY.data_integrity.requiredTools;
    const result = postflightCheck('data_integrity', mockDataIntegrity, tools);
    expect(result.valid).toBe(true);
  });

  it('postflight catches unauthorized tool calls', () => {
    const tools = [...AGENT_REGISTRY.data_integrity.requiredTools, 'generate_recommendation' as any];
    const result = postflightCheck('data_integrity', mockDataIntegrity, tools);
    expect(result.valid).toBe(false);
    expect(result.boundaryViolations.length).toBeGreaterThan(0);
    expect(result.boundaryViolations[0]).toContain('unauthorized');
  });

  it('boundary check catches agent producing another agents output', () => {
    const violations = checkAgentBoundary('data_integrity', ['data_quality', 'recommendations']);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('Wealth Manager');
  });

  it('boundary check passes when output is within scope', () => {
    const violations = checkAgentBoundary('data_integrity', ['data_quality', 'issues', 'confidence']);
    expect(violations).toHaveLength(0);
  });
});
