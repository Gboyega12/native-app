# Implementation Plan: Enrichment Intelligence & UX Fixes

**Date:** 2026-03-17
**Status:** Planning

---

## Overview

Six workstreams covering debt UX fixes, transaction embedding, self-transfer detection,
global learning, and the income recategorization bug.

---

## 1. Debt Move £0 Impact Fix

**Problem:** When user has zero or negative surplus (common for people in debt),
`claimSurplus()` returns 0, so `calcInterestSaved(bal, apr, payment, payment + 0)` = 0.
The multi-debt path has no fallback. Single-debt path has `|| debtPayments * 10%` fallback.

**Root cause:** `p.surplus <= 0` → `remainingSurplus = 0` → debt move shows £0/month, £0/year.

**Fix (3 parts):**

### 1a. Add fallback to multi-debt path (parity with single-debt)
- [ ] `lib/enrichment-engine.ts` ~line 1369: Add `|| Math.round(p.debtPayments * T.singleDebtOverpayPct)` fallback
- [ ] This ensures the card always shows a meaningful number even when surplus is 0

### 1b. Calculate debt impact from interest cost, not just overpayment savings
- [ ] When surplus = 0, the impact should show "current interest being paid" not "savings from overpaying"
- [ ] For each debt: `balance * APR / 12` = monthly interest cost
- [ ] Show this as the impact: "£X/month in interest across N debts"
- [ ] This reframes the move from "overpay to save" → "here's what debt is costing you"

### 1c. Debt-first surplus allocation when APR > 15%
- [ ] Before generating any moves, check if `hasExpensiveDebt`
- [ ] If yes, pre-reserve 70% of surplus for debt (min £0, max £500)
- [ ] Store reserved amount, debt `claimSurplus` draws from reservation first
- [ ] Other moves compete for remaining 30%
- [ ] This ensures debt always gets priority over "eat out less"

**Files:** `lib/enrichment-engine.ts` (genDecisionStack ~lines 1149-1170, 1357-1370)

---

## 2. Income Recategorization Bug (Bug B)

**Problem:** When recategorizing a transaction from income, the income total visually
changes then the transaction disappears. The issue is the optimistic UI update sequence.

**Investigation needed:**
- [ ] Trace exact flow: which state update fires first? `setAnalysis` triggers income total
  recalc AND removes tx from source category simultaneously via `LayoutAnimation`
- [ ] Check if `income_sources` is recalculated when analysis changes — if not, stale
  income sources show the old total before the layout animation removes the row
- [ ] Check if `incomeSources` memo depends on `analysis` or is cached separately

**Likely fix:**
- [ ] Ensure income total and income sources are updated atomically in same render
- [ ] If income_sources is a separate memo, ensure it recomputes when analysis.income_sources changes
- [ ] Add the recategorized transaction to the correct destination BEFORE removing from income
  (swap render order so user sees "moved to X" not "disappeared from income")

**Files:** `app/(main)/(tabs)/index.tsx` (saveRecategorize ~line 958, income card ~line 3320)

---

## 3. Transaction Embedding in Income Card

**Problem:** Income card shows source summaries (name, frequency, avg amount) but NOT
the individual transactions behind each source. Users want to tap "Salary" and see
every salary deposit with date and amount.

**Current state:**
- `IncomeSource` interface has: source, frequency, avgAmount, monthly, isSalary, recentAmounts
- NO `transactions[]` field
- Raw transactions ARE accessible during enrichment (line 643-674 in enrichment-engine.ts)
  but get aggregated and discarded

**Fix:**

### 3a. Extend IncomeSource type
- [ ] `lib/types.ts`: Add `transactions?: TransactionDetail[]` to `IncomeSource` interface

### 3b. Capture transactions during enrichment
- [ ] `lib/enrichment-engine.ts` ~line 674: In the income source mapping, attach the raw
  transactions as `TransactionDetail[]` to each source
- [ ] Map from `EnrichedTransaction` → `TransactionDetail` (date, merchant, description, amount)

### 3c. Render expandable transactions in Income card
- [ ] `app/(main)/(tabs)/index.tsx` ~line 3381: Make each income source row tappable
- [ ] On tap, expand to show individual transactions (same pattern as Essentials/Lifestyle)
- [ ] Show: date, description, amount per transaction
- [ ] Use existing `toggleCategory` pattern or add `expandedIncomeSource` state

**Files:** `lib/types.ts`, `lib/enrichment-engine.ts`, `app/(main)/(tabs)/index.tsx`

---

## 4. Self-Transfer Detection (Name Matching)

**Problem:** Transfers between a user's own bank accounts (Revolut → HSBC) appear as
person transfers because the description contains their name ("JOHN SMITH").

**Data source for user name:** `supabase.auth.user.user_metadata?.full_name`
(already used in `AppDataProvider.tsx` line 44-46, stored as `userName`)

**Fix:**

### 4a. Pass user's full name through enrichment pipeline
- [ ] `api/enrich.ts`: Fetch user's full name from Supabase auth metadata
- [ ] Pass it to `EnrichmentEngine.buildProfile()` or `enrichTransaction()` as parameter
- [ ] Also pass it to `isPersonTransfer()` as exclusion

### 4b. Name matching in enrichment
- [ ] `lib/merchant-db.ts` (isPersonTransfer): Add optional `selfName` parameter
- [ ] Normalize both the transaction description name and the user's name
- [ ] If normalized names match → return `false` (NOT a person transfer)
- [ ] Handle variations: "J SMITH", "JOHN SMITH", "MR J SMITH", "SMITH J"
  - Split into tokens, compare last name (required match) + first name/initial (fuzzy)

### 4c. Classify as "Internal Transfer"
- [ ] `lib/enrichment-engine.ts` (enrichTransaction): When self-transfer detected:
  - `category: 'Internal Transfer'`
  - `isTransfer: true`
  - Excluded from: income, spending, person_transfers, review modal, budget math
- [ ] Show in collapsed "Internal Transfers" section in UI (visible but excluded from budget)

### 4d. UI: Internal Transfers section
- [ ] `app/(main)/(tabs)/index.tsx`: Add collapsed "INTERNAL TRANSFERS" section
  below Savings card (or within it)
- [ ] Show total and expandable transaction list
- [ ] Greyed out / muted styling to signal "excluded from budget"

**Files:** `api/enrich.ts`, `lib/merchant-db.ts`, `lib/enrichment-engine.ts`,
`lib/types.ts`, `app/(main)/(tabs)/index.tsx`

---

## 5. Global Learning State (Cross-User Enrichment)

**Problem:** Each user independently categorises the same merchants. User A's correction
for "WING YIP B'HAM" → Groceries doesn't help User B.

**Fix:**

### 5a. Create Supabase table
- [ ] `global_merchant_categories` table:
  ```
  id              UUID DEFAULT gen_random_uuid()
  normalized_key  TEXT NOT NULL (indexed)
  category        TEXT NOT NULL
  is_essential    BOOLEAN DEFAULT false
  vote_count      INTEGER DEFAULT 1
  last_voted_at   TIMESTAMPTZ DEFAULT now()
  created_at      TIMESTAMPTZ DEFAULT now()
  UNIQUE(normalized_key, category)
  ```
- [ ] RLS policy: any authenticated user can read; insert/update via server function only

### 5b. Upsert on user override
- [ ] `api/enrich.ts` or new `api/global-overrides.ts`: When user saves an override,
  upsert into `global_merchant_categories` with +1 vote
- [ ] Normalize merchant name using `normaliseDescription()` for consistent keys
- [ ] On conflict (same merchant + category): increment vote_count, update last_voted_at
- [ ] On conflict (same merchant, different category): insert new row (competing votes)

### 5c. Query during enrichment
- [ ] `lib/enrichment-engine.ts` (enrichTransaction): After merchant-db miss, before
  Claude AI, query global table for matching normalized_key
- [ ] If top-voted category has `vote_count >= 3` → use with `confidence: 'medium', classifiedBy: 'crowd'`
- [ ] If `vote_count >= 5` → use with `confidence: 'high', classifiedBy: 'crowd'`
- [ ] In case of competing categories, use the one with highest vote_count
- [ ] User's own overrides (layer 1) always win over crowd consensus (layer 3)

### 5d. Wire into saveRecategorize and saveReview
- [ ] `app/(main)/(tabs)/index.tsx`: After saving user override to `transaction_overrides`,
  also call API endpoint to upsert global vote
- [ ] Fire-and-forget (don't block save on global upsert)

### 5e. Enrichment pipeline order update
- [ ] Update enrichment priority stack:
  1. User's own overrides (highest)
  2. Merchant-db (hardcoded)
  3. Global crowd consensus ← NEW
  4. Claude AI classification
  5. Fuzzy/keyword match
  6. "Other" fallback (lowest)

**Files:** Supabase migration, `api/enrich.ts` or `api/global-overrides.ts`,
`lib/enrichment-engine.ts`, `app/(main)/(tabs)/index.tsx`

---

## 7. Trust UX: Invisible Intelligence & Noise Reduction

**Principle:** The system should feel like it already knows the answer. Review is
confirmation, not homework. Learning is invisible. Confidence is felt, not displayed.

---

### 7a. Rewrite all enrichment-facing copy (language reframe)

**Current → Proposed:**

| Location | Current Copy | New Copy | Why |
|----------|-------------|----------|-----|
| Review banner (line 2444) | `X items need your input` | `X items to confirm` | "Need your input" = work. "Confirm" = quick tap. |
| Review banner (line 3500) | `X uncategorised — tap to quick-fix` | `X items to review — tap to improve` | "Uncategorised" = broken. "Review" = you're refining. |
| Section header (line 4152) | `UNCATEGORISED (N)` | `NEEDS REVIEW (N)` | Core reframe. System tried, asking for help. |
| Review subtitle (line 3975) | `Help us get your numbers right` | `Confirm a few items to sharpen your plan` | Ties review to their benefit, not our need. |
| Review subtitle (line 3974) | `Confirm or adjust AI suggestions` | `Bocy's best guesses — tap to confirm` | Friendlier, sets expectation of accuracy. |
| AI section header (line 4023) | `AI CATEGORISED (N)` | `READY TO CONFIRM (N)` | Remove "AI" label. Users don't care how. |
| Accept button (line 4047) | `Accept all (N) ✓` | `Confirm all (N) ✓` | Consistent "confirm" language. |
| Low-confidence hint (line 3553) | `hold to move` | `hold to recategorise` | More descriptive. |
| Loading (line 2404) | `Analysing your transactions` | `Building your financial picture` | Warmer. Outcome-focused. |
| Loading (line 3972) | `Bocy is analysing your transactions...` | `Bocy is reviewing your transactions...` | "Reviewing" feels like intelligence, not processing. |
| Merchant loading (line 4012) | `Analysing merchants...` | `Matching merchants...` | More concrete action. |
| Done button (line 4233) | `Done (N reviewed)` | `Save (N confirmed)` | "Done" feels like closing. "Save" feels like progress. |

- [ ] Update all 12 strings in `app/(main)/(tabs)/index.tsx`

**Files:** `app/(main)/(tabs)/index.tsx`

---

### 7b. Confidence as feel, not label

**Current state:** `confidence` field exists on every transaction but is only surfaced
as `hold to move` hint for low-confidence items. Medium and high are invisible. Good.

**Enhancement — progressive confidence styling:**
- [ ] High confidence transactions: render normally (no visual indicator needed)
- [ ] Medium confidence: subtle muted category label (slightly lighter text colour)
  — signals "we're fairly sure" without explicit label
- [ ] Low confidence: existing "hold to recategorise" hint + slightly dimmed row
- [ ] NEVER show "high/medium/low" text or confidence percentages to users
- [ ] When user confirms a medium-confidence item, silently promote to high
  (no animation, no "learned!" toast — just works next time)

**Files:** `app/(main)/(tabs)/index.tsx` (transaction row styles ~line 3540-3560)

---

### 7c. Make learning invisible but powerful

**Current state:** Learning loop exists (user overrides propagate to all merchant variants)
but user gets ZERO feedback that it happened. This is actually correct — learning
should be silent. But we should close one gap:

**Gap:** When a user reviews 10 transactions, the next month's enrichment is better,
but the user doesn't know their effort paid off.

**Fix — review count decay (subtle trust signal):**
- [ ] Track `reviewCountThisMonth` vs `reviewCountLastMonth` in AnalysisResult
- [ ] When review count drops by 30%+, show ONE subtle line on the review banner:
  `"Less to review this month — your corrections are working"`
- [ ] Show this ONCE per month, then hide. No badge, no celebration, just a line.
- [ ] If review count is 0: show nothing (perfection is its own reward)

**Anti-pattern to avoid:**
- NO "Bocy learned 47 merchants!" counters
- NO "AI accuracy: 89%" dashboards
- NO gamification of corrections
- The ABSENCE of review items IS the signal

**Files:** `app/(main)/(tabs)/index.tsx` (review banner ~line 2425-2447),
`lib/types.ts` (AnalysisResult)

---

### 7d. Remove noise variables and dead computations

**Audit found these computed-but-never-rendered values:**

| Variable | Location | Action |
|----------|----------|--------|
| `recentAmounts[]` | `IncomeSource` (types.ts line 68) | Keep — needed for tx embedding (workstream 3) |
| `amountSD` | `IncomeSource` (types.ts line 70) | Remove — never used in UI or logic |
| `allocationEfficiency` | chat.tsx ~line 2664 | Remove — computed but never rendered |
| `topReallocation` | chat.tsx ~line 2666-2671 | Remove — computed but never rendered |
| `DecisionScore.verdict` | types.ts | Keep — used in chat context, may surface later |
| `enrichmentMetrics.bySource` | types.ts line 364-370 | Keep — useful for internal debugging |
| `SpendingRing` import | index.tsx line 26 | Remove — imported but never called |
| `CategoryBars` import | index.tsx line 26 | Remove — imported but never called |

- [ ] Remove `amountSD` from IncomeSource type and enrichment calculation
- [ ] Remove `allocationEfficiency` and `topReallocation` from chat.tsx
- [ ] Remove unused `SpendingRing` and `CategoryBars` imports

**Files:** `lib/types.ts`, `lib/enrichment-engine.ts`, `app/(main)/(tabs)/chat.tsx`,
`app/(main)/(tabs)/index.tsx`

---

### 7e. Fix leaked implementation detail

**Problem:** When sync falls back to cached data, users see "(using cached data)"
(line ~2755) — this is a developer signal, not a user-facing message.

- [ ] Replace `"(using cached data)"` with `"Using your latest transactions"`
  or remove the parenthetical entirely
- [ ] The "Latest: X days ago" message is fine — it's informational, not alarming

**Files:** `app/(main)/(tabs)/index.tsx` (~line 2750-2761)

---

### 7f. Review flow UX refinement

**Current flow:**
1. User sees banner: "X items need your input"
2. Taps → modal opens with AI CATEGORISED + UNCATEGORISED sections
3. User taps accept/reject per item or "Accept all"
4. Taps "Done"

**Problems:**
- Two sections (AI CATEGORISED vs UNCATEGORISED) creates cognitive overhead
- "Accept all" only applies to AI section, confusing
- Modal feels like a chore, not like refining

**Proposed flow:**
1. Banner: `"X items to confirm"` (single number, not split)
2. Tap → modal opens with ONE list, sorted by confidence desc:
   - High-confidence AI suggestions at top (pre-checked, green tint)
   - Medium-confidence in middle (suggested category shown, neutral)
   - Low-confidence at bottom (no suggestion, needs input)
3. Single `"Confirm all"` button at top confirms everything with a suggestion
4. User only needs to interact with items they disagree with
5. `"Save"` button when done

- [ ] Merge AI CATEGORISED and UNCATEGORISED into single sorted list
- [ ] Sort by confidence: high → medium → low
- [ ] Pre-check high-confidence items (user can uncheck to change)
- [ ] Single "Confirm all" button for all suggested items
- [ ] Rename "Done" → "Save (N confirmed)"

**Files:** `app/(main)/(tabs)/index.tsx` (review modal ~line 3960-4240)

---

## 8. Enrichment Pipeline Order (updated)

After all changes, the full enrichment stack per transaction:

```
1. User override          → confidence: high,   classifiedBy: user_override
2. Merchant-db (exact)    → confidence: high,   classifiedBy: merchant_db
3. Global crowd (≥5)      → confidence: high,   classifiedBy: crowd
4. Global crowd (≥3)      → confidence: medium, classifiedBy: crowd
5. Fuzzy merchant match   → confidence: medium, classifiedBy: fuzzy_match
6. Keyword match          → confidence: medium, classifiedBy: keyword
7. Claude AI (Sonnet 4.6) → confidence: medium, classifiedBy: claude_ai
8. "Other" fallback       → confidence: low,    classifiedBy: default
```

Self-transfers (name match) are detected at step 0 and excluded from all downstream logic.

---

## 9. AI Review Modal Decision Engine

**Date added:** 2026-03-18
**Problem:** `aiSuggestedGroups` filter sends ALL `classifiedBy === 'claude_ai'` transactions
to the review modal regardless of confidence. ~90% are already correct — wasting user effort.

### 9a. Add confidence gate to aiSuggestedGroups
- [x] Only show AI-classified transactions in review modal when:
  - `confidence === 'low'`, OR
  - `category === 'Other'` (Claude wasn't sure enough to assign a real category)
- [x] Medium/high confidence in a real category = auto-accepted, skip review modal

### 9b. Auto-persist high-confidence AI classifications
- [x] When Claude classifies with medium+ confidence into a known (non-Other) category,
  automatically save to `transaction_overrides` so the learning loop kicks in
- [x] This means next sync won't re-classify the same merchant — it'll match the override

### 9c. Ensure manual review persists and cascades
- [x] Verify saveReview writes to `transaction_overrides` (confirmed: lines 607-622)
- [x] Verify optimistic UI updates all cards (confirmed: lines 625-707, recalcs surplus)
- [x] Verify savedOverrideKeys prevents re-showing (confirmed: lines 722-733)

---

## Implementation Order

**Priority 1 (Critical bugs + trust):**
1. Trust UX copy rewrite (7a) — immediate feel improvement, zero logic changes
2. Debt move £0 impact fix (1a + 1b) — users see broken data
3. Income recategorization bug (2) — UX trust issue
4. AI review modal decision engine (9) — 90% of review items are noise

**Priority 2 (UX refinement):**
5. Review flow merge (7f) — single sorted list, fewer decisions
6. Noise removal (7d + 7e) — dead code cleanup, leaked implementation detail
7. Confidence styling (7b) — subtle visual trust signals

**Priority 3 (High-impact features):**
8. Debt-first surplus allocation (1c) — correct financial advice
9. Self-transfer detection (4) — cleaner data, less manual work
10. Transaction embedding in Income card (3) — user transparency

**Priority 4 (Platform features):**
11. Global learning state (5) — scales enrichment across user base
12. Invisible learning signal (7c) — "less to review this month"

---

## Decisions Needed

1. **Internal transfers visibility**: Show in collapsed "Internal Transfers" section (recommended)
2. **Global consensus threshold**: 3 votes = medium confidence, 5 votes = high (recommended)
3. **Debt impact reframe**: Show interest cost when surplus = 0 (recommended)
4. **Surplus card**: Remains non-transactional (it's a computed remainder, not real transactions)
5. **Review modal**: Merge AI + Uncategorised into single confidence-sorted list (recommended)
6. **Learning signal**: Show "less to review" line once/month when corrections reduce review count by 30%+ (recommended)
7. **Confidence display**: Never show labels, only subtle styling differences (recommended)

---

## 10. Critical Bug Fixes: Surplus, Left-to-Spend, Categorization Persistence

**Date added:** 2026-03-18

### 10a. Surplus doesn't subtract detected savings
- [x] `lib/enrichment-engine.ts` `buildProfile()`: Change `surplus = monthlyIncome - monthlySpending - monthlySavings`
- [x] Keep `savingsRate` using gross surplus (pre-savings): `(monthlyIncome - monthlySpending) / monthlyIncome * 100`
- [x] This makes `analysis.surplus` consistent with income card display

### 10b. Left-to-spend counts refunds/credits as spending
- [x] `app/(main)/(tabs)/index.tsx`: Filter weekly spend to `amount < 0` only
- [x] Prevents `Math.abs` from inflating spend with positive transactions in discretionary categories

### 10c. Categorization persistence: 120s guard timeout
- [x] `app/(main)/(tabs)/index.tsx`: Remove 120s timeout from `recentOverride` check in `loadData`
- [x] Guard should persist until cleared by successful post-override sync acceptance

### 10d. Income card surplus simplification
- [x] `app/(main)/(tabs)/index.tsx`: Use `analysis.surplus` directly instead of recalculating

---

## 11. "Debt Free" Modal Fires for Every New User

**Date added:** 2026-03-18

### Root Cause
`reactive-engine.ts:573` **hardcodes** `debt_account_count: 0` in the `ScoreSnapshot`, ignoring the actual debt data. `achievements.ts:124` awards `debt_free` when `debt_account_count === 0`. Result: every new user with no debt data triggers the celebration modal on first analysis.

### Fix
- [ ] **`reactive-engine.ts:573`** — Populate `debt_account_count` from the `debtAccounts` parameter instead of hardcoding 0
- [ ] **`achievements.ts:124`** — Only award `debt_free` as a **transition**: require a previous analysis where `debt_account_count > 0` before awarding. "Never had debt data" ≠ "debt free". Guard: `previous.debt_account_count > 0 && current.debt_account_count === 0`
- [ ] **Consider `data_completeness` guard** — Don't fire milestone achievements until the user has completed at least one full analysis cycle with connected data

---

## 12. Duplicate Income Sources (Same Paycheck, Different Names)

**Date added:** 2026-03-18

### Root Cause
`enrichment-engine.ts:670-676` groups income by `tx.merchant || tx.description`. The same paycheck can match via two paths:
- **Path A:** Merchant DB match → `merchant = "Net Ltd"` (company name)
- **Path B:** Salary keyword match → `merchant = "Salary"` (generic label)

Both have the same amount and date but different merchant names → separate income groups → totals inflated (£3000 + £3000 = £6000).

### Fix
- [ ] **Dedup pass after income grouping in `buildProfile()`** — For each pair of income groups, check if they have overlapping transaction dates (±2 days) AND similar amounts (within 5%). If overlap ≥ 50% of transactions, merge into the group with the more specific name (company name beats "Salary")
- [ ] **Merchant enrichment priority** — When a transaction matches a merchant DB entry with `isIncome: true`, skip the salary keyword fallback path entirely. The generic "Salary" label should only apply when NO specific merchant match exists
- [ ] **Fuzzy name merge** — Before final grouping, normalize income merchant names: if two groups share significant tokens (e.g., "Net Ltd" vs "NET TRANSFER FROM NET LTD"), merge them using token overlap (Jaccard > 0.4)

---

## 13. Savings Optimizer Recommendation Quality

**Date added:** 2026-03-18

### Root Causes

**A. No archetype-aware move filtering**
- `genDecisionStack()` only checks `isHighSaver` (25%+ savings rate) to suppress discretionary cuts
- No concept of user sophistication or archetype — a 22% saver still gets "cut £84 discretionary"
- `archetypes.ts` has no `savings_optimizer` archetype (closest is `quiet_builder` at 20%+ savings rate)

**B. Essential services recommended for cutting**
- `merchant-db.ts` marks TFL, council tax, utilities as `isEssential: true`
- `genDecisionStack()` **never checks this flag** — transport/subscription cut moves can include essentials
- Result: "Cancel your council tax subscription" or "Cut TFL transport spend"

**C. Credit card optimizers get debt recommendations**
- System detects "good debt" via TrueLayer balance (<15% utilization) or spending-ratio (50-150%)
- Without connected accounts, detection fails → rewards users get "pay off your credit card" moves
- No concept of "uses cards strategically for points and pays in full"

**D. No confidence/quality scoring on moves**
- `Move` type has no `confidence` or `relevance` field
- Ranking uses impact/effort but not appropriateness for the user's profile

### Fix — Phase 1: Essential Protection (Quick Win)
- [ ] **`enrichment-engine.ts` move generation** — Filter `isEssential` transactions from ALL cut/reduce recommendations. Before building subscription, transport, or discretionary cut moves, exclude any items where the underlying transactions are from essential merchants
- [ ] **`merchant-db.ts` audit** — Verify council tax, TFL, all utilities, insurance are `isEssential: true`

### Fix — Phase 2: Archetype-Aware Move Filtering
- [ ] **Add `savings_optimizer` archetype** to `archetypes.ts` — Trigger: savings rate ≥ 15%, no problematic debt (or utilization < 30%), surplus > 0. Distinguishes from `quiet_builder` (passive) — savings optimizers are active/intentional
- [ ] **Pass archetype into `genDecisionStack()`** — Use it to gate move categories
- [ ] **Archetype-specific suppression for savings optimizers:**
  - Suppress discretionary cuts with `annualImpact < £500`
  - Suppress generic subscription cut moves
  - Suppress debt recommendations when credit utilization is healthy or full-payer pattern detected
  - Lower `isHighSaver` threshold to 15% for this archetype
- [ ] **Add `confidence` field to `Move` type** — Score 0-100 based on data quality and archetype relevance. Moves below threshold (e.g., 40) are hidden

### Fix — Phase 3: Predictive/Mathematical Recommendations
- [ ] **Credit card rewards detection** — Detect high CC spend + full monthly payoff pattern → `creditCardOptimizer: true`. Replace "pay off debt" with "maximize rewards categories" or "you're earning ~£X/year in cashback"
- [ ] **Trajectory projections** — New move types:
  - "At your savings rate, you'll have £X emergency fund in Y months"
  - "Switching savings account from X% to Y% APR = £Z more per year"
  - "ISA allowance usage: X% — contribute £Y more before April"
  - "At current trajectory, you'll reach £X net worth by [date]"
- [ ] **Pattern-based insights** — Detect spending variance and seasonal patterns:
  - "Your transport spend is 30% above your 3-month average"
  - "Your grocery spend drops £X in summer months — expect increase in autumn"
  - Anomaly detection: flag individual transactions that are 2σ+ above category average
- [ ] **Rate optimization** — Compare detected savings APR against best available rates (could use static table initially). "Your £X in savings at Y% could earn £Z more at Z%"

---

## Priority Order (New Items)

1. **Bug 11 (Debt Free modal)** — Simple fix, high annoyance, ship first
2. **Bug 12 (Income duplication)** — Moderate complexity, directly inflates key numbers
3. **Bug 13 Phase 1 (Essential protection)** — Quick win, stops embarrassing recommendations
4. **Bug 13 Phase 2 (Archetype filtering)** — Core architectural improvement for savings optimizers
5. **Bug 13 Phase 3 (Predictive recommendations)** — Highest value but most complex, differentiator for the platform

---

## 14. Silent High Earner Cohorts — Capital Allocation Engine

**Date added:** 2026-03-18
**Status:** Planning

### Vision
Transform BOCY from a spending tracker into a **capital allocation engine** for Silent High Earners. Two cohorts:

- **Unstructured High Earners (UHE):** £70k–£250k+ income, cash-heavy, under-optimized, decision-fatigued. Problem = lack of capital direction
- **Structured High Earners (SHE):** Same income band, but active — mortgages, investments, credit cards for points. Locally efficient, globally suboptimal

### What Exists Today

| Component | Status | Gap |
|-----------|--------|-----|
| `account_balances` (TrueLayer) | Fetched & stored in `bank_data` JSONB | **Never queried or displayed** — idle cash invisible |
| Account types (current/savings/isa) | Raw `account_type` from TrueLayer stored | **Not classified** into cash/savings/ISA/pension buckets |
| Tax engine (`surplus-engine.ts`) | UK_TAX constants, marginal rate calc, pension return calc | **ISA/pension allowance tracking = 0** — `existingIsaUsed: 0` hardcoded |
| Investment merchants (merchant-db) | Freetrade, Vanguard, HL etc. detected | **Not differentiated** by account type (ISA vs GIA vs SIPP) |
| Move generation | Threshold-based cuts only | **No capital reallocation moves** — no idle cash, no ISA fill, no pension optimize |
| Archetype system | 10 archetypes, none for high earners | **No UHE/SHE detection** |
| UKPF flowchart | Levels 0-9, tops out at "Long-term wealth" | **Level 9 is a dead end** — no guidance once you're there |
| Debt detection | Credit card, overdraft, mortgage | **No distinction** between strategic credit use and problem debt |

---

### Phase 1: Cohort Detection & Account Intelligence

#### 14a. Surface account balances from `bank_data`
- [ ] **`api/truelayer/sync.ts`** — Already stores `account_balances` JSONB. No change needed in sync
- [ ] **`lib/enrichment-engine.ts` `buildProfile()`** — Accept `accountBalances` parameter. Add to `FinancialProfile`:
  ```
  accounts: {
    cash: { total: number; accounts: AccountSnapshot[] }
    savings: { total: number; accounts: AccountSnapshot[] }
    isa: { total: number; accounts: AccountSnapshot[] }
    pension: { total: number; estimated: boolean }
    investments: { total: number; accounts: AccountSnapshot[] }
  }
  ```
- [ ] **`lib/types.ts`** — Add `AccountSnapshot` type: `{ name, type, balance, provider }`
- [ ] **`lib/types.ts`** — Add `accounts` field to `FinancialProfile`
- [ ] **Dashboard query** — Fetch `account_balances` from `bank_data` and pass to `buildProfile()`

#### 14b. Classify account types
- [ ] **New function: `classifyAccounts()`** in enrichment-engine or new `lib/account-classifier.ts`
- [ ] Map TrueLayer raw `account_type` to buckets:
  - `"SAVINGS"`, `"savings"` → savings bucket
  - Account name contains "ISA", "Stocks & Shares", "Cash ISA" → isa bucket
  - Account name contains "SIPP", "Pension" → pension bucket
  - `"CURRENT"`, `"current"` → cash bucket
  - Investment platform transactions (Freetrade, Vanguard, HL) → investments bucket
- [ ] Pension: estimate from detected pension contribution transactions × months employed (no balance data from TrueLayer, so flag `estimated: true`)
- [ ] Mortgage: already in `debt_accounts` — surface as `liabilities.mortgage`

#### 14c. Detect cohort: UHE vs SHE vs Other
- [ ] **New: `lib/cohort-engine.ts`** — Cohort detection function:
  ```typescript
  function detectCohort(profile, accounts, debtAccounts, identity): Cohort
  ```
- [ ] **Income gate:** Monthly income ≥ £4,000 (≈ £58k+ gross). Below this = existing archetype system
- [ ] **UHE triggers** (must meet income gate + 2 of 3):
  1. Cash-to-income ratio > 3x monthly income sitting in current accounts
  2. Savings rate < 15% despite high income (under-deployed)
  3. No detected ISA/pension/investment contributions
- [ ] **SHE triggers** (must meet income gate + 2 of 3):
  1. Active investment platform transactions (Freetrade, Vanguard, HL, etc.)
  2. Mortgage present
  3. Credit card full-payer pattern detected (already exists in enrichment engine)
- [ ] **Cohort stored** in `Analysis` table alongside `archetype`
- [ ] Cohort takes precedence over archetype for move generation but archetype still used for behavioral insights

---

### Phase 2: Capital Allocation Moves — Unstructured High Earners

#### 14d. Idle Capital Drag (UHE Primary Insight)
- [ ] **New move type: `category: 'allocate'`** — Add to Move.category union
- [ ] **Detection:** Sum `accounts.cash.total` across current accounts. If > 3× monthly spending → idle capital detected
- [ ] **Calculation:**
  - Idle amount = `cashTotal - (monthlySpending × 3)` (keep 3 months buffer)
  - Opportunity cost = `idleAmount × (achievableRate - currentRate)` where `achievableRate = 0.045` (best easy-access savings) and `currentRate ≈ 0.01` (typical current account)
  - Annual drag = `idleAmount × 0.035`
- [ ] **Move output:**
  ```
  action: "£46,000 of your cash is earning <1%. Reallocating £30,000 would generate ~£1,050/year without increasing risk."
  annualImpact: 1050
  effort: 'low'
  category: 'allocate'
  strategy: 'Move excess cash to high-yield savings'
  ```
- [ ] **Proof string:** `"£46,000 cash across 2 accounts | 3-month buffer = £16,000 | £30,000 idle × (4.5% - 1%) = £1,050/yr"`

#### 14e. Tax Shield Underutilization
- [ ] **Detection:** Estimate ISA contributions this tax year from savings/ISA transactions. Compare against £20,000 allowance
- [ ] **ISA tracking:** Sum transactions to ISA-classified accounts or investment platforms with ISA keyword in description. `remainingIsaAllowance = 20000 - detectedIsaContributions`
- [ ] **Move output (if remaining > £5,000):**
  ```
  action: "You have £X of ISA allowance remaining. Using it protects future gains from tax."
  annualImpact: calculatedTaxSaving
  ```
- [ ] **Annual impact calc:** `remainingAllowance × expectedReturn × marginalTaxRate`
  - E.g., £15,000 × 5% return × 20% tax = £150/year protected; over 10 years with growth ≈ significant
- [ ] **Pension optimization:** Use existing `calcPensionEffectiveReturn()` from surplus-engine. If gross income > £50,270 (higher rate), show: "£1 pension contribution saves you 40p in tax"
- [ ] **Move output:**
  ```
  action: "Increase pension contribution by £500/month → captures ~£2,400/year in tax relief"
  proof: "£500/mo × 12 = £6,000/yr | marginal rate 40% | tax relief = £2,400/yr"
  ```

#### 14f. Structural Misallocation
- [ ] **Detection:** Calculate allocation percentages across buckets:
  ```
  cashPct = accounts.cash.total / totalAssets × 100
  investPct = (accounts.isa.total + accounts.investments.total) / totalAssets × 100
  pensionPct = accounts.pension.total / totalAssets × 100
  ```
- [ ] **Benchmark:** Optimal allocation by age/risk profile (from identity.risk_appetite):
  - Conservative: 30% cash / 40% invested / 30% pension
  - Balanced: 20% cash / 50% invested / 30% pension
  - Growth: 10% cash / 60% invested / 30% pension
- [ ] **Move output (if cashPct > benchmark + 15%):**
  ```
  action: "Your allocation is 62% cash vs 18% invested. Rebalancing could improve long-term outcome by ~£84,000 over 10 years."
  proof: "£62k cash × 1% vs invested × 7% avg = 6% drag on £44k excess = ~£2,640/yr | compounded 10yr ≈ £84k"
  ```

#### 14g. Timing-Based Loss (Delayed Deployment)
- [ ] **Detection:** Track cash balance trend across syncs. If cash has been growing for 3+ months without investment outflow → delayed deployment
- [ ] **Requires:** New `balance_history` tracking — snapshot account balances monthly (store in new JSONB field or separate table)
- [ ] **Move output:**
  ```
  action: "Your cash has grown £X over 3 months without investment. Historical data suggests delaying costs ~£Y in missed returns."
  proof: "£X undeployed × 7% avg market return × 0.25yr = £Y opportunity cost"
  ```
- [ ] **Defer to Phase 3** — requires balance history which needs multiple syncs to build

---

### Phase 3: Capital Allocation Moves — Structured High Earners

#### 14h. Debt vs Investment Trade-off (SHE Core Insight)
- [ ] **Detection:** User has mortgage AND investment activity. Mortgage overpayments detected (payment > expected minimum)
- [ ] **Calculation:**
  - Mortgage rate from debt_accounts (or inferred from surplus-engine: defaults to 4.5%)
  - Expected investment return: 7% nominal long-term
  - If mortgage rate < investment return × 0.7 (tax-adjusted): overpaying mortgage is suboptimal
- [ ] **Move output:**
  ```
  action: "You're overpaying your mortgage by £900/month at 4.5%. Redirecting to ISA at ~7% would net ~£41,000 more over 10 years."
  proof: "£900/mo × 12 = £10,800/yr | mortgage saves 4.5% = £486/yr | ISA earns ~7% = £756/yr | net gain £270/yr | compounded 10yr ≈ £41k"
  ```
- [ ] **Important:** Only surface when mortgage rate < 5% (threshold where investment edge is meaningful after tax)

#### 14i. Net Yield Mismatch
- [ ] **Detection:** User holds cash (accounts.cash.total > £10k) AND has debt with APR > savings rate
- [ ] **Calculation:** `mismatchCost = min(cashExcess, debtBalance) × (debtAPR - cashRate)`
- [ ] **Move output:**
  ```
  action: "You hold £18,000 in low-yield cash while paying 5.2% on car finance → costing ~£936/year net."
  proof: "min(£18k, £12k debt) = £12k × (5.2% - 1%) = £504/yr guaranteed return"
  ```
- [ ] **Guard:** Don't recommend depleting below 3-month buffer

#### 14j. Liquidity Inefficiency
- [ ] **Detection:** Cash across all accounts > recommended buffer (from Monte Carlo `simulateBufferNeed`)
- [ ] **Excess calc:** `excessLiquidity = totalCash - bufferRecommendation.amount`
- [ ] **Move output (if excess > £5,000):**
  ```
  action: "You're holding ~£22,000 excess liquidity beyond your risk-adjusted buffer → reducing long-term returns by ~£17,000 over 10 years."
  proof: "buffer need = £8k (from Monte Carlo) | excess = £22k | drag at 5% = £1,100/yr | 10yr compounded ≈ £17k"
  ```

#### 14k. Tax Structure Optimization
- [ ] **Detection:** Compare current ISA vs GIA vs pension allocation against tax-optimal split
- [ ] **Uses existing:** `calcMarginalRate()`, `calcPensionEffectiveReturn()` from surplus-engine
- [ ] **Logic:**
  - If gross > £50,270 AND pension contribution < £500/mo: pension move (40% relief)
  - If gross > £100,000 AND pension contribution could bring below PA taper: "£1 pension saves you 60p" (60% effective rate in taper zone)
  - If investments in GIA AND ISA allowance remaining: move to ISA wrapper
- [ ] **Move output:**
  ```
  action: "Shifting £X from GIA to ISA wrapper saves ~£Y/year in capital gains tax"
  proof: "£X × 7% return × 20% CGT = £Y/yr | plus dividend tax savings"
  ```

---

### Phase 4: Integration & UI

#### 14l. Move engine integration
- [ ] **`move-engine.ts` `rankMoves()`** — Add cohort-aware scoring:
  - UHE/SHE moves get `1.3x` boost when user matches cohort
  - Suppress discretionary cut moves for UHE/SHE users when annualImpact < £500 (noise)
  - Capital allocation moves rank above spending cuts for these cohorts
- [ ] **New UKPF flowchart level 9 expansion:**
  - Level 9a: "Optimize tax wrappers" (ISA/pension fill)
  - Level 9b: "Reduce idle capital drag"
  - Level 9c: "System-level optimization" (cross-account rebalancing)
- [ ] **`genDecisionStack()` integration** — When cohort is UHE/SHE, call new capital allocation move generators alongside existing spending moves. Existing moves still generated but filtered by relevance

#### 14m. Dashboard UI for capital allocation
- [ ] **Net Worth card** — New dashboard card showing:
  - Total across all account buckets (cash, savings, ISA, pension, investments)
  - Allocation pie/bar (cash% / invested% / pension%)
  - Trend arrow (from balance history)
- [ ] **Move cards for allocation moves** — Same card format but with:
  - Blue/purple accent (vs green for spending cuts)
  - "THE MATH" proof string showing compound growth calculations
  - "Rebalance" CTA instead of "Cut"
- [ ] **ISA/Pension tracker** — Small widget showing allowance usage:
  - "ISA: £4,200 / £20,000 used" with progress bar
  - "Tax year ends 5 April — X weeks remaining"

#### 14n. Cohort-specific chat context
- [ ] **`ChatContext`** — Add fields:
  ```
  cohort?: 'unstructured_high_earner' | 'structured_high_earner' | null
  account_summary?: { cash: number; savings: number; isa: number; pension: number; investments: number }
  idle_capital?: number
  isa_remaining?: number
  pension_allowance_remaining?: number
  allocation_vs_benchmark?: { cashPct: number; investPct: number; pensionPct: number }
  ```
- [ ] **Chat system prompt** — When cohort is UHE/SHE, inject capital allocation context so Bocy can answer "where should I put my money?" intelligently

---

### Implementation Order

**Sprint 1: Foundation (Account Intelligence)**
1. 14a — Surface account balances from bank_data
2. 14b — Classify accounts into buckets
3. 14c — Cohort detection (UHE vs SHE)

**Sprint 2: UHE Moves (Capital Direction)**
4. 14d — Idle Capital Drag
5. 14e — Tax Shield (ISA + Pension)
6. 14f — Structural Misallocation

**Sprint 3: SHE Moves (System Optimization)**
7. 14h — Debt vs Investment Trade-off
8. 14i — Net Yield Mismatch
9. 14j — Liquidity Inefficiency
10. 14k — Tax Structure Optimization

**Sprint 4: Integration & UI**
11. 14l — Move engine integration + cohort scoring
12. 14m — Dashboard UI (Net Worth card, allocation, ISA tracker)
13. 14n — Chat context enrichment

**Deferred:**
- 14g — Timing-Based Loss (requires balance history across multiple syncs)

---

### Key Design Decisions Needed

1. **Income threshold for cohort:** £4,000/mo net (≈£58k gross) — or should it be £5,000/mo (≈£70k gross) to match the spec?
2. **Pension estimation:** Without TrueLayer pension data, estimate from contribution transactions × employment months. Flag as estimated. Acceptable?
3. **Investment return assumption:** 7% nominal for equity benchmarks. Conservative enough?
4. **Balance history:** New table vs JSONB snapshots on existing `bank_data`? Need monthly snapshots for trend detection
5. **Rate comparison source:** Static UK savings rate table (updated monthly) vs API? Start static?
6. **ISA detection accuracy:** Rely on account name matching + investment platform transactions. Will miss some. Acceptable for MVP?
