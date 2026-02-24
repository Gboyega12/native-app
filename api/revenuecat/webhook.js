// ── RevenueCat Webhook Handler ──
// POST /api/revenuecat/webhook
// Receives subscription lifecycle events from RevenueCat and upserts
// the user_subscriptions table — same row that Stripe webhooks write to.
//
// RevenueCat docs: https://www.revenuecat.com/docs/integrations/webhooks
//
// Required env vars:
//   REVENUECAT_WEBHOOK_SECRET — the authorization header value you set in RC dashboard
//   SUPABASE_URL / EXPO_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth: verify the shared secret ──
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'RevenueCat webhook not configured' });
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Invalid authorization' });
  }

  // ── Parse event ──
  const event = req.body?.event;
  if (!event) {
    return res.status(400).json({ error: 'Missing event payload' });
  }

  // app_user_id is the Supabase user ID we passed to Purchases.configure()
  const userId = event.app_user_id;
  if (!userId || userId.startsWith('$RCAnonymousID')) {
    // Anonymous user or missing ID — can't map to our DB
    return res.json({ received: true, skipped: 'anonymous_user' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const type = event.type;

    // Events we care about:
    // INITIAL_PURCHASE, RENEWAL, PRODUCT_CHANGE — active subscription
    // CANCELLATION — user cancelled (still active until period end)
    // EXPIRATION — subscription actually expired
    // BILLING_ISSUE — payment failed
    // SUBSCRIBER_ALIAS — not relevant (we use custom app_user_id)

    const activeEvents = [
      'INITIAL_PURCHASE',
      'RENEWAL',
      'PRODUCT_CHANGE',
      'UNCANCELLATION',
    ];

    const isActive = activeEvents.includes(type);
    const isCancellation = type === 'CANCELLATION';
    const isExpiration = type === 'EXPIRATION';
    const isBillingIssue = type === 'BILLING_ISSUE';

    let status = 'active';
    let tier = 'pro';

    if (isExpiration) {
      status = 'cancelled';
      tier = 'free';
    } else if (isBillingIssue) {
      status = 'past_due';
      tier = 'pro'; // still pro during grace period
    } else if (isCancellation) {
      // User cancelled but subscription is active until period end
      status = 'active';
      tier = 'pro';
    } else if (!isActive) {
      // Unknown event type — acknowledge but don't update
      return res.json({ received: true, skipped: type });
    }

    // Extract subscription details
    const periodEnd = event.expiration_at_ms
      ? new Date(event.expiration_at_ms).toISOString()
      : null;

    const productId = event.product_id || '';
    const billingInterval = productId.includes('annual') || productId.includes('yearly')
      ? 'year'
      : 'month';

    const row = {
      user_id: userId,
      tier,
      status,
      billing_interval: billingInterval,
      current_period_end: periodEnd,
      cancel_at_period_end: isCancellation,
      rc_customer_id: event.original_app_user_id || userId,
      updated_at: new Date().toISOString(),
    };

    const { error } = await admin
      .from('user_subscriptions')
      .upsert(row, { onConflict: 'user_id' });

    if (error) {
      console.error('[revenuecat/webhook] upsert failed:', error.message);
      return res.status(500).json({ error: 'Database update failed' });
    }

    return res.json({ received: true, type, userId });
  } catch (err) {
    console.error('[revenuecat/webhook] Error:', err.message);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
}
