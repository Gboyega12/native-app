# Implementation Plan

## 1. Remove Remaining Mixpanel / `trackEvent` References

**Problem:** The Mixpanel SDK was removed, but `trackEvent()` calls are still scattered across 4 files with no definition or import — they're dead code that likely throws `ReferenceError` at runtime.

**Files affected:**
- `app/(main)/(tabs)/index.tsx` — ~30+ `trackEvent()` calls
- `app/(main)/(tabs)/chat.tsx` — ~15+ `trackEvent()` calls
- `app/(main)/processing.tsx` — 2 `trackEvent()` calls
- `app/(main)/account-setup.tsx` — 6 `trackEvent()` calls

**Plan:**
- **Option A (Recommended):** Remove every `trackEvent(...)` call from all 4 files. They serve no purpose without a backend. Simple find-and-delete.
- **Option B:** Create a no-op stub (`const trackEvent = () => {}`) in a `lib/analytics.ts` file and import it, preserving the call sites for future analytics integration. More future-proof but adds dead code.

**Recommendation:** Option A — clean removal. When you add a real analytics provider later, you can instrument fresh with the right events.

---

## 2. Users Don't Understand What the App Does Before Signup

**Current flow:** Splash (2.8s "BOCY" animation) → Sign-in page. No explanation of what BOCY does before the user commits to creating an account. The value proposition screens (`welcome.tsx`, `education.tsx`) only appear **after** signup.

**Problem:** Users must create an account blindly. The value prop is hidden behind the auth wall.

**Plan:** Add a **pre-auth landing/hero screen** between splash and sign-in that explains the app:

1. **New screen: `app/(auth)/landing.tsx`** — A single-scroll or swipeable screen shown before sign-in containing:
   - Hero: Bocy character + tagline "Your personal finance companion"
   - 3 short value props (reuse content from `education.tsx`):
     - "Finds the smartest money move you can make right now"
     - "Builds a plan ranked by real impact"
     - "Guides you through each step"
   - A prominent "Get Started" CTA → navigates to sign-up
   - A secondary "Already have an account? Sign in" link → navigates to sign-in

2. **Modify `splash.tsx`:** After animation, route to `/(auth)/landing` instead of `/(auth)/sign-in`

3. **Modify `sign-in.tsx` / `sign-up.tsx`:** Add a back button to return to landing

**Design notes:**
- Matches the Nothing Phone aesthetic (dot-matrix, minimal, monochrome with accent pops)
- Mobile-first, 560px max-width
- Animated entrance (stagger the value props in)
- Keep it to ONE screen — don't add a multi-slide carousel before auth (that's what `education.tsx` is for post-auth)

---

## 3. Missing Account/Asset/Debt Collection Screen Before Dashboard

**Current state:** The screen **does exist** at `app/(main)/account-setup.tsx`. It's in the onboarding flow array in `_layout.tsx`:
```
['welcome', 'education', 'identity', 'connect', 'processing', 'callback', 'account-setup']
```

**Likely issue:** The routing logic in `_layout.tsx` may be skipping it. The AuthGate checks:
1. Has `analyses` rows? → Go to dashboard (skips account-setup!)
2. Has `full_name`? → Go to welcome
3. Has `user_identity`? → Go to education
4. Else → Go to connect

**The problem:** The `processing.tsx` screen runs the analysis and creates `analyses` rows. After processing completes, the AuthGate sees `analyses` exist and routes straight to dashboard, **bypassing `account-setup.tsx`**. The flow is: connect → processing (creates analysis) → AuthGate sees analysis → dashboard. Account-setup never gets reached.

**Plan:**
- **Option A:** Fix the routing logic in `_layout.tsx` — Add a check for `bocy_account_setup_done` localStorage flag BEFORE the analyses check. If the flag is missing, route to `account-setup` instead of dashboard.
- **Option B (Recommended):** Change `processing.tsx` to navigate directly to `account-setup` on completion instead of letting AuthGate handle routing. Then `account-setup` navigates to dashboard when done/skipped.

**Recommendation:** Option B — explicit navigation is more reliable than depending on AuthGate flag checks.

---

## 4. Profile Page: Open Banking for Credit Cards (Currently Manual Only)

**Current state:** The profile page (`app/(main)/profile.tsx`) only offers manual debt entry via a modal. However, the `account-setup.tsx` screen AND the `connect.tsx` screen both have Open Banking integration via Finexer for adding accounts.

**Problem:** After initial onboarding, if a user wants to connect additional credit card accounts via Open Banking from the profile page, they can't — they're stuck with manual entry only.

**Plan:**
1. **Add an "Open Banking" button alongside the manual "Add debt" button** in the profile's debt section
2. **Reuse the Finexer connect flow** from `connect.tsx` / `account-setup.tsx`:
   - When tapped, call `/api/finexer/connect` to initiate a new consent
   - Redirect to bank auth
   - On callback, fetch new accounts and merge into existing `debt_accounts`
3. **Extract the Finexer connect logic** into a shared hook or utility (e.g. `lib/use-finexer-connect.ts`) so it can be used from both onboarding and profile
4. **UI:** Two buttons in the debt section header:
   - "+ Connect via bank" (accent, primary) — triggers Open Banking
   - "+ Add manually" (secondary) — opens existing modal

---

## 5. Manual Card Entry Modal — Poor Design & Usability

**Current state** (`profile.tsx` lines 735-778): A basic modal with:
- Plain text inputs stacked vertically
- No visual hierarchy — all fields look the same
- No input formatting (no £ prefix in balance fields, no % suffix for rate)
- Chip selector for debt type is functional but visually flat
- No progressive disclosure — all optional fields shown at once
- No inline validation or guidance
- Generic "Save" button

**Plan — Redesign the manual debt entry modal:**

1. **Visual hierarchy & grouping:**
   - Group into "Required" (name, type, balance) and "Details" (limit, rate, payment) sections
   - Collapse "Details" behind an expandable "Add more details" toggle (progressive disclosure)

2. **Input formatting & affordances:**
   - Currency inputs: Show "£" prefix inside the input field (not just placeholder)
   - Rate input: Show "%" suffix
   - Auto-format numbers with commas as user types (e.g. "12,500.00")
   - Larger, tappable debt type chips with subtle icons or better active states

3. **Inline validation:**
   - Show validation on blur, not just on save
   - Balance required indicator (asterisk or "Required" tag)
   - Sensible ranges (e.g. interest rate 0-100%, balance > 0)

4. **Better visual design:**
   - Use `Card` component styling for the modal (matching app's design system)
   - Theme-consistent input fields (border color from `colors.border`, focus state with `colors.accent`)
   - Rounded chip selectors with active state that uses accent color
   - Replace "Save" with contextual CTA like "Add Credit Card"

5. **Apply same improvements to the investment and savings modals** for consistency.

---

## Implementation Order

| Priority | Task | Type | Effort |
|----------|------|------|--------|
| 1 | Mixpanel `trackEvent` cleanup | Bug fix | Small |
| 2 | Fix account-setup routing | Bug fix | Small |
| 3 | Pre-auth landing screen | New feature | Medium |
| 4 | Manual entry modal redesign | UX improvement | Medium |
| 5 | Open Banking on profile page | Feature addition | Medium-Large |

Items 1-2 are bug fixes (should be done first). Items 3-5 are enhancements.
