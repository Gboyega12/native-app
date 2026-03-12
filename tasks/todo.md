# Decision Engine Optimality Overhaul + Event Timeline

## Context

The move engine uses heuristics and magic numbers where it should use real maths. Users see wrong £ amounts, wrong payoff timelines, and suboptimal move rankings. This plan fixes the engine to be mathematically optimal while adding timeline-aware life event handling.

---

## Must Fix — Wrong Answers

### 1. APR + Minimum Payment Data Capture
**Problem:** TrueLayer doesn't provide interest rates or minimum payments. The engine guesses `debtPayments × 0.40` for interest savings and `2.5%` of balance for minimums. Every downstream debt calculation is built on these guesses.

**Fix:**
- [ ] Add default APR by debt type to `constants.ts`: credit card 39.9%, store card 39.9%, overdraft 39.9% EAR, BNPL 0%, personal loan 7.9%
- [ ] Add default minimum payment rules to `constants.ts`: credit card max(£25, 2.5%), overdraft interest-only, BNPL fixed instalments, loan fixed term
- [ ] When `debt_accounts` are synced from TrueLayer (`sync.ts:350`), auto-populate `interest_rate` and `minimum_payment` with defaults based on `account_type` if NULL
- [ ] Add inline nudge data: `is_default_apr: boolean` field on `debt_accounts` so the UI knows to show "Assuming 39.9% APR — tap to set your actual rate"
- [ ] Update `profile.tsx` debt section to allow editing APR and minimum payment on connected accounts (already works for manual accounts)

**Files:** `lib/constants.ts`, `lib/sync.ts`, `app/(main)/processing.tsx`, `supabase-migration.sql` (add `is_default_apr` column), `app/(main)/profile.tsx`

### 2. Debt Avalanche Ordering
**Problem:** Engine sorts debts smallest-balance-first (snowball). Mathematically optimal is highest-rate-first (avalanche). With APR data from step 1, we can now do this.

**Fix:**
- [ ] In `enrichment-engine.ts:1350`, change sort from `(a.outstanding_balance) - (b.outstanding_balance)` to `(b.interest_rate || defaultAPR(b)) - (a.interest_rate || defaultAPR(a))`
- [ ] Update strategy text: "Avalanche method: clear highest-rate debt first to minimise total interest"
- [ ] Update steps: target highest-rate debt, not smallest balance
- [ ] Keep snowball as fallback ONLY when all debts have the same rate (or all rates are unknown/default) — in that case smallest balance is a reasonable tiebreaker

**Files:** `lib/enrichment-engine.ts`

### 3. Real Amortisation Calculations
**Problem:** `annualImpact` for debt moves uses `debtPayments × 0.40` — a flat guess. With real APR + balance + payment data, we can compute actual interest cost and savings.

**Fix:**
- [ ] Create `lib/amortisation.ts` with:
  - `calcMonthlyInterest(balance, apr)` → `balance × (apr / 12)`
  - `calcPayoffMonths(balance, apr, monthlyPayment)` → iterative: subtract payment, add interest, count months
  - `calcTotalInterest(balance, apr, monthlyPayment)` → sum of interest across all months
  - `calcInterestSaved(balance, apr, currentPayment, newPayment)` → difference in total interest between two payment amounts
- [ ] Replace heuristic in `enrichment-engine.ts:1367` with `calcInterestSaved()` using real APR from debt account
- [ ] Replace heuristic in `enrichment-engine.ts:1424` (single debt) similarly
- [ ] Replace hardcoded `0.19` fallback in `enrichment-engine.ts:1462` with `defaultAPR(account_type)`
- [ ] Replace minimum payment estimate in `enrichment-engine.ts:1318-1325` with real data from `debt_accounts.minimum_payment` or smarter defaults from step 1

**Files:** `lib/amortisation.ts` (new), `lib/enrichment-engine.ts`

### 4. Surplus Allocation Starting Point
**Problem:** Budget solver starts at hardcoded 40/35/25 (buffer/savings/invest) regardless of context. Someone with zero buffer gets same starting split as someone with 12 months saved.

**Fix:**
- [ ] In `budget-solver.ts:199-242`, make initial split responsive:
  - If buffer < 1 month expenses: 70/20/10 (buffer-heavy)
  - If buffer < 3 months: 50/30/20
  - If buffer ≥ 3 months and has debt: 20/30/50 (debt gets investment share)
  - If buffer ≥ 3 months and no debt: 20/40/40 (balanced growth)
- [ ] Use `identity.risk_appetite` to shift: conservative adds +10% to buffer, growth adds +10% to invest
- [ ] The solver's iterative step already adjusts from here — better starting point means fewer iterations and more accurate result

**Files:** `lib/budget-solver.ts`

---

## Should Fix — Distorted Rankings

### 5. Opportunity Cost / NPV Comparison
**Problem:** No unified model to compare "pay 39.9% debt" vs "save at 4.5%". The engine uses CRRA multipliers instead of rate-of-return comparison.

**Fix:**
- [ ] Add `calcOpportunityCostMultiplier(move, profile, debtAccounts)` to `lib/liquidity-engine.ts`:
  - For debt moves: effective return = APR of the debt (paying 39.9% debt = 39.9% guaranteed return)
  - For savings moves: effective return = best available savings rate (use `boeBaseRate` from constants)
  - For invest moves: effective return = expected equity return minus risk discount
  - Multiplier = `moveReturn / baselineReturn` where baseline = risk-free rate
- [ ] Apply this multiplier in `move-engine.ts` ranking alongside CRRA (not replacing it — CRRA handles diminishing returns, NPV handles rate comparison)
- [ ] This naturally resolves "should I save or pay debt" — a 39.9% debt move gets ~8.9x multiplier vs 4.5% savings

**Files:** `lib/liquidity-engine.ts`, `lib/move-engine.ts`

### 6. Spending Cut Percentages from User Data
**Problem:** `foodDeliveryCutPct: 0.4` is arbitrary. User who spends £30-£120/month on delivery (high variance) can realistically cut more than someone steady at £80.

**Fix:**
- [ ] In `enrichment-engine.ts`, for each spending category move:
  - Calculate the user's month-to-month variance for that category from transaction data
  - Use `minimum month / average month` as the achievable floor (they've already done it)
  - Cut target = average - (average × achievable reduction), where achievable reduction = `1 - (min / avg)` capped at 0.5
  - Fallback to current constants only if < 3 months of data
- [ ] This means: if a user spent £30, £60, £120 on delivery over 3 months, min/avg = 30/70 = 43% achievable cut — close to current 40% but now data-driven
- [ ] Update `annualImpact` to use the data-derived cut, not the constant

**Files:** `lib/enrichment-engine.ts`, `lib/constants.ts` (keep as fallbacks)

### 7. Effort Multiplier → Monte Carlo Follow-Through
**Problem:** Flat ×1.3 (low) / ×0.8 (high) distorts rankings. A £75 hard move loses to a £50 easy one.

**Fix:**
- [ ] Replace effort multiplier in `move-engine.ts:148` with consistency-derived follow-through:
  - For spending categories: use the user's actual month-to-month coefficient of variation (CV) for that category
  - Low CV (steady spend) = harder to change = lower follow-through estimate
  - High CV (already fluctuates) = easier to change = higher follow-through
  - Formula: `followThrough = 0.5 + 0.4 × (categoryCV / maxCV)` — ranges from 0.5 to 0.9
- [ ] Update `monte-carlo.ts:317` base rates to use this instead of hardcoded 88/65/42%
- [ ] Keep `effort` field on moves for display purposes but decouple it from scoring

**Files:** `lib/move-engine.ts`, `lib/monte-carlo.ts`

### 8. UKPF Boost + Goal Alignment from Real Cost
**Problem:** UKPF boost is flat ×1.15, goal alignment is flat ×1.3. These are guesses.

**Fix:**
- [ ] Replace UKPF boost (`move-engine.ts:165`) with cost-of-inaction:
  - If priority = debt and move is debt: boost = `1 + (highestAPR × monthlyBalance / annualIncome)` — the actual cost of not prioritising this
  - If priority = buffer and move is buffer: boost = `1 + (emergencyProbability × averageEmergencyCost / annualIncome)` — expected cost of not having a buffer
  - Floor at 1.0, cap at 1.5
- [ ] Replace goal alignment boost (`move-engine.ts:170-174`) with months-shaved ratio:
  - `boost = 1 + (monthsSaved / currentMonths)` capped at 1.5
  - A move that cuts 6 months off a 12-month goal gets ×1.5; one that saves 1 month off 24 gets ×1.04
  - This makes the boost proportional to actual goal acceleration

**Files:** `lib/move-engine.ts`

### 9. Income Volatility from Real Transaction Data
**Problem:** Salaried gets 5% CV, self-employed 25%. These are defaults that ignore actual income patterns in the bank data.

**Fix:**
- [ ] In `monte-carlo.ts:83-99`, after setting default CV by work type:
  - If `profile.budgetReality` has ≥ 3 months of income data, calculate actual CV from `income_sources`
  - `actualCV = stddev(monthlyIncomes) / mean(monthlyIncomes)`
  - Use `actualCV` instead of default, with default as fallback for < 3 months data
- [ ] Same for spending CV: calculate from actual monthly totals instead of hardcoded 8% essential / 22% discretionary

**Files:** `lib/monte-carlo.ts`

---

## Feature

### 10. Event Timeline Picker
**Problem:** Engine treats "baby" as binary. 1 month away needs crisis-mode advice; 9 months away is a calm savings plan. No way to distinguish.

**Fix:**
- [ ] Update `UpcomingEvent` type in `types.ts` from `string` to `{ type: string; months_away?: number }`
- [ ] In `identity.tsx` screen 5 ("Anything big coming up?"), after user selects baby/moving/wedding:
  - Show inline follow-up below the selected card: "Roughly when?"
  - Options: "1–2 months", "3–5 months", "6–9 months", "Not sure yet"
  - No new screen — appears as a conditional row beneath the selected card
  - Store as `months_away` number (midpoint: 1.5, 4, 7.5, null)
- [ ] Update `saveAndContinue` in `identity.tsx` to persist `months_away` with the event
- [ ] Update Supabase `user_identity` column `upcoming_events` JSONB to support `[{ type: 'baby', months_away: 4 }]`
- [ ] In `enrichment-engine.ts:2070` (baby move):
  - If `months_away <= 3`: target = 1 month expenses (realistic), effort = 'low' (only easy wins), urgency multiplier ×1.5
  - If `months_away <= 6`: target = 2 months expenses, standard approach
  - If `months_away > 6` or null: target = 3 months expenses (current behaviour)
  - Adjust strategy text to reflect timeline: "You have ~2 months — focus on building £1,500 minimum"
- [ ] In `enrichment-engine.ts` for moving/wedding: similar timeline-scaled targets
- [ ] In `monte-carlo.ts:113`: scale emergency rate bump by proximity: `emergencyRate += 0.04 × (6 / months_away)` — imminent events get larger bump

**Files:** `lib/types.ts`, `app/(main)/identity.tsx`, `lib/enrichment-engine.ts`, `lib/monte-carlo.ts`

---

## Measure Then Fix (Need Usage Data)

### 11. Follow-Through Rate Calibration
**Problem:** `88% / 65% / 42%` follow-through rates are invented. Need real data.

**Plan (not implementing now):**
- Track which moves users actually execute via `reactive-engine.ts` verification
- After N months of data, replace hardcoded rates with empirical rates by category and effort level
- This is a data pipeline task, not a code fix

---

## Implementation Order

1. **Step 1 → 2 → 3** (APR capture → avalanche → amortisation) — these are sequential dependencies
2. **Step 4** (surplus allocation) — independent, can parallel with step 1-3
3. **Step 5** (NPV) — depends on step 3 (needs amortisation functions)
4. **Step 6** (spending cuts from data) — independent
5. **Step 7** (effort → follow-through) — independent
6. **Step 8** (UKPF/goal from real cost) — depends on step 5 (uses opportunity cost)
7. **Step 9** (income volatility) — independent
8. **Step 10** (event timeline) — independent, can parallel with anything

**Parallelisable groups:**
- Group A: Steps 1→2→3→5→8 (debt pipeline)
- Group B: Steps 4, 6, 7, 9 (independent fixes)
- Group C: Step 10 (feature)

---

## Must Fix — Bank Reconnection Flow

### 12. Loop-Back-to-Banner Multi-Bank Reconnection
**Problem:** When multiple banks expire (e.g. Barclays + Monzo), the banner shows both but tapping "Fix" navigates to `/connect` with no bank-specific context. After reconnecting one bank, the user is redirected back to profile/home and never prompted for the second. Each visit to connect handles exactly one connection — there's no queuing or multi-bank flow.

**Approach:** Lighter-weight "loop back to banner" — after reconnecting one bank, redirect home where the banner naturally updates to show only remaining expired banks. Avoids turning the connect page into a multi-step wizard.

**Fix:**
- [ ] Fix the guard at `connect.tsx:97` so existing users coming from the banner aren't bounced home — pass `from: 'banner'` as a distinct mode alongside `'profile'`
- [ ] Update banner tap handler in `index.tsx` (lines 1810-1812) to navigate with `from: 'banner'` param: `router.push({ pathname: '/(main)/connect', params: { from: 'banner' } })`
- [ ] In `connect.tsx`, handle `from: 'banner'` — skip the onboarding guard, allow the TrueLayer flow, and after successful reconnection redirect back to home (not profile)
- [ ] After reconnection redirect lands on home, trigger a re-sync so the banner updates to reflect remaining expired banks
- [ ] Add a brief toast/alert on home after successful banner reconnection: _"[Bank] reconnected. X bank(s) still need attention."_ (only if there are remaining expired banks)
- [ ] If all expired banks are now reconnected, show success toast: _"All banks reconnected"_ and hide the banner

**Files:** `app/(main)/connect.tsx`, `app/(main)/(tabs)/index.tsx`, `lib/sync.ts`

**Why not the wizard approach:** The connect page's single-connection flow stays untouched. No new state machine, no partial-completion edge cases, no wizard back-button behavior. The banner already tracks which banks are expired — it's a free queue. Can revisit if data shows users dropping off mid-reconnection with 3+ banks.

---

## UX Improvements

### 13. Categorisation → Budget Sync Feedback
**Problem:** After saving category reviews, there's no confirmation the re-sync completed. Optimistic update (lines 634-676) removes transactions from "Other" but doesn't add them to the target category — the budget looks like money vanished.

**Already done:** `saveReview()` triggers `syncInBackground()` after saving (commit `474fc81`). Haptic + checkmark animation fires at line 679.

**Recommended fix:**
- [ ] In the optimistic update block (lines 634-676), after removing transactions from "Other", find-or-create the target category in the correct section (`discretionary`/`non_discretionary` based on `a.isEssential`) and push the transactions into it. Recalculate `monthly` and `txs` on the target category, and `section.total`.
- [ ] After `syncInBackground` completes (it's fire-and-forget currently), chain a `.then()` or use a callback/ref to trigger a lightweight toast: "Budget updated". Use the existing `LayoutAnimation` pattern — no new toast library needed, a timed `<Text>` overlay that auto-dismisses after 2s is sufficient.

**Files:** `app/(main)/(tabs)/index.tsx` (lines 634-700)

### 14. Banner Persistence — Eliminate Flash
**Problem:** `useEffect` at line 118 runs `AsyncStorage.getItem()` on every `connectionWarning` change. This is async — the banner renders visible for a frame before the stored fingerprint resolves and hides it. The flash is most noticeable on slower devices.

**Recommended fix:**
- [ ] Add a module-level `let dismissCache: Record<string, string> = {}` outside the component. On mount (single `useEffect([], [])`), hydrate it from AsyncStorage once: `dismissCache[CONN_DISMISS_KEY] = await AsyncStorage.getItem(CONN_DISMISS_KEY)`.
- [ ] Replace the async check at line 118 with a synchronous read: `const stored = dismissCache[CONN_DISMISS_KEY]; setConnectionDismissed(stored === currentFingerprint);` — no `.then()`, no flash.
- [ ] Update `dismissConnection()` (line 157) to write both to `dismissCache` and AsyncStorage simultaneously.
- [ ] Same pattern for `INCOME_DISMISS_KEY` at line 150.
- [ ] Initialise `connectionDismissed` state to `true` (hidden by default) instead of `false`. Flip to `false` only after the synchronous cache confirms it shouldn't be dismissed. This eliminates the flash entirely — banner starts hidden, appears only when confirmed.

**Files:** `app/(main)/(tabs)/index.tsx` (lines 112-163)

### 15. Connect Page Guard — Skip to TrueLayer
**Problem:** Banner tap at line 1805 navigates to `/(main)/connect` with no params. The connect page guard (line 97) checks `!isFromProfile && !isRedirecting` — since `from` isn't passed, an existing user with an analysis gets bounced home at line 106. Even after fixing the guard, the user lands on a connect page and has to manually tap "Connect via Open Banking" — an unnecessary intermediate step.

**Recommended fix (two-phase):**

*Phase 1 — make it work (Step 12):*
- [ ] Pass `from: 'banner'` in the banner's `onPress` at line 1805: `router.push({ pathname: '/(main)/connect', params: { from: 'banner' } })`
- [ ] In `connect.tsx` line 68, expand check: `const isFromProfile = params.from === 'profile' || params.from === 'banner';` — this skips the guard at line 97 and ensures redirect-back at line 214 fires.
- [ ] At line 218, branch on `from`: if `'banner'`, redirect to `/(main)/(tabs)` (home) instead of `/(main)/profile`.

*Phase 2 — skip the page entirely (this step):*
- [ ] Extract `handleTrueLayer()` logic from `connect.tsx` into a shared util (or just call TrueLayer's auth URL builder directly from `index.tsx`).
- [ ] Banner tap generates a `connection_id`, builds the TrueLayer auth URL, and opens it via `Linking.openURL()` — user goes straight to bank selection.
- [ ] TrueLayer callback redirects back to connect page (existing deep link), which handles the token exchange as normal, then redirects home.
- [ ] **Tradeoff:** This couples index.tsx to TrueLayer URL construction. May not be worth it if Phase 1 feels smooth enough. Recommend implementing Phase 1 first, then evaluating.

**Files:** `app/(main)/(tabs)/index.tsx` (line 1805), `app/(main)/connect.tsx` (lines 68, 97, 214-218)

### 16. Banner Timing — Debounce State Changes
**Problem:** During sync, `connectionWarning` flips from `null` → `{...}` → `null` as the sync starts (clears old state), detects issues, then resolves. Each flip triggers a re-render and the banner visibly appears then disappears within ~1s.

**Recommended fix:**
- [ ] Add a `useRef` + `setTimeout` debounce wrapper around the banner visibility. Instead of rendering directly on `connectionWarning && !connectionDismissed`, derive a `showConnectionBanner` state that only becomes `true` after `connectionWarning` has been truthy for 500ms continuously.
- [ ] Pattern:
  ```
  useEffect(() => {
    if (connectionWarning && !connectionDismissed) {
      const timer = setTimeout(() => setShowConnectionBanner(true), 500);
      return () => clearTimeout(timer);
    }
    setShowConnectionBanner(false);
  }, [connectionWarning, connectionDismissed]);
  ```
- [ ] Replace the condition at line 1803 with `showConnectionBanner`.
- [ ] Same debounce for income banner if it has the same flicker issue.

**Files:** `app/(main)/(tabs)/index.tsx` (lines 1802-1821)

---

## Verification

- [ ] All TypeScript compiles cleanly
- [ ] Debt moves show real amortisation numbers, not heuristic estimates
- [ ] Avalanche ordering: highest-rate debt is targeted first
- [ ] User with 39.9% debt and 4.5% savings sees "pay debt" ranked above "save"
- [ ] Budget solver allocates 70%+ to buffer when buffer = £0
- [ ] Baby in 1 month vs 9 months generates different move targets and urgency
- [ ] Spending cut amounts reflect user's actual variance, not flat percentages
- [ ] Move ranking uses follow-through from spending history, not flat effort multipliers
- [ ] UKPF/goal boosts scale with actual financial impact
- [ ] Monte Carlo uses real income CV when ≥ 3 months data available
- [ ] Banner tap navigates to connect with `from: 'banner'` — existing user guard doesn't bounce
- [ ] After reconnecting one expired bank via banner, user lands back on home (not profile)
- [ ] Banner updates to show only remaining expired banks after one is reconnected
- [ ] Toast shows "[Bank] reconnected. X bank(s) still need attention" when others remain
- [ ] Toast shows "All banks reconnected" and banner hides when none remain
- [ ] "Budget updated" toast appears after saving category reviews
- [ ] Optimistic update adds transactions to target category (not just removes from Other)
- [ ] Banner doesn't flash on mount — synchronous cache prevents async flicker
- [ ] Banner state changes are debounced (~500ms) — no flicker during sync
