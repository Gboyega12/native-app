-- Add week tracking for spending percentage dedup
-- Fixes bug where 50% spending alert only fires once ever
-- instead of once per week when the threshold is crossed.
ALTER TABLE notification_state
  ADD COLUMN IF NOT EXISTS last_spending_pct_week TEXT;
