# Fix Vercel Build TypeScript Errors

## Root Cause
Vercel's serverless function type-checker forces `moduleResolution: "node16"` when checking
files included by `api/tsconfig.json`. That tsconfig includes `../lib/**/*.ts`, so all `lib/`
files are checked under `node16` rules — which require `.js` extensions on relative imports.

The TS2339 errors (`Property 'test' does not exist on type 'unknown'`) are **cascading** from
the failed import of `./archetypes`. When the import can't resolve, `SUB_TRAITS` becomes
`unknown`, causing downstream property access failures. Fixing imports fixes these too.

## Fix Strategy
**Option A (chosen): Add `.js` extensions to all relative imports in `lib/`.**
- This is the standard ESM-compatible approach
- Works with both `bundler` and `node16` resolution
- No config changes needed — Expo/bundler ignores the extension and resolves `.ts` anyway

**Option B (rejected): Change tsconfig to exclude lib/ from api type-checking.**
- Would hide real type errors in shared code
- Fragile — Vercel could change behavior

## Files to Edit (7 files, imports only)

- [ ] `lib/enrichment-engine.ts` — 6 imports: `./merchant-db` → `./merchant-db.js`, etc.
- [ ] `lib/move-engine.ts` — 5 imports: `./types`, `./liquidity-engine`, `./constants`, `./monte-carlo` (×2)
- [ ] `lib/liquidity-engine.ts` — 3 imports: `./types`, `./monte-carlo`, `./surplus-engine`
- [ ] `lib/monte-carlo.ts` — 1 import: `./types`
- [ ] `lib/classifier.ts` — 1 import: `./merchant-db`
- [ ] `lib/archetypes.ts` — 1 import: `./types`
- [ ] `lib/surplus-engine.ts` — 1 import: `./types`

## Verification
- [ ] Run `npx tsc --noEmit` with root tsconfig to ensure no regressions
- [ ] Run `npx tsc --noEmit -p api/tsconfig.json` to simulate Vercel's check
- [ ] Commit & push to trigger Vercel rebuild
