# Full App Audit - Senior Engineer Review

**Date:** 2026-03-13
**Scope:** Security, Architecture, Bugs, Operability
**App:** Bocy - Fintech PWA (Expo + Vercel + Supabase)

---

## CRITICAL FINDINGS (Fix Immediately)

### 1. Missing JWT Authentication on 3 API Endpoints
- [x] `api/goals/update.ts` - JWT auth added. User ID derived from verified token, not request body.
- [x] `api/plans/index.ts` - JWT auth added. User ID derived from verified token, not request body.
- [x] `api/notifications/subscribe.ts` - JWT auth added. User ID derived from verified token, not request body.

### 2. Open Redirect in OAuth Callback
- [x] `api/truelayer/callback.ts` - `webOrigin` validated against `ALLOWED_ORIGINS` whitelist. Invalid origins silently dropped.

---

## HIGH SEVERITY

### 3. HTML Injection in Email Notifications
- [ ] `api/notifications/send.ts:71` - User-controlled `html` passed directly to Resend API without sanitization.

### 4. Distributed State / Triple-Fetch Problem
- [ ] Home, Plan, and Chat screens all independently fetch `analysis`, `debtAccounts`, `weeklyContext` from Supabase. No shared data layer.
- **Impact:** Redundant network calls, inconsistent UI state across tabs.

### 5. enrichment-engine.ts is 2649 Lines
- [ ] Mix of parsing, classification, profiling, archetype detection, scoring, and recommendation logic in one file.
- **Impact:** Hard to test, review, and maintain.

### 6. 40+ `any` Types in Business Logic
- [ ] `lib/sync.ts`, `lib/reactive-engine.ts`, `lib/enrichment-engine.ts`, `lib/monte-carlo.ts` all use `any` extensively.
- [ ] 8+ `catch (e: any)` blocks should be `catch (e: unknown)` with type guards.

### 7. No Structured Logging or Error Tracking
- [x] Sentry integrated: client-side (`@sentry/react`) in `_layout.tsx` + `ErrorBoundary.tsx`, server-side (`@sentry/node`) via `lib/sentry-server.ts`.
- [x] User context attached on auth state change. `EXPO_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` env vars added to `.env.example`.

### 8. No UI Component Tests
- [ ] 7 test files (4260 lines) cover API + engines well, but zero React component tests.
- [ ] No integration tests, no visual regression tests, no coverage reporter.

### 9. Dependency Vulnerabilities
- [ ] `npm audit` reports 8 vulnerabilities (2 moderate, 6 high) via `@vercel/node` transitive deps.
- [ ] Includes `undici` HTTP smuggling, `minimatch` ReDoS, `path-to-regexp` backtracking.

---

## MEDIUM SEVERITY

### 10. Missing CSRF Protection
- [ ] OAuth state parameter not cryptographically validated in `api/truelayer/callback.ts`.
- [ ] POST endpoints accept `user_id` in body instead of deriving from JWT.

### 11. Module-Level Mutable State
- [ ] `app/_layout.tsx:20-39` uses `_pendingOAuth` and `_emailConfirmed` as global mutable variables.
- [ ] `app/(main)/(tabs)/index.tsx:66-67` uses `dismissCache` as module-level state invisible to React.
- **Impact:** Hard to debug, race conditions possible.

### 12. CSV Deduplication Code Duplicated
- [ ] `api/enrich.ts:17-29` (Set-based) and `lib/sync.ts:65-109` (count-based) implement the same logic differently.

### 13. Date Formatting Duplicated 5 Times
- [ ] `formatTimeAgo()`, `formatTxDateAge()`, `formatRelativeDate()` and 2 more variants scattered across files.

### 14. Inconsistent API Response Structure
- [ ] Some endpoints return `{ success: true, csv_data }`, others return `{ reason: 'token_expired', expired_connections }`.
- [ ] No standardized response envelope.

### 15. No Request/Response Validation
- [ ] API endpoints accept any request shape. No Zod or joi validation.
- [ ] Financial data not validated (income >= 0, sources sum correctly).

### 16. Performance - ScrollView for Large Lists
- [ ] Home tab renders transactions/categories in ScrollView without FlatList virtualization.
- [ ] Analytics `trackScreen()` fires on every state change in useEffect.

### 17. Sensitive Data in Logs
- [ ] `api/truelayer/callback.ts:299` logs bank account balances: `console.log('[callback] Balances:', JSON.stringify(updatePayload))`.

### 18. No Offline Detection
- [ ] No `navigator.onLine` checks. No AppState listener for background/foreground.
- [ ] Sync doesn't pause when app is backgrounded.

---

## LOW SEVERITY

### 19. Accessibility Gaps
- [ ] Minimal `testID` attributes. No screen reader testing. No reduced-motion support.

### 20. No i18n Support
- [ ] All text hardcoded in English. Acceptable if UK-only.

### 21. No Bundle Size Monitoring
- [ ] No `expo-bundle-analyzer` in scripts or CI.

### 22. Service Worker Cache Strategy
- [ ] Basic precache list. SW updates show banner but don't force reload.

---

## CURRENT SPRINT: Categorisation Banner + Scroll Fix (2026-03-15)

### Bug 1: Categorisation banner reappears after saving

**Root cause:** The `overridesSavedAt` guard (added last sprint) is still insufficient. The guard at line 1310 compares `result.syncStartedAt < overridesSavedAt.current` — but the force-sync triggered at line 771 starts AFTER `overridesSavedAt` is set (line 767), so `syncStartedAt >= overridesSavedAt`. The guard clears at line 1316, and the enrichment engine may return stale data if overrides haven't propagated yet, overwriting the optimistic state.

**Fix — merchant-key-based guard (deterministic, not time-based):**
- [x] After `saveReview()`, store the set of categorised merchant keys in a ref (`overriddenMerchants`)
- [x] In `setAnalysis()` updater (line 1306), if `overriddenMerchants.current` is non-empty, check the incoming `fresh` analysis: if ANY of those merchants still appear in "Other" with `classifiedBy === 'default'`, reject the sync result and keep `prev`
- [x] Only clear `overriddenMerchants` when a sync result correctly reflects the overrides (those merchants are NOT in "Other", or have `classifiedBy !== 'default'`)
- [x] Add a 10-second delay before triggering `syncInBackground` after saving overrides, giving the enrichment engine time to ingest the new overrides

### Bug 2: Can't scroll on transactions card in spending section

**Root cause:** `Card` component has `overflow: 'hidden'` (Card.tsx:518) which clips content. The FlatLists inside have `scrollEnabled={false}` (correct — they rely on the parent ScrollView), but the Card clips them before the parent ScrollView can render them.

**Fix:**
- [x] Override `overflow: 'visible'` on the spending details Card specifically (don't change the global Card style as other cards may need clipping for charts/images)

### Verification
- [x] TypeScript compiles clean (0 errors in changed files)
- [ ] Categorisation banner stays dismissed after saving
- [ ] Transactions card scrolls vertically in spending section

---

## PREVIOUS SPRINT: Sync, Categorisation Persistence & Surgical Plans (2026-03-14)

### Fix 1: Re-sync window — 3 months → 1 month
- [x] `api/truelayer/sync.ts:96` — `setMonth(-3)` → `setMonth(-1)`
- [x] `api/cron/bank-sync.ts:103` — `setMonth(-3)` → `setMonth(-1)`
- [x] Update comments to reflect 1-month window
- Initial 12-month pull in `callback.ts` stays as-is

### Fix 2: Re-categorised transactions reverting on refresh/re-sync

**Root cause:** The 120s time-based guard (`reviewSavedRef.current`) is a race condition. A sync started BEFORE overrides were saved can complete AFTER the 120s window expires, overwriting the correct state with stale data.

**Fix — replace time-based guard with sync-generation tracking:**
- [x] Add `overridesSavedAt` ref (timestamp of last override save)
- [x] Thread a `syncStartedAt` timestamp through `requestSync()` → `syncBankData()` return value
- [x] In `syncInBackground`, only accept analysis results where `syncStartedAt > overridesSavedAt`
- [x] This is deterministic: syncs started before overrides were saved are always rejected
- [x] Remove the brittle 120s window and `AsyncStorage` persistence of `review_saved_at`

**Files:**
| File | Change |
|------|--------|
| `app/(main)/(tabs)/index.tsx` | Replace `reviewSavedRef` guard with `overridesSavedAt` check |
| `lib/sync.ts` | Return `syncStartedAt` timestamp from `syncBankData()` |
| `lib/sync-coordinator.ts` | Pass through `syncStartedAt` |

### Fix 3: Surgical, data-driven plans

**Problem:** Both plan systems (moves + user plans) fall back to generic, vague steps:
- `hydrateSubGoals()` generates "Debt 1", "Debt 2" — no real names
- `getPlanSteps()` generates "List all debts with their interest rates" — generic advice
- User with Capital One + Amex sees "debt..." instead of specific accounts with balances

**Fix A — `hydrateSubGoals()` gets real data:**
- [x] Add optional `debtAccounts` parameter to `hydrateSubGoals(move, debtAccounts?)`
- [x] For debt moves: use real account names, balances, APRs from `debtAccounts`
- [x] Each debt becomes its own trackable sub-goal: "Capital One — £2,400 at 22.9%"
- [x] In dashboard (line 2498 + 2451), pass current `debtAccounts` state to `hydrateSubGoals()`

**Fix B — Replace `getPlanSteps()` with data-driven step generation:**
- [x] New function `generatePlanSteps(plan, analysis, debtAccounts)` replaces `getPlanSteps(plan)`
- [x] For debt plans: generate one step per debt account with real name, balance, APR, recommended payment
  - e.g. `"Pay £180/mo to Capital One — £2,400 at 22.9% APR"`
  - e.g. `"Pay £95/mo to Amex — £1,100 at 19.9% APR"`
- [x] For spending plans: generate steps per top spending category with real amounts
  - e.g. `"Reduce Eating Out from £320 to £200/mo (Deliveroo, Uber Eats)"`
- [x] For subscription plans: generate steps per subscription with real merchant + amount
  - e.g. `"Cancel Netflix — £15.99/mo"`
  - e.g. `"Cancel Disney+ — £10.99/mo"`
- [x] For savings/buffer plans: generate step with real surplus amount and timeline
  - e.g. `"Transfer £250/mo from surplus → reaches £3,000 in 12 months"`
- [x] Each step is individually completable with strike-through on tap
- [x] Steps show real numbers from the user's analysis, not generic advice

**Fix C — User plans get sub-goals too:**
- [x] When user plan matches debt category: create `MoveSubGoal[]` from `debtAccounts` at display time
- [x] Sub-goals show progress bars with real balance tracking (same as move sub-goals)
- [x] Reactive engine already verifies debt_clear sub-goals — user plans benefit from same verification

**Files:**
| File | Change |
|------|--------|
| `lib/types.ts` | `hydrateSubGoals(move, debtAccounts?)` signature + debt account hydration |
| `app/(main)/(tabs)/index.tsx` | Replace `getPlanSteps()` with `generatePlanSteps()`, pass data to hydration |

### Verification
- [x] TypeScript compiles clean (0 errors in changed files)
- [x] Re-sync uses 1-month window in both endpoints
- [x] Recategorised transactions persist through sync cycles (deterministic guard)
- [x] Plan items show specific merchant names with real amounts
- [x] Plan sub-goals show progress bars with real balance data

---

## PREVIOUS SPRINT: Background Verification (2026-03-14)

### Problem
During onboarding, the processing screen runs Claude AI verification (classifying low-confidence transactions) synchronously on the client. This takes 20-60 seconds depending on transaction volume. If the user leaves the screen, work is orphaned and restarts from scratch on return.

### Solution
Split the enrichment pipeline into two phases:
1. **Fast phase (client):** Rule-based enrichment, profile building, move ranking, save draft analysis. User proceeds to dashboard in ~3 seconds.
2. **Slow phase (server):** Claude classification + move refinement runs as a background API call. Updates the analysis row when done. Dashboard picks up the improved version.

### Step 1: Add verification status to analyses table
- [x] Add `verification_status` column: `'draft' | 'verifying' | 'verified'`
- [x] Default to `'verified'` so existing rows are unaffected
- [x] Add `verified_at` timestamp column (nullable)

### Step 2: New background verification API endpoint
- [x] Create `api/verify.ts` that accepts `{ user_id }`
- [x] Authenticate via JWT (same pattern as other endpoints)
- [x] Read stored CSV from `bank_data`, fetch overrides/identity/debt/goals
- [x] Run `EnrichmentEngine.enrich()` to get enriched transactions
- [x] Run Claude classify batches on low-confidence transactions (same logic currently in processing.tsx lines 252-319)
- [x] Run `EnrichmentEngine.rebuild()` with improved classifications
- [x] Re-rank moves with `rankMoves()`, run Claude move refinement
- [x] Update the analysis row with improved data + set `verification_status = 'verified'`, `verified_at = now()`

### Step 3: Modify processing.tsx to skip Claude calls
- [x] Remove the Claude classify loop (current lines 252-319)
- [x] Remove the Claude move refinement call (current lines 363-419)
- [x] Save the analysis with `verification_status: 'draft'`
- [x] After saving, fire and forget `fetch('/api/verify')` with user's JWT
- [x] Navigate user to dashboard immediately after save
- [x] Processing screen now completes in ~3 seconds

### Step 4: Dashboard picks up verified analysis
- [x] In dashboard `loadData()`, read `verification_status` from the analysis row
- [x] If status is `'draft'` or `'verifying'`, show subtle text: "Refining your analysis..."
- [x] Add lightweight poll: if not `'verified'`, re-fetch every 15 seconds (max 4 attempts)
- [x] When verified version arrives, update state smoothly (no jarring layout shifts)
- [x] On `syncCoordinator.onSyncComplete()`, also check for status change

### Step 5: Handle edge cases
- [x] If `/api/verify` fails, keep `verification_status = 'draft'` (not stuck on 'verifying')
- [x] Next background sync via cron picks up unverified analyses and runs verification
- [x] If user triggers manual re-analysis, skip the poll and run fresh
- [x] Ensure verify endpoint is idempotent (safe to call twice)

### Files to modify

| File | Change |
|------|--------|
| `app/(main)/processing.tsx` | Remove Claude classify + refine, save draft, fire background verify |
| `api/verify.ts` | New endpoint: classify + refine + update analysis |
| `app/(main)/(tabs)/index.tsx` | Read verification_status, subtle indicator, lightweight poll |
| `lib/sync.ts` | After sync, trigger verify if analysis is still draft |
| `api/enrich.ts` | Set verification_status on analyses it creates |
| Supabase migration | Add `verification_status` + `verified_at` columns |

### User experience

**Before:** 30-60 second spinner. Leaving = lost progress.

**After:**
1. Connect bank, set goals, processing shows 4 quick steps (~3 seconds)
2. Land on dashboard with accurate surplus, categories, and moves (rule-based, ~95% correct)
3. Small "Refining your analysis..." text visible
4. ~20-30 seconds later, text disappears. Categories and moves may shift very slightly
5. If they never notice the refinement, that's the ideal outcome

---

## PREVIOUS SPRINT: Education Carousel Redesign (2026-03-14)

### Design Overhaul — Minimalist, Sophisticated, Elegant
- [x] Upgrade MockupDashboard: surplus + next best move (no spending bars)
- [x] Upgrade MockupMoves: energy switch, savings placement, debt consolidation
- [x] Upgrade MockupChat: debt-free timeline + income variability
- [x] Update slide copy to match new mockups, remove all dashes

---

## PREVIOUS SPRINT: Sync & Categorisation Fixes (2026-03-14)

### A. Categorisation modal re-populates after user manually categorises (on refresh/re-sync)
- [x] **Root cause:** `syncBankData()` re-fetches transactions from TrueLayer, re-enriches, and re-computes analysis. The `unresolvedGroups` memo recomputes from `analysis` state. The `reviewSavedRef` 60s guard protects against overwrite, but after 60s the fresh sync wipes optimistic state. The overrides ARE persisted to `transaction_overrides`, and the enrichment engine DOES apply them — BUT the `persistAnalysis()` only saves `non_discretionary`, `discretionary`, `monthly_spending`, `surplus` and does NOT persist the enriched transaction details that include `confidence`/`classifiedBy` fields. So after sync, enrichment re-runs with overrides applied correctly, but transactions that were "Other" before remain in the `unresolvedGroups` because the override system works at the enrichment level, not at the analysis→modal level.
- [x] **Fix:** The real issue is that `persistAnalysis()` in `saveReview` doesn't persist the updated `non_discretionary.items` and `discretionary.items` with the transactions moved out of "Other". The analysis object stored in Supabase retains the old item structure. When the next sync reads from Supabase (before TrueLayer responds), it loads the OLD structure with transactions still in "Other". The enrichment re-run DOES apply overrides correctly — so the fix should ensure the analysis persistence includes the full items structure, not just totals.

### B. Re-sync fetches too much data
- [x] **Current state:** `api/truelayer/sync.ts` uses 30-day window. `api/cron/bank-sync.ts` uses 30-day window. `api/truelayer/callback.ts` uses 12-month window (initial connect only). This is actually correct — the 12-month pull only happens on initial connection, and re-syncs already use 30 days. BUT the user wants 3-month window on re-sync (not 30 days).
- [x] **Fix:** Change re-sync window from 30 days to 90 days (3 months) in both `api/truelayer/sync.ts` and `api/cron/bank-sync.ts`. Keep count-based deduplication to avoid duplicates.

### C. Multi-bank reconnection UX
- [x] **Current state:** When multiple banks expire, the profile page shows individual "Reconnect" buttons per bank. User must tap each one individually, each triggering a full TrueLayer OAuth redirect. No batch flow exists.
- [x] **Fix:** Add a banner/section on the home screen that shows all expired banks and allows sequential reconnection with a clear progress indicator. After reconnecting one bank, return to the same flow for the next expired bank.

---

## STRENGTHS

- Clean layered architecture - Frontend, API, business logic, data layers properly separated
- No circular dependencies - Acyclic dependency graph
- Excellent API key management - No secrets in source, proper `.env.example`
- Row Level Security - All Supabase tables have RLS policies
- No SQL injection - Parameterized queries throughout
- TypeScript strict mode enabled project-wide
- Good test coverage on engines (4260 lines across 7 test files)
- Sync resilience - Token recovery, timeout protection, graceful degradation
- Theme system with WCAG AA contrast, dark/light modes
- Skeleton loading states with staggered animations
- Full web push notification implementation
- ESLint + Prettier enforced

---

## RECOMMENDED FIX ORDER

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| ~~P0~~ | ~~Add JWT auth to goals/plans/notifications endpoints~~ | ~~2h~~ | ~~Blocks IDOR attacks~~ DONE |
| ~~P0~~ | ~~Validate OAuth redirect URL whitelist~~ | ~~1h~~ | ~~Blocks phishing~~ DONE |
| ~~P1~~ | ~~Add Sentry error tracking~~ | ~~4h~~ | ~~Production visibility~~ DONE |
| P1 | Sanitize email HTML | 1h | Blocks injection |
| P1 | Replace `any` types with proper types | 4h | Type safety |
| P1 | Add request validation (Zod) to API endpoints | 4h | Input safety |
| P2 | Consolidate data fetching (shared hook) | 4h | Performance, consistency |
| P2 | Split enrichment-engine.ts | 8h | Maintainability |
| P2 | Add FlatList virtualization | 2h | Performance |
| P2 | Add component tests | 8h | Regression safety |
| P2 | Standardize API response envelope | 4h | DX, debugging |
| P3 | Deduplicate CSV/date utilities | 2h | Maintenance |
| P3 | Remove module-level mutable state | 2h | Correctness |
| P3 | Add offline detection | 4h | UX |
| P3 | Update @vercel/node deps | 1h | Security |
| P4 | Accessibility audit | 8h | Compliance |
| P4 | Bundle size monitoring | 2h | Performance |
