import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  // Verify JWT
  const authHeader = req.headers.authorization as string | undefined;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { current_situation, one_year_goal, two_year_goal, target_amount } = req.body;
  if (!current_situation || !one_year_goal || !two_year_goal) {
    return res.status(400).json({ error: 'current_situation, one_year_goal, and two_year_goal required' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  const { error } = await admin.from('goals').upsert({
    user_id: user.id,
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
