-- Manual assets: investments, pensions, property held on external platforms
-- not connected via open banking. Users add these through chat.

CREATE TABLE IF NOT EXISTS manual_assets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN (
    'stocks_and_shares_isa', 'cash_isa', 'general_investment',
    'pension', 'sipp', 'crypto', 'property', 'premium_bonds', 'other'
  )),
  estimated_value NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, platform, asset_type)
);

-- RLS
ALTER TABLE manual_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own manual assets"
  ON manual_assets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own manual assets"
  ON manual_assets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own manual assets"
  ON manual_assets FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own manual assets"
  ON manual_assets FOR DELETE
  USING (auth.uid() = user_id);

-- Service role bypass for API
CREATE POLICY "Service role full access on manual_assets"
  ON manual_assets FOR ALL
  USING (auth.role() = 'service_role');

-- Index for fast lookup
CREATE INDEX idx_manual_assets_user ON manual_assets(user_id);
