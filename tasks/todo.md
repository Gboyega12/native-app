# Simplify Home Screen: 3-Bucket Model + Correlated Cards

**Date:** 2026-03-17
**Status:** Complete

## Design Decisions (Agreed)
- **3 buckets**: Essentials, Lifestyle, Savings & Surplus
- **Savings & Surplus** = explicit savings/investment txs + remaining (Income - Essentials - Lifestyle)
- **Subcategory tags** kept internal (invisible to user), used by chat for specific advice
- **Recategorization → instant move refresh**: auto-regenerate recommendations when totals change
- **Chat invalidation**: auto-replace stale recommendations with updated ones (no strikethrough noise)

---

## Implementation Plan

### Phase 1: Income Card — Add Lifestyle Row
**File:** `app/(main)/(tabs)/index.tsx` (~line 3209)

- [ ] Add `lifestyle` row to the income card summary between Essentials and Surplus
  - Current: `[Income, Essentials, Surplus]`
  - New: `[Income, Essentials, Lifestyle, Savings & Surplus]`
  - Lifestyle value = `discTotal` (already computed)
  - Savings & Surplus = `income - nonDiscTotal - discTotal` (currently called `leftToDecide`)
  - Rename "Surplus" label to "Savings & Surplus"
- [ ] Add `lifestyle` to the `editingIncomeField` type union: `'income' | 'essentials' | 'lifestyle' | 'surplus'`
- [ ] Add `saveIncomeOverride` handler for `field === 'lifestyle'`:
  - Scale `discretionary.total` and its items proportionally (same pattern as essentials handler)
- [ ] Update colors: Lifestyle row gets `colors.dim` (consistent with existing lifestyle color), Savings & Surplus keeps `colors.green`

### Phase 2: Transactions Section — Replace Spending Details
**File:** `app/(main)/(tabs)/index.tsx` (~lines 3295-3570)

- [ ] Rename section: `SPENDING DETAILS` → `TRANSACTIONS`
- [ ] Add tab state: `const [txTab, setTxTab] = useState<'essentials' | 'lifestyle' | 'savings'>('essentials')`
- [ ] Replace the budget progress bars + big spend number with 3 tab buttons:
  - `[Essentials] [Lifestyle] [Savings & Surplus]`
  - Style: same as existing `periodToggleRow` pattern (pill buttons)
- [ ] **Essentials tab**: Show `periodNonDiscData` categories with expandable transactions (reuse existing `renderCategoryRow`)
- [ ] **Lifestyle tab**: Show `periodDiscData` categories with expandable transactions (reuse existing `renderCategoryRow`)
- [ ] **Savings & Surplus tab**:
  - List savings/investment transactions from `analysis` (tagged `isSavings` during enrichment)
  - Show person transfers (currently in `person_transfers` array) — keep "hold to move" recategorization
  - Show computed "Remaining" line: `Income - Essentials - Lifestyle - Explicit Savings`
- [ ] **Remove**: overall progress bar, essentials/lifestyle sub-progress bars, "Remaining" standalone row, TOP CATEGORIES bar chart, big centered spend number with "of £X"
- [ ] **Keep**: period toggle (annual/monthly/weekly), uncategorised review banner, "hold to move" on all txs, minor categories collapse

### Phase 3: Correlation Engine — Recategorization Triggers Move Refresh
**Files:** `app/(main)/(tabs)/index.tsx`, `lib/enrichment-engine.ts`

When a user recategorizes (moves £200 from Lifestyle → Essentials), surplus changes, making existing moves potentially wrong.

- [ ] Extract `recomputeMoves(analysis: Analysis)` from the enrichment engine:
  - Takes current `Analysis` (with updated totals after recategorization)
  - Rebuilds minimal `FinancialProfile` from analysis fields (income, spending, surplus, savingsRate, category breakdowns)
  - Calls `genDecisionStack()` with this profile → fresh moves
  - Returns new `all_moves` array
- [ ] In `saveRecategorize()`: after optimistic update, call `recomputeMoves(updated)`, set `updated.all_moves = freshMoves`
- [ ] In `saveIncomeOverride()`: same — recompute moves after update
- [ ] In `mergeAdjustments()`: same pattern

### Phase 4: Chat/Recommendation Auto-Refresh

- [ ] After `recomputeMoves`, hero card + move sections auto-update (already happens via `setAnalysis(updated)`)
- [ ] Preserve in-progress moves across recomputation: if user approved a move, keep it even if re-ranked stack would deprioritize it (match by `move.action`)

---

## What Gets Removed (Simplification)
1. Overall progress bar (% of income spent)
2. Essentials/Lifestyle sub-progress bars with budget comparison
3. "Remaining" standalone row → replaced by Savings & Surplus tab
4. TOP CATEGORIES bar chart → subcategories visible within each tab
5. Big centered spend number with "of £X"

## What Gets Kept
- Period toggle (annual/monthly/weekly)
- Uncategorised review banner
- "Hold to move" recategorization on every transaction
- Minor categories collapse
- Person transfers (moved into Savings & Surplus tab)
- All duplicate prevention guards

## Data Flow After Changes
```
Transaction recategorized
  → optimistic UI update (move tx between buckets)
  → recompute totals (essentials, lifestyle, savings & surplus)
  → recomputeMoves(updatedAnalysis)
  → setAnalysis(updated) — single state update
  → ALL cards re-render from same source:
      Income card:   reads monthly_income, nonDiscTotal, discTotal, savingsAndSurplus
      Transactions:  reads non_discretionary.items, discretionary.items, savings txs
      Hero card:     reads all_moves[0]
      Move sections: reads all_moves
  → persist to AsyncStorage + delayed Supabase sync
```

## Edge Cases
| Edge Case | Decision |
|-----------|----------|
| Debt payments | Essentials (mandatory) |
| BNPL | Lifestyle (discretionary purchase) |
| Refunds | Negative amount in original bucket |
| Savings/ISA | Savings & Surplus tab as explicit txs |
| Person transfers | Savings & Surplus tab, "hold to move" |
| Subscriptions | Keep in current bucket based on type |

## Verification
- [ ] Income card: 4 rows sum correctly (Income = Essentials + Lifestyle + Savings & Surplus)
- [ ] Editing any row recomputes others + refreshes moves
- [ ] Recategorizing tx updates: income card, transaction list, hero move
- [ ] Period toggle works across all 3 tabs
- [ ] In-progress moves survive recategorization
- [ ] No regression in: override persistence, stale sync guards, transfer batch moves
