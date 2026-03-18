// ── Subscription hook ──
// The app is completely free — no subscription gates, no trial limits.
// This hook is kept as a stable interface so existing consumers don't break,
// but it always returns "active" state with no loading delay.
// When payments are needed again, restore the Stripe/trial logic here.

export type SubscriptionStatus = 'active' | 'inactive' | 'past_due' | 'cancelled';

export interface SubscriptionState {
  isActive: boolean;
  isTrial: boolean;
  isSubscribed: boolean;
  trialDaysLeft: number;
  trialEndsAt: Date | null;
  loading: boolean;
  status: SubscriptionStatus;
  billingInterval: 'month' | 'year' | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  refresh: () => Promise<void>;

  /** @deprecated */
  isPro: boolean;
  /** @deprecated */
  tier: 'free' | 'pro';
}

const noop = async () => {};

/** Always returns active — app is free, no gates. */
export function useSubscription(): SubscriptionState {
  return {
    isActive: true,
    isTrial: false,
    isSubscribed: false,
    trialDaysLeft: 0,
    trialEndsAt: null,
    loading: false,
    status: 'active',
    billingInterval: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    refresh: noop,
    isPro: false,
    tier: 'free',
  };
}

/** Server-side check — always returns true (app is free). */
export async function isUserActive(_userId: string, _adminClient: any): Promise<boolean> {
  return true;
}

/** @deprecated */
export async function getUserTier(_userId: string, _adminClient: any): Promise<'free' | 'pro'> {
  return 'pro';
}
