-- ============================================================
-- Table: budget_adjustments
-- Manual budget items added by the user (e.g. rent paid via
-- a partner, cash expenses) that don't appear in bank data.
-- Merged into the budget reality card during analysis.
--
-- RUN THIS IN: Supabase Dashboard > SQL Editor > New query
-- ============================================================

CREATE TABLE IF NOT EXISTS budget_adjustments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  monthly_amount NUMERIC NOT NULL,
  is_essential BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE budget_adjustments ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (safe to run if they don't exist)
DO $$ BEGIN
  DROP POLICY IF EXISTS "Users can read own budget adjustments" ON budget_adjustments;
  DROP POLICY IF EXISTS "Users can insert own budget adjustments" ON budget_adjustments;
  DROP POLICY IF EXISTS "Users can update own budget adjustments" ON budget_adjustments;
  DROP POLICY IF EXISTS "Users can delete own budget adjustments" ON budget_adjustments;
END $$;

CREATE POLICY "Users can read own budget adjustments"
  ON budget_adjustments FOR SELECT USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own budget adjustments"
  ON budget_adjustments FOR INSERT WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own budget adjustments"
  ON budget_adjustments FOR UPDATE USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own budget adjustments"
  ON budget_adjustments FOR DELETE USING ((select auth.uid()) = user_id);
