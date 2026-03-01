// ── Web Push Subscription Management ──
// POST: Save a web push subscription for a user.
// DELETE: Remove a user's web push subscription.
//
// Stores subscriptions in `web_push_subscriptions` table in Supabase.
// The subscription object comes from PushManager.subscribe().toJSON()
// and contains { endpoint, keys: { p256dh, auth } }.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (!serviceKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // ── POST: Save subscription ──
  if (req.method === 'POST') {
    const { user_id, subscription } = req.body;

    if (!user_id || !subscription?.endpoint || !subscription?.keys) {
      return res.status(400).json({ error: 'Missing user_id or subscription' });
    }

    try {
      // Upsert — one subscription per endpoint per user
      const { error } = await admin
        .from('web_push_subscriptions')
        .upsert(
          {
            user_id,
            endpoint: subscription.endpoint,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,endpoint' }
        );

      if (error) {
        console.error('[subscribe] Upsert error:', error.message);
        return res.status(500).json({ error: 'Failed to save subscription' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[subscribe] Error:', err?.message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  // ── DELETE: Remove subscription ──
  if (req.method === 'DELETE') {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    try {
      await admin
        .from('web_push_subscriptions')
        .delete()
        .eq('user_id', user_id);

      return res.json({ success: true });
    } catch (err) {
      console.error('[subscribe] Delete error:', err?.message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
