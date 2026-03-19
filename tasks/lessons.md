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

## Dashboard UX

- **Never leave users on an infinite spinner.** When the dashboard detects "bank connected, no analysis" and retries sync, it MUST have an escape hatch after retries exhaust. Show "Try again" + "Upload a statement instead" buttons. Also add a safety timeout (3 minutes) in case sync never triggers the retry path at all.
- **Processing.tsx bypass creates an orphan state.** When processing.tsx detects 0 enriched transactions and bypasses to dashboard via `router.replace`, the dashboard has no analysis and no way to create one. The sync retry loop is the only recovery path — and it gives up after 5 attempts (~6 minutes). After that, the user is stuck forever.

## Insights Engine

- **Don't add simplistic multipliers on top of a principled scoring system.** The move engine uses CRRA marginal utility, Monte Carlo consistency, UKPF waterfall, and goal alignment. Adding archetype-based cohort boosts creates multiplicative stacking (e.g. 1.5x UKPF × 2.0x cohort = 3.0x) that distorts the CRRA model's carefully calibrated outputs. Trust the existing economic model.
- **Research the existing architecture before adding features.** The move engine had 4 integrated layers (UKPF → CRRA → Monte Carlo → Goal alignment) that I didn't fully understand before adding cohort boosts. Always map the full system before modifying it.

## Modal UX

- **Don't show users things the system already knows.** If enrichment + Claude AI classifies 98% of transactions correctly, auto-apply those results. Only surface truly unclassifiable items in review modals. Users can always re-categorize from the budget section.
- **Preserve enrichment metadata through the pipeline.** `TransactionDetail` originally stripped `confidence` and `classifiedBy` when mapping from `EnrichedTransaction`. Without these fields, the dashboard can't distinguish auto-classifiable items from truly unresolved ones.

## Enrichment Engine

- **Income is strictly from businesses.** Only sources matching employer patterns (`ltd`, `plc`, `limited`, `inc`, `corp`, `llp`, `council`, `nhs`, `university`) or salary/benefit keywords should qualify as income. No person name should ever count as income, regardless of regularity. People get paid weekly, fortnightly, AND monthly — don't restrict frequency.
- **Person-name heuristic must require positive evidence.** "2-4 alphabetic words = person" is too aggressive — "TASTY JERK", "FISH SHACK", "GREEN DOOR" all false-positive. Require at least one word to be in a known first-names list.
- **Transfer method markers trump keyword classification.** When a description contains "faster payment", "bank transfer", etc. AND matches a person name, the transfer signal is stronger than a coincidental keyword match (e.g. "internet" in "FASTER PAYMENT TO JOHN INTERNET").
- **Adding models without fixing the classification priority order creates cascading errors.** The Bayesian ensemble, learned patterns, and amount heuristics are all good additions — but they interact with the person-name heuristic and keyword classifier in unexpected ways. Always trace the full pipeline for edge cases before adding new classification layers.
- **Don't replace working metrics-based scoring with signal-derived scoring.** The original decision score (baseline 50, additive factors for savings rate/debt/subscriptions/delivery/salary/BNPL) was correct. Replacing it with signal-derived scoring (baseline 70, alert/watch/info adjustments) produced wrong scores and generic recommendations. The structural factors directly measure financial health — signals are speculative.
- **Don't add signal boosting to move ranking.** The CRRA utility × opportunity cost × UKPF priority × goal alignment × Monte Carlo consistency ranking is mathematically sound. Adding signal-weighted boosting (1.05-1.20x per signal) and impact distributions (P10/P50/P90) made weak generic moves float to top. The existing ranking already accounts for all relevant factors.
- **Recommendations must be mathematical, not motivational.** "Freeze non-essential spending for 30 days" and "cancel unnecessary subscriptions" are weak. Good moves show specific numbers: "Cut 3 lowest-value subscriptions (Netflix £11, Spotify £10, Audible £8) = £348/year". Data-driven cut percentages via P25 of monthly distribution are already in genDecisionStack.

## Archetype → Segment Migration

- **Archetypes were never the right abstraction.** The 11 archetype system (subscription_collector, debt_juggler, etc.) was a behavioural classification that didn't drive any meaningful downstream decisions. Replaced with 3 segments: `structured` (SHE), `unstructured` (UHE), `default` — aligned with account-classifier.ts cohort detection.
- **DB column renames require matching all Supabase queries.** When renaming `archetype` → `segment`, every `.select()`, `.insert()`, `.update()` touching the `analyses` and `score_history` tables must be updated.
- **Income dedup must catch same-paycheck-different-name.** Transaction-overlap dedup (±2 days, 5% amount) misses when the same salary appears under two different merchant names (e.g. "NET MEDIA PLANET L MONTHLY PAY BGC" vs "Salary"). Added a salary-specific amount-based dedup pass that runs first: if both sources have `isSalary=true` and monthly amounts are within 15%, merge them.
- **Never use "Debt 1" as a display name.** The `resolveDebtName()` fallback chain should exhaust: account_name → institution → provider_name → merchant payment name → account type → "Debt account". Generic indexed names confuse users.
- **Double income inflates surplus and cascades into bad recommendations.** When salary appears twice, surplus doubles → debt payment suggestions use inflated surplus → nonsensical recommendations. Fixing dedup at the root fixes everything downstream.

## Workflow Compliance

- **Always write plan to `tasks/todo.md` BEFORE implementing.** Even when using inline TodoWrite for progress tracking, the spec should live in `tasks/todo.md` with checkable items.
- **Update `tasks/lessons.md` after every correction or non-obvious discovery.** Don't wait until asked — capture the pattern immediately.
- **Enter plan mode for 3+ step tasks.** Both the UI reorder and bug fix qualified but were implemented without formal plan mode. The work was correct but didn't follow the prescribed workflow.
