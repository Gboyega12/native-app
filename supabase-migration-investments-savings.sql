-- ============================================================
-- Migration: Create investments and savings_accounts tables
-- These tables store user-tracked investment holdings and
-- savings account balances for the account setup & dashboard.
-- ============================================================


-- ============================================================
-- Table: savings_accounts
-- Stores savings account balances from manual entry or sync.
-- ============================================================
CREATE TABLE IF NOT EXISTS savings_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  account_name TEXT NOT NULL,
  provider TEXT,
  balance NUMERIC NOT NULL,
  interest_rate NUMERIC,
  account_type TEXT NOT NULL CHECK (account_type IN ('easy_access', 'fixed', 'isa', 'other')),
  monthly_contribution NUMERIC,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE savings_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own savings accounts"
  ON savings_accounts FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own savings accounts"
  ON savings_accounts FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own savings accounts"
  ON savings_accounts FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own savings accounts"
  ON savings_accounts FOR DELETE USING ((select auth.uid()) = user_id);


-- ============================================================
-- Table: investments
-- Stores investment holdings from manual entry or CSV import.
-- ============================================================
CREATE TABLE IF NOT EXISTS investments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('stocks', 'bonds', 'etfs', 'crypto', 'property', 'pension', 'other')),
  platform TEXT,
  current_value NUMERIC NOT NULL,
  purchase_cost NUMERIC,
  quantity NUMERIC,
  currency TEXT,
  notes TEXT,
  source TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE investments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own investments"
  ON investments FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own investments"
  ON investments FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own investments"
  ON investments FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own investments"
  ON investments FOR DELETE USING ((select auth.uid()) = user_id);
