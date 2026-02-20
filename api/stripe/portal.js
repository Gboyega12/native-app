// ── Stripe Customer Portal ──
// POST /api/stripe/portal
// Creates a Stripe Billing Portal session for managing subscriptions.
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

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const appUrl = process.env.APP_URL || 'https://native-app-ashy.vercel.app';
  const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  // Verify user
  const token = authHeader.replace('Bearer ', '');
  const supabase = createClient(supabaseUrl, anonKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Get Stripe customer ID from subscription record
  const admin = createClient(supabaseUrl, serviceKey);
  const { data: sub } = await admin
    .from('user_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .single();

  if (!sub?.stripe_customer_id) {
    return res.status(404).json({ error: 'No subscription found' });
  }

  try {
    const stripe = new Stripe(stripeKey);
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${appUrl}/(main)/profile`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe/portal] Error:', err.message);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
}
