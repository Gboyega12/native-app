// ── Web Push Subscription Management ──
// POST: Save a web push subscription for a user.
// DELETE: Remove a user's web push subscription.
//
// Stores subscriptions in `web_push_subscriptions` table in Supabase.
// The subscription object comes from PushManager.subscribe().toJSON()
// and contains { endpoint, keys: { p256dh, auth } }.

import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string(),
      auth: z.string(),
    }),
  }),
});

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return res.status(500).json({ error: 'Server not configured' });
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

  const admin = createClient(supabaseUrl, serviceKey);

  // ── POST: Save subscription ──
  if (req.method === 'POST') {
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
    }
    const { subscription } = parsed.data;

    try {
      // Upsert — one subscription per endpoint per user
      const { error } = await admin
        .from('web_push_subscriptions')
        .upsert(
          {
            user_id: user.id,
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[subscribe] Error:', message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  // ── DELETE: Remove subscription ──
  if (req.method === 'DELETE') {
    try {
      await admin
        .from('web_push_subscriptions')
        .delete()
        .eq('user_id', user.id);

      return res.json({ success: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[subscribe] Delete error:', message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
