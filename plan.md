# Implementation Plan: Dashboard Restructure & Notification System

## Overview
Major restructuring of the dashboard layout, removal of the Plan page, UI overhaul for add-account/investment screens, income card cleanup, and functional PWA notifications.

---

## Phase 1: Dashboard Layout Restructure
**File:** `app/(main)/(tabs)/index.tsx`

### 1A. Remove Carousel, Make #1 Move the First Card
- Remove the horizontal snapping pager/carousel wrapper and pagination dots
- Render the **#1 Move card** as a standalone, full-width card at the **top** of the dashboard
- Keep: move title, monthly/annual impact, progress bar, "Start this move" CTA
- Remove the secondary move card page (it moves into "Your Insights" below)

### 1B. Restructure "Your Insights" Section (Below #1 Move)
- Rename nothing here - this stays as "Your Insights"
- Redesign to match the current "inefficiency detected" card pattern:
  - One **primary parent card** containing embedded insight moves
  - Show **2 insight moves** visible by default
  - Add a collapsible **"Other moves"** section within the card that expands/collapses to reveal remaining moves
- This section sits directly below the #1 Move card

### 1C. Rename "Your Insights" (Inefficiency Detected Cards) to "Highlights"
- The current section that shows detected inefficiencies with annual impact badges gets renamed from "Your Insights" to **"Highlights"**
- Keep the existing card design (statement, annual impact badge, expandable cause/implication/5-year impact)
- Just update the section title text

### 1D. Daily Spending Card - Independent & Open Banking Connected
- Remove the daily spending sparkline from inside the hero/carousel area
- Create a **standalone Daily Spending card** placed **below** the "Your Insights" moves section
- Connect data source to Finexer open banking integration (`lib/finexer.ts`) instead of any local/mock data
- Card shows: daily spending line chart, current day's spend, safe-to-spend amount
- Data flow: Finexer sync -> transactions -> daily aggregation -> card

### Final Dashboard Order (top to bottom):
1. **#1 Move Card** (standalone, full-width)
2. **Your Insights** (moves section - primary card with 2 visible + collapsible others)
3. **Highlights** (formerly "Your Insights" inefficiency cards)
4. **Daily Spending Card** (standalone, open-banking-powered)
5. **Income Card** (minus Savings variable - see Phase 2)
6. Debt Accounts
7. Investments
8. Account Balances & Buckets

---

## Phase 2: Income Card - Remove "Savings" Variable
**File:** `app/(main)/(tabs)/index.tsx` (~lines 3370-3500)

- Remove `const savingsTotal = analysis?.monthly_savings ?? 0` usage from the income breakdown rows
- Remove the "Savings" row from the rendered list (Income, Essentials, Lifestyle, ~~Savings~~, Surplus)
- Keep the underlying data calculation if used elsewhere, just remove from display

---

## Phase 3: Remove Plan Page
**Files:** `app/(main)/(tabs)/plan.tsx`, `app/(main)/(tabs)/_layout.tsx`

- Delete `plan.tsx` entirely
- Remove the Plan tab from `_layout.tsx` tab navigation
- Result: Bottom tabs become **Home** and **Chat** only (2 tabs)
- Check for any navigation links pointing to the Plan tab and remove/redirect them

---

## Phase 4: Add Account/Investment Screen Overhaul
**Files:** `app/(main)/account-setup.tsx`, `app/(main)/profile.tsx`

### 4A. Add Account Screen - Grid Layout (Matching Reference Images)
Replace horizontal pill scrolls with a **clear, visible grid layout**:

- **Categories section** (full-width stacked cards):
  - "Connect bank accounts and credit cards" (with bank logos: Chase, BoA, etc.)
  - "Connect investments and loans" (with brokerage logos: Fidelity, Vanguard, etc.)
  - "Add your property" (with home + Zillow/Zoopla icons)
  - "Add your Crypto" (with Bitcoin + Coinbase icons)
  - "Import from Mint, Monarch, or .csv" (with app logos)

- **Additional categories** (2-column grid of cards):
  - Connect Apple card (full-width with Apple logo)
  - Insurance | Valuables
  - Private Equity | Vehicles
  - Pensions and annuities | Cash
  - Unpaid Debt | Other

- Each card: rounded rectangle with icon/logo centered, label below, no horizontal scrolling

### 4B. Add Investment Section in Profile - Progressive Disclosure
- Replace current flat modal with **progressive disclosure** pattern:
  - Step 1: Choose investment type (grid of cards, not pill scroll)
  - Step 2: Enter details relevant to chosen type (fields appear progressively)
  - Step 3: Optional advanced fields (ticker, platform, cost basis) revealed on demand
- Asset class selection: grid cards instead of horizontal pill scroll
- Same pattern for debt type, savings type, property type, mortgage type selections

### 4C. Profile/Settings Screen - Match Reference Image
- Add **"SPECIAL OFFER"** section at top with gradient banner: "Invite friends and get Origin for $1"
- **ACCOUNT** section (grouped card): Profile, Notifications, Membership, Security, Linked Accounts
- **PREFERENCES** section (grouped card): Spending Settings, AI Financial Profile, Appearance (with expand chevron)
- **RESOURCES** section (grouped card): Support, Documents
- **Logout** button (separate card, red text)
- App version footer

---

## Phase 5: PWA Notifications - Make Functional
**Files:** `public/sw.js`, `lib/web-push.ts`, `lib/notifications.ts`, `api/notifications/subscribe.ts`, new API routes

### 5A. Fix Core Push Notification Flow
- Verify service worker registration and activation lifecycle
- Ensure `subscribe()` in `useWebPush` correctly stores VAPID subscription in Supabase
- Add server-side push sending via `web-push` npm package (currently only subscription storage exists, no actual sending)
- Create **`api/notifications/send.ts`** endpoint that:
  - Fetches user's push subscription from Supabase
  - Sends push notification via web-push library
  - Handles expired/invalid subscriptions gracefully

### 5B. Payday Alert Notification
- On income detection (during Finexer sync), trigger push notification:
  - Title: "Payday Alert"
  - Body: "Your salary of X has arrived"
  - Click action: Opens app to dashboard
- Hook into `api/finexer/sync.ts` - after detecting income transactions, call notification send

### 5C. Spending Limit Notifications (50% Threshold)
- After each sync or spending event, calculate `left_to_spend / spending_limit`
- When ratio crosses **50%** threshold, send push notification:
  - Title: "Spending Alert"
  - Body: "You've used 50% of your spending limit. X left to spend."
  - Click action: Opens app to dashboard daily spending card
- Track notification state to avoid duplicate alerts (store last threshold notified in Supabase)

### 5D. Growth Engine Time-Sensitive Notifications
- Create a **scheduled check** (could be cron/edge function) that evaluates:
  - Tax season deadlines (e.g., ISA deadline April 5th, Self Assessment January 31st)
  - Unused tax allowances (ISA allowance remaining, pension allowance, CGT allowance)
- Send notifications like:
  - Title: "Tax Season Ending Soon"
  - Body: "You have X ISA allowance remaining. Use it before April 5th."
  - Click action: Opens app to **chat** with pre-loaded context explaining the recommendation
- On notification click, pass context to chat so Bocy can explain the reasoning and next steps

### 5E. Notification Click Deep Linking
- Update `sw.js` `notificationclick` handler to support different action URLs based on notification type:
  - Payday -> `/` (dashboard)
  - Spending limit -> `/` (dashboard, scroll to spending)
  - Tax/growth -> `/chat?context=tax_optimization` (chat with pre-loaded context)
- Ensure clicking a notification when the app is in background properly focuses and navigates

---

## Phase Summary & Dependencies

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| 1: Dashboard Restructure | High | None |
| 2: Remove Savings from Income | Low | None |
| 3: Remove Plan Page | Low | None |
| 4: Add Account/Profile Overhaul | Medium | None |
| 5: PWA Notifications | High | Finexer integration (existing), web-push npm package |

**Suggested implementation order:** Phase 3 -> Phase 2 -> Phase 1 -> Phase 4 -> Phase 5

Phases 2 and 3 are quick wins. Phase 1 is the core dashboard work. Phase 4 is UI refactoring. Phase 5 is the most complex as it requires server-side push infrastructure.
