import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { user_id, current_situation, one_year_goal, two_year_goal, target_amount } = req.body;
  if (!user_id || !current_situation || !one_year_goal || !two_year_goal) {
    return res.status(400).json({ error: 'user_id, current_situation, one_year_goal, and two_year_goal required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const { error } = await admin.from('goals').upsert({
    user_id,
    current_situation,
    one_year_goal,
    two_year_goal,
    target_amount: target_amount || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.json({ success: true });
}
