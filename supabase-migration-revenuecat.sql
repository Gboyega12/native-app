-- Bocy App — RevenueCat Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- Adds RevenueCat customer ID column to user_subscriptions for IAP tracking.

-- Add RevenueCat customer ID (maps to original_app_user_id from RC webhooks)
ALTER TABLE user_subscriptions
ADD COLUMN IF NOT EXISTS rc_customer_id TEXT;

-- Index for webhook lookups (find user by RC customer ID)
CREATE INDEX IF NOT EXISTS idx_subscriptions_rc_customer
ON user_subscriptions(rc_customer_id);
