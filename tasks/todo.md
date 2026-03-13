# Fix: Modal Categorisation Bug

## Problem
Manual categorisation modal removes data from budget instead of adding to it.
On refresh, all sorted transactions disappear.

## Root Causes
1. `saveReview()` removes transactions from "Other" but never adds them to the target category
2. `saveRecategorize()` has a broken monthly amount formula
3. Optimistic state isn't persisted to Supabase, and `reviewSavedRef` guard doesn't survive page refresh

## Fixes
- [x] Fix 1: `saveReview()` — add transactions to target categories with cross-section handling
- [x] Fix 2: `saveRecategorize()` — fix monthly math to simple subtraction
- [x] Fix 3: Persist optimistic analysis to `analyses` table immediately after save
- [x] Fix 4: Make `reviewSavedRef` guard survive page refreshes via AsyncStorage
