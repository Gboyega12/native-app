# Frontend Design Skill

## Purpose
Governs all UI implementation decisions — layout, styling, animations, and visual consistency.

---

## Design System Rules

### Spacing (8pt Grid)
- All spacing must use theme `spacing` tokens
- Vertical rhythm: consistent gaps between sections
- Horizontal padding: uniform across screens
- Never use magic numbers — always reference the spacing scale

### Typography Hierarchy
- `fonts.heading` — screen titles, hero numbers
- `fonts.semibold` — section headers, labels, CTAs
- `fonts.regular` — body text, descriptions
- `fonts.mono` — tags, badges, micro-labels (uppercase)
- Letter-spacing: tight for headings (-0.3 to -0.5), wide for mono labels (1-3px)

### Color System
- Semantic colors only: `colors.accent`, `colors.coral`, `colors.green`, `colors.amber`
- Dim variants for backgrounds: `colors.greenDim`, `colors.accentDim`
- Surface layers: `colors.surface`, `colors.surface2`
- Text hierarchy: `colors.text`, `colors.text2`, `colors.muted`
- Never hardcode hex values — always reference theme

### Radius System
- `radius.sm` — small elements, badges, chips
- `radius.md` — cards, inputs, buttons
- `radius.lg` — modals, large cards
- `radius.full` (999) — pills, avatars

### Animation Standards
- Entrance: 400-700ms with cubic easing
- Stagger: 100-200ms between sequential items
- Micro-interactions: 150-300ms
- Breathing: 2-4s loop with gentle scale (1.0 → 1.04)
- Always use `LayoutAnimation.configureNext(SMOOTH_ANIM)` for layout changes
- Haptic feedback: `hapticTick()` for selections, `hapticSuccess()` for completions

### Component Patterns
- Cards: `colors.surface` bg + 1px `colors.border` + `radius.md`
- Buttons: full-width + accent bg + white text + `radius.md` + 14-18px vertical padding
- Inputs: `colors.surface` bg + 1px `colors.border` + `radius.lg` + 16px horizontal padding
- Badges: `colorDim` bg + `color` text + `fonts.mono` 9-11px uppercase
- Rows: icon + label + chevron/value, consistent height

### Nothing Phone Aesthetic
- Dot-matrix patterns for loading states
- Letterpress typography (ultra-sparse letter-spacing on brand text)
- Minimal, geometric animations
- Monochrome base with strategic accent pops
- Glass-morphism for overlays (rgba backgrounds)

---

## Quality Gates

Before shipping any UI:
1. Does it use theme tokens exclusively? (no magic numbers)
2. Is spacing on the 8pt grid?
3. Are animations smooth on low-end Android?
4. Does it handle all states? (empty, loading, error, success)
5. Is text hierarchy clear at a glance?
6. Would a top-tier fintech ship this?
