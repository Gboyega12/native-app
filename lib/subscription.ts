// ── Subscription tier hook ──
// Checks user_subscriptions table. No row = free tier.
// Pro users get: all moves, AI chat, check-ins, achievements, overrides. Weekly digest is free for all.
// Subscribes to Supabase Realtime so UI auto-updates when Stripe webhook fires.

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabase';

export type Tier = 'free' | 'pro';
export type SubscriptionStatus = 'active' | 'inactive' | 'past_due' | 'cancelled';

export interface SubscriptionState {
  tier: Tier;
  isPro: boolean;
  loading: boolean;
  status: SubscriptionStatus;
  billingInterval: 'month' | 'year' | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  refresh: () => Promise<void>;
}

const SELECT_COLS = 'tier, status, billing_interval, current_period_end, cancel_at_period_end';

function deriveIsPro(tier: string | undefined, status: string | undefined): boolean {
  return tier === 'pro' && (status === 'active' || status === 'past_due');
}

export function useSubscription(): SubscriptionState {
  const [tier, setTier] = useState<Tier>('free');
  const [status, setStatus] = useState<SubscriptionStatus>('inactive');
  const [billingInterval, setBillingInterval] = useState<'month' | 'year' | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<Date | null>(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const userIdRef = useRef<string | null>(null);

  const applyRow = useCallback((row: any | null) => {
    if (!row || !deriveIsPro(row.tier, row.status)) {
      setTier('free');
      setStatus(row?.status ?? 'inactive');
      setBillingInterval(null);
      setCurrentPeriodEnd(null);
      setCancelAtPeriodEnd(false);
    } else {
      setTier('pro');
      setStatus(row.status);
      setBillingInterval(row.billing_interval ?? null);
      setCurrentPeriodEnd(row.current_period_end ? new Date(row.current_period_end) : null);
      setCancelAtPeriodEnd(row.cancel_at_period_end ?? false);
    }
  }, []);

  const fetchTier = useCallback(async () => {
    try {
      let user: any = null;
      try {
        const { data } = await supabase.auth.getUser();
        user = data?.user;
      } catch (e) {
        console.warn('[subscription] auth.getUser failed:', e);
      }
      if (!user) {
        applyRow(null);
        setLoading(false);
        return;
      }
      userIdRef.current = user.id;

      const { data } = await supabase
        .from('user_subscriptions')
        .select(SELECT_COLS)
        .eq('user_id', user.id)
        .maybeSingle();

      applyRow(data);
    } catch {
      applyRow(null);
    }
    setLoading(false);
  }, [applyRow]);

  useEffect(() => {
    fetchTier();
  }, [fetchTier]);

  // Real-time: auto-update when Stripe webhook upserts the row
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    try {
      channel = supabase
        .channel('user_subscriptions_changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'user_subscriptions' },
          (payload) => {
            const row = payload.new as any;
            if (row && row.user_id === userIdRef.current) {
              applyRow(row);
            }
          },
        )
        .subscribe();
    } catch (err) {
      console.warn('[subscription] Realtime channel error:', err);
    }

    return () => {
      if (channel) {
        try { supabase.removeChannel(channel); } catch {}
      }
    };
  }, [applyRow]);

  return {
    tier,
    isPro: deriveIsPro(tier, status),
    loading,
    status,
    billingInterval,
    currentPeriodEnd,
    cancelAtPeriodEnd,
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
