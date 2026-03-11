# Fix: Transfer Visibility, Debt Prioritisation, Rent Detection, Modal UX

## Root Cause Analysis

### Bug 1: Person-to-person transfers not visible anywhere
**Root cause (multi-layered):**
- Layer 1 (FIXED): `ambiguous_transfers`, `essential_gaps`, `verified_bills` not persisted to DB in sync.ts
- Layer 2: `person_transfers` is persisted but **never rendered** in the UI. The only visible section is "RECURRING TRANSFERS" (`ambiguous_transfers`) which requires 3+ transactions from the same person with consistent frequency and <15% CV. Irregular or infrequent inflows vanish completely.
- Layer 3: For inflows specifically, the classification IS correct (`isTransfer: true` at line 398 when `isPerson` is true), but the 3+ threshold in `detectAmbiguousTransfers` filters them out.

**Fix:** Show `person_transfers` in the review modal as a third section ("PERSON TRANSFERS") for any person transfers not already covered by `ambiguous_transfers`. This gives users visibility into ALL person transfers, even one-off or irregular ones.

### Bug 2: Debt not prioritised / LAMU engine not surfacing debt moves
**Root cause:** The debt move in `genDecisionStack` (line 1332) requires `actualDebtCount >= 1` where `actualDebtCount = Math.max(m.debtAccountCount, activeDebts.length)`.
- `m.debtAccountCount` (line 714) counts unique merchants from transactions flagged `isDebt` — but a connected debt account (TrueLayer credit card) may not have matching transactions classified as `isDebt` if the payment descriptions don't match debt keywords.
- `activeDebts` comes from the `debt_accounts` table, which is populated from TrueLayer balance data. But the `debtAccountsData` query at sync.ts:339 filters `eq('source', 'truelayer')` — if the account was connected but the balance sync failed or the account type wasn't identified as debt, `activeDebts` is empty.

**Fix:** Check the debt_accounts query and ensure TrueLayer credit card accounts are correctly identified and synced to the `debt_accounts` table. Also, ensure `reconcileDebtPayments` correctly marks transactions for connected credit cards.

### Bug 3: Rent not identified (private landlord)
**Root cause:** When rent is paid to a person name (e.g., "JOHN SMITH"), it gets `category: 'Transfers'` and `isTransfer: true`. The system doesn't know it's rent — that's what the `ambiguous_transfers` review modal is for (it offers "Rent" as an option for outbound person transfers). But since `ambiguous_transfers` wasn't being persisted (Bug 1 Layer 1), the user was never asked.

**Fix:** Already fixed by persisting `ambiguous_transfers`. After the next sync, the review modal will show recurring person-name outflows with "Rent" as a classification option. No additional code change needed for this specific issue — the persistence fix resolves it.

### Bug 4: Modal has two sections / recurring section crashes
**Root cause:** The modal has UNCATEGORISED and RECURRING TRANSFERS as two separate sections. The user feels one section is enough. When categorising recurring transfers, the crash likely occurs in the optimistic UI update (lines 681-714) where `section.items` might be undefined or the spread fails.

**Fix:** Investigate and fix the crash. Consider merging into one section if architecturally clean.

---

## Plan

### Step 1: Show person_transfers in review modal
- [ ] Add a "PERSON TRANSFERS" section below recurring transfers for items not in ambiguous_transfers
- [ ] Allow categorisation with the same chip UI as uncategorised items
- [ ] Save overrides on Done

### Step 2: Fix debt account detection gap
- [ ] Check debt_accounts sync query — ensure connected credit cards create debt_accounts entries
- [ ] Ensure reconcileDebtPayments correctly links transactions to connected credit card accounts

### Step 3: Fix modal recurring section crash
- [ ] Add null guards in optimistic UI update for section.items
- [ ] Test transfer categorisation flow

### Step 4: Verify
- [ ] TypeScript compiles cleanly
- [ ] Review all changes for correctness
