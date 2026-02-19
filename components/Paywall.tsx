// ── Paywall modal ──
// Shown when free users try to access Pro features.
// Matches the Nothing Phone OS design language.

import { View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView } from 'react-native';
import { colors, fonts, spacing, radius } from '@/theme';

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
  const contextMessage = feature === 'chat'
    ? 'Unlock AI chat to get personalised advice on your finances.'
    : feature === 'moves'
    ? 'Unlock all moves to see your full action plan with step-by-step guidance.'
    : 'Get the full Bocy experience.';

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

            {/* Price */}
            <View style={styles.priceCard}>
              <View style={styles.priceRow}>
                <Text style={styles.priceAmount}>{'\u00a3'}4.99</Text>
                <Text style={styles.pricePeriod}>/month</Text>
              </View>
              <Text style={styles.priceAlt}>or {'\u00a3'}39.99/year (save 33%)</Text>
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
            <TouchableOpacity style={styles.upgradeBtn} activeOpacity={0.8}>
              <Text style={styles.upgradeBtnText}>Start free trial</Text>
            </TouchableOpacity>
            <Text style={styles.trialNote}>7-day free trial, cancel anytime</Text>

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

  // Price
  priceCard: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    marginBottom: spacing.lg,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  priceAmount: {
    fontFamily: fonts.mono,
    fontSize: 36,
    fontWeight: '300',
    color: colors.text,
    letterSpacing: -1,
  },
  pricePeriod: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.dim,
    marginLeft: 2,
  },
  priceAlt: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginTop: spacing.xs,
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
