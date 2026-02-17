import { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Linking,
  LayoutAnimation,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';

const CONSENT_DAYS = 90;
const WARN_DAYS = 14; // show warning when < 14 days left

type BankConnection = {
  id: string;
  connection_id: string;
  source: string;
  created_at: string;
  updated_at: string | null;
  account_type?: string; // 'bank' | 'credit'
  provider_name?: string;
};

function getConsentStatus(createdAt: string) {
  const created = new Date(createdAt);
  const expiry = new Date(created);
  expiry.setDate(expiry.getDate() + CONSENT_DAYS);
  const now = new Date();
  const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  const expired = daysLeft <= 0;
  const expiring = !expired && daysLeft <= WARN_DAYS;
  return { expiry, daysLeft, expired, expiring };
}

export default function Profile() {
  const router = useRouter();
  const { connected } = useLocalSearchParams<{ connected?: string }>();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [securityOpen, setSecurityOpen] = useState(false);
  const [connectedBanks, setConnectedBanks] = useState<BankConnection[]>([]);
  const [showSuccess, setShowSuccess] = useState(connected === 'true');

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setName(user.user_metadata?.full_name || '');
      setEmail(user.email || '');
      const { data: banks } = await supabase
        .from('bank_data')
        .select('id, connection_id, source, created_at, updated_at, account_type, provider_name')
        .eq('user_id', user.id)
        .order('created_at', { ascending: true });
      if (banks) setConnectedBanks(banks as BankConnection[]);
    }
  };

  const handleRemoveBank = (bankId: string, label: string) => {
    Alert.alert(
      `Remove ${label}?`,
      'This will remove this connection and its data. You can reconnect it later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('bank_data').delete().eq('id', bankId);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setConnectedBanks((prev) => prev.filter((b) => b.id !== bankId));
          },
        },
      ],
    );
  };

  const handleReconnect = () => {
    router.push({ pathname: '/(main)/connect', params: { from: 'profile' } });
  };

  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/(auth)/sign-in');
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete account',
      'This will permanently delete your account and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const { data: { session } } = await supabase.auth.getSession();
              if (!session) {
                Alert.alert('Error', 'You are not signed in.');
                return;
              }

              const res = await fetch('/api/delete-account', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${session.access_token}`,
                },
              });

              const data = await res.json();
              if (data.success) {
                await supabase.auth.signOut();
                router.replace('/(auth)/sign-in');
              } else {
                Alert.alert('Error', data.error || 'Could not delete account. Please try again.');
              }
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Something went wrong. Please try again.');
            }
          },
        },
      ],
    );
  };

  // Split connections by type
  const bankAccounts = connectedBanks.filter((b) => b.account_type !== 'credit');
  const creditCards = connectedBanks.filter((b) => b.account_type === 'credit');

  return (
    <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scroll}>
      {/* Back button */}
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => router.back()}
      >
        <Text style={styles.backArrow}>{'\u2190'}</Text>
        <Text style={styles.backLabel}>Home</Text>
      </TouchableOpacity>

      {/* Connection success banner */}
      {showSuccess && (
        <View style={styles.successBanner}>
          <Text style={styles.successBannerText}>Connection successful</Text>
          <TouchableOpacity onPress={() => setShowSuccess(false)}>
            <Text style={styles.successDismiss}>{'x'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Avatar */}
      <View style={styles.avatarSection}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials || '?'}</Text>
        </View>
        <Text style={styles.name}>{name || 'User'}</Text>
        <Text style={styles.email}>{email}</Text>
      </View>

      {/* ── BANK ACCOUNTS (transactions) ── */}
      <View style={styles.connectionSection}>
        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={styles.sectionLabel}>BANK ACCOUNTS</Text>
            <Text style={styles.sectionHint}>Transaction data (e.g. Revolut, Monzo)</Text>
          </View>
          <TouchableOpacity
            onPress={handleReconnect}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.addIcon}>+</Text>
          </TouchableOpacity>
        </View>

        {bankAccounts.length > 0 ? (
          bankAccounts.map((bank, i) => (
            <ConnectionCard
              key={bank.id}
              bank={bank}
              index={i}
              typeLabel="Bank account"
              onRemove={() => handleRemoveBank(bank.id, bank.provider_name || `Bank account ${i + 1}`)}
              onReconnect={handleReconnect}
            />
          ))
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyCardText}>No bank accounts connected</Text>
            <TouchableOpacity onPress={handleReconnect}>
              <Text style={styles.emptyCardLink}>Connect your first bank account</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* ── CREDIT CARDS (balances) ── */}
      <View style={styles.connectionSection}>
        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={styles.sectionLabel}>CREDIT CARDS</Text>
            <Text style={styles.sectionHint}>Credit balances (e.g. Amex, Capital One)</Text>
          </View>
          <TouchableOpacity
            onPress={handleReconnect}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Text style={styles.addIcon}>+</Text>
          </TouchableOpacity>
        </View>

        {creditCards.length > 0 ? (
          creditCards.map((bank, i) => (
            <ConnectionCard
              key={bank.id}
              bank={bank}
              index={i}
              typeLabel="Credit card"
              onRemove={() => handleRemoveBank(bank.id, bank.provider_name || `Credit card ${i + 1}`)}
              onReconnect={handleReconnect}
            />
          ))
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyCardText}>No credit cards connected</Text>
            <TouchableOpacity onPress={handleReconnect}>
              <Text style={styles.emptyCardLink}>Connect a credit card</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* 90-day consent info */}
      {connectedBanks.length > 0 && (
        <View style={styles.consentInfo}>
          <Text style={styles.consentText}>
            Open Banking connections expire every 90 days. You'll need to reauthorise to keep your data up to date.
          </Text>
        </View>
      )}

      {/* Menu Items */}
      <MenuItem
        icon=">"
        label="Goals"
        onPress={() => router.push('/(main)/goals')}
      />
      <MenuItem
        icon="@"
        label="Report a Bug"
        onPress={() => Linking.openURL('mailto:support@bocy.app?subject=Bug%20Report')}
      />
      <MenuItem
        icon="!"
        label="Notifications"
        onPress={() => Alert.alert('Coming soon', 'Notifications will be available in a future update.')}
        dimmed
      />
      <MenuItem
        icon="#"
        label="Agreements"
        onPress={() => Alert.alert('Coming soon', 'Agreements will be available in a future update.')}
        dimmed
      />

      {/* Security Section */}
      <TouchableOpacity
        style={styles.securityHeader}
        onPress={() => setSecurityOpen(!securityOpen)}
      >
        <Text style={styles.securityTitle}>Security</Text>
        <Text style={styles.securityChevron}>{securityOpen ? 'v' : '>'}</Text>
      </TouchableOpacity>

      {securityOpen && (
        <View style={styles.securityContent}>
          <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.deleteButton} onPress={handleDeleteAccount}>
            <Text style={styles.deleteText}>Delete account</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

/* ── Connection Card Component ── */
function ConnectionCard({
  bank, index, typeLabel, onRemove, onReconnect,
}: {
  bank: BankConnection; index: number; typeLabel: string;
  onRemove: () => void; onReconnect: () => void;
}) {
  const connDate = new Date(bank.created_at);
  const lastSync = bank.updated_at ? new Date(bank.updated_at) : null;
  const { daysLeft, expired, expiring } = getConsentStatus(bank.created_at);
  const displayName = bank.provider_name || `${typeLabel} ${index + 1}`;

  return (
    <View style={[styles.bankCard, expired && styles.bankCardExpired]}>
      <View style={styles.bankCardTop}>
        <View style={styles.bankCardInfo}>
          <Text style={styles.bankCardName}>{displayName}</Text>
          <Text style={styles.bankCardMeta}>
            Connected {connDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            {lastSync ? ` · Synced ${lastSync.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
          </Text>
        </View>

        {/* Status badge */}
        {expired ? (
          <View style={[styles.statusBadge, styles.statusExpired]}>
            <Text style={styles.statusExpiredText}>Expired</Text>
          </View>
        ) : expiring ? (
          <View style={[styles.statusBadge, styles.statusWarning]}>
            <Text style={styles.statusWarningText}>{daysLeft}d left</Text>
          </View>
        ) : (
          <View style={[styles.statusBadge, styles.statusActive]}>
            <Text style={styles.statusActiveText}>Active</Text>
          </View>
        )}
      </View>

      {/* Consent expiry bar */}
      <View style={styles.consentBar}>
        <View
          style={[
            styles.consentBarFill,
            {
              flex: Math.max(0, Math.min(CONSENT_DAYS, CONSENT_DAYS - daysLeft)),
              backgroundColor: expired ? colors.coral : expiring ? '#E8C55A' : colors.accent,
            },
          ]}
        />
        <View style={{ flex: Math.max(0, Math.min(CONSENT_DAYS, daysLeft)) }} />
      </View>

      {/* Actions row */}
      <View style={styles.bankCardActions}>
        {expired ? (
          <TouchableOpacity style={styles.reconnectButton} onPress={onReconnect}>
            <Text style={styles.reconnectText}>Reconnect now</Text>
          </TouchableOpacity>
        ) : expiring ? (
          <TouchableOpacity style={styles.renewButton} onPress={onReconnect}>
            <Text style={styles.renewText}>Renew connection</Text>
          </TouchableOpacity>
        ) : (
          <View />
        )}
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeText}>Remove</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function MenuItem({
  icon, label, onPress, dimmed,
}: {
  icon: string; label: string; onPress: () => void; dimmed?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress}>
      <Text style={[styles.menuIcon, dimmed && styles.dimmed]}>{icon}</Text>
      <Text style={[styles.menuLabel, dimmed && styles.dimmed]}>{label}</Text>
      <Text style={styles.menuChevron}>{'>'}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.xl,
    paddingTop: spacing.xxl + spacing.md,
    paddingBottom: spacing.xxl,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  backArrow: {
    fontFamily: fonts.regular,
    fontSize: 20,
    color: colors.accent,
    marginRight: spacing.xs,
  },
  backLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.accent,
  },
  successBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(122,239,199,0.08)',
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: spacing.md,
  },
  successBannerText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
  },
  successDismiss: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.dim,
    padding: 4,
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  avatarText: {
    fontFamily: fonts.semibold,
    fontSize: 24,
    color: colors.bg,
    fontWeight: '700',
  },
  name: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.text,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  email: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
  },

  // ── Connection sections ──
  connectionSection: {
    marginBottom: spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: 'uppercase',
  },
  sectionHint: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  addIcon: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.accent,
    width: 30,
    height: 30,
    lineHeight: 28,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 15,
    overflow: 'hidden',
  },

  // ── Connection card ──
  bankCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  bankCardExpired: {
    borderColor: colors.coralDim,
  },
  bankCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  bankCardInfo: {
    flex: 1,
    marginRight: spacing.sm,
  },
  bankCardName: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  bankCardMeta: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    marginTop: 2,
  },

  // ── Status badges ──
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  statusActive: {
    backgroundColor: 'rgba(122,239,199,0.1)',
  },
  statusActiveText: {
    fontFamily: fonts.medium,
    fontSize: 10,
    color: colors.accent,
  },
  statusWarning: {
    backgroundColor: 'rgba(232,197,90,0.12)',
  },
  statusWarningText: {
    fontFamily: fonts.medium,
    fontSize: 10,
    color: '#E8C55A',
  },
  statusExpired: {
    backgroundColor: colors.coralDim,
  },
  statusExpiredText: {
    fontFamily: fonts.medium,
    fontSize: 10,
    color: colors.coral,
  },

  // ── Consent bar ──
  consentBar: {
    flexDirection: 'row',
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginTop: 10,
    overflow: 'hidden',
  },
  consentBarFill: {
    borderRadius: 2,
  },

  // ── Card actions ──
  bankCardActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
  },
  reconnectButton: {
    backgroundColor: colors.coralDim,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  reconnectText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.coral,
  },
  renewButton: {
    backgroundColor: 'rgba(232,197,90,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  renewText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: '#E8C55A',
  },
  removeText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
  },

  // ── Empty state ──
  emptyCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: 'center',
  },
  emptyCardText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  emptyCardLink: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
  },

  // ── Consent info ──
  consentInfo: {
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  consentText: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    lineHeight: 16,
    textAlign: 'center',
  },

  // ── Menu items ──
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  menuIcon: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.accent,
    width: 28,
  },
  menuLabel: {
    fontFamily: fonts.regular,
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  menuChevron: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.muted,
  },
  dimmed: {
    color: colors.muted,
  },

  // ── Security ──
  securityHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  securityTitle: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.accent,
    textTransform: 'uppercase',
  },
  securityChevron: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.muted,
  },
  securityContent: {
    gap: spacing.sm,
  },
  signOutButton: {
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  signOutText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  deleteButton: {
    borderWidth: 1,
    borderColor: colors.coralDim,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  deleteText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.coral,
  },
});
