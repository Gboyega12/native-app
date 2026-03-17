# Decision Engine: Seamless Categorization

**Date:** 2026-03-17
**Status:** Planning

---

## Problem Audit

Current categorization requires **5-7 taps per transaction**:
1. Tap amber banner → opens review modal
2. Scroll to find transaction in list
3. Tap category from horizontal chip scroller
4. Tap Essential/Lifestyle toggle
5. Repeat for every uncategorized transaction
6. Tap "Save all"

**Root causes of friction:**
- AI classify runs AFTER modal opens (reactive, not proactive)
- No learning loop: user corrects "Tesco Express" once, but "TESCO EXPRESS LONDON GB" stays uncategorized
- Enrichment pipeline has NO Claude AI step — goes straight from merchant-db/keywords to "Other"
- Review modal dumps ALL uncategorized at once (overwhelming with 20+ items)
- No swipe gestures — everything is tap-tap-tap
- No confidence tiers in UX — high-confidence AI suggestions treated same as wild guesses

**Pipeline gap:** `enrichTransaction()` goes merchant-db → fuzzy → keywords → "Other". Claude AI is only called on-demand when review modal opens. This means 20-35% of transactions sit as "Other" until the user manually intervenes.

---

## Plan: Zero-Tap Categorization Engine

### Phase 1: AI-first enrichment (biggest impact, ~80% reduction in uncategorized)

Add Claude AI as step 4 in `enrichTransaction()` pipeline, before the "Other" fallback:

1. Collect all transactions that would become "Other" after merchant-db + fuzzy + keyword passes
2. Batch-classify them via `/api/claude` classify endpoint (already exists, uses Haiku)
3. Insert results with `confidence: 'medium'`, `classifiedBy: 'claude_ai'`
4. Only transactions where AI also returns low confidence become "Other"

**Files:**
- `lib/enrichment-engine.ts` — add AI classify step in `enrichTransaction()` or post-enrichment batch
- `api/enrich.ts` — wire the AI classify call into the enrichment flow
- `api/claude/index.ts` — already exists, may need batch size optimization

### Phase 2: Swipe-to-confirm review (UX speed, ~10x faster)

Replace tap-heavy review modal with swipe gestures:

1. Each review row becomes swipeable:
   - **Swipe right** = accept AI suggestion (one gesture, done)
   - **Swipe left** = reject → slides open category picker inline
2. Add "Accept all AI suggestions" button at top of review modal
3. Animate rows out on accept (satisfying feedback)

**Files:**
- `app/(main)/(tabs)/index.tsx` — review modal rows (lines ~3838-3900)
- New: `react-native-gesture-handler` Swipeable or custom PanResponder

### Phase 3: Override propagation (learning loop)

When user overrides one transaction, auto-apply to ALL matching merchants:

1. After `saveRecategorize()`, find all "Other" transactions with same normalized merchant
2. Auto-recategorize them in the UI immediately (optimistic)
3. Store override with fuzzy matching tolerance (not just exact)
4. On next enrichment, overrides catch ALL variants of that merchant

**Files:**
- `app/(main)/(tabs)/index.tsx` — `saveRecategorize()` + `saveReviewChanges()`
- `lib/enrichment-engine.ts` — override matching with fuzzy tolerance

### Phase 4: Confidence-based progressive disclosure

Different UX treatment based on confidence level:

| Confidence | Source | UX Treatment |
|-----------|--------|-------------|
| High | merchant-db, user override | Auto-categorized, no review |
| Medium | claude_ai, fuzzy_match | Show as "suggested" — one-tap accept |
| Low | default fallback | Full category picker (current) |

**Result:** User only manually picks categories for ~5% of transactions.

**Files:**
- `app/(main)/(tabs)/index.tsx` — review modal rendering
- `lib/enrichment-engine.ts` — confidence thresholds

---

## Implementation Order

**Phase 1 → 2 → 3 → 4**

Phase 1 eliminates the problem at the source. Phase 2 makes the remaining review fast. Phase 3 makes corrections stick. Phase 4 is polish.

---

## Decisions

1. **Phase 1 batching**: Classify "Other" transactions in one batch call at end of enrichment (not per-tx) — cheaper, faster
2. **Swipe library**: Use `react-native-gesture-handler` Swipeable (already likely in deps via navigation)
3. **Override propagation scope**: Apply to same normalized merchant only (not fuzzy across different merchants)
