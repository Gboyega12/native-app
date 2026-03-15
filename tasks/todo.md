# Fix: Browser refresh from homepage redirects to connect screen

**Date:** 2026-03-15
**Status:** In Progress

## Diagnosis

**Symptom**: Refreshing the browser while on the homepage `/(main)/(tabs)` redirects to the connect account screen `/(main)/connect`.

**Root cause** — `app/_layout.tsx`, `AuthGate` component:

`routedForSession` is a `useRef` (line 52). On a full page refresh, React unmounts and remounts the entire tree, resetting this ref to `null`. This triggers the full routing gauntlet:

1. Session restores from `localStorage` via Supabase ✓
2. `routedForSession.current` is `null` (ref reset) → routing logic re-runs
3. Onboarding guard (line 129-132) checks `['welcome', 'education', 'identity', 'connect', 'processing']` — `(tabs)` is NOT in this list, so no protection
4. Queries `user_identity` → succeeds
5. Queries `analyses` → **returns empty or fails silently** (likely RLS race: the restored session token may not be ready for PostgREST yet)
6. `rows.length === 0` → `router.replace('/(main)/connect')` ← **BUG**

**Why the previous fix didn't cover this**: The earlier fix (see history below) only set `routedForSession` during signal-consumption paths (TrueLayer callback, OAuth). A plain browser refresh has no pending signals, so that fix doesn't apply.

**Why this is fundamentally a ref problem**: The routing cache needs to survive page refreshes. A React ref cannot do that. `sessionStorage` can.

## Fix

**Replace `useRef` with `sessionStorage`** for `routedForSession`:

- `sessionStorage.getItem('routedForSession')` replaces `routedForSession.current`
- `sessionStorage.setItem('routedForSession', id)` replaces `routedForSession.current = id`
- `sessionStorage.removeItem('routedForSession')` replaces `routedForSession.current = null`

**Why `sessionStorage`**:
- Survives page refreshes within the same tab ✓
- Clears when tab/window closes (new tab → fresh routing) ✓
- Different session ID on new login → routing runs correctly ✓
- Logout sets it to null → next login routes correctly ✓

This is 1 file, ~10 line changes. No new dependencies. No behavioral change except the bug fix.

## Tasks

- [ ] Replace `routedForSession` ref with `sessionStorage` in `app/_layout.tsx`
- [ ] Verify logout clears the storage (line 124 already sets null)
- [ ] Commit and push

---

## Previous Fix History

**2026-03-15 (earlier)**: Fixed TrueLayer/OAuth callback flows not setting `routedForSession` after consuming signals. That fix was correct but only covered signal paths, not plain refresh.
