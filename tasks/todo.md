# Fix: Processing screen dead-end when enrichment finds 0 transactions

## Problem
When TrueLayer returns transactions that all get filtered out by the enrichment engine
(amount=0, empty descriptions, pending auths), the user is stuck on the processing
screen with "No transactions found" and can never reach the dashboard.

The dashboard also has no recovery: it only triggers sync when an analysis already exists,
creating a chicken-and-egg problem.

## Plan

### Layer 1: Processing screen — don't dead-end (processing.tsx:199-208)
When enrichment returns 0 transactions and user came from TrueLayer (not CSV upload):
- Navigate user to dashboard with a "pending" flag
- Bank data + refresh_token already saved by callback.js — transactions will settle

### Layer 2: Dashboard — handle "bank connected, no analysis" state (index.tsx)
In loadData (line 910-956):
- Also check if user has bank_data row with valid refresh_token
- If bank connected but no analysis: show "processing" state, not "connect your bank"
- Trigger syncInBackground even when no analysis exists (remove guard at line 954)

In empty state UI (line 1626-1638):
- Split into: "no bank" → connect CTA; "bank connected" → processing indicator + auto-retry

### Layer 3: sync.ts — don't silently return null (line 320)
When enrichment returns 0 transactions:
- Return partial result with `connectionIssues: ['no_transactions_yet']`
- Don't create fake analysis — just signal the state

### Layer 4: Enrichment engine — log rejection reasons (enrichment-engine.ts:150-170)
- Count rejections by reason (date old, amount=0, empty desc)
- Log summary for debugging

## Files
1. `app/(main)/processing.tsx` — lines 199-208
2. `app/(main)/(tabs)/index.tsx` — lines 910-956, 1626-1638, 981-1078
3. `lib/sync.ts` — line 320
4. `lib/enrichment-engine.ts` — lines 150-170

## Checklist
- [ ] Processing screen bypasses dead-end when bank is connected
- [ ] Dashboard shows "processing" state when bank connected but no analysis
- [ ] Dashboard auto-retries sync when in "processing" state
- [ ] sync.ts returns partial result instead of null
- [ ] Enrichment engine logs rejection reasons
- [ ] No regressions: normal flow, pull-to-refresh, CSV upload still work
- [ ] TypeScript compiles
