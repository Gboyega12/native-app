# Orchestrator — Institutional Grade

## Definition

Controls:
→ Which agents run, in what order, and under what conditions

---

## CORE OBJECTIVE

Ensure:
→ Efficient, correct, and complete system execution

---

## RESPONSIBILITIES

1. Interpret user intent
2. Determine required agents
3. Sequence execution
4. Validate outputs before passing forward

---

## STANDARD FLOW

1. Data Integrity Agent
2. Financial Analyst Agent
3. Allocation Agent
4. Risk & Investment Agent
5. Wealth Manager Agent
6. Growth Agent

---

## CONDITIONAL LOGIC

- If data confidence low:
  → halt execution
- If query is simple:
  → skip unnecessary agents

---

## OUTPUT

Pass structured outputs between agents

---

## RULES

- No direct user communication
- No financial reasoning
- Only orchestration logic

---

## RUNTIME IMPLEMENTATION

The orchestrator spec is implemented by three TypeScript modules:

### `lib/agent-registry.ts` — Agent Definitions
- Maps each agent to its required tools, optional tools, skills, dependencies, and hard rules
- Defines typed output schemas and validators for each agent
- Provides `EXECUTION_ORDER` for the standard pipeline sequence
- Helpers: `getAgentTools(agentId)`, `getAgentSkills(agentId)`

### `lib/agent-orchestrator.ts` — Pipeline Runner
- `AgentOrchestrator.execute(inputs)` — runs the full agent pipeline
- Sequences agents based on `queryIntent` (full_analysis, quick_check, debt_only, allocation_only)
- Validates each agent's output against its contract before passing downstream
- Halts pipeline if data confidence drops below threshold or data quality is LOW
- Tracks tool invocations via `ToolTracker` to verify all required tools were called
- Loads skill context via `getRequiredSkillPaths(agentId)`

### `lib/agent-contracts.ts` — Boundary Enforcement
- `preflightCheck()` — verifies tools available and dependencies met before an agent runs
- `postflightCheck()` — validates output schema, required tools called, no unauthorized tools used
- `checkAgentBoundary()` — ensures no agent produces output belonging to another agent
- Hard rule enforcement: detects if an agent generates insights, recommendations, or user-facing text it's not allowed to

### Tool ↔ Agent Mapping

| Agent | Required Tools | Skills Loaded |
|-------|---------------|---------------|
| Data Integrity | `get_enriched_transactions`, `get_user_balance_sheet` | `transaction-enrichment` |
| Financial Analyst | `get_user_balance_sheet`, `get_enriched_transactions`, `get_user_constraints`, `detect_inefficiencies` | `insight-engine`, `financial-models` |
| Allocation | `calculate_liquidity_position`, `calculate_lamu_score` | `financial-models`, `debt-intelligence` |
| Risk & Investment | `run_monte_carlo_simulation` | `financial-models`, `debt-intelligence` |
| Wealth Manager | `generate_recommendation`, `rank_recommendations` | `recommendation-engine`, `bocy-philosophy`, `tone`, `user-cohorts` |
| Growth | `generate_growth_report` | `growth-product`, `tone` |

### Halt Conditions

| Condition | Action |
|-----------|--------|
| Data Integrity confidence < 0.6 | Halt entire pipeline |
| Data quality = LOW | Halt entire pipeline |
| Critical agent failure (data_integrity, financial_analyst) | Halt pipeline with error |
| Zero inefficiencies found | Continue — wealth manager reports "all clear" |
| Growth agent failure | Continue — non-critical, pipeline still returns recommendations |

---

## SYSTEM ROLE

Acts as:
→ The **control system**
