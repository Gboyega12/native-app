# Task 1: Dashboard UI reorder — lead with #1 Move

## Problem
The hero carousel leads with weekly budget ("how much can I spend") while the #1 Move
(the actual product value) is hidden behind a swipe. Budget and Transactions are separate
collapsed sections adding visual weight.

## Plan
1. Swap carousel pages: #1 Move → page 1, Weekly Budget → page 2
2. Enhance Move hero card: show monthly + annual impact, effort badge
3. Reverse parallax direction to match new page order
4. Merge Budget + Transactions into single "SPENDING DETAILS" section
5. Clean up dead code (ConnectorDots, txManuallyCollapsed)
6. TypeScript check

## Files
1. `app/(main)/(tabs)/index.tsx` — carousel, sections, imports

## Checklist
- [x] #1 Move renders as page 1 with impact + effort badge
- [x] Weekly Budget renders as page 2
- [x] Parallax reversed (0→10 instead of 10→0)
- [x] Pagination dots animate correctly for new order
- [x] Budget + Transactions merged into "SPENDING DETAILS"
- [x] Budget-only carousel works when no moves exist
- [x] Dead code removed (ConnectorDots, txManuallyCollapsed, connectorDotsRef)
- [x] TypeScript compiles clean
- [x] Walkthrough scroll-to still works (cardPositions)

## Review
Implemented and verified. 10-point subagent verification confirmed no regressions.
All existing functionality preserved — nothing removed, just reframed.

---

# Task 2: Fix Open Banking zero-transaction error

## Problem
New users connecting via Open Banking see "No transactions found in your data. Check the
file format — it should have Date, Description, and Amount columns." when their bank
returns 0 transactions (new account, pending auth). This is a CSV-specific error shown
in the wrong context.

## Root Cause
TrueLayer callback creates header-only CSV (`Date,Description,Amount`) when bank returns
0 transactions. Processing.tsx hits `lineCount <= 1` branch and shows CSV format error
regardless of data source.

## Plan
1. Pass `source` param ('bank' | 'csv') from connect.tsx to processing.tsx
2. Bank + 0 tx: bypass to dashboard (bank IS connected, tx will settle)
3. CSV + 0 tx: show format error (existing behavior)
4. Bank + empty data: show bank-appropriate message
5. Write tests covering the full callback + source param flow

## Files
1. `app/(main)/connect.tsx` — pass source param
2. `app/(main)/processing.tsx` — branch on source
3. `__tests__/callback.test.js` — 18 new tests

## Checklist
- [x] connect.tsx passes source='bank' for Open Banking, source='csv' for uploads
- [x] processing.tsx: bank + header-only CSV → bypass to dashboard
- [x] processing.tsx: bank + empty data → bank-appropriate error message
- [x] processing.tsx: csv + header-only CSV → format error (unchanged)
- [x] PDF uploads still get source='csv' (correct)
- [x] 18 callback tests pass
- [x] Full test suite passes (39/39)
- [x] TypeScript compiles clean

## Review
Root cause fixed. The source param approach is clean — no heuristics or string sniffing.
Tests cover: successful flow, zero-tx scenario, CSV format, error handling, cleanup, and
the processing.tsx branching logic.
