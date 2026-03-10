# Lessons Learned

## Architecture

- **Plan screen is scrapped.** Only 2 screens exist: homepage (`index.tsx`) and chat (`chat.tsx`). The plan tab is hidden (`href: null`). All plan/move features live on the homepage. Don't touch `plan.tsx`.
- **Don't modify dead code.** If a screen is deprecated, don't fix bugs in it — focus changes on the active screens only.

## State Persistence

- **Deriving UI state from in-memory data is fragile.** If a dismissal needs to survive tab switches, app restarts, or chat clears, persist it to AsyncStorage with a fingerprint that auto-resets when conditions change (e.g., next payday).
- **`useFocusEffect` rebuilds context on every tab visit.** Any dismissal based only on React state will reset. Always check AsyncStorage inside `loadContext` for persistent dismissals.
- **Stale closures in async functions.** When reading React state inside an async function defined in a `useCallback`, use local variables from the async body (e.g., read from AsyncStorage) rather than relying on the closure's captured state value.

## Walkthrough / Onboarding

- **Steps must follow the page's visual order** (top to bottom), not feature priority. Users expect a chronological scroll through the UI.
- **Modals block the content they explain.** Use lighter overlays or absolute positioning so the card being explained remains visible alongside the tooltip.
- **`onMomentumScrollEnd` doesn't fire for programmatic `scrollTo()` on web.** Always update page state directly in button handlers that call `scrollTo()`. Rely on `onMomentumScrollEnd` only as a fallback for manual swipe detection.

## Data Flow

- **Open Banking and CSV share the same processing pipeline.** The `csvData` param in processing.tsx is source-agnostic. When error messages differ by source (bank vs file upload), pass a `source` param to disambiguate — don't try to detect the source from CSV content.
- **Zero transactions from a bank is not an error.** New accounts, pending auth, and settling transactions are all legitimate reasons for 0 tx. The bank IS connected — bypass to dashboard and let sync retry later.
- **Header-only CSV (`Date,Description,Amount`) has `lineCount === 1`.** This is the sentinel for "no data rows" in processing.tsx. When source is 'bank', this should bypass to dashboard, not show a file format error.
- **TrueLayer descriptions can contain newlines and commas.** Always sanitize both: `.replace(/,/g, ' ').replace(/[\r\n]+/g, ' ')`. Commas break CSV column alignment; newlines break CSV row alignment.
- **Set-based CSV deduplication loses legitimate duplicate transactions.** Two coffees at the same place on the same day for the same amount have identical `date,description,amount` keys. Use count-based dedup: track per-source occurrence counts and keep `max(count_a, count_b)` for each key.
- **Dedup context matters.** Per-connection merge (existing + new sync): count-based (overlapping windows). Cross-connection merge: count-based (preserves within-account dupes). The key insight: `max(source_a, source_b)` is always safe — it preserves legitimate duplicates while still merging true cross-source dupes.

## Workflow Compliance

- **Always write plan to `tasks/todo.md` BEFORE implementing.** Even when using inline TodoWrite for progress tracking, the spec should live in `tasks/todo.md` with checkable items.
- **Update `tasks/lessons.md` after every correction or non-obvious discovery.** Don't wait until asked — capture the pattern immediately.
- **Enter plan mode for 3+ step tasks.** Both the UI reorder and bug fix qualified but were implemented without formal plan mode. The work was correct but didn't follow the prescribed workflow.
