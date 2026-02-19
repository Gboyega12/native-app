// ── Paywall modal ──
// Shown when free users try to access Pro features.
// Fetches live pricing from RevenueCat on native, shows fallback on web.

import { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView,
  ActivityIndicator, Platform, Alert,
} from 'react-native';
import { colors, fonts, spacing, radius } from '@/theme';
import { getOfferings, purchasePackage, restorePurchases } from '@/lib/revenuecat';
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
  const { refresh } = useSubscription();
  const [monthly, setMonthly] = useState<any | null>(null);
  const [annual, setAnnual] = useState<any | null>(null);
  const [selected, setSelected] = useState<'annual' | 'monthly'>('annual');
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [loadingProducts, setLoadingProducts] = useState(false);

  // Fetch offerings when paywall opens
  useEffect(() => {
    if (!visible) return;
    loadProducts();
  }, [visible]);

  const loadProducts = async () => {
    if (Platform.OS === 'web') return; // Web uses fallback pricing
    setLoadingProducts(true);
    const offering = await getOfferings();
    if (offering) {
      setMonthly(offering.monthly);
      setAnnual(offering.annual);
    }
    setLoadingProducts(false);
  };

  const handlePurchase = async () => {
    const pkg = selected === 'annual' ? annual : monthly;

    if (Platform.OS === 'web' || !pkg) {
      // Web: direct to Stripe checkout or show info
      Alert.alert(
        'Subscribe via app',
        'In-app purchases are available on iOS and Android. Download the Bocy app to subscribe.',
      );
      return;
    }

    setPurchasing(true);
    const { success } = await purchasePackage(pkg);
    setPurchasing(false);

    if (success) {
      await refresh();
      onClose();
    }
  };

  const handleRestore = async () => {
    setRestoring(true);
    const info = await restorePurchases();
    setRestoring(false);

    if (info?.entitlements.active['pro']) {
      await refresh();
      onClose();
    } else {
      Alert.alert('No active subscription', 'We couldn\'t find an active Pro subscription to restore.');
    }
  };

  const contextMessage = feature === 'chat'
    ? 'Unlock AI chat to get personalised advice on your finances.'
    : feature === 'moves'
    ? 'Unlock all moves to see your full action plan with step-by-step guidance.'
    : 'Get the full Bocy experience.';

  // Use live pricing from RevenueCat if available, fallback to hardcoded
  const monthlyPrice = monthly?.product.priceString || '\u00a34.99';
  const annualPrice = annual?.product.priceString || '\u00a339.99';
  const annualMonthly = annual?.product.price
    ? `\u00a3${(annual.product.price / 12).toFixed(2)}`
    : '\u00a33.33';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <ScrollView showsVerticalScrollIndicator={false} bounces={false} contentContainerStyle={styles.scrollContent}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.proBadge}>PRO</Text>
              <Text style={styles.title}>Upgrade to Bocy Pro</Text>
              <Text style={styles.subtitle}>{contextMessage}</Text>
            </View>

            {/* Plan selector */}
            <View style={styles.planSelector}>
              <TouchableOpacity
                style={[styles.planOption, selected === 'annual' && styles.planOptionSelected]}
                onPress={() => setSelected('annual')}
                activeOpacity={0.8}
              >
                <View style={styles.planBestValue}>
                  <Text style={styles.planBestValueText}>BEST VALUE</Text>
                </View>
                <Text style={styles.planName}>Annual</Text>
                <Text style={styles.planPrice}>{annualPrice}/yr</Text>
                <Text style={styles.planSub}>{annualMonthly}/mo</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.planOption, selected === 'monthly' && styles.planOptionSelected]}
                onPress={() => setSelected('monthly')}
                activeOpacity={0.8}
              >
                <Text style={styles.planName}>Monthly</Text>
                <Text style={styles.planPrice}>{monthlyPrice}/mo</Text>
                <Text style={styles.planSub}>Cancel anytime</Text>
              </TouchableOpacity>
            </View>

            {/* Features */}
            <View style={styles.features}>
              {FEATURES.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <View style={styles.checkCircle}>
                    <Text style={styles.checkText}>{'\u2713'}</Text>
                  </View>
                  <View style={styles.featureContent}>
                    <Text style={styles.featureLabel}>{f.label}</Text>
                    <Text style={styles.featureDesc}>{f.desc}</Text>
                  </View>
                </View>
              ))}
            </View>

            {/* CTA */}
            <TouchableOpacity
              style={[styles.upgradeBtn, purchasing && styles.upgradeBtnDisabled]}
              onPress={handlePurchase}
              activeOpacity={0.8}
              disabled={purchasing || loadingProducts}
            >
              {purchasing ? (
                <ActivityIndicator color="#000000" size="small" />
              ) : (
                <Text style={styles.upgradeBtnText}>Start free trial</Text>
              )}
            </TouchableOpacity>
            <Text style={styles.trialNote}>7-day free trial, cancel anytime</Text>

            {/* Restore */}
            {Platform.OS !== 'web' && (
              <TouchableOpacity
                style={styles.restoreBtn}
                onPress={handleRestore}
                activeOpacity={0.7}
                disabled={restoring}
              >
                {restoring ? (
                  <ActivityIndicator color={colors.dim} size="small" />
                ) : (
                  <Text style={styles.restoreBtnText}>Restore purchases</Text>
                )}
              </TouchableOpacity>
            )}

            {/* Dismiss */}
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.closeBtnText}>Maybe later</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '90%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderBottomWidth: 0,
  },
  scrollContent: {
    padding: spacing.xl,
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
    color: colors.green,
    backgroundColor: 'rgba(0,212,170,0.12)',
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
    color: colors.text,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Plan selector
  planSelector: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  planOption: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  planOptionSelected: {
    borderColor: colors.green,
    backgroundColor: 'rgba(0,212,170,0.06)',
  },
  planBestValue: {
    backgroundColor: colors.green,
    borderRadius: 100,
    paddingVertical: 2,
    paddingHorizontal: 8,
    marginBottom: spacing.xs,
  },
  planBestValueText: {
    fontFamily: fonts.mono,
    fontSize: 8,
    letterSpacing: 1,
    color: '#000000',
    fontWeight: '700',
  },
  planName: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    marginBottom: 2,
  },
  planPrice: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: colors.text,
    fontWeight: '300',
  },
  planSub: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    marginTop: 2,
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
    backgroundColor: 'rgba(0,212,170,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
    marginTop: 1,
  },
  checkText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.green,
  },
  featureContent: {
    flex: 1,
  },
  featureLabel: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.text,
    marginBottom: 1,
  },
  featureDesc: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    lineHeight: 18,
  },

  // CTA
  upgradeBtn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    paddingVertical: 16,
    alignItems: 'center',
    minHeight: 52,
    justifyContent: 'center',
  },
  upgradeBtnDisabled: {
    opacity: 0.7,
  },
  upgradeBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: '#000000',
  },
  trialNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },

  // Restore
  restoreBtn: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  restoreBtnText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    textDecorationLine: 'underline',
  },

  // Close
  closeBtn: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    marginTop: spacing.xs,
  },
  closeBtnText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
  },
});
