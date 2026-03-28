-- ============================================================
-- Migration: Add ticker column to investments table
-- Enables Yahoo Finance live price tracking for holdings.
-- ============================================================

ALTER TABLE investments ADD COLUMN IF NOT EXISTS ticker TEXT;

-- Index for fast cron lookups (all investments with tickers)
CREATE INDEX IF NOT EXISTS idx_investments_ticker ON investments(ticker) WHERE ticker IS NOT NULL;
