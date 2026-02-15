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
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bank_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own bank data"
  ON bank_data FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert bank data"
  ON bank_data FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can delete own bank data"
  ON bank_data FOR DELETE USING (auth.uid() = user_id);
