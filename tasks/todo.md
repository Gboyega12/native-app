# Add Refund & Internal Transfer to Manual Categorisation

## Problem
When the enrichment engine misses a refund or internal transfer (unusual description),
the transaction falls into "Other" with low confidence. Users currently can only pick
spending categories — no way to mark it as a refund or internal transfer.

## Changes
- [x] Add `Refund` and `Internal Transfer` to `BUDGET_CATEGORIES`
- [x] Add mapping in `mapClaudeCategory` for Claude AI suggestions
- [x] Fix enrichment engine: set `isRefund: true` when override category is `Refund`
- [x] Update `saveReview()`: exclude Refund/Internal Transfer from budget totals (remove from Other, don't add to spending)
- [x] Update `saveRecategorize()`: same exclusion logic
- [x] Verify, commit, push
