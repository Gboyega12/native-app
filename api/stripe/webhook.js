// ── Stripe Webhook Handler ──
// POST /api/stripe/webhook
// Handles Stripe subscription lifecycle events.
// Must receive raw body for signature verification.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Vercel: disable body parsing so we can verify the Stripe signature
export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    return res.status(500).json({ error: 'Stripe webhook not configured' });
  }

  const stripe = new Stripe(stripeKey);
  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe/webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const userId = session.subscription_data?.metadata?.supabase_user_id
          || session.metadata?.supabase_user_id;

        if (!userId) {
          // Look up by customer metadata
          const customer = await stripe.customers.retrieve(customerId);
          const fallbackUserId = customer.metadata?.supabase_user_id;
          if (fallbackUserId) {
            await upsertSubscription(admin, stripe, fallbackUserId, subscriptionId, customerId);
          }
        } else {
          await upsertSubscription(admin, stripe, userId, subscriptionId, customerId);
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const subscriptionId = subscription.id;

        // Find user by stripe_customer_id
        const { data: sub } = await admin
          .from('user_subscriptions')
          .select('user_id')
          .eq('stripe_customer_id', customerId)
          .single();

        if (sub) {
          await upsertSubscription(admin, stripe, sub.user_id, subscriptionId, customerId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        if (subscriptionId) {
          const { data: sub } = await admin
            .from('user_subscriptions')
            .select('user_id')
            .eq('stripe_customer_id', customerId)
            .single();

          if (sub) {
            await upsertSubscription(admin, stripe, sub.user_id, subscriptionId, customerId);
          }
        }
        break;
      }

      default:
        // Unhandled event type — that's fine
        break;
    }
  } catch (err) {
    console.error(`[stripe/webhook] Error handling ${event.type}:`, err.message);
    return res.status(500).json({ error: 'Webhook handler failed' });
  }

  return res.json({ received: true });
}

async function upsertSubscription(admin, stripe, userId, subscriptionId, customerId) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const status = mapStripeStatus(subscription.status);
  const priceId = subscription.items.data[0]?.price?.id || null;
  const interval = subscription.items.data[0]?.price?.recurring?.interval || null;
  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  const row = {
    user_id: userId,
    tier: (status === 'active' || status === 'past_due') ? 'pro' : 'free',
    status,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_price_id: priceId,
    billing_interval: interval,
    current_period_end: periodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end || false,
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin
    .from('user_subscriptions')
    .upsert(row, { onConflict: 'user_id' });

  if (error) {
    console.error('[stripe/webhook] upsert failed:', error.message);
    throw error;
  }
}

function mapStripeStatus(stripeStatus) {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      return 'cancelled';
    default:
      return 'inactive';
  }
}
