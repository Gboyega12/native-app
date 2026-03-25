-- ============================================================
-- Migration: add monthly_contribution and source columns to savings_accounts
-- Tracks how much users contribute monthly to each savings account
-- and whether the account was added via onboarding, chat, or sync.
-- NOTE: These columns are now included in the base CREATE TABLE
-- in supabase-migration-investments-savings.sql. This ALTER is
-- kept for backwards-compatibility with databases created before
-- the base table was updated.
-- ============================================================
ALTER TABLE IF EXISTS savings_accounts
  ADD COLUMN IF NOT EXISTS monthly_contribution NUMERIC,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
