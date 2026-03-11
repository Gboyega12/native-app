# Critical Bug Fix Plan — Dashboard Issues

## Summary

5 interrelated issues traced to root causes. Ordered by severity and dependency.

---

## Issue 1: Banners persist after manual classification

**Symptom**: "75 uncategorised transactions. Fix now" and "2 recurring transfers need clarification. Review" remain visible after the user classifies items in the modal.

**Root cause**: Race condition + stale-check bypass.

1. **`syncInBackground` is fire-and-forget** (not awaited). The previous fix added `force: true`, which correctly bypasses the 30-second cache in `sync-coordinator.ts:42`. BUT the enrichment runs asynchronously. If the user navigates away before it completes, `useFocusEffect` at `index.tsx:847` calls `invalidateSyncCache()` then `loadData()`, which re-fetches from Supabase — where the OLD analysis still sits because the re-enrichment hasn't finished writing back yet.

2. **`setAnalysis` comparison is too aggressive** (`index.tsx:1234-1259`). Even when enrichment completes, if the 4 top-level numbers (income, spending, surplus, score) haven't changed, the fresh analysis is dropped. Our last fix added `otherCount()` comparison — this is correct but may not fire if the sync hasn't completed yet.

**Fix approach**:
- Don't just fire-and-forget. After saving overrides, **await** the sync and update analysis atomically before closing the modal. Show a brief "Applying changes..." state on the button while it completes.
- The optimistic update is a belt; the awaited sync is the suspenders. Both must work.
- Fallback: if sync takes >5s, close modal with optimistic update and let background sync catch up.

**Files**: `app/(main)/(tabs)/index.tsx` (saveCatReview ~551, saveTransferReview ~629)

---

## Issue 2: Credit card data showing £0 balance / £0 minimum / 0 months

**Symptom**: Move card: "Pay £0 to Credit Card — clear £0 in 0 months". Math box: "Credit Card minimum: £0/mo".

**Root cause**: Three compounding issues:

1. **`debt_accounts` table has no `minimum_payment` or `interest_rate` populated from TrueLayer**. In `api/truelayer/callback.js:244-252`, card balances are saved with `balance`, `limit`, `available` — but TrueLayer doesn't provide minimum payment or APR in the balance endpoint. The `minimum_payment` and `interest_rate` columns exist in the schema but are only populated via manual chat input.

2. **When `minimum_payment` is 0/null, snowball math breaks**. At `enrichment-engine.ts:1334`, `smallestMin = Math.round(smallestDebt?.minimum_payment || 0)` → 0. Then `realPayment = Math.min(0 + surplus, balance)`. If balance is also 0 (or null from TrueLayer), everything collapses to £0.

3. **Balance might be genuinely 0 for a fully-paid card**. TrueLayer returns `current: 0` for cards paid off. But the card still has a `credit_limit`, so utilisation is `0/limit = 0%`. The issue is that a £0-balance card shouldn't generate a debt payoff move at all.

**Fix approach**:
- **Filter out £0-balance debts** from the snowball calculation in `genDecisionStack`. A card with £0 outstanding isn't a debt to clear.
- **Estimate minimum payment** when not provided: use industry standard ~2-3% of balance, minimum £25 (or the full balance if < £25). Add this as a fallback in `genDecisionStack` when `minimum_payment` is null/0 but `outstanding_balance` > 0.
- **Don't generate debt moves for £0 balances**.
- **Filter £0-balance debts from sub-goals** so the checklist doesn't show "Credit Card — £0 left, completed".

**Files**: `lib/enrichment-engine.ts` (genDecisionStack ~1296-1375), `api/truelayer/callback.js` (~244)

---

## Issue 3: Move card CTA shows user's name instead of card brand

**Symptom**: "Next: clear Emmanuel Adegboyega Ademosu (£4 left)" instead of "Next: clear Capital One (£4 left)". Debt checklist shows "EMMANUEL ADEMOSU" as account names.

**Root cause**: TrueLayer's `card.display_name` returns the **cardholder's name**, not the card product. In `api/truelayer/callback.js:247`:

```js
name: r.card.display_name || r.card.provider?.display_name || 'Card'
```

`r.card.display_name` = "Emmanuel Ademosu" (cardholder) — wins over `r.card.provider?.display_name` = "Capital One" (bank).

This propagates:
- → `bank_data.card_balances[].name` = "Emmanuel Ademosu"
- → `debt_accounts.account_name` = "Emmanuel Ademosu" (via sync.ts:543)
- → `debtDisplayName()` tries `extractCreditCardBrand("Emmanuel Ademosu")` → no match → falls through to `d.account_name` → "Emmanuel Ademosu"
- → Move action: "Pay £0 to Emmanuel Ademosu"
- → SubGoal target: "Emmanuel Ademosu"
- → CTA: "Next: clear Emmanuel Ademosu"

**Fix approach**:
- **Flip the priority** in `callback.js:247`: prefer `r.card.provider?.display_name` (the bank name) over `r.card.display_name` (cardholder name).
- **Also use `r.card.card_network`** (Visa/Mastercard/Amex) as fallback.
- **In `debtDisplayName()`**, add person-name detection: if `account_name` matches a person-name pattern, skip it and fall through to `account_type` label.
- **Backfill existing data**: In `sync.ts:540-558` (step 10), when syncing card balances from `bank_data`, also use the flipped priority. The next sync will fix the names in `debt_accounts`.

**Files**: `api/truelayer/callback.js` (line 247), `lib/enrichment-engine.ts` (debtDisplayName ~63-69), `lib/sync.ts` (line 543)

---

## Issue 4: Person-to-person transactions invisible

**Symptom**: Transfers to/from individuals don't show up anywhere — not in budget categories, not in "uncategorised transactions", completely invisible.

**Root cause**: When `isPersonTransfer(description)` returns true, the transaction gets `isTransfer: true`. Then:

1. `buildProfile` at `enrichment-engine.ts:575`: `spending` filter = `!t.isTransfer` → **excluded**
2. `buildProfile` at `enrichment-engine.ts:576`: `income` filter = `!t.isTransfer` → **excluded**
3. Neither `discretionary.items` nor `non_discretionary.items` contain the transaction
4. `unresolvedGroups` useMemo (`index.tsx:474`) only scans `discretionary`/`non_discretionary` for "Other" items
5. Person transfers are in **neither section** → completely invisible
6. The `transfers[]` field we added to `FinancialProfile` stores them but nothing in the UI reads it yet

Additionally, `isPersonTransfer` has false negatives:
- Names with reference numbers ("JOHN SMITH REF 123") → digits → returns `false` at line 559
- Single-word names ("JOHNSON") → only 1 word → returns `false`
- Names with bank prefixes ("MOBILE-JOHN SMITH") → not cleaned → returns `false`

**Fix approach**:
- **Include person transfers in the categorisation modal**. When building `unresolvedGroups`, also scan the `transfers` array (or the raw enriched transactions where `isTransfer: true`). These need to appear alongside "Other" items so users can reclassify them.
- **Persist `transfers` to Supabase**: Add to the `fields` object in `sync.ts:462` so they survive session reload.
- **Improve `isPersonTransfer`**: Strip more bank prefixes (MOBILE-, BGC-, FPO-, STO-) and trailing reference numbers before name matching.

**Files**: `lib/enrichment-engine.ts` (buildProfile), `lib/merchant-db.ts` (isPersonTransfer ~534), `app/(main)/(tabs)/index.tsx` (unresolvedGroups ~474), `lib/sync.ts` (fields ~462)

---

## Issue 5: "DATA FROM 1D AGO (CACHED)"

**Symptom**: Dashboard header shows stale data indicator.

**Root cause**: TrueLayer sync fell back to cached CSV. At `sync.ts:280`, when API call fails, `dataSource = 'fallback'` and cached `bank_data.csv_data` is used.

The display at `index.tsx:1755-1757`:
```
syncDataSource === 'fallback' && latestTxDate
  ? `Data from ${formatTxDateAge(latestTxDate)} (cached)`
  : `Synced ${formatTimeAgo(lastSynced)}`
```

Possible causes: expired TrueLayer consent (90 days), transient API failure, or rate limiting.

**Fix approach**:
- **When data is >24h stale, escalate** to a reconnect prompt — don't just show the passive "cached" text. Currently transient failures don't trigger the reconnect banner (`index.tsx:1133-1138`).
- **Force-sync on next app foreground when `dataSource === 'fallback'`** — the current `loadData` at line 1076 calls `syncInBackground(user.id)` without `force`, so it may hit the 30s cache and never retry.
- **Add retry with backoff for transient failures** — if the first sync fails, schedule a retry in 30s rather than waiting for the next user-initiated action.

**Files**: `app/(main)/(tabs)/index.tsx` (~1076, ~1133-1157), `lib/sync.ts` (~280)

---

## Implementation Order

1. **Issue 3** (CTA name) — smallest blast radius, biggest UX win, independent
2. **Issue 2** (£0 debt data) — fixes broken move card, needs Issue 3 for correct names
3. **Issue 4** (invisible transfers) — most impactful for data completeness
4. **Issue 1** (banner persistence) — reliability fix
5. **Issue 5** (stale data) — may need user's TrueLayer connection investigated

## Verification Checklist

- [ ] Debt move card shows card brand name (Capital One, Amex) not user's name
- [ ] £0 balance cards don't generate debt payoff moves
- [ ] Minimum payment estimated when not provided by TrueLayer
- [ ] Person transfers appear in categorisation modal for user review
- [ ] Banners disappear reliably after classification (no race condition)
- [ ] Stale data prompts reconnect when >24h old
- [ ] TypeScript compiles
- [ ] No regressions in existing override/enrichment flow
