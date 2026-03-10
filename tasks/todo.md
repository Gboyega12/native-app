# Fix: CTA Math, Spending Details Peek, Surgical Recommendations

## Problem Statement

Three interconnected quality issues:

1. **CTA Payment Math**: Debt CTA says "Pay £17 to Amex" — that's just `debtPayments * 0.15` (interest savings heuristic), not a real actionable payment. Should compute real surplus-based allocation.

2. **Spending Details Visibility**: Collapsed section looks like a footer bar — bare `TouchableOpacity`, no border/bg, muted colors. Users don't discover it.

3. **Recommendation Quality**: Moves are generated with blunt heuristics:
   - Transport: recommends cutting 20% even for daily office commuters on TfL (non-negotiable cost). Includes one-time travel fares in the monthly average.
   - Subscriptions: includes essential bills (water, energy) and one-time charges. Doesn't verify recurrence pattern.
   - All moves use flat % cuts without proving the math is achievable.

---

## Plan

### Fix 1: CTA Payment Math (`enrichment-engine.ts`)

**In `genDecisionStack` — debt snowball move (line ~1149):**

Currently: `monthlyImpact = debtPayments * 0.15` (interest savings heuristic — not a real payment)

Change to: compute real surplus-based allocation using snowball method
- Sort debts by balance (smallest first)
- Calculate: `realPayment = min(smallestDebt.minimum_payment + max(0, surplus), smallestDebt.outstanding_balance)`
- `monthlyImpact = realPayment` (the actual recommended payment amount)
- `annualImpact` = keep as interest savings estimate (this IS the financial benefit metric)

**For single debt (line ~1190):**
- Use `min(surplus * 0.5, overpay_cap)` + minimum payment — already partially correct but `monthlyImpact` is still the interest savings. Fix to be the real overpayment amount.

**Fallback**: surplus ≤ 0 → use minimum_payment (still honest and actionable)

### Fix 2: Spending Details Peek Card (`index.tsx`)

**Collapsed state styling (lines 2577-2600, styles at 3575-3581):**

Add to `collapsedSectionBtn` or inline on the `TouchableOpacity`:
- `borderWidth: 1, borderColor: c.border`
- `borderRadius: 16`
- `backgroundColor: c.mintDim`
- `paddingHorizontal: 20`

Chevron: increase from 9px → 12px, use `c.dim` instead of `c.muted`.

### Fix 3: Surgical Recommendation Filtering (`enrichment-engine.ts`)

#### 3a. Subscriptions — exclude essential bills + require recurrence proof

Filter `subs` before generating the subscription move:
- Exclude categories: Energy, Water, Council Tax, Insurance, Rent, Mortgage, Broadband & Phone, TV Licence
- Require `count >= 2` (must have appeared at least twice — proves actual recurrence)
- Exclude `frequency === 'irregular'` (one-time charges)

Use filtered list for count check, saving calculation, and breakdown.

#### 3b. Transport — exclude essential commute + one-time fares

Separate transport spending into:
1. **Essential commute** (TfL, National Rail, regular rail operators) — non-negotiable for office workers
2. **One-time travel** (merchant appears only once, amount > £30) — exclude from monthly average
3. **Optimisable transport** (Uber, Bolt, taxis, excess discretionary transport)

Only recommend cutting the optimisable portion. For office workers, change strategy to "optimise commute method" (railcards, annual tickets, cycle-to-work).

#### 3c. Mathematical proof for all moves

Add `proof?: string` to Move type. For each move, attach a human-readable breakdown:
- Subscriptions: "4 recurring subs × avg £12/mo = £48. Cut 2 lowest-value = £24/mo."
- Transport: "£180/mo total − £120 commute − £15 one-time = £45 discretionary. 20% = £9/mo."
- Debt: "Surplus £60 + minimum £25 = £85/mo → £847 cleared in 10 months."

Display in expanded move card.

---

## Files to Change

| File | Change |
|------|--------|
| `lib/types.ts` | Add `proof?: string` to Move type |
| `lib/enrichment-engine.ts` | Fix `genDecisionStack` — debt math, sub filtering, transport filtering, proof generation |
| `app/(main)/(tabs)/index.tsx` | Peek card styles; display proof in move cards |

---

## Verification

- [ ] Debt CTA: surplus=60, min=25, balance=847 → "Pay £85 to Amex"
- [ ] Debt CTA: surplus=0, min=25 → "Pay £25 to Amex"
- [ ] Debt CTA: surplus=500, balance=100 → caps at "Pay £100"
- [ ] Subs: water/energy excluded from recommendations
- [ ] Subs: one-time charge (count=1) excluded
- [ ] Transport: TfL commute excluded from cut target
- [ ] Transport: one-time travel fare excluded
- [ ] Spending details has border, bg, rounded corners when collapsed
- [ ] All moves have proof string
- [ ] TypeScript compiles
