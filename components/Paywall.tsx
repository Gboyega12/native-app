// ── Paywall modal ──
// Shown when free users try to access Pro features.
// Matches the Nothing Phone OS design language.
// On iOS/Android: uses RevenueCat native IAP.
// On web: uses Stripe Checkout redirect.

import { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Pressable, Platform, ActivityIndicator, Alert, Linking } from 'react-native';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { supabase } from '@/lib/supabase';
import { purchasePackage, getOffering, restorePurchases } from '@/lib/revenuecat';
import { useSubscription } from '@/lib/subscription';

const FEATURES = [
  { label: 'All moves unlocked', desc: 'Full step-by-step execution plans for every recommendation' },
  { label: 'AI chat', desc: 'Unlimited personalised financial guidance from Bocy' },
  { label: 'Unlimited re-analyses', desc: 'Re-analyse your finances whenever you need' },
  { label: 'Weekly digest', desc: 'Surplus trends, spending breakdown, move progress every Monday' },
  { label: 'Smart check-ins', desc: 'Alerts for spending spikes, stale plans, and milestones' },
  { label: 'Achievements', desc: 'Track streaks, milestones, and financial progress' },
];

interface PaywallProps {
  visible: boolean;
  onClose: () => void;
  feature?: string; // e.g. "chat", "moves" — for contextual messaging
}

export default function Paywall({ visible, onClose, feature }: PaywallProps) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const { refresh: refreshTier } = useSubscription();
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrice, setSelectedPrice] = useState<'monthly' | 'yearly'>('monthly');

  const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

  // Fetch native prices on open (override hardcoded £ values with store prices)
  const [nativeMonthlyPrice, setNativeMonthlyPrice] = useState<string | null>(null);
  const [nativeYearlyPrice, setNativeYearlyPrice] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !isNative) return;
    (async () => {
      const offering = await getOffering();
      if (!offering) return;
      const monthly = offering.availablePackages.find((p) => p.identifier === '$rc_monthly');
      const yearly = offering.availablePackages.find((p) => p.identifier === '$rc_annual');
      if (monthly) setNativeMonthlyPrice(monthly.product.priceString);
      if (yearly) setNativeYearlyPrice(yearly.product.priceString);
    })();
  }, [visible, isNative]);

  // Reset state whenever modal opens so stale loading/error don't stick
  useEffect(() => {
    if (visible) {
      setLoading(false);
      setRestoring(false);
      setError(null);
    }
  }, [visible]);

  // Reset loading when the page is restored from bfcache (e.g. user
  // navigated to Stripe Checkout then pressed the browser back button).
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const reset = (e: PageTransitionEvent) => {
      if (e.persisted) setLoading(false);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const contextMessage = feature === 'chat'
    ? 'Unlock AI chat to get personalised insights on your finances.'
    : feature === 'moves'
    ? 'Unlock all moves to see your full action plan with step-by-step guidance.'
    : 'Get the full Bocy experience.';

  const showError = (msg: string) => {
    setError(msg);
    setLoading(false);
  };

  // ── Native IAP via RevenueCat ──
  const handleNativePurchase = async () => {
    setLoading(true);
    setError(null);
    try {
      const customerInfo = await purchasePackage(selectedPrice);
      if (customerInfo) {
        // Purchase succeeded — RC webhook will upsert the DB row,
        // but also refresh locally for instant UI update
        await refreshTier();
        onClose();
      }
      // null = user cancelled, just stop loading
    } catch (err: any) {
      console.warn('[Paywall] Native purchase error:', err);
      showError(err?.message || 'Purchase failed. Please try again.');
    }
    setLoading(false);
  };

  // ── Web: Stripe Checkout redirect ──
  const handleStripeCheckout = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession();
      const session = refreshed?.session;
      if (refreshErr || !session) {
        showError('Please sign in to subscribe.');
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ price: selectedPrice }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let msg = 'Unable to start checkout. Please try again.';
        try { msg = JSON.parse(text).error || msg; } catch {}
        showError(msg);
        return;
      }

      const data = await res.json();

      if (!data.url) {
        showError(data.error || 'Unable to start checkout. Please try again.');
        return;
      }

      window.location.href = data.url;
      return; // page is navigating away; don't touch state
    } catch (err: any) {
      console.warn('[Paywall] Checkout error:', err);
      const msg = err?.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : 'Could not connect to the payment server. Please try again.';
      showError(msg);
    }
    setLoading(false);
  };

  const handleSubscribe = isNative ? handleNativePurchase : handleStripeCheckout;

  // ── Restore purchases (native only) ──
  const handleRestore = async () => {
    setRestoring(true);
    setError(null);
    try {
      const restored = await restorePurchases();
      if (restored) {
        await refreshTier();
        onClose();
      } else {
        showError('No active subscription found. If you subscribed recently, it may take a moment to sync.');
      }
    } catch (err: any) {
      showError('Could not restore purchases. Please try again.');
    }
    setRestoring(false);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          {/* Close icon */}
          <TouchableOpacity
            style={s.closeIcon}
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            activeOpacity={0.6}
          >
            <Text style={s.closeIconText}>{'\u2715'}</Text>
          </TouchableOpacity>

          {/* Drag indicator */}
          <View style={s.dragIndicator} />

          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={false}
            contentContainerStyle={s.scrollContent}
          >
            {/* Header */}
            <View style={s.header}>
              <Text style={s.proBadge}>PRO</Text>
              <Text style={s.title}>Upgrade to Bocy Pro</Text>
              <Text style={s.subtitle}>{contextMessage}</Text>
            </View>

            {/* Price toggle */}
            <View style={s.priceToggle}>
              <TouchableOpacity
                style={[s.priceOption, selectedPrice === 'monthly' && s.priceOptionActive]}
                onPress={() => setSelectedPrice('monthly')}
                activeOpacity={0.7}
              >
                <Text style={[s.priceAmount, selectedPrice !== 'monthly' && s.priceAmountInactive]}>
                  {nativeMonthlyPrice || `${'\u00a3'}9.99`}
                </Text>
                <Text style={[s.pricePeriod, selectedPrice !== 'monthly' && s.pricePeriodInactive]}>
                  /month
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.priceOption, selectedPrice === 'yearly' && s.priceOptionActive]}
                onPress={() => setSelectedPrice('yearly')}
                activeOpacity={0.7}
              >
                <Text style={[s.priceAmount, selectedPrice !== 'yearly' && s.priceAmountInactive]}>
                  {nativeYearlyPrice || `${'\u00a3'}79.99`}
                </Text>
                <Text style={[s.pricePeriod, selectedPrice !== 'yearly' && s.pricePeriodInactive]}>
                  /year
                </Text>
                {selectedPrice === 'yearly' && (
                  <View style={s.saveBadge}>
                    <Text style={s.saveBadgeText}>save 33%</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {/* Features */}
            <View style={s.features}>
              {FEATURES.map((f, i) => (
                <View key={i} style={s.featureRow}>
                  <View style={s.checkCircle}>
                    <Text style={s.checkText}>{'\u2713'}</Text>
                  </View>
                  <View style={s.featureContent}>
                    <Text style={s.featureLabel}>{f.label}</Text>
                    <Text style={s.featureDesc}>{f.desc}</Text>
                  </View>
                </View>
              ))}
            </View>

            {/* CTA */}
            <TouchableOpacity
              style={[s.upgradeBtn, loading && s.upgradeBtnDisabled]}
              activeOpacity={0.8}
              onPress={handleSubscribe}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#000000" />
              ) : (
                <Text style={s.upgradeBtnText}>Subscribe</Text>
              )}
            </TouchableOpacity>
            {error && (
              <View style={s.errorBanner}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}
            <Text style={s.trialNote}>Cancel anytime</Text>

            {/* Restore purchases (native only) */}
            {isNative && (
              <TouchableOpacity
                style={s.restoreBtn}
                onPress={handleRestore}
                disabled={restoring}
                activeOpacity={0.7}
              >
                {restoring ? (
                  <ActivityIndicator size="small" color={colors.dim} />
                ) : (
                  <Text style={s.restoreBtnText}>Restore purchases</Text>
                )}
              </TouchableOpacity>
            )}

            {/* Dismiss */}
            <TouchableOpacity style={s.closeBtn} onPress={onClose} activeOpacity={0.7}>
              <Text style={s.closeBtnText}>Maybe later</Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const createStyles = (c: ThemeColors) => StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '90%',
    borderWidth: 1,
    borderColor: c.border,
    borderBottomWidth: 0,
  },
  closeIcon: {
    position: 'absolute',
    top: 16,
    right: 20,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.accentDim,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeIconText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
  },
  dragIndicator: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.muted,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  scrollContent: {
    padding: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },

  // Header
  header: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  proBadge: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 3,
    color: c.green,
    backgroundColor: c.greenDim,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
    borderRadius: 100,
    paddingVertical: 4,
    paddingHorizontal: 14,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: c.text,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.text2,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Price toggle
  priceToggle: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  priceOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.mintDim,
  },
  priceOptionActive: {
    borderColor: c.accent,
    backgroundColor: c.accentDim,
  },
  priceAmount: {
    fontFamily: fonts.mono,
    fontSize: 24,
    fontWeight: '300',
    color: c.text,
    letterSpacing: -1,
  },
  priceAmountInactive: {
    color: c.dim,
  },
  pricePeriod: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    marginTop: 2,
  },
  pricePeriodInactive: {
    color: c.muted,
  },
  saveBadge: {
    backgroundColor: c.greenDim,
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: spacing.xs,
  },
  saveBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: c.green,
  },

  // Features
  features: {
    marginBottom: spacing.xl,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  checkCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: c.greenDim,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm + 4,
    marginTop: 1,
  },
  checkText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.green,
  },
  featureContent: {
    flex: 1,
  },
  featureLabel: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: c.text,
    marginBottom: 2,
  },
  featureDesc: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    lineHeight: 18,
  },

  // CTA
  upgradeBtn: {
    backgroundColor: c.accent,
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
  },
  upgradeBtnDisabled: {
    opacity: 0.6,
  },
  upgradeBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: c.bg,
  },
  errorBanner: {
    backgroundColor: c.coralDim,
    borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.25)',
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.coral,
    textAlign: 'center',
    lineHeight: 20,
  },
  trialNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

  // Restore
  restoreBtn: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
  },
  restoreBtnText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    textDecorationLine: 'underline',
  },

  // Close
  closeBtn: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  closeBtnText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
  },
});
