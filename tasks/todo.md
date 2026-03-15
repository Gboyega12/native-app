# Fix: New Users Bypass Onboarding Flow

**Date:** 2026-03-15

## Problem

New users are taken directly to the dashboard, skipping the entire onboarding process. Root cause is a two-part routing flaw between `app/index.tsx` and `AuthGate` in `app/_layout.tsx`.

## Plan

### Step 1: Fix `app/index.tsx` — stop blindly redirecting to dashboard
- [ ] Remove `if (hasSession) return <Redirect href="/(main)/(tabs)" />;`
- [ ] For authenticated users, render a loading screen and let AuthGate handle routing
- [ ] Keep TrueLayer bank redirect detection as-is

### Step 2: Refactor `AuthGate` in `app/_layout.tsx` — guard ALL authenticated routes
- [ ] Expand routing logic so onboarding checks run for ALL authenticated users, not just those on `(auth)` routes
- [ ] Define onboarding screens as allowed pass-through routes (welcome, education, identity, connect, processing)
- [ ] Guard protected routes (tabs, profile, etc.) — redirect incomplete users to correct onboarding step
- [ ] Keep all special-case handling (email confirm, OAuth, bank callback) intact

### Step 3: Verify all flows
- [ ] New user email signup → full onboarding
- [ ] New user Google OAuth → full onboarding
- [ ] Existing user → dashboard
- [ ] Page refresh during onboarding → resume correct step
- [ ] Email confirmation redirect → works as before
- [ ] TrueLayer OAuth redirect → works as before
- [ ] Bank callback redirect → works as before

### Files
- `app/index.tsx`
- `app/_layout.tsx`
