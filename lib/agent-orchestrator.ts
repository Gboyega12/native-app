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
  type GrowthAgentOutput,
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
  /** Number of retry attempts before success/failure */
  retries: number;
}

export interface PipelineResult {
  status: 'completed' | 'halted' | 'partial';
  haltReason?: string;
  results: Record<AgentId, AgentResult>;
  /** Final user-facing output (only from wealth_manager) */
  recommendations: WealthManagerOutput | null;
  /** Growth report output (only from growth agent, full_analysis only) */
  growthReport: GrowthAgentOutput | null;
  totalDurationMs: number;
  /** Pipeline execution log for observability */
  log: PipelineLogEntry[];
}

// ── Logging ──

export type LogLevel = 'info' | 'warn' | 'error';

export interface PipelineLogEntry {
  timestamp: string;
  level: LogLevel;
  agentId?: AgentId;
  message: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface PipelineLogger {
  log(entry: PipelineLogEntry): void;
}

/** Default logger that writes to console with structured format */
class ConsoleLogger implements PipelineLogger {
  log(entry: PipelineLogEntry): void {
    const prefix = `[agent-pipeline]${entry.agentId ? ` [${entry.agentId}]` : ''}`;
    const duration = entry.durationMs != null ? ` (${entry.durationMs}ms)` : '';
    const msg = `${prefix} ${entry.message}${duration}`;

    switch (entry.level) {
      case 'error': console.error(msg, entry.metadata || ''); break;
      case 'warn': console.warn(msg, entry.metadata || ''); break;
      default: console.log(msg); break;
    }
  }
}

// ── Agent runner interface ──

export interface AgentRunner {
  run(
    agentId: AgentId,
    inputs: PipelineContext,
  ): Promise<AgentOutput>;
}

// ── Pipeline context ──

export interface PipelineContext {
  userId: string;
  queryIntent: PipelineInputs['queryIntent'];
  /** Outputs from completed agents */
  dataIntegrity?: DataIntegrityOutput;
  financialAnalyst?: FinancialAnalystOutput;
  allocation?: AllocationOutput;
  riskInvestment?: RiskOutput;
  wealthManager?: WealthManagerOutput;
  growth?: GrowthAgentOutput;
}

// ── Orchestrator options ──

export interface OrchestratorOptions {
  confidenceThreshold?: number;
  /** Max retry attempts per agent (default: 2) */
  maxRetries?: number;
  /** Base retry delay in ms (doubled each attempt, default: 500) */
  retryDelayMs?: number;
  /** Custom logger (default: console) */
  logger?: PipelineLogger;
}

// ── Orchestrator ──

export class AgentOrchestrator {
  private runner: AgentRunner;
  private confidenceThreshold: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private logger: PipelineLogger;

  constructor(runner: AgentRunner, opts?: OrchestratorOptions) {
    this.runner = runner;
    this.confidenceThreshold = opts?.confidenceThreshold ?? 0.6;
    this.maxRetries = opts?.maxRetries ?? 2;
    this.retryDelayMs = opts?.retryDelayMs ?? 500;
    this.logger = opts?.logger ?? new ConsoleLogger();
  }

  async execute(inputs: PipelineInputs): Promise<PipelineResult> {
    const startTime = Date.now();
    const log: PipelineLogEntry[] = [];

    const emit = (level: LogLevel, message: string, agentId?: AgentId, metadata?: Record<string, unknown>) => {
      const entry: PipelineLogEntry = {
        timestamp: new Date().toISOString(),
        level,
        agentId,
        message,
        metadata,
      };
      log.push(entry);
      this.logger.log(entry);
    };

    emit('info', `Pipeline starting — intent: ${inputs.queryIntent ?? 'full_analysis'}, user: ${inputs.userId.slice(0, 8)}...`);

    const context: PipelineContext = {
      userId: inputs.userId,
      queryIntent: inputs.queryIntent ?? 'full_analysis',
    };

    const results: Record<string, AgentResult> = {};
    let halted = false;
    let haltReason: string | undefined;

    const agentsToRun = this.resolveAgentSequence(inputs.queryIntent ?? 'full_analysis');
    emit('info', `Agent sequence: ${agentsToRun.join(' → ')}`);

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
          retries: 0,
        };
        emit('warn', `Skipped — pipeline halted`, agentId);
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
          retries: 0,
        };
        emit('error', `Dependency check failed: ${depErrors.join('; ')}`, agentId);

        // Non-critical agents: continue with graceful degradation
        if (!this.isCriticalAgent(agentId)) {
          emit('warn', `Non-critical agent skipped — continuing pipeline`, agentId);
          continue;
        }
        // Critical agents: halt
        halted = true;
        haltReason = `Critical agent ${def.name} dependency failed`;
        continue;
      }

      // Run the agent with retry logic
      emit('info', `Starting — tools: [${def.requiredTools.join(', ')}]`, agentId);
      const agentStart = Date.now();
      let lastError: string = '';
      let retryCount = 0;
      let succeeded = false;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          emit('warn', `Retry ${attempt}/${this.maxRetries} after ${delay}ms`, agentId);
          await this.sleep(delay);
          retryCount++;
        }

        try {
          const output = await this.runner.run(agentId, context);

          // Validate output against agent's contract
          const validation = def.validateOutput(output);
          if (!validation.valid) {
            lastError = validation.errors.map((e) => `Contract violation: ${e}`).join('; ');
            emit('warn', `Contract validation failed: ${lastError}`, agentId);
            continue; // retry
          }

          // Store output in context for downstream agents
          this.storeOutput(agentId, output, context);

          // Post-agent checks (halt conditions)
          const haltCheck = this.checkHaltConditions(agentId, output, context);
          if (haltCheck) {
            halted = true;
            haltReason = haltCheck;
            emit('warn', `Halt condition triggered: ${haltCheck}`, agentId);
          }

          const duration = Date.now() - agentStart;
          results[agentId] = {
            agentId,
            status: halted ? 'halted' : 'success',
            output,
            toolsCalled: def.requiredTools,
            skillsLoaded: def.skills,
            errors: [],
            durationMs: duration,
            retries: retryCount,
          };

          emit('info', `Completed successfully`, agentId, {
            durationMs: duration,
            retries: retryCount,
          });
          succeeded = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          emit('error', `Attempt ${attempt + 1} failed: ${lastError}`, agentId);
        }
      }

      // All attempts exhausted
      if (!succeeded) {
        const duration = Date.now() - agentStart;
        results[agentId] = {
          agentId,
          status: 'failed',
          output: null,
          toolsCalled: [],
          skillsLoaded: [],
          errors: [`Failed after ${retryCount + 1} attempts: ${lastError}`],
          durationMs: duration,
          retries: retryCount,
        };

        emit('error', `Failed permanently after ${retryCount + 1} attempts`, agentId);

        if (this.isCriticalAgent(agentId)) {
          halted = true;
          haltReason = `Critical agent ${def.name} failed: ${lastError}`;
          emit('error', `Critical failure — halting pipeline`, agentId);
        } else {
          // Graceful degradation: skip non-critical agents and continue
          emit('warn', `Non-critical agent failed — continuing with degraded output`, agentId);
        }
      }
    }

    const totalDurationMs = Date.now() - startTime;
    const hasAnySuccess = Object.values(results).some((r) => r.status === 'success');
    const status = halted ? 'halted' : hasAnySuccess ? 'completed' : 'partial';

    emit('info', `Pipeline finished — status: ${status}, duration: ${totalDurationMs}ms`, undefined, {
      agentResults: Object.fromEntries(
        Object.entries(results).map(([id, r]) => [id, { status: r.status, durationMs: r.durationMs, retries: r.retries }]),
      ),
    });

    return {
      status,
      haltReason,
      results: results as Record<AgentId, AgentResult>,
      recommendations: context.wealthManager ?? null,
      growthReport: context.growth ?? null,
      totalDurationMs,
      log,
    };
  }

  // ── Critical vs non-critical agents ──

  private isCriticalAgent(agentId: AgentId): boolean {
    // Data integrity and financial analyst are required — without them, nothing downstream works.
    // Risk, allocation can be skipped for degraded-but-functional output.
    return agentId === 'data_integrity' || agentId === 'financial_analyst';
  }

  // ── Conditional agent sequencing ──

  private resolveAgentSequence(intent: NonNullable<PipelineInputs['queryIntent']>): AgentId[] {
    switch (intent) {
      case 'full_analysis':
        // Full pipeline includes growth agent as final step
        return [...EXECUTION_ORDER];

      case 'quick_check':
        // Skip risk simulations and growth for fast queries
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
        // Allow missing deps in conditional flows (agent was intentionally skipped)
        continue;
      } else if (depResult.status === 'failed') {
        // Only block if the failed dependency is critical
        // Non-critical deps (risk, allocation) can fail without blocking downstream
        if (this.isCriticalAgent(dep)) {
          errors.push(`Critical dependency ${dep} failed: ${depResult.errors.join('; ')}`);
        }
        // Non-critical failed deps: allow agent to proceed with degraded context
      }
      // 'skipped' and 'halted' are OK — agent works with available context
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
      case 'growth':
        context.growth = output as GrowthAgentOutput;
        break;
    }
  }

  // ── Halt conditions ──

  private checkHaltConditions(
    agentId: AgentId,
    output: AgentOutput,
    _context: PipelineContext,
  ): string | null {
    if (agentId === 'data_integrity') {
      const diOutput = output as DataIntegrityOutput;
      if (diOutput.confidence < this.confidenceThreshold) {
        return `Data confidence ${diOutput.confidence} is below threshold ${this.confidenceThreshold} — system unreliable, blocking downstream agents`;
      }
      if (diOutput.data_quality === 'low') {
        return 'Data quality rated LOW — requires resolution before proceeding';
      }
    }

    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── Tool invocation tracker ──

export class ToolTracker {
  private called: Set<ToolId> = new Set();

  markCalled(toolId: ToolId): void {
    this.called.add(toolId);
  }

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

export function getRequiredSkillPaths(agentId: AgentId): string[] {
  const def = AGENT_REGISTRY[agentId];
  return def.skills.map((skill) => `skills/${skill.replace(/_/g, '-')}.md`);
}
