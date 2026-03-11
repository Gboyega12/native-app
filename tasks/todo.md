# Unified Review Modal — Plan v2

## Problems Identified

### P1: "Done" doesn't persist — modal comes back
**Root cause**: `syncInBackground` is raced against an 8-second timeout. If sync takes longer, the modal closes with optimistic UI, but Supabase still has the **old** analysis. On next app open, stale analysis loads, and the modal reappears.

**Additionally**: Optimistic UI filters `tx.merchant || tx.description` against `assignedMerchants`, but the override was saved with the raw description from `group.merchants` — these can mismatch.

**Fix**:
1. Don't close modal until sync actually completes (show "Saving..." state)
2. After sync, refresh analysis from newly written data
3. Remove the 8-second timeout race — let it finish

### P2: Duplicates in modal
**Root causes**:
1. `unresolvedGroups` iterates BOTH `analysis.discretionary` AND `analysis.non_discretionary` — no dedup guard
2. `confidence`/`classifiedBy` fields are optional — cached users (pre-deploy) have `undefined`, causing the filter to exclude ALL transactions (empty modal)
3. `normalizeMerchant` may create different groups than enrichment engine

**Fix**:
1. Dedup transactions by composite key (`date+description+amount`) when collecting
2. Backwards-compatible filter: if `confidence` undefined, include all 'Other' as fallback
3. Use `&&` not `||`: `confidence === 'low' && classifiedBy === 'default'`

### P3: Two banners + two modals = confusing
User sees separate "Fix uncategorised" and "Review transfers" flows. Should be one unified experience.

---

## Design: Unified Review Modal

### Single Banner
```
┌─────────────────────────────────────────────┐
│ ⚠ X items need your input                  │
│ Tap to review                               │
└─────────────────────────────────────────────┘
```
- Count = unresolvedGroups.length + ambiguousTransfers.length
- One tap opens the unified modal

### Unified Modal Layout
```
┌──────────────────────────────────────────┐
│ Review items                        ✕    │
│ Help us get your numbers right           │
│                                          │
│ ─── Progress: 3 of 5 reviewed ───────── │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░           │
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
│ │ │ ✓ John Smith     Sending · £650  │ │ │
│ │ │ [Rent ✓] [Debt] [Own account]    │ │ │
│ │ └──────────────────────────────────┘ │ │
│ │ ┌──────────────────────────────────┐ │ │
│ │ │ Jane Doe       Receiving · £200  │ │ │
│ │ │ [Household] [Income] [Transfer]  │ │ │
│ │ └──────────────────────────────────┘ │ │
│ └──────────────────────────────────────┘ │
│                                          │
│ ┌──────────────────────────────────────┐ │
│ │       ✓ Done (5 reviewed)            │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

---

## UX Polish Spec

### Animation Language (matching codebase patterns)
All animations use vanilla `Animated` API with `Easing.out(Easing.cubic)`.

| Element | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Modal overlay | Fade 0→1 | 320ms | cubic |
| Modal card | Fade 0→1 + translateY 40→0 | 320ms | cubic |
| Modal dismiss | Fade 1→0 + translateY 0→40 | 200ms | cubic |
| Category chip press | Scale 1→0.92→1 | 140ms→210ms | cubic |
| AI suggestion chips | Staggered fade+scale (0.6→1) | 420ms, 50ms stagger | cubic |
| Progress bar fill | Width 0%→N% | 800ms | cubic |
| Progress bar pulse | Opacity 0.6↔0.95 loop | 2000ms | sin (BreathingBar) |
| Completion checkmark | Scale 0→1.2→1 bounce | 300ms | spring |
| Item resolve fade | Opacity + subtle scale | 260ms | cubic |

### Haptic Feedback
| Interaction | Haptic | Function |
|-------------|--------|----------|
| Chip tap (select category) | Light tap | `hapticLight()` |
| Accept All tap | Medium tap | `hapticMedium()` |
| Save complete | Success notification | `hapticSuccess()` |
| Dismiss with unsaved | Warning notification | `hapticWarning()` |
| AI suggestion arrival | Tick | `hapticTick()` |

### Progress Indicator
- **BreathingBar** component reused from Card.tsx
- Shows "X of Y reviewed" text above the bar
- Bar animates width as user categorizes items
- Pulses gently (breathing) when incomplete
- Solid (no pulse) when all reviewed
- Progress = items with a selection / total items

### Smart Category Ordering
Instead of 18 flat chips, show categories intelligently:
1. AI suggestion first (if available), pre-selected with accent border
2. Top 3-4 most likely categories based on merchant type
3. "More..." chip that expands to show remaining categories
4. Keeps cognitive load to 4-5 chips per item (vs 18)

### Dismiss Confirmation
- If user taps ✕ with unsaved selections:
  - `hapticWarning()` fires
  - `Alert.alert("Discard changes?", "You have X unsaved categorisations.", [{text: "Keep editing"}, {text: "Discard", style: "destructive"}])`
- If no selections made: dismiss immediately (no alert)

### Error & Retry State
- On save failure: `Alert.alert("Couldn't save", "Check your connection and try again.")`
- "Done" button stays enabled for retry
- Modal stays open — no data lost

### Completion Celebration
When save succeeds:
1. `hapticSuccess()` fires
2. Button text briefly flashes "✓ Saved!" with checkmark scale-in (300ms spring)
3. 600ms pause to register success
4. Modal fade-out (200ms)

### Backwards Compatibility
```typescript
// Handle cached analysis (pre-deploy) where confidence/classifiedBy undefined
if (tx.confidence !== undefined) {
  if (tx.confidence === 'low' && tx.classifiedBy === 'default') txs.push(tx);
} else {
  // Legacy: include all 'Other' transactions (conservative fallback)
  txs.push(tx);
}
```

### Transaction Dedup Guard
```typescript
const seen = new Set<string>();
// In the collection loop:
const key = `${tx.date}|${tx.description}|${tx.amount}`;
if (seen.has(key)) continue;
seen.add(key);
txs.push(tx);
```

---

## Implementation Checklist

### Phase 1: Structural (fixes + unification)
- [ ] Fix backwards compatibility: handle undefined confidence/classifiedBy
- [ ] Add transaction dedup guard in unresolvedGroups memo
- [ ] Remove `showTransferReview` state — merge into `showReviewModal`
- [ ] Remove 8-second timeout from save — await sync completion
- [ ] Merge `saveCatReview` + `saveTransferReview` → unified `saveReview`
- [ ] Replace two banners with single unified banner
- [ ] Delete separate transfer review modal JSX
- [ ] Rebuild as unified modal with two sections (conditionally shown)

### Phase 2: Animation + Haptics
- [ ] Add modal entrance animation (fade + translateY, 320ms, matching InsightModal)
- [ ] Add modal exit animation (fade + translateY, 200ms)
- [ ] Add category chip press animation (scale 0.92, 140ms)
- [ ] Add AI suggestion staggered reveal (fade+scale, 420ms, 50ms stagger)
- [ ] Add haptic feedback to all interactions per spec
- [ ] Add item resolve visual feedback (subtle scale + opacity)

### Phase 3: Progress + Smart UX
- [ ] Add progress indicator (BreathingBar reuse) with "X of Y" text
- [ ] Implement smart category ordering (AI first, top matches, "More..." expand)
- [ ] Add dismiss confirmation (Alert.alert when unsaved selections exist)
- [ ] Add error state (Alert.alert on save failure, keep modal open)
- [ ] Add completion celebration (hapticSuccess + "✓ Saved!" flash + delayed close)
- [ ] Add bottom safe area padding (SafeAreaView or useSafeAreaInsets)

### Phase 4: Polish + Accessibility
- [ ] Add accessibilityLabel to all interactive elements
- [ ] Add accessibilityRole="button" to chips
- [ ] Add accessibilityState={{ selected }} to category chips
- [ ] Test keyboard dismiss on ScrollView
- [ ] Clean up unused styles/state from old modals
- [ ] Verify no regressions on dashboard layout

---

## Files to Modify
1. `app/(main)/(tabs)/index.tsx` — modal JSX, state, save functions, banner, animations
2. `lib/haptics.ts` — no changes needed (already has all functions)
3. `components/Card.tsx` — no changes (reuse BreathingBar, animation patterns)
4. `theme/index.ts` — no changes (animation tokens already defined)

## Animation Constants Reference
```typescript
// From theme/index.ts — use these, don't create new ones
animation.press.scale    // 0.985 (we'll use 0.92 for chips — smaller target = more feedback)
animation.press.duration // 140ms
animation.entrance.duration // 420ms
animation.entrance.stagger  // 50ms
animation.expand.duration   // 260ms
// Modal timing from InsightModal pattern
MODAL_FADE_IN  = 320  // ms
MODAL_FADE_OUT = 200  // ms
MODAL_SLIDE    = 40   // px translateY
```
