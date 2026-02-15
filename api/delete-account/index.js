import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  // Verify user with anon client
  const anonClient = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(token);

  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Admin client for deletion
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    // Delete user data from all tables
    await admin.from('analyses').delete().eq('user_id', user.id);
    await admin.from('goals').delete().eq('user_id', user.id);
    await admin.from('bank_data').delete().eq('user_id', user.id);

    // Delete auth user
    const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);
    if (deleteErr) throw deleteErr;

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
