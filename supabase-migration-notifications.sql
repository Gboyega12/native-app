-- Bocy App — Notifications & Engagement Migration
-- Run this in your Supabase SQL Editor after the base migration.

-- ============================================================
-- Table: score_history
-- Historical snapshots of decision score + key metrics.
-- One row per analysis run. Powers progress tracking & weekly digests.
-- ============================================================
CREATE TABLE IF NOT EXISTS score_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  decision_score INTEGER NOT NULL,
  monthly_income NUMERIC NOT NULL DEFAULT 0,
  monthly_spending NUMERIC NOT NULL DEFAULT 0,
  surplus NUMERIC NOT NULL DEFAULT 0,
  savings_rate NUMERIC NOT NULL DEFAULT 0,
  subscription_count INTEGER NOT NULL DEFAULT 0,
  debt_account_count INTEGER NOT NULL DEFAULT 0,
  archetype TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE score_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own score history"
  ON score_history FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own score history"
  ON score_history FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

-- Index for efficient lookups by user + time ordering
CREATE INDEX idx_score_history_user_date ON score_history (user_id, created_at DESC);


-- ============================================================
-- Table: notification_preferences
-- Per-user notification settings. One row per user.
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  weekly_digest BOOLEAN NOT NULL DEFAULT true,
  milestone_alerts BOOLEAN NOT NULL DEFAULT true,
  checkin_prompts BOOLEAN NOT NULL DEFAULT true,
  score_updates BOOLEAN NOT NULL DEFAULT true,
  achievement_alerts BOOLEAN NOT NULL DEFAULT true,
  push_token TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notification preferences"
  ON notification_preferences FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own notification preferences"
  ON notification_preferences FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own notification preferences"
  ON notification_preferences FOR UPDATE USING ((select auth.uid()) = user_id);


-- ============================================================
-- Table: notification_log
-- Audit trail of all sent notifications.
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  notification_type TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE notification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notification log"
  ON notification_log FOR SELECT USING ((select auth.uid()) = user_id);

-- Index for rate limiting and history queries
CREATE INDEX idx_notification_log_user_type ON notification_log (user_id, notification_type, sent_at DESC);


-- ============================================================
-- Table: user_achievements
-- Tracks which achievements each user has unlocked.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_achievements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  achievement_key TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ DEFAULT now(),
  notified BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(user_id, achievement_key)
);

ALTER TABLE user_achievements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own achievements"
  ON user_achievements FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own achievements"
  ON user_achievements FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own achievements"
  ON user_achievements FOR UPDATE USING ((select auth.uid()) = user_id);


-- ============================================================
-- Table: user_streaks
-- Tracks daily app usage streaks.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_streaks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  last_active_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_active_days INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE user_streaks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own streaks"
  ON user_streaks FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own streaks"
  ON user_streaks FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own streaks"
  ON user_streaks FOR UPDATE USING ((select auth.uid()) = user_id);
