# Fix: "Go to Dashboard" redirects back to Connect screen

**Date:** 2026-03-15

## Root Cause Analysis

After TrueLayer bank connection (Open Banking), the browser does a **full page reload** (`window.location.href = authUrl`). This resets all React state, including the `routedForSession` ref in `AuthGate` to `null`.

### The redirect chain that causes the bug:

1. User on `/connect` → clicks "Connect via Open Banking"
2. `window.location.href = authUrl` → **full page reload** to TrueLayer
3. TrueLayer redirects back → app reloads from scratch
4. `routedForSession.current` = `null` (ref reset on remount)
5. `pendingSignals.bankCallback = true` (detected from URL params)
6. AuthGate effect: `pendingSignals.bankCallback` → returns early → **never sets `routedForSession`**
7. Connect screen handles callback → navigates to `/processing`
8. Processing screen: AuthGate fires, `onOnboarding` guard catches it (processing is in list) → OK
9. Analysis completes → user clicks "Go to Dashboard" → `router.replace('/(main)/(tabs)')`
10. AuthGate fires: `(tabs)` NOT in onboarding list, `routedForSession.current` is still `null`
11. **Routing logic re-runs**: queries DB for analysis
12. If analysis DB insert failed (processing.tsx only warns, doesn't error) → `rows.length === 0` → **redirects to `/connect`**
13. Even if insert succeeded, this unnecessary re-routing adds latency and risk

Same bug exists for the OAuth code exchange path (`pendingSignals.oauth`).

## Fixes

### Fix 1: Set `routedForSession` when consuming signals (`_layout.tsx`)
- When clearing `bankCallback`, also set `routedForSession.current = session.user.id`
- When consuming `oauth` signal, also set `routedForSession.current = session.user.id`
- This ensures the guard works for all subsequent segment changes

### Fix 2: Add `(tabs)` to the "don't re-route" guard (`_layout.tsx`)
- If user is already on `(tabs)` (dashboard), don't run DB queries to potentially redirect them away
- Safety net that prevents AuthGate from ever routing a user AWAY from the dashboard
- Logout scenario is handled separately (`!session && !inAuth` check)

### Fix 3: Retry analysis DB insert on failure (`processing.tsx`)
- Currently, if the Supabase insert fails, it only logs a warning and continues
- Add a single retry with brief delay before continuing
- This reduces the window where AuthGate could find no analysis in DB

## Checklist
- [ ] Fix 1: Set `routedForSession` in `bankCallback` and `oauth` signal handlers
- [ ] Fix 2: Add `(tabs)` to the don't-re-route guard in AuthGate
- [ ] Fix 3: Add retry logic for analysis insert failure in processing.tsx
- [ ] Verify: Walk through all navigation flows to confirm no regressions

## Files
- `app/_layout.tsx` (AuthGate routing logic)
- `app/(main)/processing.tsx` (analysis DB insert)
