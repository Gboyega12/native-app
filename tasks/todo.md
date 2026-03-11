# Fix Product Regressions — Enrichment, Moves, Modal, Writing Style

## Problem Summary
1. Enrichment engine not working properly
2. Modal has 2 major buttons (Accept All + Done) — should just be uncategorised items + Done
3. Debt + subscription optimisations disappeared when savings was added
4. Insights not actionable ("savings momentum declined")
5. Writing style uses dashes — not human
6. Product feels downgraded

## Plan

### Step 1: Simplify the Review Modal
- [x] Remove "Accept all AI suggestions" button entirely
- [x] AI suggestions auto-apply silently (already done in processing.tsx)
- [x] Keep: uncategorised items + category chips + Done button only

### Step 2: Fix Writing Style — Remove Dashes
- [x] Replace all em-dashes (—) in hardcoded move text with natural language
- [x] Add rule in Claude enrich prompt: no em/en-dashes
- [x] Fix trajectory insight text

### Step 3: Make Savings Consistency Move Actionable
- [x] Replace "Savings momentum declining" with concrete action
- [x] Same for erratic savings

### Step 4: Verify Debt/Subscription Moves Still Generated
- [x] Code review confirms genDecisionStack still generates all move types
- [x] rankMoves diversity enforcement is intact
- [x] No changes needed — moves were never removed

### Step 5: Commit and Push
- [ ] Commit all changes
- [ ] Push to feature branch
