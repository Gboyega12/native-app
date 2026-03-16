# Fix: Persistent routing & navigation issues

**Date:** 2026-03-16
**Status:** Complete

## Diagnosis

**Symptoms** (overnight idle):
1. App reopens to connect bank screen instead of dashboard
2. Back button walks through stale onboarding history (processing → dashboard)

**Root causes** — three compounding bugs:

1. **Token refresh nukes routing cache**: `onAuthStateChange` ignored the `_event` param. Overnight token refresh fires a transient null session → `setRouted(null)` wipes cache → full DB reconstruction runs → fragile query chain routes to wrong screen.

2. **No durable onboarding flag**: Every cache miss reconstructs onboarding state by querying 3 tables (`user_identity` → `analyses` → routing). Any failure defaults to an earlier onboarding step.

3. **Navigation stack not cleared**: `router.replace()` in processing.tsx only replaces the top entry. Onboarding screens (welcome → education → identity → connect → processing) remain in back stack.

## Fix (3 parts)

### 1. Use `_event` parameter in `onAuthStateChange`
- Only clear routing cache + analytics on `SIGNED_OUT` event
- Ignore transient null sessions from `TOKEN_REFRESHED` / `INITIAL_SESSION`
- File: `app/_layout.tsx`

### 2. Durable `bocy_onboarding_done` localStorage flag
- Set in `processing.tsx` after analysis saves successfully
- Checked in `_layout.tsx` routing — if flag exists + valid session → dashboard directly
- Cleared on `SIGNED_OUT` so new login routes correctly
- Files: `app/_layout.tsx`, `app/(main)/processing.tsx`

### 3. Reset navigation stack after processing
- Use `CommonActions.reset()` instead of `router.replace()` in processing.tsx
- Resets `(main)` stack to only contain `(tabs)` — no onboarding ghost entries
- File: `app/(main)/processing.tsx`

## Tasks

- [x] Fix 1: Use `_event` param, only clear cache on `SIGNED_OUT`
- [x] Fix 2: Add `bocy_onboarding_done` localStorage flag
- [x] Fix 3: Clear navigation stack with `CommonActions.reset()`
- [x] Commit and push

---

## Previous Fix History

**2026-03-15**: Replaced `useRef` with `sessionStorage` for `routedForSession` to survive page refreshes. Added destination caching to skip DB queries on refresh.

**2026-03-15 (earlier)**: Fixed TrueLayer/OAuth callback flows not setting `routedForSession` after consuming signals.
