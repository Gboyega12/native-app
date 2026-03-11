# Unified Review Modal — Plan

## Problems Identified

### P1: "Done" doesn't persist — modal comes back
**Root cause**: The override matching in `enrichTransaction()` uses `descLower.includes(pattern)` where `pattern` is the raw merchant name saved as `match_description`. But `match_description` is saved from `group.merchants` — which are **raw transaction descriptions** like `"CARD PAYMENT TO TESCO STORES 1234 ON 05 MAR"`. During re-enrichment, `descLower` is the full description, and `pattern` is also the full description lowercased — so `includes()` should match.

BUT: the background `syncInBackground` is raced against an 8-second timeout. If the sync takes longer, the modal closes with optimistic UI, but the Supabase `analyses` table still has the **old** analysis. On next app open/loadData(), the stale analysis is loaded, and the modal reappears as if nothing was saved.

**Additionally**: The optimistic UI update (lines 608-628) filters `tx.merchant || tx.description` against `assignedMerchants`. But `TransactionDetail.merchant` was set by the enrichment engine as `tx.merchant || tx.description` — so it might be the enriched merchant name, not the raw description. The override was saved with the raw description from `group.merchants`. These could mismatch.

**Fix**:
1. Don't close modal until sync actually completes (show "Saving..." state throughout)
2. After sync, refresh analysis from the newly written data rather than relying on optimistic update
3. Remove the 8-second timeout race — let it finish

### P2: Duplicates in modal
**Root causes**:
1. `normalizeMerchant()` in the modal runs on `tx.merchant` (enriched merchant name), but the enrichment engine may have already normalized differently — creating groups that don't match the DB-level merchant
2. The `confidence`/`classifiedBy` fields I added are **optional** on TransactionDetail. For users with cached analysis (before this deploy), those fields are `undefined`. The filter `tx?.confidence === 'low' || tx?.classifiedBy === 'default'` would exclude ALL transactions for cached users — the modal would be empty, not duplicated. But for fresh enrichment, these fields should be populated.
3. The real duplicate issue is likely that `normalizeMerchant` was previously too weak — raw descriptions like `"TESCO STORES 1234"` and `"TESCO STORES 5678"` created separate groups. My improvement to strip 4+ digit suffixes helps, but lowercasing might cause display issues.

### P3: Two separate banners + two separate modals = confusing
User sees "X uncategorised transactions — Fix now" AND "Y recurring transfers need clarification — Review" as two separate banners with two separate flows. Should be one unified experience.

---

## Design: Unified Review Modal

### Single Banner
```
┌─────────────────────────────────────────────┐
│ ⚠ X items need your input                  │
│ Tap to review                               │
└─────────────────────────────────────────────┘
```
- Combines: uncategorised transactions + ambiguous transfers
- Count = unresolvedGroups.length + ambiguousTransfers.length
- One tap opens the unified modal

### Unified Modal Layout
```
┌──────────────────────────────────────────┐
│ Review items                        ✕    │
│ Help us get your numbers right           │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │ UNCATEGORISED (3)                    │ │
│ │                                      │ │
│ │ ┌──────────────────────────────────┐ │ │
│ │ │ Costa Coffee        2 txns · £14 │ │ │
│ │ │ [Coffee ✓] [Eating Out] [Other]  │ │ │
│ │ │                    Bocy suggested │ │ │
│ │ └──────────────────────────────────┘ │ │
│ │ ┌──────────────────────────────────┐ │ │
│ │ │ ACME LTD            1 txn · £200 │ │ │
│ │ │ [Shopping] [Insurance] [Other]...│ │ │
│ │ └──────────────────────────────────┘ │ │
│ │                                      │ │
│ │ RECURRING TRANSFERS (2)              │ │
│ │                                      │ │
│ │ ┌──────────────────────────────────┐ │ │
│ │ │ ✓ John Smith     Sending · £650/mo│ │ │
│ │ │ [Rent ✓] [Debt] [Own account]    │ │ │
│ │ └──────────────────────────────────┘ │ │
│ │ ┌──────────────────────────────────┐ │ │
│ │ │ Jane Doe       Receiving · £200/mo│ │ │
│ │ │ [Household] [Income] [Transfer]  │ │ │
│ │ └──────────────────────────────────┘ │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │         Done (4 reviewed)            │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

### Key UX decisions:
1. **Section headers** — "UNCATEGORISED" and "RECURRING TRANSFERS" in small caps, with counts
2. **Either section can be empty** — if no uncategorised items, only transfers show (and vice versa)
3. **AI suggestions pre-applied** — spinner at top while loading, then chips show with suggestions already selected
4. **Accept All button** — appears after AI finishes suggesting, saves everything in one tap
5. **"Done" saves both** — single save function handles both category overrides AND transfer classifications
6. **Saving state** — "Done" button shows spinner and text "Saving..." until sync actually completes (no premature close)
7. **No 8-second timeout** — wait for sync to finish. If it fails, show error toast and keep modal open

### Save flow (unified):
```
User taps "Done"
  → Button shows "Saving..." with spinner
  → Save category overrides to transaction_overrides (batch)
  → Save transfer overrides to transaction_overrides (batch)
  → Trigger syncInBackground(userId, true) — NO timeout race
  → On success: close modal, analysis auto-refreshes from sync result
  → On failure: show error toast, keep modal open, let user retry
```

### Backwards compatibility for confidence/classifiedBy:
The filter for unresolved groups should handle cached analysis (where these fields are undefined):
```typescript
// If confidence/classifiedBy present → use them to filter
// If absent (old cached data) → include all 'Other' transactions (safe fallback)
if (tx.confidence !== undefined) {
  // New enrichment: only show truly unclassifiable
  if (tx.confidence === 'low' && tx.classifiedBy === 'default') txs.push(tx);
} else {
  // Legacy cached data: show all 'Other' (conservative)
  txs.push(tx);
}
```

---

## Implementation Checklist

### State changes
- [ ] Remove `showTransferReview` state — merge into `showCatReview` (rename to `showReviewModal`)
- [ ] Remove `transferAssignments` as separate state — merge into unified `reviewAssignments` OR keep both but save together
- [ ] Single `showReviewModal` boolean controls the unified modal
- [ ] Single banner that combines both counts

### Banner
- [ ] Replace two separate banners with one unified banner
- [ ] Count = unresolvedGroups.length + ambiguousTransfers.length
- [ ] Only shows when count > 0

### Modal JSX
- [ ] Delete the separate transfer review modal
- [ ] Rebuild the categorisation modal as unified with two sections
- [ ] Section headers: "UNCATEGORISED (N)" and "RECURRING TRANSFERS (N)"
- [ ] Conditionally show each section (hide if empty)
- [ ] Transfer items show direction label + frequency-based amount + type chips
- [ ] Category items show merchant + count + amount + category chips

### Save function
- [ ] Merge `saveCatReview` and `saveTransferReview` into single `saveReview`
- [ ] Remove 8-second timeout — await sync completion fully
- [ ] Show "Saving..." state on Done button until sync finishes
- [ ] On sync failure: show error, keep modal open
- [ ] On sync success: close modal (analysis auto-updates via sync result)

### Duplicate fix
- [ ] Fix backwards compatibility: handle undefined confidence/classifiedBy for cached analysis
- [ ] Use `&&` not `||` for filter: `confidence === 'low' && classifiedBy === 'default'`

### Cleanup
- [ ] Remove unused styles for the old transfer review modal (if any unique ones)
- [ ] Remove unused state declarations
- [ ] Update tracking events to reflect unified modal

---

## Files to modify
1. `app/(main)/(tabs)/index.tsx` — modal JSX, state, save functions, banner
2. `lib/types.ts` — no changes needed (already updated)
3. `lib/enrichment-engine.ts` — no changes needed (already preserves confidence/classifiedBy)
