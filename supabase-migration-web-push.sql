-- Bocy App — Web Push Subscriptions Migration
-- Run this in your Supabase SQL Editor after the notifications migration.
--
-- Stores Web Push API subscriptions (PushSubscription objects) per user.
-- Each browser/device has its own endpoint, so a user may have multiple rows.
-- Used by /api/notifications/subscribe (upsert/delete) and
-- /api/notifications/web-push-send (lookup + delivery).

-- ============================================================
-- Table: web_push_subscriptions
-- One row per (user, browser endpoint). Upserted on subscribe,
-- deleted on unsubscribe or when the push service returns 410 Gone.
-- ============================================================
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, endpoint)
);

ALTER TABLE web_push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can read their own subscriptions
CREATE POLICY "Users can read own web push subscriptions"
  ON web_push_subscriptions FOR SELECT USING ((select auth.uid()) = user_id);

-- Users can insert their own subscriptions
CREATE POLICY "Users can insert own web push subscriptions"
  ON web_push_subscriptions FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

-- Users can update their own subscriptions (for upsert refreshes)
CREATE POLICY "Users can update own web push subscriptions"
  ON web_push_subscriptions FOR UPDATE USING ((select auth.uid()) = user_id);

-- Users can delete their own subscriptions (unsubscribe)
CREATE POLICY "Users can delete own web push subscriptions"
  ON web_push_subscriptions FOR DELETE USING ((select auth.uid()) = user_id);

-- Service role also needs full access for server-side operations
-- (handled by Supabase service role key bypassing RLS)

-- Index for efficient lookup when sending notifications to a user
CREATE INDEX idx_web_push_subscriptions_user ON web_push_subscriptions (user_id);
