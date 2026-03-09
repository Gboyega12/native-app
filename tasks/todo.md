# Hero Cards + Design Upgrade Plan

## Part 1: Hero Cards — Same Height, Separated, Animated Indicator

### 1.1 Equal-height hero cards
- Set a shared `minHeight` on both card wrappers so they match visually
- Add horizontal gap between cards (12px) so they appear separated, not edge-to-edge
- Both cards render inside the existing Animated.ScrollView with snapToInterval

### 1.2 Horizontal ConnectorDots between cards
- Create `HorizontalConnectorDots` component (or add `direction` prop to existing ConnectorDots)
- Place it as an overlay between the two cards — centered vertically, positioned at the gap
- 5-7 small dots arranged horizontally with staggered pulse animation
- Pulse triggers on scroll (when user starts dragging toward card 2)
- Uses same cascade pattern: color animates base → accent, scale pulses 1 → 1.5 → 1
- Dots flow left-to-right when scrolling right, right-to-left when scrolling back

### 1.3 Animated dot indicator
- Replace discrete `heroPage` state-driven dots with scroll-interpolated Animated.View dots
- Derive dot width from `heroScrollX` interpolation:
  - Dot 0 width: scrollX [0 → cardWidth] maps to [12 → 3]
  - Dot 1 width: scrollX [0 → cardWidth] maps to [3 → 12]
- Also interpolate backgroundColor for smooth color transition
- Keep setHeroPage for haptic tick, but dots are purely animated

## Part 2: Discussion — Design Upgrades for Onboarding & Profile

### Current State
- **Onboarding pages** (welcome, education, connect, processing, identity, goals): mostly static layouts, basic fade transitions, no Card components, direct theme imports
- **Profile page**: uses AnimGlyph for entrance, LayoutAnimation for list changes, Switch for theme toggle, direct color imports mixed with useTheme()
- **Auth pages** (splash, sign-in, sign-up): minimal animation, standard form layouts

### Proposed Upgrades (for discussion)

#### Onboarding Flow
| Page | Upgrade | Impact |
|------|---------|--------|
| **welcome.tsx** | Add AnimGlyph entrance for hero + AnimatedNumber for any stats shown | Low — cosmetic polish |
| **education.tsx** | Replace basic fade with page-swipe carousel (reuse hero card pattern with snap + animated dots) | Medium — new interaction pattern |
| **identity.tsx** | Add AnimGlyph stagger to option cards, pulse animation on selection | Low — entrance polish |
| **processing.tsx** | Already has strong animations (DotMatrix pulse). Could add SpendingRing for final summary | Low — enhancement |
| **connect.tsx** | Add Skeleton loading states during OAuth redirect wait | Low — loading UX |
| **goals.tsx** | AnimGlyph entrance for step content, breathing indicator on active step | Low |

#### Profile Page
| Area | Upgrade | Impact |
|------|---------|--------|
| **Account cards** | Use Card component with BreathingBar for connection health | Medium |
| **Debt accounts** | SpendingRing showing debt-to-income ratio | Medium — new visualization |
| **Stats section** | AnimatedNumber for key metrics (total accounts, monthly income, etc.) | Low |
| **Settings cards** | AnimGlyph stagger entrance | Low |
| **Theme toggle** | Restore cross-fade overlay animation (removed in recent fix) | Low |

#### Shared Component Adoption
- Migrate all pages from direct `import { colors } from '@/theme'` to `useTheme()` for dark/light mode support
- Wrap option selectors in `AnimatedCard` for entrance animations
- Add `DashboardSkeleton`-style skeletons to any page with async data loading
- Use `ConnectorDots` (vertical) between logical sections on longer pages

### Priority Recommendation
1. **High**: Hero card fixes (Part 1) — directly requested
2. **Medium**: education.tsx carousel upgrade (reuses hero card pattern)
3. **Medium**: Profile account cards with Card component + BreathingBar
4. **Low**: AnimGlyph/AnimatedNumber polish across other pages
5. **Low**: Theme migration to useTheme() across all onboarding pages

---

## Checklist
- [ ] Implement equal-height hero cards with gap
- [ ] Build HorizontalConnectorDots component
- [ ] Implement scroll-driven animated dot indicator
- [ ] Integrate connector animation with scroll events
- [ ] Test and verify on web
- [ ] Commit and push
