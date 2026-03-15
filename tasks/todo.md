# Fix: "Go to Dashboard" redirects back to Connect screen

**Date:** 2026-03-15
**Status:** Complete

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

## Fixes Applied

### Fix 1: Set `routedForSession` when consuming signals (`_layout.tsx`)
- [x] When clearing `bankCallback`, also set `routedForSession.current = session.user.id`
- [x] When consuming `oauth` signal, also set `routedForSession.current = session.user.id`

### Fix 2: Gate completion UI on confirmed DB insert (`processing.tsx`)
- [x] Extract insert payload, retry once on failure with 1s delay
- [x] If both attempts fail, throw error → shows error UI instead of fake "Your plan is ready"

## Verified Flows
- [x] TrueLayer bank connection (the bug scenario) → dashboard
- [x] CSV/PDF upload (no page reload) → dashboard
- [x] OAuth code exchange path → dashboard
- [x] Existing user normal load → dashboard
- [x] DB insert failure → error UI (not fake success)
- [x] Email confirmation redirect → unaffected
- [x] Bank callback with delayed session restore → protected by guard

## Files
- `app/_layout.tsx` (AuthGate routing logic)
- `app/(main)/processing.tsx` (analysis DB insert)
