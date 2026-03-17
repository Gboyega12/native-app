# Decision Engine: Seamless Categorization

**Date:** 2026-03-17
**Status:** In Progress

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

### Phase 1: AI-first enrichment — DONE

- [x] Export `classifyTransactionsBatch()` from `api/claude/index.ts` for server-side use
- [x] Add `rebuildFromEnriched()` to `EnrichmentEngine` for post-classification rebuild
- [x] Wire batch AI step into `api/enrich.ts` between enrichment and move ranking
- [x] Deduplicate by normalized description to minimize API calls (max 50)
- [x] Best-effort: AI failures don't break enrichment pipeline
- [x] Model upgraded from Haiku to Sonnet 4.6 for better accuracy

### Phase 2: Confirm-first review UI — DONE

- [x] Add `aiSuggestedGroups` memo to collect `classifiedBy: 'claude_ai'` transactions
- [x] Two-section modal: "AI CATEGORISED" (confirm list) + "UNCATEGORISED" (chip picker)
- [x] "Accept all" button for one-tap confirmation of AI suggestions
- [x] Individual confirm/reject per row with inline category picker
- [x] Banner messaging: accent-colored "X AI-categorised items to confirm"
- [x] Unified save logic for AI confirmed, AI overridden, and manually categorized items

### Phase 3: Override propagation (learning loop) — DONE

- [x] `findMatchingTransactions()` helper: scans entire analysis for normalized merchant matches
- [x] `saveRecategorize()`: propagates override to ALL transactions with same normalized merchant across every category
- [x] `saveRecategorize()`: saves overrides for every merchant name variant (not just the tapped one)
- [x] `saveReview()`: propagates overrides to all merchant variants found in analysis
- [x] `saveReview()`: optimistic UI uses normalized matching to move ALL variants
- [x] `enrichTransaction()`: enhanced override matching with normalised-to-normalised comparison
- [x] Minimum 3-char normalised pattern threshold prevents overly broad matches

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
2. **Phase 1 model**: Sonnet 4.6 (upgraded from Haiku for better classification accuracy)
3. **Phase 2 UX**: Confirm-first list with "Accept all" (chosen over swipe cards — simpler, faster for many items)
4. **Override propagation scope**: Apply to same normalized merchant only (not fuzzy across different merchants)
5. **Phase 3 matching**: Normalised-to-normalised substring matching with 3-char minimum to prevent false positives
