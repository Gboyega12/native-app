-- ============================================================
-- Migration: add monthly_contribution and source columns to savings_accounts
-- Tracks how much users contribute monthly to each savings account
-- and whether the account was added via onboarding, chat, or sync.
-- ============================================================
ALTER TABLE savings_accounts
  ADD COLUMN IF NOT EXISTS monthly_contribution NUMERIC,
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
