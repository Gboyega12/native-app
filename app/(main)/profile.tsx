import { useEffect, useState, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Linking,
  LayoutAnimation, Animated, Easing, Switch, Platform, ActivityIndicator,
  Modal, Pressable, TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import { useSubscription } from '@/lib/subscription';
import Paywall from '@/components/Paywall';
import { restorePurchases } from '@/lib/revenuecat';
import { useWebPush } from '@/lib/web-push';

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
  const { connected, upgraded } = useLocalSearchParams<{ connected?: string; upgraded?: string }>();
  const { isActive, isTrial, isSubscribed, trialDaysLeft, billingInterval, currentPeriodEnd, cancelAtPeriodEnd, refresh: refreshTier } = useSubscription();
  const { colors, isDark, toggleTheme } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [showPaywall, setShowPaywall] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);
  const [restoringPurchases, setRestoringPurchases] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [connectedBanks, setConnectedBanks] = useState<BankConnection[]>([]);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);
  const [showSuccess, setShowSuccess] = useState(connected === 'true');
  const [showUpgradeSuccess, setShowUpgradeSuccess] = useState(upgraded === 'true');
  const [notifPrefs, setNotifPrefs] = useState({
    weekly_digest: true,
    checkin_prompts: true,
  });
  const [notifExpanded, setNotifExpanded] = useState(false);
  const [userId, setUserId] = useState<string | undefined>();
  const webPush = useWebPush(userId);

  // Add debt modal state
  const [showAddDebt, setShowAddDebt] = useState(false);
  const [addDebtName, setAddDebtName] = useState('');
  const [addDebtType, setAddDebtType] = useState('credit_card');
  const [addDebtBalance, setAddDebtBalance] = useState('');
  const [addDebtLimit, setAddDebtLimit] = useState('');
  const [addDebtRate, setAddDebtRate] = useState('');
  const [addDebtMinPayment, setAddDebtMinPayment] = useState('');
  const [addDebtSaving, setAddDebtSaving] = useState(false);
  const [addDebtError, setAddDebtError] = useState('');

  const DEBT_TYPES = [
    { value: 'credit_card', label: 'Credit card' },
    { value: 'personal_loan', label: 'Personal loan' },
    { value: 'overdraft', label: 'Overdraft' },
    { value: 'student_loan', label: 'Student loan' },
    { value: 'car_finance', label: 'Car finance' },
    { value: 'bnpl', label: 'Buy now pay later' },
    { value: 'other', label: 'Other' },
  ];

  // Refresh tier after returning from Stripe Checkout
  useEffect(() => {
    if (upgraded === 'true') refreshTier();
  }, [upgraded]);

  useEffect(() => {
    loadUser();
  }, []);

  const loadUser = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const rawFullName = user.user_metadata?.full_name || '';
      setName(rawFullName.split(' ').map((w: string) => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' '));
      setEmail(user.email || '');
      setUserId(user.id);

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
          .select('weekly_digest, checkin_prompts')
          .eq('user_id', user.id)
          .maybeSingle();
        if (prefs) {
          setNotifPrefs({
            weekly_digest: prefs.weekly_digest ?? true,
            checkin_prompts: prefs.checkin_prompts ?? true,
          });
        }
      } catch {}
    } catch (err) {
      console.warn('[profile] loadUser error:', err);
    }
  };

  const handleRemoveBank = async (bankId: string, label: string) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm(`Remove ${label}?\n\nThis will disconnect this account and remove its data. You can reconnect later.`)
      : await new Promise<boolean>((resolve) =>
          Alert.alert(
            `Remove ${label}?`,
            'This will disconnect this account and remove its data. You can reconnect later.',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Remove', style: 'destructive', onPress: () => resolve(true) },
            ],
          ),
        );
    if (!confirmed) return;
    try {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setConnectedBanks((prev) => prev.filter((b) => b.id !== bankId));
      const { error } = await supabase.from('bank_data').delete().eq('id', bankId);
      if (error) {
        console.warn('[profile] Remove bank failed:', error.message);
      }
    } catch (err: any) {
      console.warn('[profile] Remove bank error:', err?.message);
    }
  };

  const handleRemoveDebtAccount = async (debtId: string, label: string) => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm(`Remove ${label}?\n\nThis will remove this account from your profile.`)
      : await new Promise<boolean>((resolve) =>
          Alert.alert(
            `Remove ${label}?`,
            'This will remove this account from your profile.',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Remove', style: 'destructive', onPress: () => resolve(true) },
            ],
          ),
        );
    if (!confirmed) return;
    try {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDebtAccounts((prev) => prev.filter((d) => d.id !== debtId));
      const { error } = await supabase.from('debt_accounts').delete().eq('id', debtId);
      if (error) {
        console.warn('[profile] Remove debt account failed:', error.message);
      }
    } catch (err: any) {
      console.warn('[profile] Remove debt account error:', err?.message);
    }
  };

  const handleAddAccount = () => {
    router.push({ pathname: '/(main)/connect', params: { from: 'profile' } });
  };

  const handleSaveDebt = async () => {
    setAddDebtError('');
    if (!addDebtName.trim()) {
      setAddDebtError('Please enter an account name.');
      return;
    }
    const balance = parseFloat(addDebtBalance);
    if (isNaN(balance) || balance <= 0) {
      setAddDebtError('Please enter a valid outstanding balance.');
      return;
    }

    setAddDebtSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setAddDebtError('Not signed in. Please sign in and try again.');
        setAddDebtSaving(false);
        return;
      }

      const limit = parseFloat(addDebtLimit) || null;
      const rate = parseFloat(addDebtRate) || null;
      const minPayment = parseFloat(addDebtMinPayment) || null;

      const newDebt = {
        user_id: user.id,
        account_name: addDebtName.trim(),
        account_type: addDebtType,
        outstanding_balance: balance,
        credit_limit: limit,
        interest_rate: rate,
        minimum_payment: minPayment,
        source: 'manual',
        last_updated: new Date().toISOString(),
      };

      const { data: inserted, error: insertErr } = await supabase
        .from('debt_accounts')
        .insert(newDebt)
        .select()
        .maybeSingle();

      if (insertErr) {
        if (insertErr.message?.includes('unique') || insertErr.code === '23505') {
          setAddDebtError('A debt account with this name already exists.');
        } else {
          setAddDebtError(`Could not save: ${insertErr.message || 'Unknown error'}`);
        }
        setAddDebtSaving(false);
        return;
      }

      // Optimistic UI update
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDebtAccounts((prev) => [...prev, inserted]);

      // Reset form
      setAddDebtName('');
      setAddDebtType('credit_card');
      setAddDebtBalance('');
      setAddDebtLimit('');
      setAddDebtRate('');
      setAddDebtMinPayment('');
      setAddDebtError('');
      setShowAddDebt(false);
    } catch (err: any) {
      setAddDebtError('Something went wrong. Please try again.');
    }
    setAddDebtSaving(false);
  };

  const handleManageSubscription = async () => {
    setPortalLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const res = await fetch('/api/stripe/portal', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const data = await res.json();
      if (data.url && Platform.OS === 'web') {
        window.location.href = data.url;
      }
    } catch (err) {
      console.warn('[Profile] Portal error:', err);
    }
    setPortalLoading(false);
  };

  const handleRestorePurchases = async () => {
    setRestoringPurchases(true);
    try {
      const restored = await restorePurchases();
      if (restored) {
        await refreshTier();
        Alert.alert('Restored', 'Your Pro subscription has been restored.');
      } else {
        Alert.alert('No subscription found', 'We couldn\u2019t find an active subscription linked to this account.');
      }
    } catch {
      Alert.alert('Error', 'Could not restore purchases. Please try again.');
    }
    setRestoringPurchases(false);
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
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('[profile] signOut error:', e);
    }
    router.replace('/(auth)/sign-in');
  };

  const handleDeleteAccount = async () => {
    const confirmed = Platform.OS === 'web'
      ? window.confirm('Delete account?\n\nThis will permanently delete your account and all associated data. This action cannot be undone.')
      : await new Promise<boolean>((resolve) =>
          Alert.alert(
            'Delete account',
            'This will permanently delete your account and all associated data. This action cannot be undone.',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
            ],
          ),
        );
    if (!confirmed) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        if (Platform.OS === 'web') window.alert('You are not signed in.');
        else Alert.alert('Error', 'You are not signed in.');
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
        const msg = data.error || 'Could not delete account. Please try again.';
        if (Platform.OS === 'web') window.alert(msg);
        else Alert.alert('Error', msg);
      }
    } catch (err: any) {
      const msg = err.message || 'Something went wrong. Please try again.';
      if (Platform.OS === 'web') window.alert(msg);
      else Alert.alert('Error', msg);
    }
  };

  const allAccounts = connectedBanks;
  const hasAccounts = allAccounts.length > 0 || debtAccounts.length > 0;

  return (
    <ScrollView style={s.container} contentContainerStyle={[s.scroll, isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding }]}>
      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/(main)/(tabs)')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={s.backBtn}>{'\u2190'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Banners ── */}
      {showUpgradeSuccess && (
        <TouchableOpacity style={s.successBanner} onPress={() => setShowUpgradeSuccess(false)} activeOpacity={0.8}>
          <Text style={s.successText}>Welcome to Bocy Pro!</Text>
          <Text style={s.successDismiss}>{'\u2715'}</Text>
        </TouchableOpacity>
      )}
      {showSuccess && (
        <TouchableOpacity style={s.successBanner} onPress={() => setShowSuccess(false)} activeOpacity={0.8}>
          <Text style={s.successText}>Account connected successfully</Text>
          <Text style={s.successDismiss}>{'\u2715'}</Text>
        </TouchableOpacity>
      )}

      {/* ── User identity ── */}
      <AnimGlyph delay={0}>
        <View style={s.userSection}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials || '?'}</Text>
          </View>
          <Text style={s.userName}>{name.split(' ')[0] || 'User'}</Text>
          <Text style={s.userEmail}>{email}</Text>
          <View style={s.tierRow}>
            <View style={[s.tierBadge, isSubscribed ? s.tierBadgePro : isTrial ? s.tierBadgeTrial : undefined]}>
              <Text style={[s.tierBadgeText, isSubscribed ? s.tierBadgeTextPro : isTrial ? s.tierBadgeTextTrial : undefined]}>
                {isSubscribed ? 'PRO' : isTrial ? 'TRIAL' : 'EXPIRED'}
              </Text>
            </View>
            {isTrial && (
              <Text style={s.tierMeta}>
                {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''} left
              </Text>
            )}
            {isSubscribed && currentPeriodEnd && !cancelAtPeriodEnd && (
              <Text style={s.tierMeta}>
                renews {currentPeriodEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              </Text>
            )}
            {isSubscribed && cancelAtPeriodEnd && (
              <Text style={[s.tierMeta, { color: colors.amber }]}>
                cancels {currentPeriodEnd ? currentPeriodEnd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'soon'}
              </Text>
            )}
          </View>
        </View>
      </AnimGlyph>

      <Paywall visible={showPaywall} onClose={() => setShowPaywall(false)} />

      {/* ── Connected accounts ── */}
      <Text style={s.sectionLabel}>ACCOUNTS</Text>

      {allAccounts.map((bank, i) => {
        const displayName = bank.provider_name || (bank.account_type === 'credit' ? `Credit card ${i + 1}` : `Bank account ${i + 1}`);
        const isBank = bank.account_type !== 'credit';
        const { daysLeft, expired, expiring } = getConsentStatus(bank.created_at);
        const statusColor = expired ? colors.coral : expiring ? colors.amber : colors.green;

        return (
          <AnimGlyph key={bank.id} delay={80 + i * 60}>
            <View style={s.accountRow}>
              <View style={[s.accountDot, { backgroundColor: statusColor }]} />
              <View style={s.accountInfo}>
                <Text style={s.accountName}>{displayName}</Text>
                <Text style={s.accountMeta}>
                  {isBank ? 'Bank' : 'Credit'}
                  {expired ? ' — expired' : expiring ? ` — ${daysLeft}d left` : ` — ${daysLeft}d remaining`}
                </Text>
              </View>
              {expired ? (
                <TouchableOpacity style={s.accountAction} onPress={handleAddAccount} activeOpacity={0.7}>
                  <Text style={[s.accountActionText, { color: colors.coral }]}>Reconnect</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={() => handleRemoveBank(bank.id, displayName)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${displayName} account`}
                  style={s.accountRemoveBtn}
                >
                  <Text style={s.accountRemove}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
          </AnimGlyph>
        );
      })}

      {/* Debt accounts — compact rows */}
      {debtAccounts.map((d, idx) => {
        const bal = d.outstanding_balance || 0;
        const lim = d.credit_limit || 0;
        const util = lim > 0 ? Math.round((bal / lim) * 100) : null;
        const isHigh = util != null && util > 75;

        return (
          <AnimGlyph key={d.id} delay={160 + idx * 60}>
            <View style={s.accountRow}>
              <View style={[s.accountDot, { backgroundColor: isHigh ? colors.coral : colors.dim }]} />
              <View style={s.accountInfo}>
                <Text style={s.accountName}>{d.account_name}</Text>
                <Text style={s.accountMeta}>
                  {'\u00a3'}{Math.round(bal).toLocaleString()}
                  {lim > 0 ? ` / \u00a3${Math.round(lim).toLocaleString()} (${util}%)` : ''}
                  {' — '}
                  {d.account_type === 'credit_card' ? 'Credit card'
                    : d.account_type === 'personal_loan' ? 'Loan'
                    : d.account_type === 'overdraft' ? 'Overdraft'
                    : d.account_type === 'student_loan' ? 'Student loan'
                    : d.account_type === 'car_finance' ? 'Car finance'
                    : d.account_type === 'bnpl' ? 'BNPL'
                    : d.account_type || 'Debt'}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => handleRemoveDebtAccount(d.id, d.account_name)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${d.account_name} account`}
                style={s.accountRemoveBtn}
              >
                <Text style={s.accountRemove}>Remove</Text>
              </TouchableOpacity>
            </View>
          </AnimGlyph>
        );
      })}

      {!hasAccounts && (
        <Text style={s.emptyHint}>No accounts connected yet</Text>
      )}

      <View style={s.addButtonsRow}>
        <TouchableOpacity style={s.addBtn} onPress={handleAddAccount} activeOpacity={0.7}>
          <Text style={s.addBtnText}>+ Add account</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.addBtn, { borderColor: colors.accentDim }]}
          onPress={() => setShowAddDebt(true)}
          activeOpacity={0.7}
        >
          <Text style={[s.addBtnText, { color: colors.dim }]}>+ Add debt</Text>
        </TouchableOpacity>
      </View>

      {connectedBanks.length > 0 && (
        <Text style={s.footnote}>
          Open Banking connections expire every 90 days.
        </Text>
      )}

      {/* ── Add debt modal ── */}
      <Modal visible={showAddDebt} transparent animationType="fade" onRequestClose={() => { setAddDebtError(''); setShowAddDebt(false); }}>
        <Pressable style={s.modalOverlay} onPress={() => { setAddDebtError(''); setShowAddDebt(false); }}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Add debt</Text>
              <TouchableOpacity style={s.modalCloseIcon} onPress={() => { setAddDebtError(''); setShowAddDebt(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalCloseIconText}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.modalDesc}>Track debts not connected via Open Banking.</Text>

            <Text style={s.modalLabel}>Account name</Text>
            <TextInput style={s.modalInput} value={addDebtName} onChangeText={setAddDebtName} placeholder="e.g. Barclaycard, Klarna" placeholderTextColor={colors.muted} />

            <Text style={s.modalLabel}>Type</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.debtTypeScroll}>
              {DEBT_TYPES.map((t) => (
                <TouchableOpacity key={t.value} style={[s.debtTypeChip, addDebtType === t.value && s.debtTypeChipActive]} onPress={() => setAddDebtType(t.value)} activeOpacity={0.7}>
                  <Text style={[s.debtTypeChipText, addDebtType === t.value && s.debtTypeChipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <Text style={s.modalLabel}>Outstanding balance</Text>
            <TextInput style={s.modalInput} value={addDebtBalance} onChangeText={setAddDebtBalance} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Credit limit <Text style={s.modalOptional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={addDebtLimit} onChangeText={setAddDebtLimit} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Interest rate <Text style={s.modalOptional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={addDebtRate} onChangeText={setAddDebtRate} placeholder="e.g. 22.9" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Minimum payment <Text style={s.modalOptional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={addDebtMinPayment} onChangeText={setAddDebtMinPayment} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            {addDebtError ? <Text style={s.modalError}>{addDebtError}</Text> : null}

            <TouchableOpacity style={s.modalSaveBtn} onPress={handleSaveDebt} disabled={addDebtSaving} activeOpacity={0.8}>
              {addDebtSaving ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Save</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Settings ── */}
      <Text style={s.sectionLabel}>SETTINGS</Text>

      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => router.push('/(main)/identity')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Goals</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={() => router.push('/(main)/subscriptions')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Manage subscriptions</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <View style={s.groupRow}>
          <Text style={s.groupRowLabel}>{isDark ? 'Dark mode' : 'Light mode'}</Text>
          <Switch
            value={!isDark}
            onValueChange={toggleTheme}
            trackColor={{ false: colors.trackOff, true: colors.green + '60' }}
            thumbColor={isDark ? colors.thumbOff : colors.green}
          />
        </View>

        <View style={s.groupDivider} />

        <TouchableOpacity
          style={s.groupRow}
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setNotifExpanded(!notifExpanded);
          }}
          activeOpacity={0.7}
        >
          <Text style={s.groupRowLabel}>Notifications</Text>
          <Text style={s.groupRowChevron}>{notifExpanded ? '\u2039' : '\u203A'}</Text>
        </TouchableOpacity>

        {notifExpanded && (
          <>
            <View style={s.groupDivider} />
            {([
              { key: 'weekly_digest' as const, label: 'Weekly digest', desc: 'Top moves & spending recap every Monday' },
              { key: 'checkin_prompts' as const, label: 'Check-in prompts', desc: 'Spending updates, nudges & income alerts' },
            ]).map((item, idx) => (
              <View key={item.key}>
                {idx > 0 && <View style={s.groupDivider} />}
                <View style={s.notifRow}>
                  <View style={s.notifInfo}>
                    <View style={s.notifLabelRow}>
                      <Text style={s.notifLabel}>{item.label}</Text>
                    </View>
                    <Text style={s.notifDesc}>{item.desc}</Text>
                  </View>
                  <Switch
                    value={notifPrefs[item.key]}
                    onValueChange={() => toggleNotifPref(item.key)}
                    trackColor={{ false: colors.trackOff, true: colors.green + '60' }}
                    thumbColor={notifPrefs[item.key] ? colors.green : colors.thumbOff}
                  />
                </View>
              </View>
            ))}
            {webPush.supported && (
              <>
                <View style={s.groupDivider} />
                <View style={s.notifRow}>
                  <View style={s.notifInfo}>
                    <Text style={s.notifLabel}>Push notifications</Text>
                    <Text style={s.notifDesc}>
                      {webPush.permission === 'denied'
                        ? 'Blocked in browser settings'
                        : 'Receive alerts in your browser'}
                    </Text>
                  </View>
                  <Switch
                    value={webPush.subscribed}
                    onValueChange={() => {
                      if (webPush.subscribed) {
                        webPush.unsubscribe();
                      } else {
                        webPush.subscribe();
                      }
                    }}
                    trackColor={{ false: colors.trackOff, true: colors.green + '60' }}
                    thumbColor={webPush.subscribed ? colors.green : colors.thumbOff}
                    disabled={webPush.loading || webPush.permission === 'denied'}
                  />
                </View>
              </>
            )}
          </>
        )}
      </View>

      {/* ── Subscription management ── */}
      {!isSubscribed && (
        <>
          <TouchableOpacity style={s.upgradeBtn} onPress={() => setShowPaywall(true)} activeOpacity={0.8}>
            <Text style={s.upgradeBtnText}>{isTrial ? 'Subscribe now' : 'Subscribe'}</Text>
          </TouchableOpacity>
          {(Platform.OS === 'ios' || Platform.OS === 'android') && (
            <TouchableOpacity
              style={s.restorePurchasesBtn}
              onPress={handleRestorePurchases}
              disabled={restoringPurchases}
              activeOpacity={0.7}
            >
              {restoringPurchases ? (
                <ActivityIndicator size="small" color={colors.dim} />
              ) : (
                <Text style={s.restorePurchasesBtnText}>Restore purchases</Text>
              )}
            </TouchableOpacity>
          )}
        </>
      )}
      {isSubscribed && (
        <TouchableOpacity style={s.manageSubBtn} onPress={handleManageSubscription} disabled={portalLoading} activeOpacity={0.7}>
          {portalLoading ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <Text style={s.manageSubBtnText}>Manage subscription</Text>
          )}
        </TouchableOpacity>
      )}

      {/* ── Feedback + account ── */}
      <Text style={s.sectionLabel}>SUPPORT</Text>

      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => Linking.openURL('https://www.bocy.io/privacy.html')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Privacy policy</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={() => Linking.openURL('https://www.bocy.io/terms.html')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Terms of use</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={() => Linking.openURL('mailto:hello@bocy.io?subject=Feedback')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Send feedback</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={handleSignOut} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Sign out of your account">
          <Text style={s.groupRowLabel}>Sign out</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={handleDeleteAccount} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Delete your account permanently">
          <Text style={[s.groupRowLabel, { color: colors.coral }]}>Delete account</Text>
          <Text style={[s.groupRowChevron, { color: colors.coral }]}>{'\u203A'}</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingTop: 60, paddingBottom: 40 },

  // ── Header ──
  header: { marginBottom: 32 },
  backBtn: { fontFamily: fonts.regular, fontSize: 22, color: c.accent },

  // ── Banners ──
  successBanner: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: c.greenDim, borderRadius: 12, padding: 12, marginBottom: 16,
  },
  successText: { fontFamily: fonts.medium, fontSize: 13, color: c.green },
  successDismiss: { fontSize: 12, color: c.green, padding: 4 },

  // ── User identity ──
  userSection: { alignItems: 'center', marginBottom: 40 },
  avatar: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: c.accent,
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
  },
  avatarText: { fontFamily: fonts.semibold, fontSize: 22, color: c.bg },
  userName: { fontFamily: fonts.semibold, fontSize: 20, color: c.text, marginBottom: 4 },
  userEmail: { fontFamily: fonts.regular, fontSize: 13, color: c.dim, marginBottom: 12 },
  tierRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tierBadge: {
    backgroundColor: c.accentDim, borderWidth: 1, borderColor: c.border,
    borderRadius: 100, paddingVertical: 3, paddingHorizontal: 10,
  },
  tierBadgePro: { backgroundColor: c.greenDim, borderColor: c.green + '40' },
  tierBadgeTrial: { backgroundColor: c.accentDim, borderColor: c.accent + '40' },
  tierBadgeText: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: c.dim },
  tierBadgeTextPro: { color: c.green },
  tierBadgeTextTrial: { color: c.accent },
  tierMeta: { fontFamily: fonts.regular, fontSize: 12, color: c.dim },

  // ── Section labels ──
  sectionLabel: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2, color: c.dim,
    textTransform: 'uppercase', marginBottom: 12, marginTop: 8,
  },

  // ── Account rows ──
  accountRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: c.mintDim,
  },
  accountDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  accountInfo: { flex: 1 },
  accountName: { fontFamily: fonts.medium, fontSize: 15, color: c.text },
  accountMeta: { fontFamily: fonts.regular, fontSize: 12, color: c.dim, marginTop: 2 },
  accountAction: { paddingVertical: 4, paddingHorizontal: 10 },
  accountActionText: { fontFamily: fonts.semibold, fontSize: 12 },
  accountRemoveBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  accountRemove: { fontFamily: fonts.regular, fontSize: 12, color: c.muted },

  // ── Empty + add ──
  emptyHint: {
    fontFamily: fonts.regular, fontSize: 13, color: c.muted,
    textAlign: 'center', paddingVertical: 20,
  },
  addButtonsRow: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 8 },
  addBtn: {
    flex: 1, borderWidth: 1, borderColor: c.accentDim, borderStyle: 'dashed',
    borderRadius: 12, paddingVertical: 12, alignItems: 'center',
  },
  addBtnText: { fontFamily: fonts.semibold, fontSize: 13, color: c.accent },
  footnote: {
    fontFamily: fonts.regular, fontSize: 11, color: c.muted,
    textAlign: 'center', marginTop: 8, marginBottom: 24,
  },

  // ── Grouped card (Settings) ──
  groupCard: {
    backgroundColor: c.card, borderWidth: 1, borderColor: c.border,
    borderRadius: 24, overflow: 'hidden', marginBottom: 16,
  },
  groupRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
  },
  groupRowLabel: { fontFamily: fonts.regular, fontSize: 15, color: c.text },
  groupRowChevron: { fontFamily: fonts.regular, fontSize: 18, color: c.muted },
  groupDivider: { height: 1, backgroundColor: c.mintDim, marginHorizontal: 20 },

  // ── Notifications (inside group card) ──
  notifRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
  },
  notifInfo: { flex: 1, marginRight: 12 },
  notifLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notifLabel: { fontFamily: fonts.medium, fontSize: 14, color: c.text },
  notifLabelLocked: { color: c.dim },
  notifDesc: { fontFamily: fonts.regular, fontSize: 11, color: c.muted, marginTop: 2, lineHeight: 16 },
  proBadge: {
    fontFamily: fonts.mono, fontSize: 8, letterSpacing: 1.5, color: c.green,
    backgroundColor: c.greenDim, borderWidth: 1, borderColor: c.green + '40',
    borderRadius: 100, paddingVertical: 1, paddingHorizontal: 6, overflow: 'hidden',
  },
  notifUpgrade: { paddingVertical: 12, alignItems: 'center' },
  notifUpgradeText: { fontFamily: fonts.medium, fontSize: 12, color: c.green },

  // ── Subscription buttons ──
  upgradeBtn: {
    backgroundColor: c.accent, borderRadius: 100, paddingVertical: 14,
    alignItems: 'center', marginBottom: 24,
  },
  upgradeBtnText: { fontFamily: fonts.semibold, fontSize: 15, color: c.bg },
  restorePurchasesBtn: {
    alignItems: 'center', paddingVertical: 10, marginTop: -16, marginBottom: 24,
  },
  restorePurchasesBtnText: { fontFamily: fonts.regular, fontSize: 13, color: c.dim, textDecorationLine: 'underline' as const },
  manageSubBtn: {
    borderWidth: 1, borderColor: c.border, borderRadius: 100,
    paddingVertical: 12, alignItems: 'center', marginBottom: 24,
  },
  manageSubBtnText: { fontFamily: fonts.medium, fontSize: 13, color: c.accent },

  // ── Modal ──
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
  modalContent: { backgroundColor: c.surface, borderRadius: 24, padding: 24, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  modalTitle: { fontFamily: fonts.semibold, fontSize: 18, color: c.text },
  modalCloseIcon: { padding: 4 },
  modalCloseIconText: { fontSize: 14, color: c.muted },
  modalDesc: { fontFamily: fonts.regular, fontSize: 13, color: c.dim, marginBottom: 16, lineHeight: 18 },
  modalLabel: { fontFamily: fonts.medium, fontSize: 13, color: c.text, marginBottom: 6, marginTop: 12 },
  modalOptional: { fontFamily: fonts.regular, fontSize: 11, color: c.muted },
  modalInput: {
    backgroundColor: c.bg, borderWidth: 1, borderColor: c.border,
    borderRadius: 12, padding: 12, fontFamily: fonts.regular, fontSize: 14, color: c.text,
  },
  modalError: { fontFamily: fonts.regular, fontSize: 12, color: c.coral, marginTop: 8 },
  modalSaveBtn: { backgroundColor: c.accent, borderRadius: 100, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  modalSaveBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: c.bg },
  debtTypeScroll: { flexGrow: 0, marginBottom: 4 },
  debtTypeChip: {
    backgroundColor: c.bg, borderWidth: 1, borderColor: c.border,
    borderRadius: 100, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
  },
  debtTypeChipActive: { backgroundColor: c.accentDim, borderColor: c.accent },
  debtTypeChipText: { fontFamily: fonts.medium, fontSize: 12, color: c.dim },
  debtTypeChipTextActive: { color: c.accent },
});
