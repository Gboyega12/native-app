# Task: TrueLayer Flow Recheck + Education Screen Bug Fix

## Problem 1: Education "Next" button stuck on Methods screen

**Root cause:** `education.tsx` uses `onMomentumScrollEnd` to update `currentPage`, but
`scrollTo()` (programmatic scroll) does NOT fire `onMomentumScrollEnd` on web or some
native platforms. Result:

1. User on page 0 (Philosophy), presses Next
2. `scrollTo()` scrolls to page 1 (Methods) — visually correct
3. `onMomentumScrollEnd` never fires — `currentPage` stays 0
4. User presses Next again → `nextPage = 0 + 1 = 1` → scrolls to same page
5. Stuck on Methods forever

**Fix:** Update `currentPage` directly in `handleNext()` alongside the `scrollTo()` call.
Keep `onMomentumScrollEnd` for manual swipe detection.

## Problem 2: TrueLayer connection flow audit

Full flow: connect.tsx → TrueLayer OAuth → callback.js → bank-data.js → processing.tsx → dashboard

### Audit findings:

**Working correctly:**
- [x] Auth URL generation with state encoding (lib/truelayer.ts)
- [x] Token exchange + 12-month transaction fetch (callback.js)
- [x] Bank data CSV generation and storage
- [x] Card/account balance tracking
- [x] Session state save/restore across redirect (web)
- [x] fetchBankData retry loop (4 attempts with backoff)
- [x] Source param ('bank' vs 'csv') passed correctly
- [x] Zero-transaction bypass to dashboard (processing.tsx:201-221)
- [x] Enrichment engine with Claude AI verification
- [x] Move ranking with UKPF flowchart
- [x] Analysis saved to Supabase + score history + achievements
- [x] Dashboard picks up _lastResult in-memory
- [x] Incremental sync (sync.js) with token rotation
- [x] 90-day consent expiry detection
- [x] Debt account sync from card balances
- [x] Sync coordinator deduplication + cooldown

**Minor issues (not blocking):**
- [ ] Empty catch blocks hide errors (bank-data.js:87, sync-coordinator.ts:62)
- [ ] Deduplication normalizes too aggressively (sync.ts:61-74) — could merge legitimately different transactions
- [ ] Debt payment matching uses naive substring (sync.ts:118-125)
- [ ] No rate limiting on parallel TrueLayer API calls
- [ ] Promise.race timeout doesn't cancel background sync (sync-coordinator.ts:46)

**Verdict:** The TrueLayer flow is architecturally sound. No blocking issues found.
The zero-transaction handling added previously works correctly. Edge cases exist but
are unlikely to affect normal users.

## Checklist
- [ ] Fix `handleNext` in education.tsx to update `currentPage` directly
- [ ] Keep `onMomentumScrollEnd` for manual swipe sync
- [ ] TypeScript compiles
- [ ] Document TrueLayer audit findings (above)
