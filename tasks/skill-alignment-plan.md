# Skill Spec Alignment Plan

**Date:** 2026-03-19
**Goal:** Close gaps between the 10 skill specs and the actual implementation
**Approach:** Dependency-ordered phases — foundational layers first, then consumers

---

## Phase 1: Transaction Enrichment Foundation
**Why first:** Every downstream system (insights, recommendations, chat) depends on correctly enriched transactions. The spec says "No insight unless underlying transactions correctly enriched."

### 1A. Economic Classification (Layer 4)
**Gap:** Code classifies by merchant type ("Tesco → Groceries"). Spec requires 10 economic types.
**File:** `lib/types.ts` + `lib/enrichment-engine.ts`
**Changes:**
- Add `EconomicType` enum: `income | fixed_essential | variable_essential | discretionary | debt_repayment | asset_transfer | internal_transfer | investment | tax_related | anomalous`
- Add `economicType: EconomicType` field to `EnrichedTransaction`
- In `enrichTransaction()`, after merchant classification, map category → economic type using deterministic rules (rent/mortgage/council_tax → fixed_essential, groceries → variable_essential, etc.)
- Update `buildProfile()` to use economic types for essential/discretionary split instead of category-level heuristics

### 1B. Confidence Gating
**Gap:** Low-confidence transactions still feed insights and income calculations.
**File:** `lib/enrichment-engine.ts`
**Changes:**
- Add `confidenceScore: number` (0-1) to `EnrichedTransaction` alongside existing `confidence: string`
- Gate: transactions with `confidenceScore < 0.5` excluded from `monthlyIncome` calculation
- Gate: moves derived from low-confidence data get `suppressible: true` flag
- Log confidence distribution in `_computeEnrichmentMetrics()`

### 1C. Validation Layer (Layer 8)
**Gap:** No consistency, balance, or cross-account checks.
**File:** `lib/enrichment-engine.ts`
**Changes:**
- Add `validateEnrichment(enriched: EnrichedTransaction[]): ValidationResult` method:
  1. **Consistency check:** Flag transactions where classification differs from same-merchant historical pattern
  2. **Balance check:** Verify total inflows ≥ total outflows per month (within tolerance)
  3. **Cross-account check:** Detect matching amounts ±1 day across accounts as transfers
- Run validation after enrichment, before `buildProfile()`
- Reclassify flagged transactions or downgrade confidence

### 1D. Contextual Enrichment (Layer 6)
**Gap:** No per-transaction essential/fixed/variable tagging or financial system role.
**File:** `lib/enrichment-engine.ts`
**Changes:**
- Add to `EnrichedTransaction`: `isFixed: boolean`, `financialRole: 'obligation' | 'discretionary' | 'transfer' | 'investment' | 'income'`
- Derive `isFixed` from recurrence detection (recurring + consistent amount = fixed)
- Derive `financialRole` from economic type mapping
- Use per-transaction flags in `buildProfile()` instead of category-level aggregation

---

## Phase 2: Insight Engine (6 Insight Types)
**Why second:** Insights are the core product. Without them, Bocy is a dashboard.
**Depends on:** Phase 1 (economic classification + confidence gating)

### 2A. System Mapping
**Gap:** No unified balance sheet constructed before insight detection.
**File:** `lib/enrichment-engine.ts` (new method) or new `lib/system-map.ts`
**Changes:**
- Add `buildSystemMap(profile, accounts, debtAccounts): SystemMap` function
- `SystemMap` type: `{ assets: { cash, savings, isa, pension, investments }, liabilities: { mortgage, loans, creditCards, bnpl }, constraints: { liquidityNeed, taxWrapperCapacity, incomeStability } }`
- Feed into insight detection as the single source of truth

### 2B. Six Insight Types
**Gap:** 0 of 6 implemented. Current reactive-engine only tracks goal milestones.
**File:** New `lib/insight-engine.ts` (separate from reactive-engine which handles event tracking)
**Changes:**
- Create `InsightType` enum: `idle_capital_drag | tax_leakage | debt_return_mismatch | liquidity_inefficiency | cross_system_distortion | time_based_loss`
- Create `Insight` interface: `{ type, statement, annualImpact, longTermImpact, cause, implication, linkedMoveCategory, confidence, priority }`
- Implement 6 detection functions:
  1. **Idle Capital Drag:** `cash > 3 months buffer` AND `cash yield < baseline return` → quantify `(cash - buffer) × (baseline - yield)`
  2. **Tax Leakage:** `ISA allowance unused` OR `pension match unused` OR `higher-rate no salary sacrifice` → quantify annual tax saving
  3. **Debt-Return Mismatch:** `debt APR > expected investment return` (or vice versa) → quantify spread × balance
  4. **Liquidity Inefficiency:** `buffer < 3 months` OR `buffer > 12 months` → quantify opportunity cost of excess/risk of deficit
  5. **Cross-System Distortion:** `saving while carrying high-interest debt` OR `investing while buffer inadequate` → quantify net loss
  6. **Time-Based Loss:** `known move not acted on for 30+ days` → quantify compounding cost of delay
- Add `detectInsights(systemMap, profile, moves, debtAccounts): Insight[]`
- Add materiality filter: suppress insights with `annualImpact < £50`

### 2C. Insight Quality Enforcement
**Gap:** Outputs deliver "acceptable" quality, not "BOCY-level."
**File:** `lib/insight-engine.ts`
**Changes:**
- Every `Insight` MUST have all 4 fields populated: statement, annualImpact, cause, implication
- Add `formatInsight(insight): string` that outputs BOCY-level format:
  `"£X earning Y% is reducing your net outcome by ~£Z/year vs optimal allocation"`
- Reject insights missing any of the 4 required elements

### 2D. Wire Insights to Homepage
**File:** `app/(main)/(tabs)/index.tsx` + `lib/enrichment-engine.ts`
**Changes:**
- Call `detectInsights()` after move generation in the analysis pipeline
- Add `insights: Insight[]` to `Analysis` type
- Render insight cards above move cards on homepage (insight-first)
- Each card shows: statement + £ impact + linked action

---

## Phase 3: Recommendation Engine Upgrades
**Why third:** Recommendations consume insights and need the enriched data.
**Depends on:** Phase 2 (insights feed recommendations)

### 3A. Feasibility Gate
**Gap:** All moves ranked, none rejected for constraint violations.
**File:** `lib/move-engine.ts`
**Changes:**
- Add `checkFeasibility(move, profile, bufferRec): { feasible: boolean, reason?: string }`
  1. Liquidity check: reject if executing move would drop buffer below minimum
  2. Hierarchy check: reject Tier 3/4 moves if Tier 1 opportunities exist
  3. Risk check: reject if move exceeds risk appetite threshold
- Filter infeasible moves before ranking (mark as `suppressed` with reason, don't discard)

### 3B. Source/Destination/Amount Fields
**Gap:** `Move` type lacks explicit account-level action details.
**File:** `lib/types.ts` + `lib/enrichment-engine.ts`
**Changes:**
- Add to `Move`: `source?: string` (account/bucket), `destination?: string`, `amount?: number` (exact £), `recommendationType: 'reallocation' | 'reduction' | 'optimization' | 'timing'`
- Populate in `generateAllMoves()` and `generateCapitalMoves()` where account data is available
- Use in `buildProofString()` for BOCY-level output: "Move £X from [source] to [destination]"

### 3C. Scenario Comparison
**Gap:** No Option A vs Option B analysis.
**File:** `lib/move-engine.ts` + `lib/monte-carlo.ts`
**Changes:**
- Add `compareScenarios(moveA: Move | null, moveB: Move, profile, vol): ScenarioComparison`
- `ScenarioComparison`: `{ current: { median, p10, p90 }, recommended: { median, p10, p90 }, netDifference, probability }`
- Use existing `simulateGoalTimeline()` for both scenarios
- Attach `scenario?: ScenarioComparison` to `RankedMove`
- Surface on move cards: "Current: £X → Recommended: £Y (Z% probability)"

### 3D. Partial Allocation
**Gap:** Binary "do this move" instead of split recommendations.
**File:** `lib/move-engine.ts`
**Changes:**
- When surplus > 0 and multiple high-priority moves exist, compute optimal split using CRRA marginal utility equalization
- Add `allocationSplit?: { moveId: string, amount: number }[]` to ranked output
- Example: "£500 surplus → £300 debt (APR 22%) + £150 ISA + £50 buffer top-up"

---

## Phase 4: Debt Intelligence
**Why here:** Builds on recommendation engine + Monte Carlo.
**Depends on:** Phase 3 (feasibility gate, scenario comparison)

### 4A. Formal Tier Classification
**Gap:** APR-sorted but no tier system.
**File:** `lib/enrichment-engine.ts` or new `lib/debt-engine.ts`
**Changes:**
- Add `DebtTier` enum: `tier1_high` (>6-8%), `tier2_medium` (4-6%), `tier3_low` (<4%)
- Classify each debt account on ingestion
- Tier 3 debts get different treatment: "often optimal to maintain" language
- Wire into move generation: Tier 1 moves always prioritized

### 4B. Debt vs Investment Monte Carlo
**Gap:** No probability comparison for debt repayment vs investing.
**File:** `lib/monte-carlo.ts`
**Changes:**
- Add `simulateDebtVsInvest(debtAPR, investAmount, vol): DebtInvestComparison`
- Output: `{ probabilityInvestWins, medianGain, downsideScenario, breakEvenYears }`
- Attach to debt-related moves as proof data
- Surface: "70% probability investing beats paying off 3.5% mortgage"

### 4C. Liquidity Override Gate
**Gap:** Debt moves not suppressed when buffer is dangerously low.
**File:** `lib/move-engine.ts`
**Changes:**
- In feasibility check: if `buffer < 3 months`, suppress all debt moves except Tier 1
- Add explicit warning: "Buffer below safety threshold — prioritizing liquidity"

---

## Phase 5: Chat Engine Architecture
**Why fifth:** Chat consumes all previous layers. Biggest spec gap but lowest urgency for MVP.
**Depends on:** Phases 1-4 (needs insights, recommendations, enrichment)

### 5A. Context Enforcement
**Gap:** Context is optional. Spec says "NEVER respond without full system context."
**File:** `api/chat/index.ts`
**Changes:**
- Make `context` required in zod schema (or return error if missing)
- Validate context contains: `monthly`, `budgetReality`, `debtAccounts`, `accountBalances`
- If incomplete, return structured error asking client to retry after sync

### 5B. Response Structure Validation
**Gap:** No check that responses include £ impact, action, trade-offs.
**File:** `api/chat/index.ts`
**Changes:**
- After Claude response, run lightweight validation:
  - Contains a number with £ sign (quantification check)
  - Contains an action verb (recommendation check)
- If validation fails on financial questions, append system nudge and retry once

### 5C. Conversation Mode Detection
**Gap:** All inputs treated identically.
**File:** `api/chat/index.ts`
**Changes:**
- Add intent classifier in system prompt or pre-processing:
  - **Query:** "How much...", "What is..." → factual, tool-derived answer
  - **Diagnostic:** "Why am I...", "What's wrong..." → causality analysis
  - **Decision:** "Should I...", "Which is better..." → scenario comparison
  - **Execution:** "Do it", "Set up..." → action execution
- Route to different tool subsets based on mode

### 5D. Proactive Insight Injection
**Gap:** Chat is purely reactive.
**File:** `api/chat/index.ts`
**Changes:**
- When context contains active insights (from Phase 2), inject relevant ones into system prompt
- Example: User asks "Can I afford a holiday?" → system also surfaces "You have £18k idle cash costing £1,200/yr"
- Add `active_insights` to context object, populated by client from analysis

---

## Phase 6: Tone & Quality Polish
**Why last:** Polish layer, not structural.
**Depends on:** All phases (tone applies everywhere)

### 6A. Hedging Language Audit
**Files:** `lib/enrichment-engine.ts`, `lib/account-classifier.ts`
**Changes:**
- Find and replace: "Consider..." → decisive language
- "could improve" → "improves"
- "you're ready for" → quantified statement
- All move descriptions must follow: Observation → £ Impact → Cause → Action

### 6B. Delay Cost Quantification
**File:** `lib/insight-engine.ts` (Phase 2) + `lib/reactive-engine.ts`
**Changes:**
- For each unacted move older than 30 days, compute: `delayDays × dailyCompoundingCost`
- Surface as Time-Based Loss insight: "Delaying ISA transfer by 45 days has cost £X"

### 6C. Cohort-Specific Language
**File:** `lib/account-classifier.ts` + insight/move formatting
**Changes:**
- UHE framing: "Clear, immediate financial loss" + urgency
- SHE framing: "Non-obvious trade-off revealed" + system-level optimization
- Pass cohort to move/insight formatters for tone adjustment

---

## Priority & Effort Matrix

| Phase | Impact | Effort | Dependency |
|-------|--------|--------|------------|
| **1: Enrichment** | Critical | Medium | None — foundation |
| **2: Insights** | Critical | High | Phase 1 |
| **3: Recommendations** | High | Medium | Phase 2 |
| **4: Debt Intelligence** | High | Medium | Phase 3 |
| **5: Chat Architecture** | Medium | High | Phases 1-4 |
| **6: Tone & Polish** | Medium | Low | All phases |

---

## Implementation Order (Suggested Sprints)

**Sprint A (Foundation):** Phase 1A + 1B + 1D → Economic types, confidence gating, per-txn flags
**Sprint B (Insights):** Phase 2A + 2B + 2C + 2D → System map, 6 insight types, wire to homepage
**Sprint C (Recommendations):** Phase 3A + 3B + 1C → Feasibility gate, source/dest fields, validation layer
**Sprint D (Debt + MC):** Phase 4A + 4B + 3C + 3D → Debt tiers, debt-vs-invest MC, scenarios, partial allocation
**Sprint E (Chat):** Phase 5A + 5B + 5C + 5D → Context enforcement, response validation, modes, proactive
**Sprint F (Polish):** Phase 6A + 6B + 6C + 4C → Tone fixes, delay costs, cohort language, liquidity gate

---

## Files Changed Per Phase

| Phase | Files Modified | New Files |
|-------|---------------|-----------|
| 1 | `lib/types.ts`, `lib/enrichment-engine.ts` | — |
| 2 | `lib/enrichment-engine.ts`, `app/(main)/(tabs)/index.tsx` | `lib/insight-engine.ts` |
| 3 | `lib/move-engine.ts`, `lib/types.ts`, `lib/monte-carlo.ts`, `lib/enrichment-engine.ts` | — |
| 4 | `lib/monte-carlo.ts`, `lib/move-engine.ts`, `lib/enrichment-engine.ts` | `lib/debt-engine.ts` (optional) |
| 5 | `api/chat/index.ts` | — |
| 6 | `lib/enrichment-engine.ts`, `lib/account-classifier.ts`, `lib/reactive-engine.ts` | — |
