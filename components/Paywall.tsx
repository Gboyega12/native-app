// ── Paywall modal ──
// Shown when free users try to access Pro features.
// Matches the Nothing Phone OS design language.

import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Pressable, Platform, ActivityIndicator, Alert, Linking } from 'react-native';
import { colors, fonts, spacing, radius } from '@/theme';
import { supabase } from '@/lib/supabase';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrice, setSelectedPrice] = useState<'monthly' | 'yearly'>('monthly');

  const contextMessage = feature === 'chat'
    ? 'Unlock AI chat to get personalised insights on your finances.'
    : feature === 'moves'
    ? 'Unlock all moves to see your full action plan with step-by-step guidance.'
    : 'Get the full Bocy experience.';

  const showError = (msg: string) => {
    setError(msg);
    setLoading(false);
  };

  const handleSubscribe = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        showError('Please sign in to subscribe.');
        return;
      }

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ price: selectedPrice }),
      });

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

      if (Platform.OS === 'web') {
        window.location.href = data.url;
      } else {
        await Linking.openURL(data.url);
      }
    } catch (err) {
      console.warn('[Paywall] Checkout error:', err);
      showError('Could not connect to the payment server. Please try again.');
    }
    setLoading(false);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {/* Close icon */}
          <TouchableOpacity
            style={styles.closeIcon}
            onPress={onClose}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            activeOpacity={0.6}
          >
            <Text style={styles.closeIconText}>{'\u2715'}</Text>
          </TouchableOpacity>

          {/* Drag indicator */}
          <View style={styles.dragIndicator} />

          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={false}
            contentContainerStyle={styles.scrollContent}
          >
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.proBadge}>PRO</Text>
              <Text style={styles.title}>Upgrade to Bocy Pro</Text>
              <Text style={styles.subtitle}>{contextMessage}</Text>
            </View>

            {/* Price toggle */}
            <View style={styles.priceToggle}>
              <TouchableOpacity
                style={[styles.priceOption, selectedPrice === 'monthly' && styles.priceOptionActive]}
                onPress={() => setSelectedPrice('monthly')}
                activeOpacity={0.7}
              >
                <Text style={[styles.priceAmount, selectedPrice !== 'monthly' && styles.priceAmountInactive]}>
                  {'\u00a3'}9.99
                </Text>
                <Text style={[styles.pricePeriod, selectedPrice !== 'monthly' && styles.pricePeriodInactive]}>
                  /month
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.priceOption, selectedPrice === 'yearly' && styles.priceOptionActive]}
                onPress={() => setSelectedPrice('yearly')}
                activeOpacity={0.7}
              >
                <Text style={[styles.priceAmount, selectedPrice !== 'yearly' && styles.priceAmountInactive]}>
                  {'\u00a3'}79.99
                </Text>
                <Text style={[styles.pricePeriod, selectedPrice !== 'yearly' && styles.pricePeriodInactive]}>
                  /year
                </Text>
                {selectedPrice === 'yearly' && (
                  <View style={styles.saveBadge}>
                    <Text style={styles.saveBadgeText}>save 33%</Text>
                  </View>
                )}
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
              style={[styles.upgradeBtn, loading && styles.upgradeBtnDisabled]}
              activeOpacity={0.8}
              onPress={handleSubscribe}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#000000" />
              ) : (
                <Text style={styles.upgradeBtnText}>Subscribe</Text>
              )}
            </TouchableOpacity>
            {error && (
              <Text style={styles.errorText}>{error}</Text>
            )}
            <Text style={styles.trialNote}>Cancel anytime</Text>

            {/* Dismiss */}
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.closeBtnText}>Maybe later</Text>
            </TouchableOpacity>
          </ScrollView>
        </Pressable>
      </Pressable>
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
  closeIcon: {
    position: 'absolute',
    top: 16,
    right: 20,
    zIndex: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeIconText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
  },
  dragIndicator: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
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
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
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
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  priceOptionActive: {
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  priceAmount: {
    fontFamily: fonts.mono,
    fontSize: 24,
    fontWeight: '300',
    color: colors.text,
    letterSpacing: -1,
  },
  priceAmountInactive: {
    color: colors.dim,
  },
  pricePeriod: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginTop: 2,
  },
  pricePeriodInactive: {
    color: colors.muted,
  },
  saveBadge: {
    backgroundColor: 'rgba(0,212,170,0.12)',
    borderRadius: 100,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: spacing.xs,
  },
  saveBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 0.5,
    color: colors.green,
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
    marginRight: spacing.sm + 4,
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
    marginBottom: 2,
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
  },
  upgradeBtnDisabled: {
    opacity: 0.6,
  },
  upgradeBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: '#000000',
  },
  errorText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: '#FF6B6B',
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  trialNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: spacing.sm,
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
    color: colors.dim,
  },
});
