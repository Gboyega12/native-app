# BOCY UI/UX Overhaul — Comprehensive Plan

## Deep Audit Summary

After auditing every screen (splash, onboarding, education, identity, connect, processing, home, chat, profile, subscriptions, goals, account-setup), here is the comprehensive improvement plan. Organized by screen, prioritized by impact.

---

## 1. EDUCATION SCREEN (Onboarding Carousel) — CRITICAL

### Problems Identified
1. **Fake gradient** — `GradientBg` uses two solid `<View>` blocks (50/50 split) with a 35% opacity overlay. Creates a hard visible horizontal line at the midpoint. Looks amateur.
2. **No color transition on swipe** — Background snaps instantly via `SLIDE_BG[currentPage]` in the render. No interpolation during the scroll gesture. When dragging between slides, background stays frozen until `onMomentumScrollEnd` fires.
3. **Glass mockups float on cheap background** — The glass cards are well-designed but sit on the fake gradient, undermining the whole screen.
4. **CTA button too subtle** — `rgba(255,255,255,0.2)` with 0.3 border. Low contrast, easy to miss.

### Plan

**A. Install `expo-linear-gradient`**
- Add dependency
- Replace `GradientBg` with `<LinearGradient>` for real smooth gradients

**B. Animated background color transitions tied to scroll position**
- Use `scrollX.interpolate()` to blend between slide background colors during swipe
- Interpolate each color channel (R, G, B) independently across the `scrollX` input range
- Colors morph fluidly during drag gesture, not just on snap
- Implementation: render 3 overlapping `<LinearGradient>` layers, each with opacity driven by `scrollX` interpolation (opacity 0→1→0 for each slide's range). This avoids RGB string interpolation issues with RN Animated.

**C. Refine gradient palette**
- Richer, more premium gradient pairs:
  - Slide 1: `#D4956A` → `#6B3A1F` (warm gold → deep amber)
  - Slide 2: `#0F1B33` → `#1A3A5C` (deep indigo → midnight blue)
  - Slide 3: `#1B4D2E` → `#3A8C4A` (forest → emerald)
- Add a subtle dark vignette overlay (radial dark edges) for depth

**D. Enhance CTA button**
- Final slide ("Let's get started"): solid white button with dark text — clear primary CTA
- "Next" slides: increase opacity to `rgba(255,255,255,0.3)` bg, `rgba(255,255,255,0.5)` border
- Add subtle scale animation on press (0.97 → 1.0)

**E. Performance**
- Ensure `useNativeDriver: true` where possible
- Three overlapping gradient layers is lightweight (static Views with animated opacity)

### Files Changed
- `package.json` — add `expo-linear-gradient`
- `app/(main)/education.tsx` — rewrite gradient system, enhance button

---

## 2. PROFILE SCREEN — HIGH PRIORITY

### Problems Identified
1. **Flat information dump** — ACCOUNT section shows banks, debts, and investments as one continuous list. With 3 banks + 2 debts + 4 investments = 9+ rows of dots/text with no visual hierarchy. Looks rowdy and overwhelming.
2. **No progressive disclosure** — Everything visible at once. No grouping, no collapse/expand.
3. **Inconsistent section patterns** — ACCOUNT = raw rows, NOTIFICATIONS = toggles, RESOURCES = links. No shared component language.
4. **"+ Add account"/"+ Add debt" dashed buttons feel disconnected** — Sit between unrelated content.
5. **No icons or nav affordances** — Unlike RESOURCES which has link behavior, ACCOUNT items have no visual cue for interactivity.

### Plan

**A. Progressive disclosure with collapsible sections**
Restructure the ACCOUNT mega-section into distinct expandable rows:

```
[wallet-outline]     Connected Accounts    3         [chevron]
[card-outline]       Debts                 £4,200    [chevron]
[trending-up]        Investments           £24,180   [chevron]
[notifications]      Notifications                   [chevron]
[moon-outline]       Appearance            Dark      [chevron]
─────────────────────────────────────────────────────
[help-circle]        Support                         [chevron]
[shield-outline]     Privacy                         [chevron]
[document-text]      Terms                           [chevron]
```

Each row: icon + label + optional value/badge + chevron. Tapping expands inline to show contents + add button. Uniform pattern across ALL sections.

**B. Shared `ProfileRow` component**
Single component used everywhere:
- Left: Ionicon
- Center: label + optional subtitle
- Right: value badge / switch / chevron (variant prop)
- Consistent 56px height, padding, border treatment

**C. Expanded state design**
When a row expands (e.g., "Connected Accounts"):
- Smooth `LayoutAnimation` slide-down
- Show compact cards for each connected item (status dot, name, meta, action)
- "+" add button at bottom of expanded section
- Collapse other expanded sections (accordion behavior)

**D. Remove section headers**
- Kill "ACCOUNT", "NOTIFICATIONS", "APPEARANCE", "RESOURCES" labels
- The icon + label rows ARE the sections now
- Use subtle dividers between logical groups (accounts group / settings group / resources group)

**E. Visual refinements**
- Avatar section: subtle surface card background
- Logout: bottom of screen, muted text, no card treatment
- Delete account: red text, separate from logout, with confirmation

### Files Changed
- `app/(main)/profile.tsx` — full restructure
- `components/ProfileRow.tsx` — new shared component

---

## 3. CHAT SCREEN — HIGH PRIORITY

### Problems Identified
1. **12-word hard limit too restrictive** — System prompt says "EVERY reply MUST be 12 words or fewer." Complex financial answers get truncated into meaningless fragments. Users asking for explanations get "want me to dig in?" when they already asked to dig in.
2. **`MAX_BUBBLES = 2` hard cap on client** — Even when the system prompt allows exceptions for "detailed breakdowns", the client-side constant truncates everything to 2 bubbles regardless.
3. **`max_tokens: 180`** — API ceiling too low for any meaningful detailed response.
4. **No visual explanations** — Pure text. No charts, spending breakdowns, or visual cards. This is a financial app where numbers are the core value.
5. **No transaction visibility in chat** — System prompt has transaction context but chat never shows recent transactions, spending trends, or breakdowns visually.
6. **Memory is session-only** — Chat resets on app restart. No persistence.
7. **No external link handling** — Can't open URLs or navigate to app screens from chat.

### Plan

**A. Dynamic response constraints (API-side: `api/chat/index.ts`)**
- Increase `max_tokens` from 180 → 512
- Modify system prompt word limit to a TIERED system:
  - **Quick replies** (greetings, confirmations, yes/no): ≤15 words (keep the punchy WhatsApp vibe)
  - **Standard answers** (lookups, single-number responses): ≤30 words
  - **Detailed breakdowns** (user explicitly asks "explain", "break down", "walk me through", "how does", "step by step", multi-part questions): up to 100 words, structured with **bold** key numbers
  - **Action results** (tool use confirmations): ≤20 words
- The existing `detectConversationMode()` function already classifies messages — wire it into the system prompt dynamically
- Keep the conversational tone rules — those are excellent. Just remove the hard 12-word ceiling.

**B. Increase client-side bubble limits (`chat.tsx`)**
- Change `MAX_BUBBLES` from 2 → 5
- Change `CHUNK_WORD_THRESHOLD` from 12 → 20
- This allows the AI's longer responses to render properly when sent

**C. Visual cards in chat (new: `ChatCard` components)**
Create inline visual components rendered inside chat:
- **SpendingCard**: Horizontal bar chart of top 5 categories with £ amounts
- **TransactionListCard**: Compact scrollable list of recent transactions
- **ComparisonCard**: This month vs last month side-by-side
- **ProgressCard**: Plan/goal progress bar with numbers
- **NumberCard**: Large hero number with label + trend arrow (e.g., "NET WORTH £24,180 ↑8.2%")

**Implementation approach:**
- API returns structured JSON blocks using a delimiter syntax: `:::chart-type {"data":{...}} :::`
- Client `Markdown` renderer detects these blocks and renders the `ChatCard` component
- Add 2-3 new tools to the API so Claude can emit structured visual data:
  - `render_spending_breakdown` — returns category bars
  - `render_transaction_list` — returns recent transactions
  - `render_comparison` — returns period comparison

**D. Chat memory persistence**
- Save conversation history to `AsyncStorage` keyed by user ID
- On mount, load last 30 messages as initial state
- Show session separators ("Today", "Yesterday", "Mar 25")
- Cap stored history at 50 messages
- Clear on logout
- Feed last 10 messages as context to the API (already partially done)

**E. External link & deep link handling**
- URLs in responses → tappable with `Linking.openURL()`
- App screen references ("check your profile", "see your subscriptions") → inline buttons that call `router.push()`
- Add a `navigate_to_screen` tool so Claude can suggest navigation

**F. Suggested question chips**
- Show 3-4 contextual chips above input when chat is empty or after each response
- Chips change based on financial state:
  - After payday: "How should I split this paycheck?"
  - High spending: "What am I overspending on?"
  - Has surplus: "What should I do with my surplus?"
  - Default: "How am I doing?", "Break down my spending", "What's my net worth?"
- Chips disappear once user starts typing

### Files Changed
- `api/chat/index.ts` — increase max_tokens, modify system prompt tiers, add visual tools
- `app/(main)/(tabs)/chat.tsx` — increase MAX_BUBBLES/CHUNK_WORD_THRESHOLD, add memory, add suggested chips, add chat card rendering
- `components/ChatCard.tsx` — new visual card components
- `lib/markdown.tsx` — extend parser for `:::type {...} :::` blocks

---

## 4. SPLASH SCREEN — LOW PRIORITY (Already Clean)

### Current State
Minimal black background, "BOCY" text reveal with animated underline bar. Well-executed.

### Minor Improvements
- Add subtle breathing glow on underline bar (pulsing opacity 0.6→1.0) for life
- Ensure no white flash on transition to sign-in
- **No major changes needed**

### Files Changed
- `app/(auth)/splash.tsx` — minor animation addition

---

## 5. SIGN-IN / SIGN-UP — MEDIUM PRIORITY

### Problems
1. Generic form layout without personality
2. No visual brand presence (no Bocy character)
3. Google OAuth could be more prominent

### Plan
- Add small Bocy face above the form (consistent brand)
- Make "Continue with Google" the primary CTA (larger, filled) — most users prefer OAuth
- Email/password as secondary option below a divider
- Subtle entrance animation (fade + slide up)

### Files Changed
- `app/(auth)/sign-in.tsx` — add Bocy, reorder CTAs
- `app/(auth)/sign-up.tsx` — match sign-in treatment

---

## 6. IDENTITY SCREEN (Onboarding Questions) — MEDIUM PRIORITY

### Problems
1. 8 screens of questions with no progress indicator
2. All option cards look the same weight — no hierarchy

### Plan
- Add thin progress bar at top (step X of 8)
- Subtle micro-animations on card selection (scale pulse 1.0→1.05→1.0)
- Consider combining housing + household into one screen (reduce to 7 steps)

### Files Changed
- `app/(main)/identity.tsx` — add progress bar, selection animations

---

## 7. HOME SCREEN — MEDIUM PRIORITY

### Problems
1. **Banner fatigue** — Multiple banners stack (offline, connection warning, income, review nudge, learning signal). Wall of banners before content.
2. **Move cards too complex** — Math boxes, trajectory bands, sub-goals all visible. Overwhelming for new users.
3. **Category breakdowns dense** — Expandable transactions within expandable categories within expandable sections.

### Plan

**A. Banner consolidation**
- Max 1 banner at a time. Priority: offline > connection warning > income > review nudge
- Non-critical signals (learning) become auto-dismissing toasts
- Smooth slide-in/out transitions

**B. Move cards progressive disclosure**
- Default collapsed: title + monthly/annual impact + effort badge only
- "See the math" and trajectory hidden behind tap
- Sub-goals hidden until move started

**C. Spending section simplification**
- Show top 3 categories only when collapsed, "See all" to expand
- Each category: name + amount + simple bar (no inline transactions)
- Transaction detail in bottom sheet, not inline

### Files Changed
- `app/(main)/(tabs)/index.tsx` — banner logic, card collapse defaults

---

## 8. CONNECT SCREEN — LOW PRIORITY

### Minor Improvements
- Add trust copy: "Bank-grade encryption", "Read-only access"
- "Upload statement" option more visible (many users fear Open Banking)

### Files Changed
- `app/(main)/connect.tsx` — copy additions

---

## 9. PROCESSING SCREEN — LOW PRIORITY

### Minor Improvements
- Friendlier step descriptions:
  - "Scanning transactions" → "Reading your spending"
  - "Enriching transactions" → "Understanding your merchants"
  - "Detecting optimisation opportunities" → "Finding ways to save"
- Add timeout + error state for stuck processing

### Files Changed
- `app/(main)/processing.tsx` — copy updates

---

## 10. WELCOME SCREEN — LOW PRIORITY

### Minor Improvements
- Clear focus state on name input (accent border)
- Benefits section: icon + text pattern instead of numbers

### Files Changed
- `app/(main)/welcome.tsx` — input styling, benefits layout

---

## 11. SUBSCRIPTIONS SCREEN — LOW PRIORITY

### Minor Improvements
- Total monthly subscription spend at top
- Group by: active / detected / cancelled
- Add "Annual cost" display

### Files Changed
- `app/(main)/subscriptions.tsx` — layout additions

---

## Implementation Phases

### Phase 1 — Visual Foundation (Critical, do first)
| # | Task | Files | Effort |
|---|------|-------|--------|
| 1 | Install `expo-linear-gradient` | `package.json` | Small |
| 2 | Education screen gradient overhaul + animated transitions | `education.tsx` | Medium |
| 3 | Profile screen progressive disclosure restructure | `profile.tsx`, new `ProfileRow.tsx` | Large |

### Phase 2 — Chat Intelligence
| # | Task | Files | Effort |
|---|------|-------|--------|
| 4 | Dynamic response constraints + increase max_tokens | `api/chat/index.ts` | Medium |
| 5 | Increase client bubble limits + suggested chips | `chat.tsx` | Small |
| 6 | Chat visual cards (spending, transactions, comparison) | new `ChatCard.tsx`, `markdown.tsx` | Large |
| 7 | Chat memory persistence | `chat.tsx` | Medium |

### Phase 3 — Screen Polish
| # | Task | Files | Effort |
|---|------|-------|--------|
| 8 | Home banner consolidation | `index.tsx` | Medium |
| 9 | Home move card progressive disclosure | `index.tsx` | Medium |
| 10 | Sign-in/sign-up brand presence | `sign-in.tsx`, `sign-up.tsx` | Small |
| 11 | Identity progress bar | `identity.tsx` | Small |

### Phase 4 — Refinements
| # | Task | Files | Effort |
|---|------|-------|--------|
| 12 | Splash breathing glow | `splash.tsx` | Tiny |
| 13 | Welcome screen polish | `welcome.tsx` | Tiny |
| 14 | Connect trust signals | `connect.tsx` | Tiny |
| 15 | Processing copy | `processing.tsx` | Tiny |
| 16 | Subscriptions grouping | `subscriptions.tsx` | Small |

---

## New Components Needed

| Component | Purpose |
|-----------|---------|
| `ProfileRow` | Shared row for profile screen (icon + label + right element) |
| `ChatCard` | Base wrapper for inline chat visuals |
| `ChatCardSpending` | Bar chart for spending categories |
| `ChatCardTransactions` | Compact transaction list |
| `ChatCardComparison` | Side-by-side period metrics |
| `ChatCardProgress` | Goal/plan progress bar |
| `ChatCardNumber` | Hero number with trend |

---

## Design Principles Applied

Per BOCY design system:
- **Clarity over complexity** — Progressive disclosure everywhere, show less by default
- **Data → insight → action** — Chat cards turn numbers into visuals into tappable actions
- **Trust-first design** — Connect screen trust signals, profile consent health bars
- **Calm, premium UI** — Real gradients, subtle animations, no visual noise
- **Minimal but powerful** — Fewer visible elements, same (or more) functionality
