# Fix: Review Modal Buttons + Person-to-Person Transfer Detection

## Root Cause Analysis

### Bug 1: Person-to-person transfers not detected
**Root cause:** `ambiguous_transfers` is computed by the enrichment engine but **never persisted to the database**. In `sync.ts:463-480`, the `fields` object omits `ambiguous_transfers`, `essential_gaps`, and `verified_bills` — so they're lost after the sync function returns. When the dashboard reads `analysis.ambiguous_transfers`, it's always `undefined` → the `useMemo` at `index.tsx:339` falls back to `[]`.

**Fix:** Add the three missing fields to the `fields` object in sync.ts so they're persisted alongside everything else.

### Bug 2: "Done" button does nothing
**Root cause:** The Done button at `index.tsx:3398` has `disabled={savingReview || totalReviewed === 0}`. When the user hasn't made any assignments yet (`totalReviewed === 0`), the button is visually dimmed and non-interactive. The user sees "Done" but can't tap it. This is by-design (can't save empty), but there's no way to **close** the modal without using the tiny X button. The Done button should still close the modal when nothing is selected — not just sit there disabled.

**Fix:** When `totalReviewed === 0`, Done should close the modal (dismiss) instead of being disabled.

### Bug 3: Cancel (X) button doesn't work
**Root cause:** The cancel button code at `index.tsx:3202-3213` is syntactically correct — it calls `setShowReviewModal(false)`. However, the `<Modal>` at line 3188 is **missing `onRequestClose`**, which means on Android the hardware back button won't close it. Additionally, the overlay (`catReviewOverlay`) is not a `Pressable`, so tapping outside the modal content does nothing. If users are tapping the dark area expecting it to close, nothing happens — they think it's broken.

**Fix:** Add `onRequestClose` to the Modal. Make overlay tappable to dismiss.

---

## Plan

### Step 1: Persist ambiguous_transfers to database
- [ ] Add `ambiguous_transfers`, `essential_gaps`, `verified_bills` to `fields` object in `sync.ts:463-480`

### Step 2: Fix Done button — allow dismiss when nothing selected
- [ ] When `totalReviewed === 0`, Done button closes modal instead of being disabled
- [ ] Keep disabled state only while `savingReview` is true

### Step 3: Fix Cancel/X and overlay dismiss
- [ ] Add `onRequestClose` prop to the review Modal
- [ ] Make overlay background tappable to dismiss (with unsaved-changes guard)

### Step 4: Verify
- [ ] TypeScript compiles cleanly
- [ ] Review all changes for correctness
