// ── Subscription tier hook ──
// Checks user_subscriptions table. No row = free tier.
// Pro users get: all moves, AI chat, weekly digest, check-ins, achievements, overrides.

import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabase';

export type Tier = 'free' | 'pro';

interface SubscriptionState {
  tier: Tier;
  isPro: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useSubscription(): SubscriptionState {
  const [tier, setTier] = useState<Tier>('free');
  const [loading, setLoading] = useState(true);

  const fetchTier = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setTier('free');
        setLoading(false);
        return;
      }

      const { data } = await supabase
        .from('user_subscriptions')
        .select('tier, status')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .single();

      setTier(data?.tier === 'pro' ? 'pro' : 'free');
    } catch {
      // No subscription row = free tier
      setTier('free');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchTier();
  }, [fetchTier]);

  return {
    tier,
    isPro: tier === 'pro',
    loading,
    refresh: fetchTier,
  };
}

/** Server-side tier check (for API routes / cron jobs) */
export async function getUserTier(userId: string, adminClient: any): Promise<Tier> {
  try {
    const { data } = await adminClient
      .from('user_subscriptions')
      .select('tier, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    return data?.tier === 'pro' ? 'pro' : 'free';
  } catch {
    return 'free';
  }
}
