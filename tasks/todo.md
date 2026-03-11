# Fix: Move Engine + Categorization Modal UX

## Correction: Move Engine (Reverting Previous Changes)

### Problem with Previous Approach
The previous commit added archetype-based cohort multipliers to `rankMoves()`. This was **redundant** because the engine already has a sophisticated multi-layer ranking system:
1. **UKPF waterfall** → sets priority category (debt/buffer/savings/invest)
2. **CRRA marginal utility** → liquidity-adjusted diminishing returns per category
3. **Monte Carlo consistency** → weights reliable/low-effort moves higher
4. **Goal alignment** → 1.3x boost for matching user's 1-year goal

Adding cohort boosts on top creates **multiplicative stacking** (e.g. debt_juggler at UKPF level 4 would get 1.5x UKPF × 2.0x cohort = 3.0x, distorting scores). The CRRA model already accounts for where each pound delivers most value.

### Fix
In `lib/move-engine.ts`:
- [x] **Remove `archetypeKey` parameter** from `rankMoves()`
- [x] **Remove cohort boost logic** (lines 131-149)
- [x] **Revert UKPF boost from 1.5x back to 1.15x** — CRRA handles the heavy lifting
- [x] **Keep category diversity enforcement** — sensible UX guard
- [x] **Update call sites**: `processing.tsx`, `sync.ts`, `api/enrich.js`

## Correction: Modal UX (Auto-Apply Enrichment)

### Problem
Showing 300 transactions in the categorize modal is bad UX. The enrichment engine + Claude AI processing pipeline already correctly classifies 98% of transactions. Users shouldn't review what the system already knows.

### Fix
In `app/(main)/(tabs)/index.tsx`:
- [x] **Change `unresolvedGroups` filter**: Only include transactions where `confidence === 'low'` AND `classifiedBy === 'default'` (truly unclassifiable)
- [x] **Remove person transfers from modal** — they already have their own transfer review modal
- [x] **Keep "Accept all" button** — still useful for the few remaining items
- [x] **Keep improved `normalizeMerchant()`** — still valuable for grouping

### Result
- Medium/high confidence enrichment results are auto-applied (no modal)
- Only genuinely unidentifiable transactions require user input
- Users can always re-categorize from the budget section

## Verification
- [ ] TypeScript compiles
- [ ] `rankMoves()` signature matches all call sites
- [ ] Modal only shows truly unclassifiable items
- [ ] No regressions in move ranking (CRRA + Monte Carlo + UKPF still works)
