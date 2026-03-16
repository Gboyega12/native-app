// ── Subscription hook ──
// New model: 2-week free trial from account creation, then subscription required.
// No free tier — the app is fully gated after trial expiry.
// Subscribes to Supabase Realtime so UI auto-updates when Stripe/RC webhook fires.

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabase.js';

export type SubscriptionStatus = 'active' | 'inactive' | 'past_due' | 'cancelled';

const TRIAL_DAYS = 14;

export interface SubscriptionState {
  /** Whether the user has full app access (trial or active subscription) */
  isActive: boolean;
  /** Whether the user is currently in the free trial (not yet subscribed) */
  isTrial: boolean;
  /** Whether the user has a paid subscription */
  isSubscribed: boolean;
  /** Days remaining in trial (0 if expired or subscribed) */
  trialDaysLeft: number;
  /** When the trial ends */
  trialEndsAt: Date | null;
  loading: boolean;
  status: SubscriptionStatus;
  billingInterval: 'month' | 'year' | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  refresh: () => Promise<void>;

  // Legacy — kept for backward compat during migration
  /** @deprecated Use isSubscribed instead */
  isPro: boolean;
  /** @deprecated Use isActive instead */
  tier: 'free' | 'pro';
}

const SELECT_COLS = 'tier, status, billing_interval, current_period_end, cancel_at_period_end';

function deriveIsSubscribed(tier: string | undefined, status: string | undefined): boolean {
  return tier === 'pro' && (status === 'active' || status === 'past_due');
}

export function useSubscription(): SubscriptionState {
  const [status, setStatus] = useState<SubscriptionStatus>('inactive');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [billingInterval, setBillingInterval] = useState<'month' | 'year' | null>(null);
  const [currentPeriodEnd, setCurrentPeriodEnd] = useState<Date | null>(null);
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [trialEndsAt, setTrialEndsAt] = useState<Date | null>(null);
  const userIdRef = useRef<string | null>(null);

  const applyRow = useCallback((row: any | null, userCreatedAt?: string) => {
    const subscribed = deriveIsSubscribed(row?.tier, row?.status);
    setIsSubscribed(subscribed);
    setStatus(row?.status ?? 'inactive');
    setBillingInterval(subscribed ? (row?.billing_interval ?? null) : null);
    setCurrentPeriodEnd(row?.current_period_end ? new Date(row.current_period_end) : null);
    setCancelAtPeriodEnd(row?.cancel_at_period_end ?? false);

    // Calculate trial end from account creation date
    if (userCreatedAt) {
      const created = new Date(userCreatedAt);
      const trialEnd = new Date(created.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      setTrialEndsAt(trialEnd);
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

      // Set trial end from account creation
      const created = new Date(user.created_at);
      const trialEnd = new Date(created.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
      setTrialEndsAt(trialEnd);

      const { data } = await supabase
        .from('user_subscriptions')
        .select(SELECT_COLS)
        .eq('user_id', user.id)
        .maybeSingle();

      applyRow(data, user.created_at);
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

  // Derived state
  const now = new Date();
  const isTrial = !isSubscribed && trialEndsAt !== null && now < trialEndsAt;
  const trialDaysLeft = isTrial && trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;
  const isActive = isSubscribed || isTrial;

  return {
    isActive,
    isTrial,
    isSubscribed,
    trialDaysLeft,
    trialEndsAt,
    loading,
    status,
    billingInterval,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    refresh: fetchTier,

    // Legacy compat
    isPro: isSubscribed,
    tier: isSubscribed ? 'pro' : 'free',
  };
}

/** Server-side check: is user active (subscribed or in trial)? */
export async function isUserActive(userId: string, adminClient: any): Promise<boolean> {
  try {
    // Check subscription first
    const { data: sub } = await adminClient
      .from('user_subscriptions')
      .select('tier, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle();

    if (sub?.tier === 'pro') return true;

    // Check trial: get user created_at from auth
    const { data: { user } } = await adminClient.auth.admin.getUserById(userId);
    if (!user) return false;

    const created = new Date(user.created_at);
    const trialEnd = new Date(created.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    return new Date() < trialEnd;
  } catch {
    return false;
  }
}

/** @deprecated Use isUserActive instead */
export async function getUserTier(userId: string, adminClient: any): Promise<'free' | 'pro'> {
  const active = await isUserActive(userId, adminClient);
  return active ? 'pro' : 'free';
}
