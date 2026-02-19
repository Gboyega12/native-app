-- Bocy App — Subscriptions Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- Creates the user_subscriptions table used by the tier system + Stripe webhooks.

-- ============================================================
-- Table: user_subscriptions
-- One row per user. Tracks Stripe subscription state.
-- ============================================================
CREATE TABLE user_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro')),
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'past_due', 'cancelled')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  billing_interval TEXT CHECK (billing_interval IN ('month', 'year')),
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can read their own subscription (client-side tier checks)
CREATE POLICY "Users can read own subscription"
  ON user_subscriptions FOR SELECT
  USING ((select auth.uid()) = user_id);

-- No INSERT/UPDATE/DELETE policies for authenticated users.
-- Only the service_role key (used by Stripe webhook API route) bypasses RLS,
-- so users cannot tamper with their own subscription status.

-- Indexes for Stripe webhook lookups (find user by Stripe IDs)
CREATE INDEX idx_subscriptions_stripe_customer ON user_subscriptions(stripe_customer_id);
CREATE INDEX idx_subscriptions_stripe_sub ON user_subscriptions(stripe_subscription_id);
