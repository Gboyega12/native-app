# Design Improvements — Phase 2

## Tasks

- [ ] **1. AnimatedNumber component** — Count-up effect for currency/number values. RN Animated API spring from 0 → target over ~800ms. Drop-in for static `£X` displays on home screen.
- [ ] **2. Skeleton loading screens** — Shimmer placeholder matching card layout. Replace ActivityIndicator on dashboard with skeleton bones.
- [ ] **3. Gesture-driven card interactions** — Swipe-to-dismiss payday card (PanResponder), long-press preview on moves.
- [ ] **4. Dark/light mode transition** — Smooth cross-fade overlay animation on theme toggle.
- [ ] **5. Page transitions** — Slide/fade transitions on Stack screens in expo-router layouts.
- [ ] **6. Progress bar animation** — Animate BreathingBar width from 0 → target on mount.

## Approach
- All built with RN built-in Animated API (no reanimated/gesture-handler — avoids native rebuild)
- Consistent with existing 420ms/cubic easing motion language
- Each feature is independent
