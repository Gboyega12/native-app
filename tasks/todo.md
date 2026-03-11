# Fix: Cohort Balance, Auto-categorization, and Duplicate Grouping

## Issue 1: Move recommendations skewed towards savings optimizers

### Root Cause
`rankMoves()` in `lib/move-engine.ts` gives UKPF priority match only a **1.15x** boost (line 166), and goal alignment only **1.3x** (lines 170-174). Base score is `annualImpact / 100`, so a savings move worth £2000/yr still outranks a debt move worth £500/yr even for a debt-juggler.

`genDecisionStack()` generates moves across all categories (spending, debt, savings, invest). The problem is ranking doesn't sufficiently reweight by cohort.

### Fix
In `lib/move-engine.ts` `rankMoves()`:
- [ ] Add **cohort multiplier** based on archetype: debt_juggler/edge_walker → 2.0x debt moves, subscription_collector/impulse_surfer/comfort_spender/convenience_seeker → 1.8x spending moves, quiet_builder/lifestyle_investor → current weights fine
- [ ] Increase UKPF priority from 1.15x to **1.5x** — this is the strongest signal for what the user needs
- [ ] Add **category diversity enforcement**: top 5 must span at least 2 categories
- [ ] Pass archetype into `rankMoves()` from `processing.tsx` (currently not passed)

## Issue 2: Enrichment modal shows easily identifiable transactions

### Root Cause
`unresolvedGroups` in `index.tsx` (line 476) collects all `category === 'Other'` items. The Claude AI classify call (line 516-559) gets them 98% right when the modal opens. But user must manually tap each suggestion.

### Fix
- [ ] Auto-apply Claude AI suggestions as **pre-selected defaults** — modal opens with suggestions already applied
- [ ] Only require explicit user action for items Claude couldn't classify (returned 'Other')
- [ ] Add "Accept all" button at top of modal for one-tap bulk approval

## Issue 3: Duplicate transactions in categorization modal

### Root Cause
`normalizeMerchant()` may not strip reference numbers, dates, card suffixes aggressively enough, creating separate groups for the same merchant.

### Fix
- [ ] Audit `normalizeMerchant()` — improve stripping of reference numbers, dates, suffixes
- [ ] When user assigns category to one group, auto-cascade to similar merchant names in the modal

---

## Implementation Order
1. Issue 1 (cohort balance) — most impactful, affects all users
2. Issue 2 (auto-apply suggestions) — reduces friction massively
3. Issue 3 (duplicate grouping) — dependent on Issue 2

## Verification
- [ ] Debt-focused user sees debt moves ranked highest
- [ ] Spending-focused user sees spending cuts ranked highest
- [ ] Savings-focused user sees savings/invest moves ranked highest
- [ ] Modal opens with AI suggestions pre-applied
- [ ] "Accept all" works for bulk categorization
- [ ] Similar merchants are grouped properly
- [ ] TypeScript compiles
