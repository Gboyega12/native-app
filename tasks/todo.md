# Fix Hero Card "Start this Move" + Living Progress Card

## Problem
- "Start this move" button on hero card navigates to chat instead of starting the move
- Once a move is in progress, the hero card should transform to show live progress

## Plan

### Step 1: Fix hero card button to actually start the move
- [ ] **File**: `app/(main)/(tabs)/index.tsx` ~line 1834
- Change `onPress` from `router.push(chat)` to `handleStartMove(originalIndex, move)`
- Need to resolve the index mapping: `dashboardMoves[0]` → original `moves` array index
  - Use `moves.indexOf(dashboardMoves[0])` since filter preserves object references

### Step 2: Transform hero card when move is in progress
- [ ] **File**: `app/(main)/(tabs)/index.tsx` ~lines 1782-1840
- Check if `dashboardMoves[0]` is already approved via `planProgress`
- If in progress, render the "Living Progress" variant:
  - Header: `MOVE IN PROGRESS · Day N` (calculate days since started)
  - Keep move title + impact numbers (evolving: "£X saved so far · £Y target")
  - Progress bar: sub-goals completed / total (or steps completed / total)
  - Social proof nudge: "You're ahead of X% of people on this move"
  - CTA: Next concrete action step → "Next: [step] →"
  - If all done, show completion state

### Step 3: Celebration micro-interaction on start
- [ ] Brief scale pulse animation when card transforms from "start" to "in progress"
- Use existing `LayoutAnimation.configureNext(SMOOTH_ANIM)` + optional Animated scale

### Step 4: Wire progress CTA to scroll to in-progress section
- [ ] "View progress" / next step button scrolls to expanded move card below

### Step 5: Verify
- [ ] Button starts the move (not navigates to chat)
- [ ] Hero card transforms after starting
- [ ] Progress bar reflects sub-goal/step completion
- [ ] Day counter works
- [ ] TypeScript compiles clean
