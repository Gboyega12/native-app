# Enrichment Pipeline Gap Fixes

**Date:** 2026-03-17
**Status:** In Progress

## Gaps to Fill

### Enrichment Engine (lib/enrichment-engine.ts)
- [ ] Gap 1: Track savings/investment debits separately (not in spending, not dropped)
- [ ] Gap 2: Net refunds against originating spending categories
- [ ] Gap 4: Monthly-normalise person_transfers
- [ ] Gap 5: Store metrics on Analysis; restore in recomputeMovesFromAnalysis
- [ ] Gap 6: Collect irregular incoming person credits (amount > 0, isTransfer, not income)
- [ ] Gap 10: Filter CC payoffs from person_transfers (category === 'Credit Card Payoff')

### Types (lib/types.ts)
- [ ] Add savings_categories, incoming_transfers, enrichment_metrics to Analysis
- [ ] Add monthlySavings to FinancialProfile.monthly

### Sync (lib/sync.ts)
- [ ] Map new profile fields to Analysis

### UI (app/(main)/(tabs)/index.tsx)
- [ ] Gap 3: Fix Savings tab double-counting (surplus = income - spending - savings)
- [ ] Gap 7: Add direction to override inserts
- [ ] Gap 8: Add Debt Payments to BUDGET_CATEGORIES, fix mapClaudeCategory
- [ ] Gap 9: Align ESSENTIAL_CATS with granular enrichment categories
- [ ] Apply stashed fixes: readonly income card, rename to Savings, button responsiveness
