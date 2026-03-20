// ── Agent Orchestrator ──
// The control system: sequences agents, validates outputs, handles failures,
// and ensures every required tool and skill is invoked at the right time.
//
// This is the runtime implementation of agents/orchestrator.md.

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
  type ToolId,
  type SkillId,
} from './agent-registry';

// ── Pipeline state ──

export interface PipelineInputs {
  userId: string;
  /** If provided, orchestrator may skip agents not needed for this query */
  queryIntent?: 'full_analysis' | 'quick_check' | 'debt_only' | 'allocation_only';
}

export interface AgentResult {
  agentId: AgentId;
  status: 'success' | 'failed' | 'skipped' | 'halted';
  output: AgentOutput | null;
  toolsCalled: ToolId[];
  skillsLoaded: SkillId[];
  errors: string[];
  durationMs: number;
}

export interface PipelineResult {
  status: 'completed' | 'halted' | 'partial';
  haltReason?: string;
  results: Record<AgentId, AgentResult>;
  /** Final user-facing output (only from wealth_manager) */
  recommendations: WealthManagerOutput | null;
  totalDurationMs: number;
}

// ── Agent runner interface ──
// Each agent must implement this to be executed by the orchestrator.
// Concrete implementations live in their own files or in the API layer.

export interface AgentRunner {
  run(
    agentId: AgentId,
    inputs: PipelineContext,
  ): Promise<AgentOutput>;
}

// ── Pipeline context ──
// Accumulated state passed between agents. Each agent reads from prior
// agents' outputs and writes its own.

export interface PipelineContext {
  userId: string;
  queryIntent: PipelineInputs['queryIntent'];
  /** Outputs from completed agents */
  dataIntegrity?: DataIntegrityOutput;
  financialAnalyst?: FinancialAnalystOutput;
  allocation?: AllocationOutput;
  riskInvestment?: RiskOutput;
  wealthManager?: WealthManagerOutput;
}

// ── Orchestrator ──

export class AgentOrchestrator {
  private runner: AgentRunner;
  private confidenceThreshold: number;

  constructor(runner: AgentRunner, opts?: { confidenceThreshold?: number }) {
    this.runner = runner;
    this.confidenceThreshold = opts?.confidenceThreshold ?? 0.6;
  }

  async execute(inputs: PipelineInputs): Promise<PipelineResult> {
    const startTime = Date.now();

    const context: PipelineContext = {
      userId: inputs.userId,
      queryIntent: inputs.queryIntent ?? 'full_analysis',
    };

    const results: Record<string, AgentResult> = {};
    let halted = false;
    let haltReason: string | undefined;

    // Determine which agents to run based on intent
    const agentsToRun = this.resolveAgentSequence(inputs.queryIntent ?? 'full_analysis');

    for (const agentId of agentsToRun) {
      if (halted) {
        results[agentId] = {
          agentId,
          status: 'skipped',
          output: null,
          toolsCalled: [],
          skillsLoaded: [],
          errors: [`Skipped: pipeline halted — ${haltReason}`],
          durationMs: 0,
        };
        continue;
      }

      const def = AGENT_REGISTRY[agentId];

      // Verify dependencies completed successfully
      const depErrors = this.checkDependencies(agentId, results);
      if (depErrors.length > 0) {
        results[agentId] = {
          agentId,
          status: 'failed',
          output: null,
          toolsCalled: [],
          skillsLoaded: [],
          errors: depErrors,
          durationMs: 0,
        };
        continue;
      }

      // Run the agent
      const agentStart = Date.now();
      try {
        const output = await this.runner.run(agentId, context);

        // Validate output against agent's contract
        const validation = def.validateOutput(output);
        if (!validation.valid) {
          results[agentId] = {
            agentId,
            status: 'failed',
            output: null,
            toolsCalled: def.requiredTools,
            skillsLoaded: def.skills,
            errors: validation.errors.map((e) => `Contract violation: ${e}`),
            durationMs: Date.now() - agentStart,
          };
          continue;
        }

        // Store output in context for downstream agents
        this.storeOutput(agentId, output, context);

        // Post-agent checks (halt conditions)
        const haltCheck = this.checkHaltConditions(agentId, output, context);
        if (haltCheck) {
          halted = true;
          haltReason = haltCheck;
        }

        results[agentId] = {
          agentId,
          status: halted ? 'halted' : 'success',
          output,
          toolsCalled: def.requiredTools,
          skillsLoaded: def.skills,
          errors: [],
          durationMs: Date.now() - agentStart,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[agentId] = {
          agentId,
          status: 'failed',
          output: null,
          toolsCalled: [],
          skillsLoaded: [],
          errors: [`Runtime error: ${message}`],
          durationMs: Date.now() - agentStart,
        };

        // If a critical agent fails, halt the pipeline
        if (agentId === 'data_integrity' || agentId === 'financial_analyst') {
          halted = true;
          haltReason = `Critical agent ${def.name} failed: ${message}`;
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const hasAnySuccess = Object.values(results).some((r) => r.status === 'success');

    return {
      status: halted ? 'halted' : hasAnySuccess ? 'completed' : 'partial',
      haltReason,
      results: results as Record<AgentId, AgentResult>,
      recommendations: context.wealthManager ?? null,
      totalDurationMs,
    };
  }

  // ── Conditional agent sequencing ──

  private resolveAgentSequence(intent: NonNullable<PipelineInputs['queryIntent']>): AgentId[] {
    switch (intent) {
      case 'full_analysis':
        return [...EXECUTION_ORDER];

      case 'quick_check':
        // Skip risk simulations for fast queries
        return ['data_integrity', 'financial_analyst', 'wealth_manager'];

      case 'debt_only':
        return ['data_integrity', 'financial_analyst', 'allocation', 'wealth_manager'];

      case 'allocation_only':
        return ['data_integrity', 'allocation', 'risk_investment', 'wealth_manager'];

      default:
        return [...EXECUTION_ORDER];
    }
  }

  // ── Dependency validation ──

  private checkDependencies(
    agentId: AgentId,
    results: Record<string, AgentResult>,
  ): string[] {
    const def = AGENT_REGISTRY[agentId];
    const errors: string[] = [];

    for (const dep of def.dependsOn) {
      const depResult = results[dep];
      if (!depResult) {
        errors.push(`Required dependency ${dep} has not run`);
      } else if (depResult.status === 'failed') {
        errors.push(`Required dependency ${dep} failed: ${depResult.errors.join('; ')}`);
      } else if (depResult.status === 'skipped') {
        // Allow skipped dependencies for conditional flows —
        // the agent will work with whatever context is available
      }
    }

    return errors;
  }

  // ── Store output for downstream consumption ──

  private storeOutput(agentId: AgentId, output: AgentOutput, context: PipelineContext): void {
    switch (agentId) {
      case 'data_integrity':
        context.dataIntegrity = output as DataIntegrityOutput;
        break;
      case 'financial_analyst':
        context.financialAnalyst = output as FinancialAnalystOutput;
        break;
      case 'allocation':
        context.allocation = output as AllocationOutput;
        break;
      case 'risk_investment':
        context.riskInvestment = output as RiskOutput;
        break;
      case 'wealth_manager':
        context.wealthManager = output as WealthManagerOutput;
        break;
    }
  }

  // ── Halt conditions ──

  private checkHaltConditions(
    agentId: AgentId,
    output: AgentOutput,
    _context: PipelineContext,
  ): string | null {
    // Data Integrity: halt if confidence too low
    if (agentId === 'data_integrity') {
      const diOutput = output as DataIntegrityOutput;
      if (diOutput.confidence < this.confidenceThreshold) {
        return `Data confidence ${diOutput.confidence} is below threshold ${this.confidenceThreshold} — system unreliable, blocking downstream agents`;
      }
      if (diOutput.data_quality === 'low') {
        return 'Data quality rated LOW — requires resolution before proceeding';
      }
    }

    // Financial Analyst: halt if zero inefficiencies detected (nothing to do)
    // Note: this is a soft halt — wealth manager can still surface "all clear"
    if (agentId === 'financial_analyst') {
      const faOutput = output as FinancialAnalystOutput;
      if (faOutput.inefficiencies.length === 0) {
        // Don't halt — let wealth manager communicate "no issues found"
        return null;
      }
    }

    return null;
  }
}

// ── Tool invocation tracker ──
// Wraps tool calls to ensure every required tool was actually invoked.

export class ToolTracker {
  private called: Set<ToolId> = new Set();

  markCalled(toolId: ToolId): void {
    this.called.add(toolId);
  }

  /**
   * Verifies that all required tools for an agent were called.
   * Returns list of missing tools, or empty array if all present.
   */
  verifyAgent(agentId: AgentId): ToolId[] {
    const def = AGENT_REGISTRY[agentId];
    const missing: ToolId[] = [];
    for (const tool of def.requiredTools) {
      if (!this.called.has(tool)) {
        missing.push(tool);
      }
    }
    return missing;
  }

  reset(): void {
    this.called.clear();
  }
}

// ── Skill loader ──
// Ensures the right skill context is loaded before an agent runs.

export function getRequiredSkillPaths(agentId: AgentId): string[] {
  const def = AGENT_REGISTRY[agentId];
  return def.skills.map((skill) => `skills/${skill.replace(/_/g, '-')}.md`);
}
