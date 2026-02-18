-- Bocy App — Supabase Migration
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)

-- ============================================================
-- Table: goals
-- One row per user. Stores financial goal questionnaire answers.
-- ============================================================
CREATE TABLE goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  current_situation TEXT NOT NULL,
  one_year_goal TEXT NOT NULL,
  two_year_goal TEXT NOT NULL,
  target_amount NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own goals"
  ON goals FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own goals"
  ON goals FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own goals"
  ON goals FOR UPDATE USING (auth.uid() = user_id);


-- ============================================================
-- Table: analyses
-- Stores complete financial analysis results. Multiple per user.
-- ============================================================
CREATE TABLE analyses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  archetype TEXT NOT NULL,
  decision_score INTEGER NOT NULL,
  monthly_income NUMERIC NOT NULL,
  monthly_spending NUMERIC NOT NULL,
  surplus NUMERIC NOT NULL,
  non_discretionary JSONB DEFAULT '{}',
  discretionary JSONB DEFAULT '{}',
  income_sources JSONB DEFAULT '[]',
  top_move JSONB DEFAULT '{}',
  all_moves JSONB DEFAULT '[]',
  behavioral_patterns JSONB DEFAULT '[]',
  goal_context JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE analyses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own analyses"
  ON analyses FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own analyses"
  ON analyses FOR INSERT WITH CHECK (auth.uid() = user_id);


-- ============================================================
-- Table: bank_data
-- Persists CSV data from TrueLayer callback.
-- Keyed by connection_id so the app can retrieve it after redirect.
-- ============================================================
CREATE TABLE bank_data (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id TEXT UNIQUE NOT NULL,
  csv_data TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'truelayer',
  refresh_token TEXT,
  card_balances JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bank_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own bank data"
  ON bank_data FOR SELECT USING (auth.uid() = user_id);

-- Allow authenticated users to read unclaimed bank_data rows (user_id is NULL)
-- after TrueLayer callback. The connection_id is a random string that acts as
-- an ephemeral secret — knowing it is proof you initiated the connection.
CREATE POLICY "Authenticated users can read unclaimed bank data"
  ON bank_data FOR SELECT USING (user_id IS NULL AND auth.role() = 'authenticated');

-- No INSERT or UPDATE policies needed for client-side access.
-- All writes to bank_data are performed via the service role (which bypasses RLS).

CREATE POLICY "Users can delete own bank data"
  ON bank_data FOR DELETE USING (auth.uid() = user_id);


-- ============================================================
-- Table: chat_messages
-- Persists Bocy chat conversations. One row per user.
-- ============================================================
CREATE TABLE chat_messages (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  messages JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own chat messages"
  ON chat_messages FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own chat messages"
  ON chat_messages FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat messages"
  ON chat_messages FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own chat messages"
  ON chat_messages FOR DELETE USING (auth.uid() = user_id);


-- ============================================================
-- Table: transaction_overrides
-- User corrections to auto-categorised transactions.
-- Applied by the enrichment engine on next analysis run.
-- ============================================================
CREATE TABLE transaction_overrides (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  match_description TEXT NOT NULL,
  category TEXT NOT NULL,
  is_essential BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE transaction_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own overrides"
  ON transaction_overrides FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own overrides"
  ON transaction_overrides FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own overrides"
  ON transaction_overrides FOR DELETE USING (auth.uid() = user_id);

-- No additional INSERT policy needed.
-- Server-side writes use the service role client (which bypasses RLS).


-- ============================================================
-- Table: user_plans
-- Plans created or approved via chat. Shown on plan page.
-- ============================================================
CREATE TABLE user_plans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  action TEXT NOT NULL,
  target_amount NUMERIC,
  monthly_saving NUMERIC,
  timeline TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own plans"
  ON user_plans FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own plans"
  ON user_plans FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own plans"
  ON user_plans FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own plans"
  ON user_plans FOR DELETE USING (auth.uid() = user_id);

-- No additional INSERT/UPDATE policies needed.
-- Server-side writes use the service role client (which bypasses RLS).


-- ============================================================
-- Table: plan_progress
-- Tracks which moves the user has started and step completion.
-- Persisted so progress survives app reloads.
-- ============================================================
CREATE TABLE plan_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  move_key TEXT NOT NULL,
  move_action TEXT NOT NULL,
  approved BOOLEAN DEFAULT false,
  completed_steps INTEGER[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, move_key)
);

ALTER TABLE plan_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own progress"
  ON plan_progress FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own progress"
  ON plan_progress FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own progress"
  ON plan_progress FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own progress"
  ON plan_progress FOR DELETE USING (auth.uid() = user_id);


-- ============================================================
-- Table: debt_accounts
-- Stores outstanding debt balances from TrueLayer or manual entry.
-- ============================================================
CREATE TABLE debt_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'credit_card',
  outstanding_balance NUMERIC,
  credit_limit NUMERIC,
  interest_rate NUMERIC,
  minimum_payment NUMERIC,
  source TEXT NOT NULL DEFAULT 'truelayer',
  last_updated TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, account_name)
);

ALTER TABLE debt_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own debt accounts"
  ON debt_accounts FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own debt accounts"
  ON debt_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own debt accounts"
  ON debt_accounts FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own debt accounts"
  ON debt_accounts FOR DELETE USING (auth.uid() = user_id);

-- No additional ALL policy needed.
-- Server-side writes (TrueLayer sync) use the service role client (which bypasses RLS).


-- ============================================================
-- Table: budget_adjustments
-- Manual budget items added by the user (e.g. rent paid via
-- a partner, cash expenses) that don't appear in bank data.
-- Merged into the budget reality card during analysis.
-- ============================================================
CREATE TABLE budget_adjustments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  monthly_amount NUMERIC NOT NULL,
  is_essential BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE budget_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own budget adjustments"
  ON budget_adjustments FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own budget adjustments"
  ON budget_adjustments FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own budget adjustments"
  ON budget_adjustments FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own budget adjustments"
  ON budget_adjustments FOR DELETE USING (auth.uid() = user_id);

-- No additional ALL policy needed.
-- Server-side writes (chat tool) use the service role client (which bypasses RLS).
