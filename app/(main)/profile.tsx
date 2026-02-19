import { useEffect, useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Linking,
  LayoutAnimation, Animated, Easing, Switch, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import { useSubscription } from '@/lib/subscription';
import Paywall from '@/components/Paywall';

// ── Glyph micro-animation: fade+scale on mount ──
const AnimGlyph = ({ children, delay = 0, style }: { children: React.ReactNode; delay?: number; style?: any }) => {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 500,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: anim,
          transform: [{
            scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
          }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
};

const CONSENT_DAYS = 90;
const WARN_DAYS = 14;

type BankConnection = {
  id: string;
  connection_id: string;
  source: string;
  created_at: string;
  updated_at: string | null;
  account_type?: string;
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
  return { daysLeft, expired, expiring };
}

function getProviderInitial(name: string) {
  return (name || '?')[0].toUpperCase();
}

export default function Profile() {
  const router = useRouter();
  const { connected } = useLocalSearchParams<{ connected?: string }>();
  const { tier, isPro } = useSubscription();
  const [showPaywall, setShowPaywall] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [connectedBanks, setConnectedBanks] = useState<BankConnection[]>([]);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);
  const [showSuccess, setShowSuccess] = useState(connected === 'true');
  const [notifPrefs, setNotifPrefs] = useState({
    weekly_digest: true,
    milestone_alerts: true,
    checkin_prompts: true,
    achievement_alerts: true,
  });
  const [notifExpanded, setNotifExpanded] = useState(false);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setName(user.user_metadata?.full_name || '');
      setEmail(user.email || '');

      // Try to claim any unclaimed bank_data rows for this user
      // This handles cases where TrueLayer redirect didn't properly set user_id
      try {
        await supabase
          .from('bank_data')
          .update({ user_id: user.id })
          .is('user_id', null)
          .eq('source', 'truelayer');
      } catch {}

      const [banksRes, debtRes] = await Promise.all([
        supabase
          .from('bank_data')
          .select('id, connection_id, source, created_at, updated_at, account_type, provider_name')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('debt_accounts')
          .select('id, account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, source, last_updated')
          .eq('user_id', user.id),
      ]);
      if (banksRes.data) setConnectedBanks(banksRes.data as BankConnection[]);
      if (debtRes.data) setDebtAccounts(debtRes.data);

      // Load notification preferences
      try {
        const { data: prefs } = await supabase
          .from('notification_preferences')
          .select('weekly_digest, milestone_alerts, checkin_prompts, achievement_alerts')
          .eq('user_id', user.id)
          .single();
        if (prefs) {
          setNotifPrefs({
            weekly_digest: prefs.weekly_digest ?? true,
            milestone_alerts: prefs.milestone_alerts ?? true,
            checkin_prompts: prefs.checkin_prompts ?? true,
            achievement_alerts: prefs.achievement_alerts ?? true,
          });
        }
      } catch {}
    }
  };

  const handleRemoveBank = (bankId: string, label: string) => {
    Alert.alert(
      `Remove ${label}?`,
      'This will disconnect this account and remove its data. You can reconnect later.',
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

  const handleRemoveDebtAccount = (debtId: string, label: string) => {
    Alert.alert(
      `Remove ${label}?`,
      'This will remove this account from your profile.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await supabase.from('debt_accounts').delete().eq('id', debtId);
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setDebtAccounts((prev) => prev.filter((d) => d.id !== debtId));
          },
        },
      ],
    );
  };

  const handleAddAccount = () => {
    router.push({ pathname: '/(main)/connect', params: { from: 'profile' } });
  };

  const toggleNotifPref = async (key: keyof typeof notifPrefs) => {
    const newVal = !notifPrefs[key];
    setNotifPrefs((prev) => ({ ...prev, [key]: newVal }));
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('notification_preferences').update({
          [key]: newVal,
          updated_at: new Date().toISOString(),
        }).eq('user_id', user.id);
      }
    } catch {}
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

  const allAccounts = connectedBanks;
  const hasAccounts = allAccounts.length > 0 || debtAccounts.length > 0;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.scroll}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={s.backBtn}>{'\u2190'}</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Profile</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Success banner */}
      {showSuccess && (
        <TouchableOpacity style={s.successBanner} onPress={() => setShowSuccess(false)} activeOpacity={0.8}>
          <Text style={s.successText}>Account connected successfully</Text>
          <Text style={s.successDismiss}>{'\u2715'}</Text>
        </TouchableOpacity>
      )}

      {/* Profile card */}
      <AnimGlyph delay={0}>
        <View style={s.profileCard}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials || '?'}</Text>
          </View>
          <View style={s.profileInfo}>
            <Text style={s.profileName}>{name || 'User'}</Text>
            <Text style={s.profileEmail}>{email}</Text>
          </View>
        </View>
      </AnimGlyph>

      {/* ── Paywall ── */}
      <Paywall visible={showPaywall} onClose={() => setShowPaywall(false)} />

      {/* ── Subscription ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Subscription</Text>
        <View style={s.subCard}>
          <View style={s.subCardHeader}>
            <View style={[s.subBadge, isPro && s.subBadgePro]}>
              <Text style={[s.subBadgeText, isPro && s.subBadgeTextPro]}>
                {isPro ? 'PRO' : 'FREE'}
              </Text>
            </View>
            <Text style={s.subTierLabel}>
              {isPro ? 'Bocy Pro' : 'Free plan'}
            </Text>
          </View>
          {!isPro && (
            <>
              <Text style={s.subDesc}>
                Upgrade to unlock all moves, AI chat, weekly digests, and smart check-ins.
              </Text>
              <TouchableOpacity
                style={s.subUpgradeBtn}
                onPress={() => setShowPaywall(true)}
                activeOpacity={0.8}
              >
                <Text style={s.subUpgradeBtnText}>Upgrade to Pro</Text>
              </TouchableOpacity>
            </>
          )}
          {isPro && (
            <Text style={s.subDesc}>
              You have access to all Bocy features.
            </Text>
          )}
        </View>
      </View>

      {/* ── Accounts ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Accounts</Text>

        {allAccounts.map((bank, i) => {
          const displayName = bank.provider_name || (bank.account_type === 'credit' ? `Credit card ${i + 1}` : `Bank account ${i + 1}`);
          const isBank = bank.account_type !== 'credit';
          const typeLabel = isBank ? 'Bank' : 'Credit';
          const { daysLeft, expired, expiring } = getConsentStatus(bank.created_at);
          const lastSync = bank.updated_at ? new Date(bank.updated_at) : null;

          return (
            <AnimGlyph key={bank.id} delay={100 + i * 80}>
              <View style={[s.accountCard, expired && s.accountCardExpired, isBank && !expired && s.accountCardBank]}>
                <View style={s.accountRow}>
                  {/* Icon */}
                  <View style={[s.accountIcon, expired && s.accountIconExpired, isBank && !expired && s.accountIconBank]}>
                    <Text style={[s.accountIconText, expired && s.accountIconTextExpired, isBank && !expired && s.accountIconTextBank]}>
                      {getProviderInitial(displayName)}
                    </Text>
                  </View>

                  {/* Info */}
                  <View style={s.accountInfo}>
                    <View style={s.accountNameRow}>
                      <Text style={s.accountName}>{displayName}</Text>
                      <View style={[s.typeBadge, bank.account_type === 'credit' && s.typeBadgeCredit, isBank && s.typeBadgeBank]}>
                        <Text style={[s.typeBadgeText, bank.account_type === 'credit' && s.typeBadgeTextCredit, isBank && s.typeBadgeTextBank]}>{typeLabel}</Text>
                      </View>
                      {isBank && !expired && (
                        <View style={s.connectedBadge}>
                          <View style={s.connectedDot} />
                          <Text style={s.connectedText}>Connected</Text>
                        </View>
                      )}
                    </View>
                  <Text style={s.accountMeta}>
                    {lastSync ? `Synced ${lastSync.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : `Connected ${new Date(bank.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                    {!expired && !expiring ? ` · ${daysLeft}d remaining` : ''}
                  </Text>

                  {/* Consent bar */}
                  <View style={s.consentBar}>
                    <View
                      style={[
                        s.consentFill,
                        {
                          flex: Math.max(0, Math.min(CONSENT_DAYS, CONSENT_DAYS - daysLeft)),
                          backgroundColor: expired ? colors.coral : expiring ? '#E8C55A' : isBank ? colors.green : colors.accent,
                        },
                      ]}
                    />
                    <View style={{ flex: Math.max(0, Math.min(CONSENT_DAYS, daysLeft)) }} />
                  </View>
                </View>

                {/* Status */}
                {expired ? (
                  <View style={[s.statusDot, { backgroundColor: colors.coral }]} />
                ) : expiring ? (
                  <View style={[s.statusDot, { backgroundColor: '#E8C55A' }]} />
                ) : (
                  <View style={[s.statusDot, { backgroundColor: isBank ? colors.green : colors.accent }]} />
                )}
              </View>

              {/* Actions */}
              <View style={s.accountActions}>
                {expired ? (
                  <TouchableOpacity style={s.reconnectBtn} onPress={handleAddAccount}>
                    <Text style={s.reconnectBtnText}>Reconnect</Text>
                  </TouchableOpacity>
                ) : expiring ? (
                  <TouchableOpacity style={s.renewBtn} onPress={handleAddAccount}>
                    <Text style={s.renewBtnText}>Renew</Text>
                  </TouchableOpacity>
                ) : (
                  <View />
                )}
                <TouchableOpacity
                  onPress={() => handleRemoveBank(bank.id, displayName)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={s.removeLink}>Remove</Text>
                </TouchableOpacity>
              </View>
              </View>
            </AnimGlyph>
          );
        })}

        {/* Debt / balance accounts */}
        {debtAccounts.map((d, idx) => {
          const bal = d.outstanding_balance || 0;
          const lim = d.credit_limit || 0;
          const util = lim > 0 ? Math.round((bal / lim) * 100) : null;
          const isHigh = util != null && util > 75;

          return (
            <AnimGlyph key={d.id} delay={200 + idx * 80}>
              <View style={s.accountCard}>
              <View style={s.accountRow}>
                <View style={[s.accountIcon, isHigh && { backgroundColor: colors.coralDim }]}>
                  <Text style={[s.accountIconText, isHigh && { color: colors.coral }]}>
                    {(d.account_name || 'C')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={s.accountInfo}>
                  <View style={s.accountNameRow}>
                    <Text style={s.accountName}>{d.account_name}</Text>
                    <View style={[s.typeBadge, s.typeBadgeCredit]}>
                      <Text style={[s.typeBadgeText, s.typeBadgeTextCredit]}>
                        {d.account_type === 'credit_card' ? 'Credit' : d.account_type || 'Debt'}
                      </Text>
                    </View>
                  </View>
                  <View style={s.balanceRow}>
                    <Text style={[s.balanceAmount, isHigh && { color: colors.coral }]}>
                      {'\u00a3'}{Math.round(bal).toLocaleString()}
                    </Text>
                    {lim > 0 && (
                      <Text style={[s.balanceLimit, isHigh && { color: colors.coral }]}>
                        / {'\u00a3'}{Math.round(lim).toLocaleString()} ({util}%)
                      </Text>
                    )}
                  </View>
                  {lim > 0 && (
                    <View style={s.utilBar}>
                      <View
                        style={[
                          s.utilFill,
                          {
                            width: `${Math.min(100, util || 0)}%`,
                            backgroundColor: isHigh ? colors.coral : (util || 0) > 50 ? '#E8C55A' : colors.accent,
                          },
                        ]}
                      />
                    </View>
                  )}
                  {d.last_updated && (
                    <Text style={s.accountMeta}>
                      Updated {new Date(d.last_updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </Text>
                  )}
                </View>
              </View>
              <View style={s.accountActions}>
                <View />
                <TouchableOpacity
                  onPress={() => handleRemoveDebtAccount(d.id, d.account_name)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Text style={s.removeLink}>Remove</Text>
                </TouchableOpacity>
              </View>
              </View>
            </AnimGlyph>
          );
        })}

        {/* Empty state */}
        {!hasAccounts && (
          <View style={s.emptyCard}>
            <Text style={s.emptyText}>No accounts connected yet</Text>
            <Text style={s.emptyHint}>Connect your bank or credit card to get started</Text>
          </View>
        )}

        {/* Add account button */}
        <TouchableOpacity style={s.addAccountBtn} onPress={handleAddAccount} activeOpacity={0.7}>
          <Text style={s.addAccountText}>+ Add account</Text>
        </TouchableOpacity>

        {/* Consent info */}
        {connectedBanks.length > 0 && (
          <Text style={s.consentNote}>
            Open Banking connections expire every 90 days. Renew before expiry to keep data flowing.
          </Text>
        )}
      </View>

      {/* ── Preferences ── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Preferences</Text>

        <TouchableOpacity style={[s.menuRow, s.menuRowFirst]} onPress={() => router.push('/(main)/goals')} activeOpacity={0.7}>
          <Text style={s.menuLabel}>Goals</Text>
          <Text style={s.menuChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.menuRow} onPress={() => Linking.openURL('mailto:support@bocy.app?subject=Bug%20Report')} activeOpacity={0.7}>
          <Text style={s.menuLabel}>Report a bug</Text>
          <Text style={s.menuChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.menuRow, !notifExpanded && s.menuRowLast]}
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setNotifExpanded(!notifExpanded);
          }}
          activeOpacity={0.7}
        >
          <Text style={s.menuLabel}>Notifications</Text>
          <Text style={s.menuChevron}>{notifExpanded ? '\u2039' : '\u203A'}</Text>
        </TouchableOpacity>

        {notifExpanded && (
          <View style={s.notifSection}>
            <View style={s.notifRow}>
              <View style={s.notifInfo}>
                <Text style={s.notifLabel}>Weekly digest</Text>
                <Text style={s.notifDesc}>Score, spending & moves recap every Monday</Text>
              </View>
              <Switch
                value={notifPrefs.weekly_digest}
                onValueChange={() => toggleNotifPref('weekly_digest')}
                trackColor={{ false: '#333', true: colors.green + '60' }}
                thumbColor={notifPrefs.weekly_digest ? colors.green : '#666'}
              />
            </View>
            <View style={s.notifRow}>
              <View style={s.notifInfo}>
                <Text style={s.notifLabel}>Check-in prompts</Text>
                <Text style={s.notifDesc}>Bocy reaches out when something needs attention</Text>
              </View>
              <Switch
                value={notifPrefs.checkin_prompts}
                onValueChange={() => toggleNotifPref('checkin_prompts')}
                trackColor={{ false: '#333', true: colors.green + '60' }}
                thumbColor={notifPrefs.checkin_prompts ? colors.green : '#666'}
              />
            </View>
            <View style={s.notifRow}>
              <View style={s.notifInfo}>
                <Text style={s.notifLabel}>Achievements</Text>
                <Text style={s.notifDesc}>Celebrate milestones and progress</Text>
              </View>
              <Switch
                value={notifPrefs.achievement_alerts}
                onValueChange={() => toggleNotifPref('achievement_alerts')}
                trackColor={{ false: '#333', true: colors.green + '60' }}
                thumbColor={notifPrefs.achievement_alerts ? colors.green : '#666'}
              />
            </View>
            <View style={[s.notifRow, s.notifRowLast]}>
              <View style={s.notifInfo}>
                <Text style={s.notifLabel}>Score changes</Text>
                <Text style={s.notifDesc}>Alert when your decision score shifts significantly</Text>
              </View>
              <Switch
                value={notifPrefs.milestone_alerts}
                onValueChange={() => toggleNotifPref('milestone_alerts')}
                trackColor={{ false: '#333', true: colors.green + '60' }}
                thumbColor={notifPrefs.milestone_alerts ? colors.green : '#666'}
              />
            </View>
            {Platform.OS === 'web' && (
              <Text style={s.notifNote}>
                Notifications are sent via email. Push notifications will be available when the app launches on iOS and Android.
              </Text>
            )}
          </View>
        )}
      </View>

      {/* ── Account ── */}
      <View style={[s.section, { marginBottom: spacing.xxl }]}>
        <Text style={s.sectionTitle}>Account</Text>

        <TouchableOpacity style={[s.menuRow, s.menuRowFirst]} onPress={handleSignOut} activeOpacity={0.7}>
          <Text style={s.menuLabel}>Sign out</Text>
          <Text style={s.menuChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[s.menuRow, s.menuRowLast, s.menuRowDanger]} onPress={handleDeleteAccount} activeOpacity={0.7}>
          <Text style={[s.menuLabel, { color: colors.coral }]}>Delete account</Text>
          <Text style={[s.menuChevron, { color: colors.coral }]}>{'\u203A'}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: spacing.lg,
    paddingTop: spacing.xxl + spacing.sm,
    paddingBottom: spacing.xxl,
  },

  // ── Header ──
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  backBtn: {
    fontFamily: fonts.regular,
    fontSize: 22,
    color: colors.accent,
  },
  headerTitle: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
    letterSpacing: -0.2,
  },

  // ── Success banner ──
  successBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.accentDim,
    borderRadius: radius.sm,
    padding: 12,
    marginBottom: spacing.md,
  },
  successText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
  },
  successDismiss: {
    fontSize: 12,
    color: colors.accent,
    padding: 4,
  },

  // ── Profile card ──
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
  },
  avatarText: {
    fontFamily: fonts.semibold,
    fontSize: 20,
    color: colors.bg,
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.text,
    marginBottom: 2,
  },
  profileEmail: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
  },

  // ── Subscription card ──
  subCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  subCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: spacing.sm,
  },
  subBadge: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  subBadgePro: {
    backgroundColor: 'rgba(0,212,170,0.12)',
    borderColor: 'rgba(0,212,170,0.25)',
  },
  subBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 2,
    color: colors.dim,
  },
  subBadgeTextPro: {
    color: colors.green,
  },
  subTierLabel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
  },
  subDesc: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  subUpgradeBtn: {
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    paddingVertical: 12,
    alignItems: 'center',
  },
  subUpgradeBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: '#000000',
  },

  // ── Section ──
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.text,
    letterSpacing: -0.2,
    marginBottom: spacing.md,
  },

  // ── Account card ──
  accountCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  accountCardExpired: {
    borderColor: 'rgba(232,114,114,0.25)',
  },
  accountCardBank: {
    borderColor: 'rgba(0,212,170,0.20)',
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  accountIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  accountIconExpired: {
    backgroundColor: colors.coralDim,
  },
  accountIconBank: {
    backgroundColor: colors.greenDim,
  },
  accountIconText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.accent,
  },
  accountIconTextExpired: {
    color: colors.coral,
  },
  accountIconTextBank: {
    color: colors.green,
  },
  accountInfo: {
    flex: 1,
  },
  accountNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  },
  accountName: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  typeBadge: {
    backgroundColor: colors.accentDim,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  typeBadgeCredit: {
    backgroundColor: colors.skyDim,
  },
  typeBadgeBank: {
    backgroundColor: colors.greenDim,
  },
  typeBadgeText: {
    fontFamily: fonts.medium,
    fontSize: 9,
    color: colors.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  typeBadgeTextCredit: {
    color: colors.sky,
  },
  typeBadgeTextBank: {
    color: colors.green,
  },
  connectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  connectedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.green,
  },
  connectedText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.green,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  accountMeta: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    marginLeft: 8,
  },

  // ── Consent bar ──
  consentBar: {
    flexDirection: 'row',
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginTop: 8,
    overflow: 'hidden',
  },
  consentFill: {
    borderRadius: 2,
  },

  // ── Balance display ──
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    marginTop: 2,
  },
  balanceAmount: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
  },
  balanceLimit: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
  },
  utilBar: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.04)',
    marginTop: 8,
    overflow: 'hidden',
  },
  utilFill: {
    height: '100%',
    borderRadius: 2,
  },

  // ── Account actions ──
  accountActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
  },
  reconnectBtn: {
    backgroundColor: colors.coralDim,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  reconnectBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.coral,
  },
  renewBtn: {
    backgroundColor: 'rgba(232,197,90,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
  },
  renewBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: '#E8C55A',
  },
  removeLink: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
  },

  // ── Add account ──
  addAccountBtn: {
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  addAccountText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },

  // ── Empty state ──
  emptyCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  emptyText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text2,
    marginBottom: 4,
  },
  emptyHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
  },

  // ── Consent note ──
  consentNote: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.muted,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: spacing.md,
  },

  // ── Menu rows ──
  menuRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomWidth: 0,
    padding: spacing.md,
  },
  menuRowFirst: {
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
  },
  menuRowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
  },
  menuRowDanger: {
    borderColor: 'rgba(232,114,114,0.15)',
  },
  menuLabel: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
  menuChevron: {
    fontFamily: fonts.regular,
    fontSize: 18,
    color: colors.muted,
  },

  // ── Notification settings ──
  notifSection: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: 1,
    overflow: 'hidden',
  },
  notifRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  notifRowLast: {
    borderBottomWidth: 0,
  },
  notifInfo: {
    flex: 1,
    marginRight: 12,
  },
  notifLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    letterSpacing: -0.1,
  },
  notifDesc: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
    lineHeight: 16,
  },
  notifNote: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.muted,
    padding: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
});
