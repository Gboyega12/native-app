# Product Design Skill

## Purpose
Governs all UX decisions — user flows, information architecture, behavioral design, and product strategy.

---

## UX Principles

### Progressive Disclosure
- Show only what's needed at each step
- Collapse secondary info behind expandable sections
- Default to the simplest view; let users dig deeper on demand
- Never present a wall of information

### Flow Design
- Every screen must have ONE clear primary action
- Reduce steps to minimum viable (merge screens where possible)
- Support escape hatches (skip, back, dismiss) without penalising
- State transitions should feel natural (fade, slide, not jump-cut)

### Information Architecture
- Group related items into named sections
- Use visual separators (spacing, dividers) to create hierarchy
- Most important content goes top-left (F-pattern scanning)
- Labels should be scannable in <2 seconds

### State Handling
- **Empty**: Welcoming, not nagging. Show value proposition + CTA
- **Loading**: Progressive (show steps/stages, not just spinner)
- **Error**: Specific, actionable, recoverable. Never "Something went wrong"
- **Success**: Celebrate briefly, then guide to next action

### Behavioral Design
- Smart defaults (pre-fill where possible)
- Nudge > nag (subtle suggestions, not pop-ups)
- Reduce friction at decision points (contextual chips, quick actions)
- Trust signals at every commitment point (FCA, encryption, read-only)

---

## BOCY-Specific Patterns

### Onboarding Flow
1. Splash (brand moment) → Education (value props) → Sign-up → Identity (profile) → Connect (bank) → Processing → Welcome → Home
2. Each step should feel like progress, not a form
3. Skip-able non-critical steps (income band, upcoming events)

### Dashboard Philosophy
- Insight-first, not dashboard-first
- One insight = one decision = one card
- Always include £ impact on every insight
- Sort by: financial impact > urgency > ease of execution

### Chat Philosophy
- Tiered replies: quick (12w) → standard (40w) → detailed (100w)
- Suggested chips reduce blank-page anxiety
- Action cards inline (not just text)
- Memory across sessions builds trust

### Profile Philosophy
- Progressive disclosure: collapsed sections with counts
- Accounts / Debts / Investments as top-level groups
- Settings (Notifications, Appearance, Resources) as secondary
- Every row: icon + label + value/chevron

---

## Quality Gates

Before shipping any flow:
1. Can a user complete the primary action in <3 taps?
2. Is cognitive load minimal? (one decision per screen)
3. Are all states handled? (empty, loading, error, success)
4. Does it reduce friction vs. add it?
5. Would a user trust this with their money?
6. Does it solve a real problem?
