# Income Detection: Frequency-Aware Normalisation & Pending Correlation

**Date:** 2026-03-17
**Status:** Complete

## Problem
Income detection was mathematically imprecise:
1. Per-source `monthly` used `totalIncome / months` (time-span division) instead of frequency-aware multipliers
2. Aggregate `monthlyIncome` inherited the same imprecision
3. Frequency detection bands were too narrow — missed payments shifted by bank holidays or month boundaries
4. No pending-vs-settled transaction correlation — same transaction counted twice
5. No confidence scoring on income sources

## Changes
- [x] Widen frequency detection bands: monthly 24-38d, fortnightly 11-18d, weekly 5-10d
- [x] Require 2+ intervals (3+ transactions) for reliable frequency detection
- [x] Frequency-aware per-source monthly: weekly × 52/12, fortnightly × 26/12, monthly × 1
- [x] Derive aggregate `monthlyIncome` from sum of frequency-aware source monthlies
- [x] Add `annualIncome` field: weekly × 52, fortnightly × 26, monthly × 12
- [x] Add `confidence` field: high/medium/low based on regularity + variability + data points
- [x] Add pending→settled transaction correlation (same merchant, 0-4 days apart, ≤5% amount difference)

## Files modified
- `lib/enrichment-engine.ts` — frequency bands, frequency-aware monthly, pending correlation
- `lib/types.ts` — IncomeSource: annualIncome, confidence fields

---

# Fix Enrichment Pipeline — False P2P, Transfer Override, Income Inflation

**Date:** 2026-03-17
**Status:** Complete

## Changes
- [x] Rewrite `isPersonTransfer` to require known UK first name match (~500 names)
- [x] Guard keyword override when explicit transfer method detected ("faster payment" etc.)
- [x] Add bidirectional transfer detection to income filter
- [x] Person-name gate on income sources (require monthly + low CV + 4+ count)
- [x] Add `isPersonTransfer` guard to Bayesian ensemble
- [x] Expand Eating Out keywords with 25+ cuisine/food terms

## Files modified
- `lib/merchant-db.ts` — COMMON_FIRST_NAMES set, rewritten isPersonTransfer
- `lib/classifier.ts` — expanded Eating Out patterns
- `lib/enrichment-engine.ts` — transfer keyword guard, income filter, ensemble guard

---

# Improve Spending Details — Trends, Hierarchy & Discoverability

**Date:** 2026-03-16
**Status:** Complete

## Changes
- [x] Per-category month-over-month trends (isPreviousMonth helper, prevTotal on period data)
- [x] Overall MoM trend indicator in header (▲/▼ X% vs last month)
- [x] Tiered category list — significant (>5% or ≥3 txs) vs minor (collapsed)
- [x] Attention sorting — categories trending up >20% or over-budget surface first
- [x] Trend badges on category bars in Charts.tsx
- [x] Inline review nudge inside Spending Details card
- [x] Low-confidence transaction "hold to move" hints

## Files modified
- `app/(main)/(tabs)/index.tsx` — all spending details UI changes
- `components/Charts.tsx` — trend badge on CategoryBarRow

---

# Fix: Income Identification & P2P Transfer Classification

**Date:** 2026-03-16
**Status:** Complete

## Problem
1. Annual income showing £180 — nearly all income being excluded
2. P2P transfers blanket-excluded from spending AND income — wrong for bill splits, rent, etc.
3. No way for users to manually recategorise P2P transactions

## Root Cause Analysis

### Income too low (£180 annual = £15/month)
The income filter chain is too aggressive:
- Line 491: `isTransfer: isPerson` — any credit from a person name → `isTransfer=true` → excluded from income
- Lines 700-727: `variability <= 0.5` filter — variable salary (overtime, bonuses) gets dropped
- Together: salary paid via "FASTER PAYMENT FROM JOHN SMITH" gets marked as person transfer → excluded
- Remaining income may only be a small benefit credit → £15/month

### P2P transfers blanket excluded
- Line 491: ALL person-name matches → `isTransfer=true`
- Line 595: spending filter excludes `isTransfer`
- Line 596: income filter excludes `isTransfer`
- Result: rent paid to flatmate, bill split to partner, etc. all invisible

## Plan

### 1. Smarter P2P classification (enrichment-engine.ts)
- [x] Split person transfers into 3 tiers:
  - **Internal transfer**: Same name appears in both credit AND debit person-name transactions → `isTransfer=true`
  - **Outbound P2P (debit)**: Default to spending, category = "Person-to-Person" → `isTransfer=false`
  - **Inbound P2P (credit)**: Don't auto-count as income → `isTransfer=false, isIncome=false`, category = "Person-to-Person"
- [x] Use a 2-pass approach: first pass enriches normally, second pass detects internal transfer pairs

### 2. Fix income identification
- [x] Remove `variability <= 0.5` hard filter on income sources
- [x] Replace with softer approach: salary keywords OR count >= 3 with regular intervals → include regardless of variability
- [x] Only exclude truly erratic credits (1-2 occurrences, no pattern)

### 3. Override support for P2P
- [x] Verify existing `TransactionOverride` system handles P2P descriptions
- [x] When user overrides a P2P transaction, it should clear the `isTransfer` flag

### 4. Annual display fix
- [x] Income calculation upstream is the root cause — fixing income identification fixes the display

## Files to modify
- `lib/enrichment-engine.ts` — P2P classification, income filter, internal transfer detection
