# BOCY Design Audit — Full Screen Re-evaluation

> Evaluated by: Frontend Designer Agent + Product Designer Agent
> Date: 2026-03-28
> Theme reference: `theme/index.ts` (spacing: 4/8/16/24/32/48, radius: 8/14/20/28, fonts: Poppins + SpaceMono)

---

## Audit Legend

| Symbol | Meaning |
|--------|---------|
| PASS | Meets world-class fintech standard |
| GAP | Missing or below standard — spec provided below |
| PARTIAL | Implemented but needs refinement |

---

# PHASE 1 — Critical

## 1. Education Screen (`app/(main)/education.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Single primary action per screen | PASS | "Let's get started" CTA is clear |
| Progressive disclosure | PASS | 3-slide carousel, one concept per slide |
| Flow completeness | PASS | Skip available, dots show progress |
| Cognitive load | PASS | Minimal — image + title + body + CTA |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Theme token usage | GAP | `GradientBg` uses hardcoded hex arrays, not theme colors |
| Gradient quality | GAP | Fake gradient — two solid `<View>` halves + blend overlay |
| Scroll color interpolation | GAP | Background set statically per `currentPage`, no interpolation during swipe |
| Vignette overlay | GAP | No edge darkening / premium depth effect |
| CTA button strength | GAP | `rgba(255,255,255,0.2)` is too subtle — needs stronger visual weight |
| Animations | PASS | Staggered cubic entrance, parallax mockup, haptic on slide |
| 8pt grid | PASS | Spacing uses theme tokens (spacing.xxl + spacing.md) |

### Gap Closure Spec — Education

**E1: Real gradient** (`expo-linear-gradient`)
- Install `expo-linear-gradient` dependency
- Replace `GradientBg` component with `<LinearGradient colors={[top, mid, bottom]} locations={[0, 0.5, 1]} />`
- Add a mid-tone for each slide (warm amber midpoint: `#A06E3F`, night sky: `#122040`, green: `#3B7324`)

**E2: Scroll-position color interpolation**
- Use `scrollX.interpolate()` to blend between adjacent slide gradient arrays
- Interpolate each of the 3 gradient stops (top, mid, bottom) independently
- Input range: `[i * width, (i+1) * width]` for each pair of slides
- This makes backgrounds morph fluidly during swipe, not snap on page change

**E3: Vignette overlay**
- Add a `<LinearGradient>` overlay on top of the background:
  - `colors={['rgba(0,0,0,0.3)', 'transparent', 'rgba(0,0,0,0.25)']}`
  - `locations={[0, 0.4, 1]}`
  - `pointerEvents="none"`, position absolute, full coverage
- Creates subtle edge darkening that adds depth and premium feel

**E4: Stronger CTA button**
- Background: `rgba(255,255,255,0.35)` (up from 0.2)
- Border: `rgba(255,255,255,0.5)` (up from 0.3)
- Add shadow: `shadowColor: '#fff', shadowOpacity: 0.15, shadowRadius: 20, shadowOffset: {height: 0}`
- Font size: 17px (up from 16px), letter-spacing: 0.5
- This makes the CTA pop without breaking the glass-morphic aesthetic

---

## 2. Profile Screen (`app/(main)/profile.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Progressive disclosure | GAP | Flat wall of rows — no collapsible sections |
| Information architecture | GAP | Accounts/Debts/Investments not grouped under collapsible headers |
| Single primary action | PARTIAL | No clear primary action — screen is purely navigational |
| Cognitive load | GAP | Too many visible rows at once (banks + debts + investments + settings) |
| Section clarity | PARTIAL | Section labels exist but rows aren't collapsible |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Shared row component | GAP | Each section uses different inline row implementations |
| Accordion animation | GAP | No expand/collapse transitions |
| Visual consistency | PARTIAL | Rows have similar styling but no uniform height/padding |
| Theme token usage | PASS | Uses spacing, colors, fonts from theme |
| State handling | PASS | Loading, error, modals all handled |

### Gap Closure Spec — Profile

**P1: Shared `ProfileRow` component**
- Create reusable component: `{ icon: ReactNode, label: string, value?: string, onPress?: () => void, chevron?: boolean }`
- Consistent height: 52px (spacing.xl + spacing.md = 48 + padding)
- Layout: icon (24px) + spacing.md + label (flex:1, fonts.regular 15px) + value (fonts.mono 13px, colors.text2) + chevron (if onPress)
- Divider: 1px `colors.border` with left inset of 56px (icon width + spacing.md)

**P2: Collapsible section headers**
- Three collapsible groups: **Accounts** (banks), **Debts**, **Investments**
- Header row: section icon + section label (fonts.semibold 14px) + count badge (fonts.mono 11px) + animated chevron
- Chevron rotates 0→90° on expand with 200ms timing
- Default state: all collapsed (show count badge: "3 accounts", "2 debts", "1 investment")
- Tap header → `LayoutAnimation.configureNext(SMOOTH_ANIM)` → toggle content visibility

**P3: Section ordering**
- Financial: Accounts → Debts → Investments (collapsible, progressive disclosure)
- Settings: Notifications → Appearance → Resources (always visible, grouped cards)
- Divider line between Financial and Settings sections (spacing.xl gap)

**P4: Accordion behavior**
- Only ONE financial section expanded at a time (accordion mode)
- Expanding one auto-collapses the others
- Settings sections remain always visible (not collapsible)

---

# PHASE 2 — High Priority (Chat)

## 3. Chat Screen (`app/(main)/(tabs)/chat.tsx`)

### Completed Items
- max_tokens: 180 → 300 DONE
- Tiered word limits (12/40/100) DONE
- MAX_BUBBLES: 2 → 4 DONE
- CHUNK_WORD_THRESHOLD: 12 → 17 DONE
- Suggested question chips DONE (contextual, data-driven)
- Chat memory DONE (via Supabase, 50 messages — adequate)

### Product Designer Evaluation (Remaining Items)

| Criterion | Status | Notes |
|-----------|--------|-------|
| Inline visual cards | GAP | No ChatCard components for spending bars, comparisons |
| Link handling | GAP | No external URL or in-app deep link support |
| Action feedback | PASS | Plan/budget cards with confirm/reject already exist |
| Blank-page anxiety | PASS | Suggestion chips solve this well |

### Frontend Designer Evaluation (Remaining Items)

| Criterion | Status | Notes |
|-----------|--------|-------|
| ChatCard component | GAP | Only text bubbles + action cards; no data visualization cards |
| Markdown link parsing | GAP | Renderer handles bold/italic/code/lists/GIFs but not `[text](url)` |
| Nothing Phone aesthetic | PASS | Dot-matrix voice orb, typewriter text — excellent |

### Gap Closure Spec — Chat

**C1: ChatCard component system**
- Create `components/ChatCard.tsx` with variant types:
  - `SpendingCard`: horizontal bar chart (category → bar → £amount)
  - `TransactionListCard`: scrollable mini-list (date + merchant + amount, max 5 rows)
  - `ComparisonCard`: two-column month-vs-month (left month, right month, delta)
  - `NumberCard`: hero number (large fonts.heading 32px) + trend arrow + context line
- Styling: `colors.surface` bg + `colors.border` 1px + `radius.md`, spacing.md padding
- Cards rendered when AI response contains delimiter `:::card-type {...json} :::`
- Detect delimiters in `splitIntoBubbles()` and render appropriate card component

**C2: Markdown link support**
- Extend `lib/markdown.tsx` to detect `[text](url)` patterns
- Render as `<Text>` with `colors.accent` color + underline
- onPress handler:
  - External URLs (`http://`, `https://`): `Linking.openURL(url)`
  - Internal routes (`bocy://screen-name`): `router.push(path)`
- Add URL validation before opening (reject javascript:, data: schemes)

**C3: Deep link tool**
- Add `navigate_to_screen` tool to chat tools array
- Parameters: `{ screen: string, params?: object }`
- Allowed screens: profile, subscriptions, connect, identity, education
- Renders as a tappable card in chat: "Go to [Screen Name] →"

---

# PHASE 3 — Medium Priority

## 4. Home Screen (`app/(main)/(tabs)/index.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Banner consolidation | GAP | Multiple banners can stack simultaneously |
| Card progressive disclosure | PASS | Expandable moves, plans, insights |
| Spending simplification | PARTIAL | Grouped by category but full detail always visible |
| Insight-first philosophy | PASS | Top insight with £ impact is prominent |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Banner animation | PARTIAL | Dismiss works but no priority queue |
| Card expansion | PASS | LayoutAnimation with SMOOTH_ANIM preset |
| Visual consistency | PASS | Theme tokens throughout |

### Gap Closure Spec — Home

**H1: Banner priority queue (max 1 at a time)**
- Define priority order: connection_warning (P1) > income_arrived (P2) > notification_promo (P3)
- Compute `activeBanner` = highest priority banner with `!dismissed` state
- Render only `activeBanner` — never stack multiple banners
- When dismissed, next-priority banner fades in (300ms, `LayoutAnimation`)

**H2: Spending section simplification**
- Default view: top 3 categories by spend + "See all" link
- "See all" expands to full category list with `LayoutAnimation`
- Each category row: icon + name + bar + £amount (single line, no nested transactions)
- Tap a category → expand inline to show individual transactions

---

## 5. Sign-in/Sign-up (`app/(auth)/sign-in.tsx`, `sign-up.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Bocy brand presence | PASS | Logo + tagline on both screens |
| Google OAuth promoted | PASS | Primary in sign-up, prominent in sign-in |
| Flow simplicity | PASS | Single-screen auth, clear CTA |
| Friction reduction | PASS | Google OAuth = 1 tap |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Visual consistency | PASS | Theme tokens, consistent styling |
| Button hierarchy | PASS | Google prominent, email secondary |

**Status: COMPLETE — no gaps.**

---

## 6. Identity Screen (`app/(main)/identity.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Progress bar | PASS | Dot indicator across all steps |
| Step clarity | PASS | One question per screen |
| Skip-able steps | PASS | Income band, events, dependents all skippable |
| Summary editable | PASS | Summary screen with edit capability |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Dot animation | PASS | Fill progression visible |
| Transitions | PASS | Smooth between steps |
| Theme compliance | PASS | Consistent use of tokens |

**Status: COMPLETE — no gaps.**

---

# PHASE 4 — Low Priority

## 7. Splash Screen (`app/(auth)/splash.tsx`)

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Brand moment | PASS | "BOCY" letterpress with line reveal — premium |
| Timing | PASS | 3.2s total — not too slow, not too fast |
| Glow effect | GAP | No halo/glow around brand text |
| Consistency | PASS | Matches Nothing Phone aesthetic |

### Gap Closure Spec — Splash

**S1: Subtle brand glow**
- Add animated `shadowColor` on the "BOCY" text:
  - `shadowColor: '#fff'`
  - `shadowOpacity`: animate from 0 → 0.3 → 0 over 1.5s (pulse once)
  - `shadowRadius: 30`
  - `shadowOffset: { width: 0, height: 0 }`
- Start glow after text fade-in completes (delay 1100ms = 300ms + 800ms)
- Single pulse, not looping — creates a "breathing" brand moment
- On iOS, pair with `overflow: 'visible'` for glow to render outside bounds

---

## 8. Welcome Screen (`app/(main)/welcome.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Two-step flow | PASS | Intro → form, reduces cognitive load |
| Value proposition | PASS | Benefits listed with numbered badges |
| Friction | PASS | Minimal fields (just first name) |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Input focus state | GAP | No visual change on focus |
| Input error state | GAP | No inline validation feedback |
| Input success state | GAP | No confirmation visual |
| Theme compliance | PASS | Uses theme tokens |

### Gap Closure Spec — Welcome

**W1: Input state styling**
- **Default**: `borderColor: colors.border` (existing)
- **Focused**: `borderColor: colors.accent`, `borderWidth: 1.5` — animate border color over 150ms
- **Error**: `borderColor: colors.coral`, show error text below in `colors.coral` fonts.regular 12px
- **Success**: `borderColor: colors.green`, brief 200ms flash then back to default
- Use `onFocus` / `onBlur` events to toggle state
- Error state: show only if field was touched AND is empty on blur

---

## 9. Connect Screen (`app/(main)/connect.tsx`)

### Product + Frontend Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Trust signals | PASS | FCA + read-only + data-on-device badges |
| Finexer info box | PASS | Clear, credible |
| Visual hierarchy | PASS | Step label → title → description → CTA |
| Multi-bank flow | PASS | Progress indicator for reconnection |

**Status: COMPLETE — no gaps.**

---

## 10. Processing Screen (`app/(main)/processing.tsx`)

### Product + Frontend Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Step messaging | PASS | Clear, action-oriented labels |
| Personalized insight | PASS | Adapts to user profile (remote, single parent, etc.) |
| Dot-matrix animation | PASS | Premium Nothing Phone aesthetic |
| Slow warning | PASS | Reassurance after 45s |
| Error recovery | PASS | Specific, actionable error messages |

**Status: COMPLETE — no gaps.**

---

## 11. Subscriptions Screen (`app/(main)/subscriptions.tsx`)

### Product Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Grouping by category | GAP | Data grouped in logic but UI renders flat list |
| Value communication | PASS | Annual projection + cuttable badge |
| Action path | PASS | "Ask Bocy to help cancel" leads to chat |

### Frontend Designer Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Section headers | GAP | No category group headers in the list |
| Visual hierarchy | PARTIAL | Summary card is strong, but list lacks structure |
| Empty state | PASS | Welcoming BocyFace + CTA |

### Gap Closure Spec — Subscriptions

**SUB1: Category group headers**
- Group subscriptions by category: Streaming, Entertainment, Subscriptions (other)
- Section header: `fonts.mono` 11px uppercase + category name + section total (£/mo)
- Spacing: `spacing.lg` above header, `spacing.sm` below
- If only 1 category, skip the headers (no unnecessary structure)

**SUB2: Category subtotals**
- Each section header shows: `STREAMING  •  £15/mo` (category + dot separator + subtotal)
- Styled: `colors.text2`, monospace, 11px

---

# Summary — All Gaps by Phase

## Phase 1 (Critical) — 7 gaps
| ID | Screen | Gap | Effort |
|----|--------|-----|--------|
| E1 | Education | Real `expo-linear-gradient` | Medium |
| E2 | Education | Scroll color interpolation | Medium |
| E3 | Education | Vignette overlay | Small |
| E4 | Education | Stronger CTA button | Small |
| P1 | Profile | Shared `ProfileRow` component | Medium |
| P2 | Profile | Collapsible section headers | Medium |
| P3+P4 | Profile | Section ordering + accordion | Small |

## Phase 2 (High) — 3 gaps
| ID | Screen | Gap | Effort |
|----|--------|-----|--------|
| C1 | Chat | ChatCard component system | Large |
| C2 | Chat | Markdown link support | Medium |
| C3 | Chat | Deep link tool | Medium |

## Phase 3 (Medium) — 2 gaps
| ID | Screen | Gap | Effort |
|----|--------|-----|--------|
| H1 | Home | Banner priority queue | Medium |
| H2 | Home | Spending section simplification | Medium |

## Phase 4 (Low) — 4 gaps
| ID | Screen | Gap | Effort |
|----|--------|-----|--------|
| S1 | Splash | Subtle brand glow | Small |
| W1 | Welcome | Input focus/error/success states | Small |
| SUB1 | Subscriptions | Category group headers | Small |
| SUB2 | Subscriptions | Category subtotals | Small |

## Already Complete (no action needed)
- Sign-in/Sign-up (Phase 3) — PASS
- Identity (Phase 3) — PASS
- Connect (Phase 4) — PASS
- Processing (Phase 4) — PASS
- Chat: max_tokens, tiered limits, MAX_BUBBLES, CHUNK_WORD_THRESHOLD, suggestion chips, memory — PASS

---

## Total: 16 gaps across 7 screens
- **Small** (< 1 hour): 6 items
- **Medium** (1-3 hours): 8 items
- **Large** (3+ hours): 2 items
