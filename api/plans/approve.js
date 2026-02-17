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
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Only allow the owning user to approve their own plan
  const { data, error } = await admin
    .from('user_plans')
    .update({ status: 'active', updated_at: new Date().toISOString() })
    .eq('id', plan_id)
    .eq('user_id', user_id)
    .eq('status', 'proposed')
    .select('id')
    .single();

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  if (!data) {
    return res.status(404).json({ error: 'Plan not found or already processed' });
  }

  return res.json({ success: true, plan_id: data.id });
}
