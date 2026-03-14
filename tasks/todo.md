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

## CURRENT SPRINT: Background Verification (2026-03-14)

### Problem
During onboarding, the processing screen runs Claude AI verification (classifying low-confidence transactions) synchronously on the client. This takes 20-60 seconds depending on transaction volume. If the user leaves the screen, work is orphaned and restarts from scratch on return.

### Solution
Split the enrichment pipeline into two phases:
1. **Fast phase (client):** Rule-based enrichment, profile building, move ranking, save draft analysis. User proceeds to dashboard in ~3 seconds.
2. **Slow phase (server):** Claude classification + move refinement runs as a background API call. Updates the analysis row when done. Dashboard picks up the improved version.

### Step 1: Add verification status to analyses table
- [ ] Add `verification_status` column: `'draft' | 'verifying' | 'verified'`
- [ ] Default to `'verified'` so existing rows are unaffected
- [ ] Add `verified_at` timestamp column (nullable)

### Step 2: New background verification API endpoint
- [ ] Create `api/verify.ts` that accepts `{ user_id }`
- [ ] Authenticate via JWT (same pattern as other endpoints)
- [ ] Read stored CSV from `bank_data`, fetch overrides/identity/debt/goals
- [ ] Run `EnrichmentEngine.enrich()` to get enriched transactions
- [ ] Run Claude classify batches on low-confidence transactions (same logic currently in processing.tsx lines 252-319)
- [ ] Run `EnrichmentEngine.rebuild()` with improved classifications
- [ ] Re-rank moves with `rankMoves()`, run Claude move refinement
- [ ] Update the analysis row with improved data + set `verification_status = 'verified'`, `verified_at = now()`

### Step 3: Modify processing.tsx to skip Claude calls
- [ ] Remove the Claude classify loop (current lines 252-319)
- [ ] Remove the Claude move refinement call (current lines 363-419)
- [ ] Save the analysis with `verification_status: 'draft'`
- [ ] After saving, fire and forget `fetch('/api/verify')` with user's JWT
- [ ] Navigate user to dashboard immediately after save
- [ ] Processing screen now completes in ~3 seconds

### Step 4: Dashboard picks up verified analysis
- [ ] In dashboard `loadData()`, read `verification_status` from the analysis row
- [ ] If status is `'draft'` or `'verifying'`, show subtle text: "Refining your analysis..."
- [ ] Add lightweight poll: if not `'verified'`, re-fetch every 15 seconds (max 4 attempts)
- [ ] When verified version arrives, update state smoothly (no jarring layout shifts)
- [ ] On `syncCoordinator.onSyncComplete()`, also check for status change

### Step 5: Handle edge cases
- [ ] If `/api/verify` fails, keep `verification_status = 'draft'` (not stuck on 'verifying')
- [ ] Next background sync via cron picks up unverified analyses and runs verification
- [ ] If user triggers manual re-analysis, skip the poll and run fresh
- [ ] Ensure verify endpoint is idempotent (safe to call twice)

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
