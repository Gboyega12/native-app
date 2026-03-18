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
