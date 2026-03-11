# Recurring Person Transfers & Debt Display Fix

## Problem
1. Recurring person-to-person transfers (rent to/from partner, debt repayments, self-transfers) are misclassified — either treated as generic transfers or mistaken for income.
2. Debt payment display shows user names ("pay £8 to John Doe") instead of bank/card names ("pay £8 to Capital One").

---

## Implementation Plan

### Part A: Detect Ambiguous Recurring Person Transfers

**File: `lib/enrichment-engine.ts`**

- [ ] **A1. New type `AmbiguousTransfer`** (~line 59)
  ```typescript
  export type AmbiguousTransfer = {
    counterparty: string;
    direction: 'inbound' | 'outbound';
    frequency: 'weekly' | 'fortnightly' | 'monthly';
    averageAmount: number;
    count: number;
    sampleDescriptions: string[];
    suggestedType: 'rent' | 'household_contribution' | 'debt_repayment' | 'self_transfer' | null;
  };
  ```

- [ ] **A2. New function `detectAmbiguousTransfers()`** (after `detectRecurring()` ~line 438)
  1. Group ALL transactions (including transfers + income) by person name counterparty
  2. For each group with 3+ transactions:
     - Calculate intervals → frequency (weekly/fortnightly/monthly)
     - Calculate amount CV — skip if CV > 0.15
     - Determine direction (all inbound or all outbound)
  3. Cross-reference with identity:
     - `housing='renting'|'shared_house'` AND outbound AND rent-range → suggest `rent`
     - Couple/family AND inbound AND regular → suggest `household_contribution`
     - User name fuzzy-matches counterparty → suggest `self_transfer`
     - Otherwise → `null`
  4. Filter out counterparties with existing `transaction_override`
  5. Return `AmbiguousTransfer[]`

- [ ] **A3. Add `ambiguousTransfers` to `EnrichmentResult`**
  Call in `enrich()` after `detectRecurring()`, pass identity data.

- [ ] **A4. Return from `api/enrich.js`**
  Include `ambiguousTransfers` in response JSON.

### Part B: Override Model — Pattern-Level + Direction

**File: `lib/enrichment-engine.ts`**

- [ ] **B1. Extend `TransactionOverride` type**
  Add `direction?: 'credit' | 'debit'` field.

- [ ] **B2. Update override matching in `enrichTransaction()`**
  When `direction` is set, also check `tx.amount` sign.

- [ ] **B3. Handle `Household Contribution` category**
  Set `isTransfer: true, isIncome: false` so it doesn't inflate income.

### Part C: Review Banner + Modal UI

**File: `app/(main)/(tabs)/index.tsx`**

- [ ] **C1. State for ambiguous transfers** (~line 310)
  ```typescript
  const [ambiguousTransfers, setAmbiguousTransfers] = useState<AmbiguousTransfer[]>([]);
  const [showTransferReview, setShowTransferReview] = useState(false);
  const [transferAssignments, setTransferAssignments] = useState<Record<string, string>>({});
  ```

- [ ] **C2. Banner** (below categorisation banner, ~line 1762)
  Same style as `reviewBanner`. Text: "{N} recurring transfers need clarification. **Review**"
  Banner disappears when all resolved.

- [ ] **C3. Modal — stepper through each ambiguous transfer**
  Same pattern as cat review modal. For each transfer show:
  - Counterparty name, direction, amount, frequency
  - Quick-select chips:
    - **Outbound:** Rent | Debt repayment | My own account | Just a transfer
    - **Inbound:** Household contribution | Income | Just a transfer
  - Pre-select `suggestedType` chip if exists

- [ ] **C4. Save function**
  On "Done":
  - Insert `transaction_overrides` with direction:
    - Rent → `{ category: 'Rent', is_essential: true, direction: 'debit' }`
    - Household contribution → `{ category: 'Household Contribution', is_essential: false, direction: 'credit' }`
    - Debt repayment → `{ category: 'Debt Payments', is_essential: true, direction: 'debit' }`
    - My own account → `{ category: 'Internal Transfer', is_essential: false, direction: 'debit' }`
    - Just a transfer → `{ category: 'Transfers', is_essential: false }` (suppress future prompts)
  - Re-enrich in background
  - Clear state → banner disappears

### Part D: Chat Awareness

**File: `api/chat/index.js`**

- [ ] **D1. Add ambiguous transfer context to system prompt**
  Include unresolved transfers. Suggest user taps "Review" on dashboard.

- [ ] **D2. Update chat override saving**
  Include `direction` field when saving person transfer overrides.

### Part E: Debt Payment Display Fix

- [ ] **E1. New helper `debtDisplayName()`** in `lib/enrichment-engine.ts`
  ```typescript
  function debtDisplayName(d: { account_name?: string; institution?: string; account_type?: string }): string {
    if (d.institution) return d.institution;
    const brand = extractCreditCardBrand(d.account_name || '');
    if (brand) return brand;
    if (d.account_type === 'credit_card') return 'Credit Card';
    if (d.account_type === 'car_finance') return 'Car Finance';
    return d.account_name || 'Debt';
  }
  ```

- [ ] **E2. `extractCreditCardBrand()` in `lib/merchant-db.ts`**
  Match account_name against existing CC brand patterns (Capital One, Barclaycard, MBNA, Amex, etc. at lines 217-240).

- [ ] **E3. Apply `debtDisplayName()` everywhere**
  - `enrichment-engine.ts:1195` (smallestName)
  - `enrichment-engine.ts:1213` (debtSubGoals target)
  - `reactive-engine.ts:152` (debtByName lookup)

---

## Files to Change

| File | Change |
|------|--------|
| `lib/enrichment-engine.ts` | AmbiguousTransfer type, detectAmbiguousTransfers(), override direction, debtDisplayName() |
| `lib/merchant-db.ts` | extractCreditCardBrand() |
| `lib/reactive-engine.ts` | Use debtDisplayName() for display |
| `app/(main)/(tabs)/index.tsx` | Transfer review banner + modal |
| `api/enrich.js` | Return ambiguousTransfers |
| `api/chat/index.js` | Chat awareness + direction on overrides |

## Verification
- [ ] Recurring transfers from partner not counted as income
- [ ] Recurring transfers to partner classified as rent when confirmed
- [ ] Self-transfers detected and excluded from spending
- [ ] Debt repayments to people classified correctly
- [ ] Banner appears, modal works, banner disappears after review
- [ ] Chat references ambiguous transfers when relevant
- [ ] Debt display shows "Capital One" not "John Doe"
- [ ] Existing overrides still work (no regressions)
- [ ] Pattern overrides respect direction (inbound vs outbound)
- [ ] TypeScript compiles
