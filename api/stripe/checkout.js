// ── Stripe Checkout Session ──
// POST /api/stripe/checkout
// Creates a Stripe Checkout Session and returns the URL to redirect to.
// Body: { price: "monthly" | "yearly" }
// Auth: Bearer token (Supabase JWT)

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  const { price } = req.body;
  if (!price || !['monthly', 'yearly'].includes(price)) {
    return res.status(400).json({ error: 'price must be "monthly" or "yearly"' });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceMonthly = process.env.STRIPE_PRICE_MONTHLY;
  const priceYearly = process.env.STRIPE_PRICE_YEARLY;
  const appUrl = process.env.APP_URL || 'https://app.bocy.io';
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!stripeKey || !priceMonthly || !priceYearly) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  // Verify user
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const stripe = new Stripe(stripeKey);
  const priceId = price === 'yearly' ? priceYearly : priceMonthly;

  try {
    // Check if user already has a Stripe customer ID
    const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: existingSub } = await admin
      .from('user_subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single();

    let customerId = existingSub?.stripe_customer_id;

    // Create Stripe customer if needed
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
    }

    // Check if user has had a trial before (prevent repeat trials)
    const { data: existingTrialSub } = await admin
      .from('user_subscriptions')
      .select('id')
      .eq('user_id', user.id)
      .not('current_period_end', 'is', null)
      .maybeSingle();

    const isFirstSubscription = !existingTrialSub;

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/(main)/profile?upgraded=true`,
      cancel_url: `${appUrl}/(main)/profile`,
      subscription_data: {
        metadata: { supabase_user_id: user.id },
        // 14-day free trial for first-time subscribers
        ...(isFirstSubscription && { trial_period_days: 14 }),
      },
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe/checkout] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
}
