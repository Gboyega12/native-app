// ── RevenueCat Webhook ──
// Receives subscription events from RevenueCat and syncs to user_subscriptions table.
// Set this URL in RevenueCat Dashboard > Project > Integrations > Webhooks:
//   https://native-app-ashy.vercel.app/api/revenuecat/webhook
//
// Required env vars:
//   REVENUECAT_WEBHOOK_SECRET — from RevenueCat dashboard (Authorization header)
//   SUPABASE_SERVICE_ROLE_KEY — for admin database access

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify webhook signature
  const webhookSecret = process.env.REVENUECAT_WEBHOOK_SECRET;
  const authHeader = req.headers.authorization || '';
  if (webhookSecret && authHeader !== `Bearer ${webhookSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const { event } = req.body;
    if (!event) {
      return res.status(400).json({ error: 'Missing event' });
    }

    const { type, app_user_id } = event;
    if (!app_user_id) {
      return res.status(400).json({ error: 'Missing app_user_id' });
    }

    // RevenueCat app_user_id = Supabase auth user ID (set during identifyUser)
    const userId = app_user_id;

    // Events that grant Pro access
    const activateEvents = [
      'INITIAL_PURCHASE',
      'RENEWAL',
      'UNCANCELLATION',
      'NON_RENEWING_PURCHASE',
      'PRODUCT_CHANGE',
    ];

    // Events that revoke Pro access
    const deactivateEvents = [
      'EXPIRATION',
      'BILLING_ISSUE',
    ];

    // Cancellation — still active until period ends, just won't renew
    const cancelEvents = [
      'CANCELLATION',
    ];

    if (activateEvents.includes(type)) {
      await admin.from('user_subscriptions').upsert({
        user_id: userId,
        tier: 'pro',
        status: 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    } else if (deactivateEvents.includes(type)) {
      await admin.from('user_subscriptions').upsert({
        user_id: userId,
        tier: 'free',
        status: 'expired',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    } else if (cancelEvents.includes(type)) {
      // Still active until expiry — just mark as cancelled
      await admin.from('user_subscriptions').upsert({
        user_id: userId,
        tier: 'pro',
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[revenuecat/webhook] Error:', err?.message);
    return res.status(500).json({ error: err?.message });
  }
}
