# Task: Deep TrueLayer Flow Recheck + Fixes

## Problem: Line-by-line audit of TrueLayer connection → enrichment → visualization

Full flow traced: connect.tsx → TrueLayer OAuth → callback.js → bank-data.js →
processing.tsx → enrichment-engine.ts → dashboard (index.tsx)

## Bugs Found & Fixed

### 1. Description newline sanitization (callback.js:145, sync.js:135)
**Problem:** TrueLayer descriptions containing `\n` would break CSV format — each newline
creates an extra malformed row. Only commas were stripped, not newlines.
**Fix:** Added `.replace(/[\r\n]+/g, ' ')` to description sanitization in both files.

### 2. Aggressive deduplication (sync.js:308-317, sync.js:342-365, sync.ts:61-74)
**Problem:** Set-based dedup collapsed legitimate duplicate transactions (e.g., two £3.50
coffees at Costa on the same day) into one. Any transaction with the same date+description+amount
was treated as a duplicate.
**Fix:** Count-based dedup — keep `max(count_source_a, count_source_b)` per key. This
preserves legitimate duplicates within one account while still merging the same transaction
appearing across multiple accounts. Applied to:
- Per-connection CSV merge (sync.js: existing stored CSV + new 30-day sync)
- Cross-connection CSV merge (sync.js: combining all connections)
- Fallback CSV merge (sync.ts: loading cached data from multiple bank_data rows)

### 3. Silent error swallowing (bank-data.js:87)
**Problem:** Empty `catch {}` block hid errors during account_type derivation and old
connection cleanup. If the DB was down or query had issues, no diagnostics logged.
**Fix:** Added `console.warn` with error message.

## Audit: What's Working Correctly

### Connection (truelayer.ts → connect.tsx → callback.js)
- [x] Auth URL with scopes: accounts, balance, transactions, cards
- [x] State encoding: connectionId|origin for redirect
- [x] Token exchange: authorization_code grant
- [x] 12-month transaction fetch (accounts + cards in parallel)
- [x] CSV conversion: CREDIT→positive, else→negative
- [x] Bank data storage with refresh_token, provider_name, account_type
- [x] Card/account balance tracking (overdraft detection)
- [x] Old connection cleanup per provider

### Processing (processing.tsx → enrichment-engine.ts)
- [x] Source param ('bank' vs 'csv') correctly distinguishes error messages
- [x] Zero-transaction bypass to dashboard for bank connections
- [x] CSV parsing: flexible header detection (date, desc/narr/memo, amount/debit/credit)
- [x] Date parsing: YYYY-MM-DD, DD/MM/YYYY, named dates
- [x] Transaction filtering: 1-year cutoff, zero amounts, empty descriptions
- [x] Rejection logging for debugging zero-tx scenarios
- [x] Multi-stage enrichment: user overrides → merchant DB → fuzzy match → keyword → default
- [x] Credit card full-payer detection (prevents double-counting)
- [x] Claude AI classification for low-confidence transactions (batches of 25)
- [x] Move ranking with UKPF flowchart + goal trajectories
- [x] Analysis saved to Supabase + score history + achievements

### Sync (sync.js → sync.ts → sync-coordinator.ts)
- [x] Token rotation: new refresh_token persisted BEFORE data fetches
- [x] 30-day incremental window with retry on TrueLayer endpoint failure
- [x] Consent expiry: 90-day window from created_at (not updated_at)
- [x] Fallback to stored CSV if TrueLayer sync fails
- [x] Re-enrichment of merged data
- [x] Debt account sync from card balances
- [x] Reactive engine for feedback loop

## Checklist
- [x] Newline sanitization added to callback.js and sync.js
- [x] Count-based dedup in sync.js per-connection merge
- [x] Count-based dedup in sync.js cross-connection merge
- [x] Count-based dedup in sync.ts fallback merge
- [x] Logging added to bank-data.js catch block
- [x] TypeScript compiles clean
- [x] 39/39 tests pass

## Review
Three real bugs fixed. The core TrueLayer flow is architecturally sound — token
management, error handling, fallback paths, and enrichment pipeline all work correctly.
The dedup fix is the most impactful: users with repeated purchases at the same merchant
for the same amount on the same day were losing transactions.
