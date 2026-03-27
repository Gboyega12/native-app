-- ============================================================
-- Migration: Expand notification_state for new alert types
-- Adds dedup columns for 10 new notification categories:
--   Money-saving: spending spike, surplus milestone, debt countdown
--   Behavioral: move reminder, weekly recap, savings rate milestone
--   Calendar/UK: CGT deadline, pension allowance, BoE rate, council tax
-- ============================================================

-- Money-saving dedup
ALTER TABLE notification_state
  ADD COLUMN IF NOT EXISTS last_spending_spike_week TEXT,
  ADD COLUMN IF NOT EXISTS last_surplus_milestone INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_debt_countdown_month TEXT;

-- Behavioral nudge dedup
ALTER TABLE notification_state
  ADD COLUMN IF NOT EXISTS last_move_reminder_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_weekly_recap_week TEXT,
  ADD COLUMN IF NOT EXISTS last_savings_rate_milestone INTEGER DEFAULT 0;

-- Calendar-aware / UK-specific dedup
ALTER TABLE notification_state
  ADD COLUMN IF NOT EXISTS cgt_deadline_notified_year TEXT,
  ADD COLUMN IF NOT EXISTS pension_allowance_notified_year TEXT,
  ADD COLUMN IF NOT EXISTS boe_rate_notified_month TEXT,
  ADD COLUMN IF NOT EXISTS council_tax_notified_year TEXT;
