import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
  LayoutAnimation, ActivityIndicator, Modal, Pressable, TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import type { Investment, InvestmentAssetClass, SavingsAccount } from '@/lib/types';

// ── Constants ──

const SAVINGS_TYPES = [
  { value: 'easy_access' as const, label: 'Easy access' },
  { value: 'fixed' as const, label: 'Fixed' },
  { value: 'isa' as const, label: 'ISA' },
  { value: 'other' as const, label: 'Other' },
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

type SectionStatus = 'pending' | 'added' | 'skipped';

interface Property {
  id?: string;
  address: string;
  postcode: string;
  estimated_value: number;
  purchase_price: number | null;
  purchase_date: string | null;
  property_type: 'house' | 'flat' | 'terraced' | 'semi_detached' | 'detached' | 'bungalow' | 'other';
  has_mortgage: boolean;
  mortgage_balance: number | null;
  mortgage_rate: number | null;
  mortgage_term_remaining: number | null;
  mortgage_monthly_payment: number | null;
  mortgage_type: 'fixed' | 'variable' | 'tracker' | 'offset' | null;
  mortgage_fix_end_date: string | null;
}

const PROPERTY_TYPES = [
  { value: 'house' as const, label: 'House' },
  { value: 'flat' as const, label: 'Flat' },
  { value: 'terraced' as const, label: 'Terraced' },
  { value: 'semi_detached' as const, label: 'Semi-detached' },
  { value: 'detached' as const, label: 'Detached' },
  { value: 'bungalow' as const, label: 'Bungalow' },
  { value: 'other' as const, label: 'Other' },
];

const MORTGAGE_TYPES = [
  { value: 'fixed' as const, label: 'Fixed' },
  { value: 'variable' as const, label: 'Variable' },
  { value: 'tracker' as const, label: 'Tracker' },
  { value: 'offset' as const, label: 'Offset' },
];

export default function AccountSetup() {
  const router = useRouter();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);

  // Section visit/completion status
  const [debtStatus, setDebtStatus] = useState<SectionStatus>('pending');
  const [savingsStatus, setSavingsStatus] = useState<SectionStatus>('pending');
  const [investmentStatus, setInvestmentStatus] = useState<SectionStatus>('pending');
  const [propertyStatus, setPropertyStatus] = useState<SectionStatus>('pending');

  // Added items
  const [debts, setDebts] = useState<any[]>([]);
  const [savings, setSavings] = useState<SavingsAccount[]>([]);
  const [investments, setInvestments] = useState<Investment[]>([]);
  const [properties, setProperties] = useState<Property[]>([]);

  // ── Debt modal state ──
  const [showDebtModal, setShowDebtModal] = useState(false);
  const [debtName, setDebtName] = useState('');
  const [debtType, setDebtType] = useState('credit_card');
  const [debtBalance, setDebtBalance] = useState('');
  const [debtLimit, setDebtLimit] = useState('');
  const [debtRate, setDebtRate] = useState('');
  const [debtMinPayment, setDebtMinPayment] = useState('');
  const [debtSaving, setDebtSaving] = useState(false);
  const [debtError, setDebtError] = useState('');

  // ── Savings modal state ──
  const [showSavingsModal, setShowSavingsModal] = useState(false);
  const [savName, setSavName] = useState('');
  const [savProvider, setSavProvider] = useState('');
  const [savBalance, setSavBalance] = useState('');
  const [savRate, setSavRate] = useState('');
  const [savType, setSavType] = useState<SavingsAccount['account_type']>('easy_access');
  const [savSaving, setSavSaving] = useState(false);
  const [savError, setSavError] = useState('');

  // ── Property modal state ──
  const [showPropertyModal, setShowPropertyModal] = useState(false);
  const [propAddress, setPropAddress] = useState('');
  const [propPostcode, setPropPostcode] = useState('');
  const [propValue, setPropValue] = useState('');
  const [propPurchasePrice, setPropPurchasePrice] = useState('');
  const [propPurchaseDate, setPropPurchaseDate] = useState('');
  const [propType, setPropType] = useState<Property['property_type']>('house');
  const [propHasMortgage, setPropHasMortgage] = useState(false);
  const [propMortgageBalance, setPropMortgageBalance] = useState('');
  const [propMortgageRate, setPropMortgageRate] = useState('');
  const [propMortgageTerm, setPropMortgageTerm] = useState('');
  const [propMortgagePayment, setPropMortgagePayment] = useState('');
  const [propMortgageType, setPropMortgageType] = useState<Property['mortgage_type']>('fixed');
  const [propMortgageFixEnd, setPropMortgageFixEnd] = useState('');
  const [propSaving, setPropSaving] = useState(false);
  const [propError, setPropError] = useState('');
  const [propValuating, setPropValuating] = useState(false);

  // ── Investment modal state ──
  const [showInvestModal, setShowInvestModal] = useState(false);
  const [invName, setInvName] = useState('');
  const [invClass, setInvClass] = useState<InvestmentAssetClass>('stocks');
  const [invPlatform, setInvPlatform] = useState('');
  const [invValue, setInvValue] = useState('');
  const [invCost, setInvCost] = useState('');
  const [invQuantity, setInvQuantity] = useState('');
  const [invNotes, setInvNotes] = useState('');
  const [invSaving, setInvSaving] = useState(false);
  const [invError, setInvError] = useState('');

  const [saving, setSaving] = useState(false);

  const DEBT_TYPES = [
    { value: 'credit_card', label: 'Credit card' },
    { value: 'personal_loan', label: 'Personal loan' },
    { value: 'overdraft', label: 'Overdraft' },
    { value: 'student_loan', label: 'Student loan' },
    { value: 'car_finance', label: 'Car finance' },
    { value: 'bnpl', label: 'Buy now pay later' },
    { value: 'other', label: 'Other' },
  ];

  // Investment ticker field for stocks
  const [invTicker, setInvTicker] = useState('');

  // ── Save handlers ──

  const handleSaveDebt = async () => {
    setDebtError('');
    if (!debtName.trim()) { setDebtError('Please enter an account name.'); return; }
    const balance = parseFloat(debtBalance);
    if (isNaN(balance) || balance <= 0) { setDebtError('Please enter a valid balance.'); return; }

    setDebtSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setDebtError('Not signed in.'); setDebtSaving(false); return; }

      const newDebt = {
        user_id: user.id,
        account_name: debtName.trim(),
        account_type: debtType,
        outstanding_balance: balance,
        credit_limit: parseFloat(debtLimit) || null,
        interest_rate: parseFloat(debtRate) || null,
        minimum_payment: parseFloat(debtMinPayment) || null,
        source: 'manual',
        last_updated: new Date().toISOString(),
      };

      const { data: inserted, error } = await supabase.from('debt_accounts').insert(newDebt).select().maybeSingle();
      if (error) { setDebtError(error.message); setDebtSaving(false); return; }

      trackEvent('Debt Account Added (Setup)', { type: debtType });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDebts((prev) => [...prev, inserted]);
      setDebtStatus('added');
      resetDebtForm();
      setShowDebtModal(false);
    } catch { setDebtError('Something went wrong.'); }
    setDebtSaving(false);
  };

  const handleSaveSavings = async () => {
    setSavError('');
    if (!savName.trim()) { setSavError('Please enter an account name.'); return; }
    const balance = parseFloat(savBalance);
    if (isNaN(balance) || balance < 0) { setSavError('Please enter a valid balance.'); return; }

    setSavSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setSavError('Not signed in.'); setSavSaving(false); return; }

      const newSav = {
        user_id: user.id,
        account_name: savName.trim(),
        provider: savProvider.trim() || null,
        balance,
        interest_rate: parseFloat(savRate) || null,
        account_type: savType,
        source: 'manual' as const,
      };

      const { data: inserted, error } = await supabase.from('savings_accounts').insert(newSav).select().maybeSingle();
      if (error) { setSavError(error.message); setSavSaving(false); return; }

      trackEvent('Savings Account Added (Setup)', { type: savType });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setSavings((prev) => [...prev, inserted as SavingsAccount]);
      setSavingsStatus('added');
      resetSavingsForm();
      setShowSavingsModal(false);
    } catch { setSavError('Something went wrong.'); }
    setSavSaving(false);
  };

  const handleSaveInvestment = async () => {
    setInvError('');
    if (!invName.trim()) { setInvError('Please enter a name.'); return; }
    const value = parseFloat(invValue);
    if (isNaN(value) || value <= 0) { setInvError('Please enter a valid current value.'); return; }

    setInvSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setInvError('Not signed in.'); setInvSaving(false); return; }

      const newInv = {
        user_id: user.id,
        name: invName.trim(),
        asset_class: invClass,
        platform: invPlatform.trim() || null,
        current_value: value,
        purchase_cost: parseFloat(invCost) || null,
        quantity: parseFloat(invQuantity) || null,
        notes: invNotes.trim() || null,
        ticker: invClass === 'stocks' && invTicker.trim() ? invTicker.trim().toUpperCase() : null,
        source: 'manual' as const,
      };

      const { data: inserted, error } = await supabase.from('investments').insert(newInv).select().maybeSingle();
      if (error) { setInvError(error.message); setInvSaving(false); return; }

      trackEvent('Investment Added (Setup)', { asset_class: invClass });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setInvestments((prev) => [...prev, inserted as Investment]);
      setInvestmentStatus('added');
      resetInvestmentForm();
      setShowInvestModal(false);
    } catch { setInvError('Something went wrong.'); }
    setInvSaving(false);
  };

  // ── Property valuation lookup via postcode ──
  const lookupPropertyValue = async () => {
    if (!propPostcode.trim()) return;
    setPropValuating(true);
    try {
      // Use the free HM Land Registry Price Paid Data API for UK property estimates.
      // Falls back to a conservative estimate if unavailable.
      const postcode = propPostcode.trim().replace(/\s+/g, '').toUpperCase();
      const postcodeFormatted = postcode.length > 3
        ? postcode.slice(0, -3) + ' ' + postcode.slice(-3)
        : postcode;

      const res = await fetch(
        `https://landregistry.data.gov.uk/data/ppi/transaction-record.json?propertyAddress.postcode=${encodeURIComponent(postcodeFormatted)}&_pageSize=20&_sort=-transactionDate`
      );

      if (res.ok) {
        const data = await res.json();
        const items = data?.result?.items;
        if (Array.isArray(items) && items.length > 0) {
          // Filter to same property type if possible, then take median of recent sales
          const typeMap: Record<string, string> = {
            'house': 'semi-detached', 'semi_detached': 'semi-detached',
            'detached': 'detached', 'terraced': 'terraced', 'flat': 'flat',
          };
          const targetType = typeMap[propType] || '';
          const matchingPrices = items
            .filter((i: any) => !targetType || (i.propertyAddress?.type || '').toLowerCase().includes(targetType))
            .map((i: any) => i.pricePaid)
            .filter((p: any) => typeof p === 'number' && p > 0);

          const allPrices = matchingPrices.length > 0
            ? matchingPrices
            : items.map((i: any) => i.pricePaid).filter((p: any) => typeof p === 'number' && p > 0);

          if (allPrices.length > 0) {
            allPrices.sort((a: number, b: number) => a - b);
            const median = allPrices[Math.floor(allPrices.length / 2)];
            // Apply ~5% annual appreciation estimate from the most recent sale date
            const mostRecent = items[0]?.transactionDate;
            let adjustedValue = median;
            if (mostRecent) {
              const yearsAgo = (Date.now() - new Date(mostRecent).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
              adjustedValue = Math.round(median * Math.pow(1.04, yearsAgo));
            }
            setPropValue(String(adjustedValue));
          }
        }
      }
    } catch (err) {
      console.warn('[property] Valuation lookup failed:', err);
    }
    setPropValuating(false);
  };

  const handleSaveProperty = async () => {
    setPropError('');
    if (!propAddress.trim()) { setPropError('Please enter an address.'); return; }
    if (!propPostcode.trim()) { setPropError('Please enter a postcode.'); return; }
    const value = parseFloat(propValue);
    if (isNaN(value) || value <= 0) { setPropError('Please enter an estimated value.'); return; }

    setPropSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setPropError('Not signed in.'); setPropSaving(false); return; }

      const newProp = {
        user_id: user.id,
        address: propAddress.trim(),
        postcode: propPostcode.trim().toUpperCase(),
        estimated_value: value,
        purchase_price: parseFloat(propPurchasePrice) || null,
        purchase_date: propPurchaseDate.trim() || null,
        property_type: propType,
        has_mortgage: propHasMortgage,
        mortgage_balance: propHasMortgage ? (parseFloat(propMortgageBalance) || null) : null,
        mortgage_rate: propHasMortgage ? (parseFloat(propMortgageRate) || null) : null,
        mortgage_term_remaining: propHasMortgage ? (parseInt(propMortgageTerm) || null) : null,
        mortgage_monthly_payment: propHasMortgage ? (parseFloat(propMortgagePayment) || null) : null,
        mortgage_type: propHasMortgage ? propMortgageType : null,
        mortgage_fix_end_date: propHasMortgage && propMortgageFixEnd.trim() ? propMortgageFixEnd.trim() : null,
        source: 'manual',
      };

      const { data: inserted, error } = await supabase.from('properties').insert(newProp).select().maybeSingle();
      if (error) { setPropError(error.message); setPropSaving(false); return; }

      trackEvent('Property Added (Setup)', { type: propType, has_mortgage: propHasMortgage });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setProperties((prev) => [...prev, inserted as Property]);
      setPropertyStatus('added');
      resetPropertyForm();
      setShowPropertyModal(false);
    } catch { setPropError('Something went wrong.'); }
    setPropSaving(false);
  };

  const handleContinue = async () => {
    setSaving(true);
    if (typeof window !== 'undefined') {
      localStorage.setItem('bocy_account_setup_done', 'true');
    }
    trackEvent('Account Setup Complete', {
      debts: debts.length,
      savings: savings.length,
      investments: investments.length,
      properties: properties.length,
    });
    router.replace('/(main)/(tabs)');
  };

  // ── Reset helpers ──

  const resetDebtForm = () => {
    setDebtName(''); setDebtType('credit_card'); setDebtBalance('');
    setDebtLimit(''); setDebtRate(''); setDebtMinPayment(''); setDebtError('');
  };

  const resetSavingsForm = () => {
    setSavName(''); setSavProvider(''); setSavBalance('');
    setSavRate(''); setSavType('easy_access'); setSavError('');
  };

  const resetInvestmentForm = () => {
    setInvName(''); setInvClass('stocks'); setInvPlatform('');
    setInvValue(''); setInvCost(''); setInvQuantity(''); setInvNotes(''); setInvTicker(''); setInvError('');
  };

  const resetPropertyForm = () => {
    setPropAddress(''); setPropPostcode(''); setPropValue(''); setPropPurchasePrice('');
    setPropPurchaseDate(''); setPropType('house'); setPropHasMortgage(false);
    setPropMortgageBalance(''); setPropMortgageRate(''); setPropMortgageTerm('');
    setPropMortgagePayment(''); setPropMortgageType('fixed'); setPropMortgageFixEnd(''); setPropError('');
  };

  // ── Section renderer ──

  const handleConnectOpenBanking = (type: 'credit_card' | 'savings') => {
    trackEvent('Open Banking Connect (Setup)', { type });
    router.push({ pathname: '/(main)/connect', params: { accountType: type, returnTo: 'account-setup' } });
  };

  const renderSection = (
    title: string,
    status: SectionStatus,
    items: any[],
    itemLabel: (item: any) => string,
    itemValue: (item: any) => string,
    onAdd: () => void,
    onSkip: () => void,
    showOpenBanking?: boolean,
  ) => (
    <View style={s.section}>
      <View style={s.sectionHeader}>
        <Text style={s.sectionTitle}>{title}</Text>
        {status === 'added' && <Text style={s.checkmark}>{'\u2713'}</Text>}
        {status === 'skipped' && <Text style={s.skippedBadge}>skipped</Text>}
      </View>

      {items.length > 0 && items.map((item, idx) => (
        <View key={idx} style={s.itemRow}>
          <Text style={s.itemName}>{itemLabel(item)}</Text>
          <Text style={s.itemValue}>{'\u00a3'}{Math.round(parseFloat(itemValue(item)) || 0).toLocaleString()}</Text>
        </View>
      ))}

      {showOpenBanking && (
        <TouchableOpacity
          style={s.openBankingBtn}
          onPress={() => handleConnectOpenBanking(title.includes('Debt') ? 'credit_card' : 'savings')}
          activeOpacity={0.7}
        >
          <Text style={s.openBankingText}>Connect via Open Banking</Text>
        </TouchableOpacity>
      )}

      <View style={s.sectionActions}>
        <TouchableOpacity style={s.addBtn} onPress={onAdd} activeOpacity={0.7}>
          <Text style={s.addBtnText}>{showOpenBanking ? 'Or add manually' : '+ Add'}</Text>
        </TouchableOpacity>
        {status === 'pending' && (
          <TouchableOpacity onPress={onSkip} activeOpacity={0.7}>
            <Text style={s.skipText}>I don't have any</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  return (
    <ScrollView style={s.container} contentContainerStyle={[s.scroll, isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding }]}>
      <Text style={s.heading}>Set up your accounts</Text>
      <Text style={s.subtitle}>
        Add your financial accounts so Bocy can give you the full picture. You can skip any section.
      </Text>

      {/* ── Bank Accounts ── */}
      <View style={s.section}>
        <View style={s.sectionHeader}>
          <Text style={s.sectionTitle}>Bank Accounts</Text>
          <Text style={s.checkmark}>{'\u2713'}</Text>
        </View>
        <Text style={s.sectionHint}>Connected via Open Banking in the previous step.</Text>
      </View>

      {/* ── Debts ── */}
      {renderSection(
        'Credit Cards & Debt',
        debtStatus,
        debts,
        (d) => d.account_name,
        (d) => String(d.outstanding_balance || 0),
        () => setShowDebtModal(true),
        () => { setDebtStatus('skipped'); },
        true,
      )}

      {/* ── Savings ── */}
      {renderSection(
        'Savings Accounts',
        savingsStatus,
        savings,
        (s) => s.account_name,
        (s) => String(s.balance || 0),
        () => setShowSavingsModal(true),
        () => { setSavingsStatus('skipped'); },
        true,
      )}

      {/* ── Investments ── */}
      {renderSection(
        'Investments',
        investmentStatus,
        investments,
        (i) => i.name,
        (i) => String(i.current_value || 0),
        () => setShowInvestModal(true),
        () => { setInvestmentStatus('skipped'); },
      )}

      {/* ── Properties ── */}
      <View style={s.section}>
        <View style={s.sectionHeader}>
          <Text style={s.sectionTitle}>Properties</Text>
          {propertyStatus === 'added' && <Text style={s.checkmark}>{'\u2713'}</Text>}
          {propertyStatus === 'skipped' && <Text style={s.skippedBadge}>skipped</Text>}
        </View>
        <Text style={[s.sectionHint, { marginBottom: 8 }]}>
          Track your property value and mortgage for a complete net worth picture.
        </Text>

        {properties.length > 0 && properties.map((p, idx) => (
          <View key={idx} style={s.itemRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.itemName}>{p.address}</Text>
              {p.has_mortgage && p.mortgage_balance && (
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                  Mortgage: {'\u00a3'}{Math.round(p.mortgage_balance).toLocaleString()}
                </Text>
              )}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={s.itemValue}>{'\u00a3'}{Math.round(p.estimated_value).toLocaleString()}</Text>
              {p.has_mortgage && p.mortgage_balance && (
                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.green }}>
                  Equity: {'\u00a3'}{Math.round(p.estimated_value - p.mortgage_balance).toLocaleString()}
                </Text>
              )}
            </View>
          </View>
        ))}

        <View style={s.sectionActions}>
          <TouchableOpacity style={s.addBtn} onPress={() => setShowPropertyModal(true)} activeOpacity={0.7}>
            <Text style={s.addBtnText}>+ Add property</Text>
          </TouchableOpacity>
          {propertyStatus === 'pending' && (
            <TouchableOpacity onPress={() => setPropertyStatus('skipped')} activeOpacity={0.7}>
              <Text style={s.skipText}>I don't own property</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Continue button ── */}
      <TouchableOpacity
        style={s.continueBtn}
        onPress={handleContinue}
        disabled={saving}
        activeOpacity={0.8}
      >
        {saving ? (
          <ActivityIndicator color={colors.bg} size="small" />
        ) : (
          <Text style={s.continueBtnText}>
            Continue to Dashboard
          </Text>
        )}
      </TouchableOpacity>

      <Text style={s.continueHint}>You can always add accounts later from your profile</Text>

      {/* ══ Add Debt Modal ══ */}
      <Modal visible={showDebtModal} transparent animationType="fade" onRequestClose={() => { resetDebtForm(); setShowDebtModal(false); }}>
        <Pressable style={s.modalOverlay} onPress={() => { resetDebtForm(); setShowDebtModal(false); }}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Add debt</Text>
              <TouchableOpacity onPress={() => { resetDebtForm(); setShowDebtModal(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>

            <Text style={s.modalLabel}>Account name</Text>
            <TextInput style={s.modalInput} value={debtName} onChangeText={setDebtName} placeholder="e.g. Barclaycard, Klarna" placeholderTextColor={colors.muted} />

            <Text style={s.modalLabel}>Type</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {DEBT_TYPES.map((t) => (
                <TouchableOpacity key={t.value} style={[s.chip, debtType === t.value && s.chipActive]} onPress={() => setDebtType(t.value)} activeOpacity={0.7}>
                  <Text style={[s.chipText, debtType === t.value && s.chipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.modalLabel}>Outstanding balance</Text>
            <TextInput style={s.modalInput} value={debtBalance} onChangeText={setDebtBalance} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Credit limit <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={debtLimit} onChangeText={setDebtLimit} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Interest rate <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={debtRate} onChangeText={setDebtRate} placeholder="e.g. 22.9" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Min. payment <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={debtMinPayment} onChangeText={setDebtMinPayment} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            {debtError ? <Text style={s.modalError}>{debtError}</Text> : null}

            <TouchableOpacity style={s.modalSaveBtn} onPress={handleSaveDebt} disabled={debtSaving} activeOpacity={0.8}>
              {debtSaving ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Save</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ══ Add Savings Modal ══ */}
      <Modal visible={showSavingsModal} transparent animationType="fade" onRequestClose={() => { resetSavingsForm(); setShowSavingsModal(false); }}>
        <Pressable style={s.modalOverlay} onPress={() => { resetSavingsForm(); setShowSavingsModal(false); }}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Add savings account</Text>
              <TouchableOpacity onPress={() => { resetSavingsForm(); setShowSavingsModal(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>

            <Text style={s.modalLabel}>Account name</Text>
            <TextInput style={s.modalInput} value={savName} onChangeText={setSavName} placeholder="e.g. Marcus, Chip" placeholderTextColor={colors.muted} />

            <Text style={s.modalLabel}>Provider <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={savProvider} onChangeText={setSavProvider} placeholder="e.g. Goldman Sachs, Chase" placeholderTextColor={colors.muted} />

            <Text style={s.modalLabel}>Balance</Text>
            <TextInput style={s.modalInput} value={savBalance} onChangeText={setSavBalance} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Interest rate <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={savRate} onChangeText={setSavRate} placeholder="e.g. 4.5" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Type</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {SAVINGS_TYPES.map((t) => (
                <TouchableOpacity key={t.value} style={[s.chip, savType === t.value && s.chipActive]} onPress={() => setSavType(t.value)} activeOpacity={0.7}>
                  <Text style={[s.chipText, savType === t.value && s.chipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {savError ? <Text style={s.modalError}>{savError}</Text> : null}

            <TouchableOpacity style={s.modalSaveBtn} onPress={handleSaveSavings} disabled={savSaving} activeOpacity={0.8}>
              {savSaving ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Save</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ══ Add Investment Modal ══ */}
      <Modal visible={showInvestModal} transparent animationType="fade" onRequestClose={() => { resetInvestmentForm(); setShowInvestModal(false); }}>
        <Pressable style={s.modalOverlay} onPress={() => { resetInvestmentForm(); setShowInvestModal(false); }}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Add investment</Text>
              <TouchableOpacity onPress={() => { resetInvestmentForm(); setShowInvestModal(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={s.modalClose}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>

            <Text style={s.modalLabel}>Name</Text>
            <TextInput style={s.modalInput} value={invName} onChangeText={setInvName} placeholder="e.g. Vanguard S&P 500" placeholderTextColor={colors.muted} />

            <Text style={s.modalLabel}>Asset class</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {ASSET_CLASSES.map((t) => (
                <TouchableOpacity key={t.value} style={[s.chip, invClass === t.value && s.chipActive]} onPress={() => setInvClass(t.value)} activeOpacity={0.7}>
                  <Text style={[s.chipText, invClass === t.value && s.chipTextActive]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {invClass === 'stocks' && (
              <>
                <Text style={s.modalLabel}>Ticker / Symbol <Text style={s.optional}>(optional)</Text></Text>
                <TextInput style={s.modalInput} value={invTicker} onChangeText={setInvTicker} placeholder="e.g. VUSA, AAPL" placeholderTextColor={colors.muted} autoCapitalize="characters" />
                <Text style={s.tickerHint}>Adding a ticker enables live price tracking</Text>
              </>
            )}

            <Text style={s.modalLabel}>Platform <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={invPlatform} onChangeText={setInvPlatform} placeholder="e.g. Trading 212, Vanguard" placeholderTextColor={colors.muted} />

            <Text style={s.modalLabel}>Current value</Text>
            <TextInput style={s.modalInput} value={invValue} onChangeText={setInvValue} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Purchase cost <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={invCost} onChangeText={setInvCost} placeholder={'\u00a3 0.00'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Quantity <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={invQuantity} onChangeText={setInvQuantity} placeholder="e.g. 10.5" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

            <Text style={s.modalLabel}>Notes <Text style={s.optional}>(optional)</Text></Text>
            <TextInput style={s.modalInput} value={invNotes} onChangeText={setInvNotes} placeholder="Any notes..." placeholderTextColor={colors.muted} multiline />

            {invError ? <Text style={s.modalError}>{invError}</Text> : null}

            <TouchableOpacity style={s.modalSaveBtn} onPress={handleSaveInvestment} disabled={invSaving} activeOpacity={0.8}>
              {invSaving ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Save</Text>}
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ══ Add Property Modal ══ */}
      <Modal visible={showPropertyModal} transparent animationType="fade" onRequestClose={() => { resetPropertyForm(); setShowPropertyModal(false); }}>
        <Pressable style={s.modalOverlay} onPress={() => { resetPropertyForm(); setShowPropertyModal(false); }}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle}>Add property</Text>
                <TouchableOpacity onPress={() => { resetPropertyForm(); setShowPropertyModal(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Text style={s.modalClose}>{'\u2715'}</Text>
                </TouchableOpacity>
              </View>

              <Text style={s.modalLabel}>Address</Text>
              <TextInput style={s.modalInput} value={propAddress} onChangeText={setPropAddress} placeholder="e.g. 42 Oak Lane" placeholderTextColor={colors.muted} />

              <Text style={s.modalLabel}>Postcode</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 4 }}>
                <TextInput
                  style={[s.modalInput, { flex: 1, marginBottom: 0 }]}
                  value={propPostcode}
                  onChangeText={setPropPostcode}
                  placeholder="e.g. SW1A 1AA"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="characters"
                />
                <TouchableOpacity
                  style={[s.addBtn, { justifyContent: 'center', paddingVertical: 12 }]}
                  onPress={lookupPropertyValue}
                  disabled={propValuating || !propPostcode.trim()}
                  activeOpacity={0.7}
                >
                  <Text style={s.addBtnText}>{propValuating ? 'Looking up...' : 'Estimate value'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.tickerHint}>Uses HM Land Registry data to estimate based on recent area sales</Text>

              <Text style={s.modalLabel}>Property type</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {PROPERTY_TYPES.map((t) => (
                  <TouchableOpacity key={t.value} style={[s.chip, propType === t.value && s.chipActive]} onPress={() => setPropType(t.value)} activeOpacity={0.7}>
                    <Text style={[s.chipText, propType === t.value && s.chipTextActive]}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.modalLabel}>Estimated current value</Text>
              <TextInput style={s.modalInput} value={propValue} onChangeText={setPropValue} placeholder={'\u00a3 0'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

              <Text style={s.modalLabel}>Purchase price <Text style={s.optional}>(optional)</Text></Text>
              <TextInput style={s.modalInput} value={propPurchasePrice} onChangeText={setPropPurchasePrice} placeholder={'\u00a3 0'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

              <Text style={s.modalLabel}>Purchase date <Text style={s.optional}>(optional)</Text></Text>
              <TextInput style={s.modalInput} value={propPurchaseDate} onChangeText={setPropPurchaseDate} placeholder="e.g. 2020-03" placeholderTextColor={colors.muted} />

              {/* ── Mortgage section ── */}
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, marginBottom: 8 }}
                onPress={() => setPropHasMortgage(!propHasMortgage)}
                activeOpacity={0.7}
              >
                <View style={{
                  width: 20, height: 20, borderRadius: 4, borderWidth: 1.5,
                  borderColor: propHasMortgage ? colors.accent : colors.border,
                  backgroundColor: propHasMortgage ? colors.accent : 'transparent',
                  justifyContent: 'center', alignItems: 'center',
                }}>
                  {propHasMortgage && <Text style={{ color: colors.bg, fontSize: 12, fontWeight: '700' }}>{'\u2713'}</Text>}
                </View>
                <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>I have a mortgage on this property</Text>
              </TouchableOpacity>

              {propHasMortgage && (
                <View style={{ borderLeftWidth: 2, borderLeftColor: colors.accent, paddingLeft: 12, marginLeft: 10 }}>
                  <Text style={s.modalLabel}>Outstanding mortgage balance</Text>
                  <TextInput style={s.modalInput} value={propMortgageBalance} onChangeText={setPropMortgageBalance} placeholder={'\u00a3 0'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

                  <Text style={s.modalLabel}>Interest rate (%)</Text>
                  <TextInput style={s.modalInput} value={propMortgageRate} onChangeText={setPropMortgageRate} placeholder="e.g. 4.5" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

                  <Text style={s.modalLabel}>Monthly payment</Text>
                  <TextInput style={s.modalInput} value={propMortgagePayment} onChangeText={setPropMortgagePayment} placeholder={'\u00a3 0'} placeholderTextColor={colors.muted} keyboardType="decimal-pad" />

                  <Text style={s.modalLabel}>Years remaining</Text>
                  <TextInput style={s.modalInput} value={propMortgageTerm} onChangeText={setPropMortgageTerm} placeholder="e.g. 25" placeholderTextColor={colors.muted} keyboardType="number-pad" />

                  <Text style={s.modalLabel}>Mortgage type</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {MORTGAGE_TYPES.map((t) => (
                      <TouchableOpacity key={t.value} style={[s.chip, propMortgageType === t.value && s.chipActive]} onPress={() => setPropMortgageType(t.value)} activeOpacity={0.7}>
                        <Text style={[s.chipText, propMortgageType === t.value && s.chipTextActive]}>{t.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {propMortgageType === 'fixed' && (
                    <>
                      <Text style={s.modalLabel}>Fixed rate end date <Text style={s.optional}>(optional)</Text></Text>
                      <TextInput style={s.modalInput} value={propMortgageFixEnd} onChangeText={setPropMortgageFixEnd} placeholder="e.g. 2027-06" placeholderTextColor={colors.muted} />
                    </>
                  )}
                </View>
              )}

              {propError ? <Text style={s.modalError}>{propError}</Text> : null}

              <TouchableOpacity style={s.modalSaveBtn} onPress={handleSaveProperty} disabled={propSaving} activeOpacity={0.8}>
                {propSaving ? <ActivityIndicator color={colors.bg} size="small" /> : <Text style={s.modalSaveBtnText}>Save property</Text>}
              </TouchableOpacity>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.bg },
  scroll: { padding: 24, paddingTop: 60, paddingBottom: 40 },

  heading: { fontFamily: fonts.semibold, fontSize: 24, color: c.text, marginBottom: 8 },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, color: c.dim, marginBottom: 32, lineHeight: 20 },

  // ── Sections ──
  section: {
    borderWidth: 1, borderColor: c.border, borderRadius: 16,
    padding: 20, marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
  },
  sectionTitle: { fontFamily: fonts.semibold, fontSize: 16, color: c.text },
  sectionHint: { fontFamily: fonts.regular, fontSize: 13, color: c.dim },
  checkmark: { fontFamily: fonts.mono, fontSize: 16, color: c.green },
  skippedBadge: {
    fontFamily: fonts.mono, fontSize: 9, color: c.muted, letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionActions: {
    flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12,
  },

  // ── Items ──
  itemRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
  },
  itemName: { fontFamily: fonts.medium, fontSize: 14, color: c.text },
  itemValue: { fontFamily: fonts.mono, fontSize: 14, color: c.accent },

  // ── Buttons ──
  addBtn: {
    borderWidth: 1, borderColor: c.accentDim, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  addBtnText: { fontFamily: fonts.medium, fontSize: 13, color: c.accent },
  skipText: { fontFamily: fonts.regular, fontSize: 13, color: c.muted },

  continueBtn: {
    backgroundColor: c.accent, borderRadius: 12,
    paddingVertical: 16, alignItems: 'center', marginTop: 24,
  },
  continueBtnDisabled: { opacity: 0.3 },
  continueBtnText: { fontFamily: fonts.semibold, fontSize: 16, color: c.bg },
  continueHint: {
    fontFamily: fonts.regular, fontSize: 12, color: c.muted,
    textAlign: 'center', marginTop: 8,
  },

  // ── Modal ──
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', padding: 24,
  },
  modalContent: {
    backgroundColor: c.surface, borderRadius: 20, padding: 24,
    width: '100%', maxWidth: 420, maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16,
  },
  modalTitle: { fontFamily: fonts.semibold, fontSize: 18, color: c.text },
  modalClose: { fontSize: 16, color: c.muted, padding: 4 },
  modalLabel: { fontFamily: fonts.medium, fontSize: 13, color: c.text2, marginBottom: 6, marginTop: 8 },
  optional: { fontFamily: fonts.regular, fontSize: 11, color: c.muted },
  modalInput: {
    fontFamily: fonts.regular, fontSize: 15, color: c.text,
    borderWidth: 1, borderColor: c.border, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, marginBottom: 4,
  },
  modalError: { fontFamily: fonts.regular, fontSize: 13, color: c.coral, marginTop: 8 },
  modalSaveBtn: {
    backgroundColor: c.accent, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', marginTop: 16,
  },
  modalSaveBtnText: { fontFamily: fonts.semibold, fontSize: 15, color: c.bg },

  // ── Chips ──
  chip: {
    borderWidth: 1, borderColor: c.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
  },
  chipActive: { borderColor: c.accent, backgroundColor: c.accentDim },
  chipText: { fontFamily: fonts.regular, fontSize: 13, color: c.muted },
  chipTextActive: { color: c.accent },

  // ── Open Banking button ──
  openBankingBtn: {
    backgroundColor: c.accent, borderRadius: 10,
    paddingVertical: 12, alignItems: 'center', marginTop: 8,
  },
  openBankingText: { fontFamily: fonts.semibold, fontSize: 14, color: c.bg },
  tickerHint: {
    fontFamily: fonts.regular, fontSize: 11, color: c.muted,
    marginTop: 2, marginBottom: 4,
  },
});
