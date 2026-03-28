import { useEffect, useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking,
  LayoutAnimation, Switch, ActivityIndicator,
  Modal, Pressable, TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import { useWebPush } from '@/lib/web-push';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { AnimGlyph, BreathingBar } from '@/components/Card';
import type { Investment, InvestmentAssetClass } from '@/lib/types';

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
  const { colors, isDark, toggleTheme } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [connectedBanks, setConnectedBanks] = useState<BankConnection[]>([]);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);
  const [showSuccess, setShowSuccess] = useState(connected === 'true');
  const [notifPrefs, setNotifPrefs] = useState({
    weekly_digest: true,
    checkin_prompts: true,
  });
  const [notifExpanded, setNotifExpanded] = useState(false);
  const [expandedSection, setExpandedSection] = useState<'accounts' | 'debts' | 'investments' | null>(null);

  // Identity/goals state
  const [identityData, setIdentityData] = useState<{
    work_setup?: string;
    household?: string;
    housing?: string;
    priorities?: string[];
    risk_appetite?: string;
  } | null>(null);

  const toggleSection = (section: 'accounts' | 'debts' | 'investments') => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedSection((prev) => (prev === section ? null : section));
  };
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

  // Investment state
  const [investmentAccounts, setInvestmentAccounts] = useState<Investment[]>([]);
  const [showAddInvestment, setShowAddInvestment] = useState(false);
  const [addInvName, setAddInvName] = useState('');
  const [addInvClass, setAddInvClass] = useState<InvestmentAssetClass>('stocks');
  const [addInvPlatform, setAddInvPlatform] = useState('');
  const [addInvValue, setAddInvValue] = useState('');
  const [addInvCost, setAddInvCost] = useState('');
  const [addInvQuantity, setAddInvQuantity] = useState('');
  const [addInvNotes, setAddInvNotes] = useState('');
  const [addInvSaving, setAddInvSaving] = useState(false);
  const [addInvError, setAddInvError] = useState('');

  // CSV import state
  const [showCsvPreview, setShowCsvPreview] = useState(false);
  const [csvRows, setCsvRows] = useState<Partial<Investment>[]>([]);
  const [csvImporting, setCsvImporting] = useState(false);

  const DEBT_TYPES = [
    { value: 'credit_card', label: 'Credit card' },
    { value: 'personal_loan', label: 'Personal loan' },
    { value: 'overdraft', label: 'Overdraft' },
    { value: 'student_loan', label: 'Student loan' },
    { value: 'car_finance', label: 'Car finance' },
    { value: 'bnpl', label: 'Buy now pay later' },
    { value: 'other', label: 'Other' },
  ];

  const ASSET_CLASSES: { value: InvestmentAssetClass; label: string }[] = [
    { value: 'stocks', label: 'Stocks' },
    { value: 'bonds', label: 'Bonds' },
    { value: 'etfs', label: 'ETFs' },
    { value: 'crypto', label: 'Crypto' },
    { value: 'property', label: 'Property' },
    { value: 'pension', label: 'Pension' },
    { value: 'other', label: 'Other' },
  ];

  useEffect(() => {
    trackScreen('Profile');
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
      // This handles cases where Finexer redirect didn't properly set user_id
      try {
        await supabase
          .from('bank_data')
          .update({ user_id: user.id })
          .is('user_id', null)
          .eq('source', 'finexer');
      } catch {}

      const [banksRes, debtRes, investRes] = await Promise.all([
        supabase
          .from('bank_data')
          .select('id, connection_id, source, created_at, updated_at, account_type, provider_name')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('debt_accounts')
          .select('id, account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, source, last_updated')
          .eq('user_id', user.id),
        supabase
          .from('investments')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
      ]);
      if (banksRes.data) setConnectedBanks(banksRes.data as BankConnection[]);
      if (debtRes.data) setDebtAccounts(debtRes.data);
      if (investRes.data) setInvestmentAccounts(investRes.data as Investment[]);

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

      // Load identity data
      try {
        const { data: identity } = await supabase
          .from('user_identity')
          .select('work_setup, household, housing, priorities, risk_appetite')
          .eq('user_id', user.id)
          .maybeSingle();
        if (identity) setIdentityData(identity);
      } catch {}
    } catch (err) {
      console.warn('[profile] loadUser error:', err);
    }
  };

  const handleRemoveBank = async (bankId: string, label: string) => {
    trackEvent('Bank Removed');
    const confirmed = window.confirm(`Remove ${label}?\n\nThis will disconnect this account and remove its data. You can reconnect later.`);
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
    trackEvent('Debt Account Removed');
    const confirmed = window.confirm(`Remove ${label}?\n\nThis will remove this account from your profile.`);
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
    trackEvent('Add Bank Tapped');
    router.push({ pathname: '/(main)/connect', params: { from: 'profile' } });
  };

  const handleSaveInvestment = async () => {
    setAddInvError('');
    if (!addInvName.trim()) { setAddInvError('Please enter a name.'); return; }
    const value = parseFloat(addInvValue);
    if (isNaN(value) || value <= 0) { setAddInvError('Please enter a valid current value.'); return; }

    setAddInvSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setAddInvError('Not signed in.'); setAddInvSaving(false); return; }

      const newInv = {
        user_id: user.id,
        name: addInvName.trim(),
        asset_class: addInvClass,
        platform: addInvPlatform.trim() || null,
        current_value: value,
        purchase_cost: parseFloat(addInvCost) || null,
        quantity: parseFloat(addInvQuantity) || null,
        notes: addInvNotes.trim() || null,
        source: 'manual' as const,
      };

      const { data: inserted, error: insertErr } = await supabase
        .from('investments').insert(newInv).select().maybeSingle();
      if (insertErr) { setAddInvError(insertErr.message); setAddInvSaving(false); return; }

      trackEvent('Investment Added', { asset_class: addInvClass });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setInvestmentAccounts((prev) => [inserted as Investment, ...prev]);

      // Reset form
      setAddInvName(''); setAddInvClass('stocks'); setAddInvPlatform('');
      setAddInvValue(''); setAddInvCost(''); setAddInvQuantity(''); setAddInvNotes('');
      setAddInvError(''); setShowAddInvestment(false);
    } catch { setAddInvError('Something went wrong.'); }
    setAddInvSaving(false);
  };

  const handleRemoveInvestment = async (invId: string, label: string) => {
    trackEvent('Investment Removed');
    const confirmed = window.confirm(`Remove ${label}?\n\nThis will remove this investment from your profile.`);
    if (!confirmed) return;
    try {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setInvestmentAccounts((prev) => prev.filter((i) => i.id !== invId));
      await supabase.from('investments').delete().eq('id', invId);
    } catch (err: any) {
      console.warn('[profile] Remove investment error:', err?.message);
    }
  };

  const handleCsvImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = async (e: any) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.split('\n').filter((l: string) => l.trim());
      if (lines.length < 2) return;

      const headers = lines[0].toLowerCase().split(',').map((h: string) => h.trim());
      const nameIdx = headers.findIndex((h: string) => h === 'name');
      const classIdx = headers.findIndex((h: string) => h === 'asset_class' || h === 'type');
      const platformIdx = headers.findIndex((h: string) => h === 'platform' || h === 'provider');
      const valueIdx = headers.findIndex((h: string) => h === 'current_value' || h === 'value');
      const costIdx = headers.findIndex((h: string) => h === 'purchase_cost' || h === 'cost');
      const quantityIdx = headers.findIndex((h: string) => h === 'quantity');
      const notesIdx = headers.findIndex((h: string) => h === 'notes');

      if (nameIdx === -1 || valueIdx === -1) {
        window.alert('CSV must have "name" and "current_value" (or "value") columns.');
        return;
      }

      const validClasses = ['stocks', 'bonds', 'etfs', 'crypto', 'property', 'pension', 'other'];
      const rows: Partial<Investment>[] = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c: string) => c.trim());
        const name = cols[nameIdx];
        const val = parseFloat(cols[valueIdx]);
        if (!name || isNaN(val) || val <= 0) continue;
        const rawClass = classIdx >= 0 ? cols[classIdx]?.toLowerCase() : 'other';
        rows.push({
          name,
          asset_class: (validClasses.includes(rawClass) ? rawClass : 'other') as InvestmentAssetClass,
          platform: platformIdx >= 0 ? cols[platformIdx] || undefined : undefined,
          current_value: val,
          purchase_cost: costIdx >= 0 ? parseFloat(cols[costIdx]) || undefined : undefined,
          quantity: quantityIdx >= 0 ? parseFloat(cols[quantityIdx]) || undefined : undefined,
          notes: notesIdx >= 0 ? cols[notesIdx] || undefined : undefined,
          source: 'csv' as const,
        });
      }

      if (rows.length === 0) { window.alert('No valid rows found in CSV.'); return; }
      setCsvRows(rows);
      setShowCsvPreview(true);
    };
    input.click();
  };

  const handleConfirmCsvImport = async () => {
    setCsvImporting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setCsvImporting(false); return; }

      const toInsert = csvRows.map((r) => ({ ...r, user_id: user.id }));
      const { data: inserted, error } = await supabase.from('investments').insert(toInsert).select();
      if (error) { window.alert(`Import failed: ${error.message}`); setCsvImporting(false); return; }

      trackEvent('Investments CSV Imported', { count: inserted?.length || 0 });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setInvestmentAccounts((prev) => [...(inserted as Investment[]), ...prev]);
      setCsvRows([]);
      setShowCsvPreview(false);
    } catch { window.alert('Something went wrong.'); }
    setCsvImporting(false);
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

      trackEvent('Debt Account Added', { type: addDebtType });

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

  const toggleNotifPref = async (key: keyof typeof notifPrefs) => {
    const newVal = !notifPrefs[key];
    trackEvent('Notification Toggled', { type: key, enabled: newVal });
    setNotifPrefs((prev) => ({ ...prev, [key]: newVal }));
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('notification_preferences').upsert({
          user_id: user.id,
          [key]: newVal,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
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
    trackEvent('Sign Out');
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('[profile] signOut error:', e);
    }
    router.replace('/(auth)/sign-in');
  };

  const handleDeleteAccount = async () => {
    const confirmed = window.confirm('Delete account?\n\nThis will permanently delete your account and all associated data. This action cannot be undone.');
    if (!confirmed) return;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        window.alert('You are not signed in.');
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
        window.alert(data.error || 'Could not delete account. Please try again.');
      }
    } catch (err: any) {
      window.alert(err.message || 'Something went wrong. Please try again.');
    }
  };

  const allAccounts = connectedBanks;
  const hasAccounts = allAccounts.length > 0 || debtAccounts.length > 0 || investmentAccounts.length > 0;

  return (
    <ScrollView style={s.container} contentContainerStyle={[s.scroll, isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding }]} testID="profile-screen">
      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/(main)/(tabs)')} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={s.backBtn}>{'\u2190'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Banners ── */}
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
        </View>
      </AnimGlyph>

      {/* ── ACCOUNTS ── */}
      <Text style={s.sectionLabelSpaced}>ACCOUNTS</Text>
      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => toggleSection('accounts')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Connected accounts</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={s.groupRowBadge}>{allAccounts.length}</Text>
            <Text style={[s.groupRowChevron, expandedSection === 'accounts' && { transform: [{ rotate: '90deg' }] }]}>{'\u203A'}</Text>
          </View>
        </TouchableOpacity>

        {expandedSection === 'accounts' && (
          <>
            {allAccounts.map((bank, i) => {
              const displayName = bank.provider_name || (bank.account_type === 'credit' ? `Credit card ${i + 1}` : `Bank account ${i + 1}`);
              const isBank = bank.account_type !== 'credit';
              const { daysLeft, expired, expiring } = getConsentStatus(bank.created_at);
              const statusColor = expired ? colors.coral : expiring ? colors.amber : colors.green;

              return (
                <AnimGlyph key={bank.id} delay={80 + i * 60}>
                  <View style={s.groupDivider} />
                  <View style={s.cardItemRow}>
                    <View style={[s.accountDot, { backgroundColor: statusColor }]} />
                    <View style={s.accountInfo}>
                      <Text style={s.accountName}>{displayName}</Text>
                      <Text style={s.accountMeta}>
                        {isBank ? 'Bank' : 'Credit'}
                        {expired ? ' — expired' : expiring ? ` — ${daysLeft}d left` : ` — ${daysLeft}d remaining`}
                      </Text>
                      {!expired && (
                        <View style={{ height: 3, borderRadius: 1.5, backgroundColor: colors.border, overflow: 'hidden', marginTop: 8 }}>
                          <BreathingBar
                            color={statusColor}
                            width={`${Math.max(0, Math.min(100, Math.round((daysLeft / CONSENT_DAYS) * 100)))}%`}
                            style={{ height: '100%', borderRadius: 1.5 }}
                          />
                        </View>
                      )}
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

            {allAccounts.length === 0 && (
              <>
                <View style={s.groupDivider} />
                <Text style={s.emptyHint}>No accounts connected yet</Text>
              </>
            )}

            <View style={s.groupDivider} />
            <TouchableOpacity style={s.cardAddRow} onPress={handleAddAccount} activeOpacity={0.7} testID="profile-add-account-button" accessibilityRole="button" accessibilityLabel="Add account">
              <Text style={s.cardAddText}>+ Add account</Text>
            </TouchableOpacity>

            {connectedBanks.length > 0 && (
              <Text style={s.footnote}>
                Open Banking connections expire every 90 days.
              </Text>
            )}
          </>
        )}
      </View>

      {/* ── DEBTS ── */}
      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => toggleSection('debts')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Debts</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={s.groupRowBadge}>{debtAccounts.length}</Text>
            <Text style={[s.groupRowChevron, expandedSection === 'debts' && { transform: [{ rotate: '90deg' }] }]}>{'\u203A'}</Text>
          </View>
        </TouchableOpacity>

        {expandedSection === 'debts' && (
          <>
            {debtAccounts.map((d, idx) => {
              const bal = d.outstanding_balance || 0;
              const lim = d.credit_limit || 0;
              const util = lim > 0 ? Math.round((bal / lim) * 100) : null;
              const isHigh = util != null && util > 75;

              return (
                <AnimGlyph key={d.id} delay={80 + idx * 60}>
                  <View style={s.groupDivider} />
                  <View style={s.cardItemRow}>
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
                      {lim > 0 && util != null && (
                        <View style={{ height: 3, borderRadius: 1.5, backgroundColor: colors.border, overflow: 'hidden', marginTop: 8 }}>
                          <BreathingBar
                            color={isHigh ? colors.coral : colors.accent}
                            width={`${Math.min(100, util)}%`}
                            style={{ height: '100%', borderRadius: 1.5 }}
                          />
                        </View>
                      )}
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

            {debtAccounts.length === 0 && (
              <>
                <View style={s.groupDivider} />
                <Text style={s.emptyHint}>No debts added yet</Text>
              </>
            )}

            <View style={s.groupDivider} />
            <TouchableOpacity style={s.cardAddRow} onPress={() => setShowAddDebt(true)} activeOpacity={0.7}>
              <Text style={s.cardAddText}>+ Add debt</Text>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ── INVESTMENTS ── */}
      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => toggleSection('investments')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Investments</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={s.groupRowBadge}>{investmentAccounts.length}</Text>
            <Text style={[s.groupRowChevron, expandedSection === 'investments' && { transform: [{ rotate: '90deg' }] }]}>{'\u203A'}</Text>
          </View>
        </TouchableOpacity>

        {expandedSection === 'investments' && (
          <>
            {investmentAccounts.length > 0 ? (
              investmentAccounts.map((inv, idx) => {
                const gain = inv.purchase_cost ? inv.current_value - inv.purchase_cost : null;
                return (
                  <AnimGlyph key={inv.id || idx} delay={80 + idx * 60}>
                    <View style={s.groupDivider} />
                    <View style={s.cardItemRow}>
                      <View style={[s.accountDot, { backgroundColor: colors.accent }]} />
                      <View style={s.accountInfo}>
                        <Text style={s.accountName}>{inv.name}</Text>
                        <Text style={s.accountMeta}>
                          {inv.asset_class.toUpperCase()}
                          {inv.platform ? ` \u2022 ${inv.platform}` : ''}
                          {' \u2022 '}
                          {'\u00a3'}{Math.round(inv.current_value).toLocaleString()}
                          {gain !== null ? ` (${gain >= 0 ? '+' : ''}\u00a3${Math.round(gain).toLocaleString()})` : ''}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => handleRemoveInvestment(inv.id!, inv.name)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${inv.name} investment`}
                        style={s.accountRemoveBtn}
                      >
                        <Text style={s.accountRemove}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  </AnimGlyph>
                );
              })
            ) : (
              <>
                <View style={s.groupDivider} />
                <Text style={s.emptyHint}>No investments added yet</Text>
              </>
            )}

            <View style={s.groupDivider} />
            <View style={s.cardAddRowDouble}>
              <TouchableOpacity style={s.cardAddBtn} onPress={() => setShowAddInvestment(true)} activeOpacity={0.7}>
                <Text style={s.cardAddText}>+ Add investment</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.cardAddBtn} onPress={handleCsvImport} activeOpacity={0.7}>
                <Text style={[s.cardAddText, { color: colors.dim }]}>+ Import CSV</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>

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
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
              {DEBT_TYPES.map((t) => (
                <TouchableOpacity key={t.value} style={[s.debtTypeChip, addDebtType === t.value && s.debtTypeChipActive]} onPress={() => setAddDebtType(t.value)} activeOpacity={0.7}>
                  <Text style={[s.debtTypeChipText, addDebtType === t.value && s.debtTypeChipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

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

      {/* ── Divider between financial sections and settings ── */}
      <View style={{ height: spacing.sm }} />

      {/* ── Add investment modal ── */}
      <Modal visible={showAddInvestment} transparent animationType="fade" onRequestClose={() => { setAddInvError(''); setShowAddInvestment(false); }}>
        <Pressable style={s.modalOverlay} onPress={() => { setAddInvError(''); setShowAddInvestment(false); }}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle}>Add investment</Text>
                <TouchableOpacity style={s.modalCloseIcon} onPress={() => { setAddInvError(''); setShowAddInvestment(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={s.modalCloseIconText}>{'\u2715'}</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.modalLabel}>Name</Text>
              <TextInput style={s.modalInput} value={addInvName} onChangeText={setAddInvName} placeholder="e.g. Vanguard S&P 500" placeholderTextColor={colors.muted} />

              <Text style={s.modalLabel}>Asset class</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
                {ASSET_CLASSES.map((t) => (
                  <TouchableOpacity key={t.value} style={[s.debtTypeChip, addInvClass === t.value && s.debtTypeChipActive]} onPress={() => setAddInvClass(t.value)} activeOpacity={0.7}>
                    <Text style={[s.debtTypeChipText, addInvClass === t.value && s.debtTypeChipTextActive]}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.modalLabel}>Platform <Text style={s.modalOptional}>(optional)</Text></Text>
              <TextInput style={s.modalInput} value={addInvPlatform} onChangeText={setAddInvPlatform} placeholder="e.g. Trading 212, Vanguard" placeholderTextColor={colors.muted} />

              <Text style={s.modalLabel}>Current value</Text>
              <TextInput style={s.modalInput} value={addInvValue} onChangeText={setAddInvValue} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

              <Text style={s.modalLabel}>Purchase cost <Text style={s.modalOptional}>(optional)</Text></Text>
              <TextInput style={s.modalInput} value={addInvCost} onChangeText={setAddInvCost} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

              <Text style={s.modalLabel}>Quantity <Text style={s.modalOptional}>(optional)</Text></Text>
              <TextInput style={s.modalInput} value={addInvQuantity} onChangeText={setAddInvQuantity} placeholder="e.g. 10.5" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

              <Text style={s.modalLabel}>Notes <Text style={s.modalOptional}>(optional)</Text></Text>
              <TextInput style={s.modalInput} value={addInvNotes} onChangeText={setAddInvNotes} placeholder="Any notes..." placeholderTextColor={colors.muted} multiline />

              {addInvError ? <Text style={s.modalError}>{addInvError}</Text> : null}

              <TouchableOpacity style={s.modalSaveBtn} onPress={handleSaveInvestment} disabled={addInvSaving} activeOpacity={0.8}>
                {addInvSaving ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Save</Text>}
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── CSV preview modal ── */}
      <Modal visible={showCsvPreview} transparent animationType="fade" onRequestClose={() => setShowCsvPreview(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setShowCsvPreview(false)}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Import {csvRows.length} investments</Text>
              <TouchableOpacity style={s.modalCloseIcon} onPress={() => setShowCsvPreview(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalCloseIconText}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.modalDesc}>Review the investments below before importing.</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              {csvRows.map((r, idx) => (
                <View key={idx} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.text }}>{r.name}</Text>
                    <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.dim }}>{r.asset_class}{r.platform ? ` \u2022 ${r.platform}` : ''}</Text>
                  </View>
                  <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.accent }}>{'\u00a3'}{Math.round(r.current_value || 0).toLocaleString()}</Text>
                </View>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.modalSaveBtn} onPress={handleConfirmCsvImport} disabled={csvImporting} activeOpacity={0.8}>
              {csvImporting ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Import all</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── GOALS ── */}
      <Text style={s.sectionLabelSpaced}>GOALS</Text>
      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => { trackEvent('Edit Goals Tapped'); router.push({ pathname: '/(main)/goals', params: { from: 'profile' } }); }} activeOpacity={0.7}>
          <View style={{ flex: 1 }}>
            <Text style={s.groupRowLabel}>Edit goals</Text>
            {identityData?.work_setup ? (
              <Text style={s.groupRowDesc}>
                {identityData.work_setup?.replace(/_/g, ' ')}
                {identityData.priorities?.length ? ` \u2022 ${identityData.priorities.map(p => p.replace(/_/g, ' ')).join(', ')}` : ''}
              </Text>
            ) : (
              <Text style={s.groupRowDesc}>Set your financial goals</Text>
            )}
          </View>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── NOTIFICATIONS ── */}
      <Text style={s.sectionLabelSpaced}>NOTIFICATIONS</Text>
      <View style={s.groupCard}>
        {([
          { key: 'weekly_digest' as const, label: 'Weekly digest', desc: 'Top moves & spending recap every Monday' },
          { key: 'checkin_prompts' as const, label: 'Check-in prompts', desc: 'Spending updates, nudges & income alerts' },
        ]).map((item, idx) => (
          <View key={item.key}>
            {idx > 0 && <View style={s.groupDivider} />}
            <View style={s.groupRow}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={s.groupRowLabel}>{item.label}</Text>
                <Text style={s.groupRowDesc}>{item.desc}</Text>
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
            <View style={s.groupRow}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={s.groupRowLabel}>Push notifications</Text>
                <Text style={s.groupRowDesc}>
                  {webPush.permission === 'denied'
                    ? 'Blocked in browser settings'
                    : 'Receive alerts even when app is closed'}
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
      </View>

      {/* ── APPEARANCE — dark/light mode ── */}
      <Text style={s.sectionLabelSpaced}>APPEARANCE</Text>

      <View style={s.groupCard}>
        <View style={s.groupRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.groupRowLabel}>{isDark ? 'Dark mode' : 'Light mode'}</Text>
            <Text style={s.groupRowDesc}>
              {isDark ? 'AMOLED-optimised dark theme' : 'Clean light theme'}
            </Text>
          </View>
          <Switch
            value={!isDark}
            onValueChange={() => { trackEvent('Theme Toggled'); toggleTheme(); }}
            trackColor={{ false: colors.trackOff, true: colors.green + '60' }}
            thumbColor={isDark ? colors.thumbOff : colors.green}
            testID="profile-theme-toggle"
          />
        </View>
      </View>

      {/* ── RESOURCES ── */}
      <Text style={s.sectionLabelSpaced}>RESOURCES</Text>

      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={() => Linking.openURL('mailto:hello@bocy.io?subject=Support')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Support</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={() => Linking.openURL('https://www.bocy.io/privacy.html')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Privacy Policy</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={() => Linking.openURL('https://www.bocy.io/terms.html')} activeOpacity={0.7}>
          <Text style={s.groupRowLabel}>Terms of Use</Text>
          <Text style={s.groupRowChevron}>{'\u203A'}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Logout & Delete ── */}
      <View style={s.groupCard}>
        <TouchableOpacity style={s.groupRow} onPress={handleSignOut} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Sign out of your account" testID="profile-sign-out-button">
          <Text style={[s.groupRowLabel, { color: colors.coral }]}>Logout</Text>
          <Text style={[s.groupRowChevron, { color: colors.coral }]}>{'\u203A'}</Text>
        </TouchableOpacity>

        <View style={s.groupDivider} />

        <TouchableOpacity style={s.groupRow} onPress={handleDeleteAccount} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Delete your account">
          <Text style={[s.groupRowLabel, { color: colors.muted }]}>Delete account</Text>
          <Text style={[s.groupRowChevron, { color: colors.muted }]}>{'\u203A'}</Text>
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
  // ── Section label with spacing ──
  sectionLabelSpaced: {
    fontFamily: fonts.mono, fontSize: 11, letterSpacing: 2, color: c.dim,
    textTransform: 'uppercase', marginTop: spacing.lg, marginBottom: spacing.sm + 4,
    paddingHorizontal: 4,
  },

  // ── Account item rows inside group cards ──
  cardItemRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
  },
  accountDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  accountInfo: { flex: 1 },
  accountName: { fontFamily: fonts.medium, fontSize: 14, color: c.text },
  accountMeta: { fontFamily: fonts.regular, fontSize: 11, color: c.dim, marginTop: 2 },
  accountAction: { paddingVertical: 4, paddingHorizontal: 10 },
  accountActionText: { fontFamily: fonts.semibold, fontSize: 12 },
  accountRemoveBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  accountRemove: { fontFamily: fonts.regular, fontSize: 12, color: c.muted },

  // ── Empty + add (inside card) ──
  emptyHint: {
    fontFamily: fonts.regular, fontSize: 13, color: c.muted,
    textAlign: 'center', paddingVertical: 16, paddingHorizontal: 20,
  },
  cardAddRow: {
    paddingHorizontal: 20, paddingVertical: 14, alignItems: 'center',
  },
  cardAddRowDouble: {
    flexDirection: 'row', paddingHorizontal: 20, paddingVertical: 14, gap: 16,
    justifyContent: 'center',
  },
  cardAddBtn: { flex: 1, alignItems: 'center' },
  cardAddText: { fontFamily: fonts.semibold, fontSize: 13, color: c.accent },
  footnote: {
    fontFamily: fonts.regular, fontSize: 11, color: c.muted,
    textAlign: 'center', paddingHorizontal: 20, paddingBottom: 14,
  },

  // ── Badge for counts ──
  groupRowBadge: {
    fontFamily: fonts.mono, fontSize: 11, color: c.muted,
    backgroundColor: c.accentDim, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 2,
    overflow: 'hidden',
  },

  // ── Description text for group rows ──
  groupRowDesc: {
    fontFamily: fonts.regular, fontSize: 11, color: c.muted, marginTop: 2,
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

  // (notification styles now use groupRow/groupRowLabel/groupRowDesc)

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
