# PWA Cleanup & Code Quality Overhaul

## Phase 1: Remove Native iOS/Android Code
- [ ] 1. Delete native-only files (revenuecat.ts, revenuecat webhook, withIAP.cjs, eas.json, RC migration SQL)
- [ ] 2. Clean app.json: remove ios/android sections, native-only plugins
- [ ] 3. Clean package.json: remove native deps, EAS scripts
- [ ] 4. Clean app/_layout.tsx: remove RevenueCat init, native push registration
- [ ] 5. Clean components/Paywall.tsx: remove native IAP path, keep Stripe web only
- [ ] 6. Clean app/(main)/profile.tsx: remove restorePurchases, native checks
- [ ] 7. Clean lib/notifications.ts: remove native expo-notifications, keep web push
- [ ] 8. Clean lib/supabase.ts: remove expo-secure-store, use web storage only
- [ ] 9. Clean lib/mixpanel.ts: replace native SDK with web-compatible approach
- [ ] 10. Remove Android UIManager calls from education.tsx, identity.tsx, index.tsx, plan.tsx
- [ ] 11. Simplify Platform.OS checks: remove dead iOS/Android branches

## Phase 2: Code Quality Fixes
- [ ] 12. Fix useState(() => trackScreen()) anti-pattern → useEffect (5 files)
- [ ] 13. Fix silent empty catch blocks (subscriptions.tsx, processing.tsx, etc.)

## Phase 3: Verify & Ship
- [ ] 14. TypeScript checks, Expo web build, tests
- [ ] 15. Commit and push
