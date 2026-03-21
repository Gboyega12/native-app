# Plan: Post-Onboarding Account Setup Gate + Investment Management + Dashboard Investment Card

## Overview
Three interconnected features:
1. **Account Setup Gate** — After onboarding, force users through a mandatory financial account setup flow before reaching the dashboard
2. **Investment Management on Profile** — Add individual + CSV investment entry from the profile page
3. **Dashboard Investment Card** — New card below the Debt card tracking all user investments

---

## Feature 1: Post-Onboarding Account Setup Gate

### Problem
Currently, after onboarding (welcome → education → identity → connect → processing), users go straight to the dashboard. There's no mandatory step to ensure they've added all their financial accounts (credit cards, debts, savings, investments).

### Approach
Add a new screen `app/(main)/account-setup.tsx` that sits between `processing` and the dashboard. This screen has sections for each account type and requires at least one account connection OR explicit skip before proceeding.

### New Screen: `account-setup.tsx`
**Sections (scrollable, step-by-step):**
1. **Bank Accounts** — Already connected via TrueLayer in the `connect` step. Show connected accounts with a "Add another" option.
2. **Credit Cards / Debt** — Reuse the existing `Add debt` modal pattern from profile.tsx. Let users add multiple debts. Show added items inline.
3. **Savings Accounts** — Simple form: account name, provider, balance, interest rate (optional), type (easy access / fixed / ISA / other).
4. **Investments** — Individual entry form: name, asset class (stocks, bonds, ETFs, crypto, property, pension, other), platform/provider, current value, purchase cost (optional). Also a CSV upload button.

**Each section has:**
- An "Add" button to add entries
- A list of added items
- A "Skip" / "I don't have any" option
- Visual checkmark when at least one item is added

**Navigation logic:**
- In `_layout.tsx` AuthGate: after processing completes, route to `account-setup` instead of dashboard
- New localStorage flag: `bocy_account_setup_done`
- If flag exists, skip to dashboard on future loads
- "Continue to Dashboard" button at bottom only enabled after all sections are visited (not necessarily filled — user can skip each)

### Database
- Debt accounts: already handled by `debt_accounts` table
- **New table: `savings_accounts`** — `id, user_id, account_name, provider, balance, interest_rate, account_type (easy_access/fixed/isa/other), source (manual/truelayer), created_at, updated_at`
- **New table: `investments`** — `id, user_id, name, asset_class (stocks/bonds/etfs/crypto/property/pension/other), platform, current_value, purchase_cost, quantity, currency, notes, source (manual/csv), created_at, updated_at`

### Types (`lib/types.ts`)
```typescript
export interface SavingsAccount {
  id?: string;
  user_id?: string;
  account_name: string;
  provider?: string;
  balance: number;
  interest_rate?: number;
  account_type: 'easy_access' | 'fixed' | 'isa' | 'other';
  source?: 'manual' | 'truelayer';
  created_at?: string;
  updated_at?: string;
}

export type InvestmentAssetClass = 'stocks' | 'bonds' | 'etfs' | 'crypto' | 'property' | 'pension' | 'other';

export interface Investment {
  id?: string;
  user_id?: string;
  name: string;
  asset_class: InvestmentAssetClass;
  platform?: string;
  current_value: number;
  purchase_cost?: number;
  quantity?: number;
  currency?: string;
  notes?: string;
  source?: 'manual' | 'csv';
  created_at?: string;
  updated_at?: string;
}
```

---

## Feature 2: Investment Management on Profile Page

### Changes to `app/(main)/profile.tsx`

**Add a new section after Debt Accounts:**

1. **INVESTMENTS section header**
2. List existing investments with: name, asset class badge, platform, current value, gain/loss (if purchase cost exists)
3. **"+ Add investment"** button → opens an Add Investment modal (same form as account-setup)
4. **"+ Import CSV"** button → opens file picker, parses CSV, previews rows, bulk-inserts

### CSV Import Logic
- Accept `.csv` files via `<input type="file" accept=".csv">`
- Expected columns (flexible matching): `name`, `asset_class`/`type`, `platform`/`provider`, `current_value`/`value`, `purchase_cost`/`cost`, `quantity`, `currency`, `notes`
- Preview parsed rows in a modal before confirming import
- Validate: name required, current_value required and numeric
- Insert all valid rows to `investments` table with `source: 'csv'`
- Show success count + any skipped rows with reasons

### Add Investment Modal Fields
- Name (required)
- Asset class: chips selector (stocks, bonds, ETFs, crypto, property, pension, other)
- Platform/Provider (optional) — e.g. "Vanguard", "Trading 212", "Coinbase"
- Current value (required) — £ amount
- Purchase cost (optional) — for gain/loss tracking
- Quantity (optional) — number of units/shares
- Notes (optional)

---

## Feature 3: Dashboard Investment Card

### Position
Below the Debt card, before Net Worth card (line ~3477 in `index.tsx`).

### Design (matches existing card patterns)
**Collapsed state:** Collapsible button like Debt card
- Label: "INVESTMENTS"
- Right side: total portfolio value + asset count badge
- Expand/collapse arrow

**Expanded state:** Card with:
1. **Hero section:** Total portfolio value in accent color
2. **Gain/Loss row** (if any investments have purchase_cost): total unrealised gain/loss with % and color (green = gain, coral = loss)
3. **Asset allocation bar** — horizontal stacked bar showing allocation by asset class (each class gets a color)
4. **Asset class breakdown rows** — one per class:
   - Color dot + class name
   - Number of holdings
   - Total value + % of portfolio
5. **Individual holdings** (within each class, expandable):
   - Name + platform badge
   - Current value
   - Gain/loss per holding (if purchase_cost exists)

### Data Flow
- Add `investments` to `AppDataProvider` state (fetch from `investments` table)
- Add `investments` to `AppData` interface in `useAppData.ts`
- Dashboard reads from context like it does for `debtAccounts`

### Colors per Asset Class
- Stocks: `colors.accent` (blue)
- Bonds: `colors.green`
- ETFs: `#9382DC` (purple, same as ISA)
- Crypto: `colors.amber`
- Property: `colors.text2`
- Pension: `#E8915C` (warm orange)
- Other: `colors.muted`

---

## Implementation Order

### Step 1: Types + Database
- Add `SavingsAccount`, `Investment`, `InvestmentAssetClass` types to `lib/types.ts`
- (Tables created via Supabase dashboard — document the SQL)

### Step 2: AppDataProvider Updates
- Add `investments` and `savingsAccounts` state to provider
- Fetch from Supabase in parallel with existing queries
- Expose via context + hook

### Step 3: Account Setup Screen
- Create `app/(main)/account-setup.tsx`
- Implement all 4 sections with add/skip flows
- Wire up Supabase inserts for each type

### Step 4: Navigation Gate
- Update `_layout.tsx` AuthGate to route through account-setup after processing
- Add `bocy_account_setup_done` localStorage check

### Step 5: Profile — Investment Management
- Add Investments section to profile.tsx
- Implement Add Investment modal
- Implement CSV import with file picker + parser + preview + bulk insert

### Step 6: Dashboard Investment Card
- Add investment card below debt card in `index.tsx`
- Collapsed/expanded states matching existing pattern
- Asset allocation bar + class breakdown + individual holdings

### Step 7: Testing + Polish
- Test full flow: onboarding → account-setup → dashboard
- Test profile investment add/remove/CSV import
- Test dashboard card with various investment mixes
- Verify existing flows (returning users skip account-setup via localStorage flag)

---

## Files Modified
1. `lib/types.ts` — New types
2. `hooks/useAppData.ts` — New fields in AppData interface
3. `providers/AppDataProvider.tsx` — Fetch + expose investments/savings
4. **NEW** `app/(main)/account-setup.tsx` — Account setup gate screen
5. `app/_layout.tsx` — AuthGate routing update
6. `app/(main)/profile.tsx` — Investment management section
7. `app/(main)/(tabs)/index.tsx` — Investment dashboard card
