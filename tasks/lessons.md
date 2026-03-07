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
