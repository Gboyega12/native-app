# Savings/Surplus Split + Transfer Recategorization + AI Recategorization

**Date:** 2026-03-17
**Status:** Planning

---

## Context & Research Summary

### Current State
- **Income card** shows 4 rows: Income, Essentials, Lifestyle, "Savings & Surplus" (single combined value)
- **Transactions card** has 3 tabs: Essentials, Lifestyle, Savings (single tab combining savings txs + surplus)
- `leftToDecide = income - nonDiscTotal - discTotal` — lumps savings and surplus together
- `analysis.savings_categories` already identifies savings transactions (flagged via `isSavings` keyword matching)
- `analysis.monthly_savings` already tracks their monthly total
- **Transfer to People** grouped by normalized merchant, shown in Savings tab with long-press to recategorize
- **Claude AI classify endpoint** already exists at `/api/claude` with `action: 'classify'`
- Existing recategorization modal: long-press → category chips + essential/lifestyle toggle → `saveRecategorize()`

---

## Plan

### Phase 1: Split Savings & Surplus into separate variables

**Income Card** (lines ~3186-3204):
- [ ] Compute `savingsTotal` from `analysis.monthly_savings ?? 0`
- [ ] Compute `surplusTotal` = `Math.max(0, income - nonDiscTotal - discTotal - savingsTotal)`
- [ ] Replace single "Savings & Surplus" row with two rows:
  - "Savings" → `savingsTotal` (green)
  - "Surplus" → `surplusTotal` (different color, e.g. `colors.accent` or lighter green)
- [ ] Update border logic (was `idx === 3` for last row, now `idx === 4`)

**Transactions Card** (lines ~3298-3530):
- [ ] Split "Savings" tab into showing two distinct sections:
  - **SAVINGS** section header → savings categories (from `analysis.savings_categories`)
  - **SURPLUS** section header → the unallocated remainder
  - **TRANSFERS TO PEOPLE** section stays as-is
- [ ] Update tab total to still show combined (savings + surplus) so numbers add up
- [ ] Or: consider splitting into two tabs — but likely too crowded. **Decision: keep one tab, two sections.**

### Phase 2: Transfer to People — allow re-categorization of individual items within groups

**Current behavior**: Long-press on a transfer group → recategorizes ALL transactions with that merchant name as a batch.

**New behavior**:
- [ ] When a transfer group is expanded (showing individual transactions), allow long-press on **individual** transactions within the group
- [ ] Wire individual transaction long-press to open the same recategorization modal
- [ ] In `saveRecategorize()`, handle single-transaction moves (vs batch) — use `match_description` scoped to that specific transaction
- [ ] After recategorizing a single tx from a group, remove it from the group and update the group total
- [ ] If group becomes empty after removal, remove the group entirely

### Phase 3: Claude AI-assisted recategorization in transactions card

**Approach**: When a user opens the recategorization modal, show an AI suggestion chip at the top.

**How it works**:
- [ ] The existing `/api/claude` classify endpoint already returns category suggestions
- [ ] Current code already fetches AI suggestions on modal open (lines 585-628) for "Other" transactions
- [ ] Extend this to work for ALL recategorization modals (not just "Other" items)
- [ ] Show suggested category as a highlighted/recommended chip in the modal
- [ ] If Claude already classified it (`classifiedBy: 'claude_ai'`), show that as the suggestion without a new API call
- [ ] For transfer-to-people items, Claude can suggest whether it's actually "Charity", "Rent", "Childcare", etc.

**UI additions**:
- [ ] Add "AI suggested: {category}" label above category chips when suggestion available
- [ ] Auto-select the suggested category chip (user can still change)
- [ ] Add subtle loading state while fetching suggestion

---

## Decisions to Confirm

1. **Surplus color**: Use a distinct color from Savings green? (e.g. blue/accent)
2. **Tab structure**: Keep single "Savings" tab with internal sections vs split into "Savings" + "Surplus" tabs?
3. **AI recategorization scope**: Should we also add a "Categorize all with AI" bulk action button, or just per-transaction suggestions in the modal?

---

## Review
*(to be filled after implementation)*
