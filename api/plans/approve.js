import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { plan_id, user_id } = req.body;
  if (!plan_id || !user_id) {
    return res.status(400).json({ error: 'plan_id and user_id required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.error('[approve] Missing env vars:', { url: !!supabaseUrl, key: !!serviceKey });
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Update any non-dismissed plan owned by this user (relaxed from requiring 'proposed')
  const { data, error } = await admin
    .from('user_plans')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', plan_id)
    .eq('user_id', user_id)
    .neq('status', 'dismissed')
    .select('id')
    .single();

  if (error) {
    console.error('[approve] Update failed:', error.message, error.code);
    return res.status(400).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ error: 'Plan not found or already dismissed' });
  }

  return res.json({ success: true, plan_id: data.id });
}
