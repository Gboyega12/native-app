import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  LayoutAnimation, Platform, UIManager, TextInput, Modal, Alert, Animated, Easing, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getLastResult } from '@/app/(main)/processing';
import { syncBankData, type WeeklyContext } from '@/lib/sync';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { BocyFace, getBocyMood } from '@/components/Bocy';
import type { Analysis, BudgetCategory, TransactionDetail, IncomeSource, Move, Goals } from '@/lib/types';

/** Strip markdown bold/italic markers from text rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Smooth layout animation config for micro-interactions
const SMOOTH_ANIM = {
  duration: 280,
  create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
};


// ── Breathing bar: subtle pulse on progress indicators ──
const BreathingBar = ({ color, width: barWidth, style }: { color: string; width: string; style?: any }) => {
  const breathAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(breathAnim, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ]),
    ).start();
  }, []);
  const opacity = breathAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });
  return (
    <Animated.View style={[style, { width: barWidth, backgroundColor: color, opacity }]} />
  );
};

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

export default function Home() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedMoves, setExpandedMoves] = useState<Set<number>>(new Set());
  const [budgetExpanded, setBudgetExpanded] = useState(false);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);
  const [weeklyCtx, setWeeklyCtx] = useState<WeeklyContext | null>(null);

  const toggleCategory = (key: string) => {
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleMove = (idx: number) => {
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setExpandedMoves((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  const isCurrentMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  };

  const [syncing, setSyncing] = useState(false);
  const [verifyMove, setVerifyMove] = useState<Move | null>(null);
  const [infoCard, setInfoCard] = useState<string | null>(null);
  const [recatTx, setRecatTx] = useState<{ tx: TransactionDetail; catKey: string; section: 'essential' | 'lifestyle' } | null>(null);
  const [recatTarget, setRecatTarget] = useState('');
  const [recatEssential, setRecatEssential] = useState(true);
  const [savingRecat, setSavingRecat] = useState(false);
  const [removingSource, setRemovingSource] = useState<string | null>(null);

  // Add budget item state
  const [showAddItem, setShowAddItem] = useState(false);
  const [addItemDesc, setAddItemDesc] = useState('');
  const [addItemAmount, setAddItemAmount] = useState('');
  const [addItemCategory, setAddItemCategory] = useState('');
  const [addItemEssential, setAddItemEssential] = useState(true);
  const [addItemSaving, setAddItemSaving] = useState(false);
  const [addItemError, setAddItemError] = useState('');

  // Categorise review modal state
  const [showCatReview, setShowCatReview] = useState(false);
  const [catAssignments, setCatAssignments] = useState<Record<string, { category: string; isEssential: boolean }>>({});
  const [savingCatReview, setSavingCatReview] = useState(false);
  const [aiSuggesting, setAiSuggesting] = useState(false);

  const ESSENTIAL_CATS = new Set(['Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport', 'Childcare', 'Health', 'Education', 'Debt Payments', 'Savings']);

  const BUDGET_CATEGORIES = [
    'Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport', 'Travel',
    'Eating Out', 'Shopping', 'Entertainment', 'Subscriptions', 'Health',
    'Childcare', 'Education', 'Charity', 'Transfers', 'Savings', 'Investments', 'Other',
  ];

  // Map Claude's broader categories to our BUDGET_CATEGORIES
  const mapClaudeCategory = (cat: string): string => {
    const map: Record<string, string> = {
      'Delivery': 'Eating Out', 'Coffee & Cafes': 'Eating Out',
      'Streaming': 'Subscriptions', 'Fitness': 'Health',
      'BNPL': 'Shopping', 'Broadband & Phone': 'Bills',
      'Council Tax': 'Bills', 'Energy': 'Bills', 'Water': 'Bills',
      'TV Licence': 'Bills', 'Personal Care': 'Shopping',
      'Gambling': 'Entertainment', 'Pets': 'Shopping',
      'Debt Payments': 'Bills',
    };
    const mapped = map[cat] || cat;
    return BUDGET_CATEGORIES.includes(mapped) ? mapped : 'Other';
  };

  const saveAddItem = async () => {
    setAddItemError('');
    const amount = parseFloat(addItemAmount);
    if (!addItemDesc.trim()) {
      setAddItemError('Please enter a description.');
      return;
    }
    if (!addItemCategory) {
      setAddItemError('Please select a category.');
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      setAddItemError('Please enter a valid monthly amount.');
      return;
    }

    setAddItemSaving(true);
    try {
      let user: any = null;
      try {
        const { data } = await supabase.auth.getUser();
        user = data?.user;
      } catch (authErr: any) {
        console.warn('[home] auth.getUser failed:', authErr?.message);
      }

      if (!user) {
        setAddItemError('Not signed in. Please sign in and try again.');
        setAddItemSaving(false);
        return;
      }

      // Insert the budget item
      const { error: insertError, status } = await supabase
        .from('budget_adjustments')
        .insert({
          user_id: user.id,
          description: addItemDesc.trim(),
          category: addItemCategory,
          monthly_amount: amount,
          is_essential: addItemEssential,
        });

      if (insertError) {
        console.warn('[home] Failed to insert budget item:', insertError.message, 'code:', insertError.code, 'status:', status);
        const msg = insertError.message || '';
        if (msg.includes('schema cache') || msg.includes('relation') || msg.includes('does not exist') || insertError.code === '42P01') {
          setAddItemError('The budget_adjustments table hasn\'t been created yet. Run the SQL in supabase-budget-adjustments.sql in your Supabase SQL Editor (Dashboard > SQL Editor > New query).');
        } else if (insertError.code === '42501' || msg.includes('policy')) {
          setAddItemError('Permission error. The app needs to be re-authorised — try signing out and back in.');
        } else {
          setAddItemError(`Could not save: ${msg || 'Unknown error'}. Please try again.`);
        }
        setAddItemSaving(false);
        return;
      }

      // Optimistic update: merge the new item directly into current analysis state
      if (analysis) {
        const updated = { ...analysis };
        const sectionKey = addItemEssential ? 'non_discretionary' : 'discretionary';
        const section = { ...(updated[sectionKey] as any || { total: 0, items: [] }) };
        section.items = [...(section.items || [])];

        const existingIdx = section.items.findIndex((i: BudgetCategory) => i.category === addItemCategory);
        const newTx = {
          date: new Date().toISOString().split('T')[0],
          merchant: addItemDesc.trim(),
          description: addItemDesc.trim() + ' (manual)',
          amount: -Math.abs(amount),
        };

        if (existingIdx >= 0) {
          const existing = { ...section.items[existingIdx] };
          existing.monthly += amount;
          existing.txs += 1;
          existing.transactions = [...(existing.transactions || []), newTx];
          section.items[existingIdx] = existing;
        } else {
          section.items.push({
            category: addItemCategory,
            monthly: amount,
            txs: 1,
            transactions: [newTx],
          });
        }
        section.total = section.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);

        (updated as any)[sectionKey] = section;
        updated.monthly_spending = (updated.monthly_spending || 0) + amount;
        updated.surplus = (updated.surplus || 0) - amount;

        LayoutAnimation.configureNext(SMOOTH_ANIM);
        setAnalysis(updated);
      }

      // Reset form and close
      setAddItemDesc('');
      setAddItemAmount('');
      setAddItemCategory('');
      setAddItemEssential(true);
      setAddItemError('');
      setShowAddItem(false);
    } catch (err: any) {
      console.warn('[home] Failed to save budget item:', err?.message);
      setAddItemError('Something went wrong. Please try again.');
    }
    setAddItemSaving(false);
  };

  // Normalize merchant names so similar transactions group together
  const normalizeMerchant = (raw: string) => {
    let n = raw.trim();
    // Remove common bank prefixes
    n = n.replace(/^(PAYMENT TO |DIRECT DEBIT |DEBIT CARD PAYMENT |CARD PAYMENT TO |CARD PAYMENT |CONTACTLESS |POS )/i, '');
    // Remove trailing reference numbers (6+ digits)
    n = n.replace(/\s+\d{6,}$/, '');
    // Remove trailing dates (dd/mm or dd-mm patterns)
    n = n.replace(/\s+\d{2}[\/\-]\d{2}([\/\-]\d{2,4})?$/, '');
    // Collapse whitespace
    n = n.replace(/\s+/g, ' ').trim();
    return n;
  };

  // ── Unresolved transaction groups (for categorise modal) ──
  const unresolvedGroups = useMemo(() => {
    if (!analysis) return [];
    const txs: TransactionDetail[] = [];
    for (const section of [analysis.discretionary, analysis.non_discretionary]) {
      if (!(section as any)?.items) continue;
      for (const item of (section as any).items) {
        if (item.category === 'Other') {
          txs.push(...(item.transactions || []));
        }
      }
    }
    // Group by normalized merchant/description — user assigns one category per group
    const groups = new Map<string, { key: string; label: string; merchants: string[]; txs: TransactionDetail[]; total: number }>();
    for (const tx of txs) {
      const raw = tx.merchant || tx.description;
      const normalized = normalizeMerchant(raw);
      if (!groups.has(normalized)) groups.set(normalized, { key: normalized, label: raw, merchants: [], txs: [], total: 0 });
      const g = groups.get(normalized)!;
      if (!g.merchants.includes(raw)) g.merchants.push(raw);
      g.txs.push(tx);
      g.total += Math.abs(tx.amount);
    }
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [analysis]);

  const unresolvedTxCount = useMemo(
    () => unresolvedGroups.reduce((sum, g) => sum + g.txs.length, 0),
    [unresolvedGroups],
  );

  // Auto-suggest categories using Claude AI when modal opens
  useEffect(() => {
    if (!showCatReview || unresolvedGroups.length === 0) return;
    let cancelled = false;

    const fetchSuggestions = async () => {
      setAiSuggesting(true);
      try {
        const txList = unresolvedGroups.map((g) => ({
          description: g.label,
          amount: -(g.total / Math.max(g.txs.length, 1)),
        }));

        const res = await fetch('/api/claude', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'classify', transactions: txList }),
        });
        const data = await res.json();

        if (cancelled || !data.success || !data.classifications) return;

        const suggestions: Record<string, { category: string; isEssential: boolean }> = {};
        for (const cls of data.classifications) {
          const group = unresolvedGroups[cls.index];
          if (!group) continue;
          const category = mapClaudeCategory(cls.category);
          if (category === 'Other') continue;
          suggestions[group.key] = { category, isEssential: ESSENTIAL_CATS.has(category) };
        }
        setCatAssignments((prev) => {
          const merged = { ...suggestions };
          for (const [k, v] of Object.entries(prev)) merged[k] = v;
          return merged;
        });
      } catch (err) {
        console.warn('[home] AI suggest failed:', err);
      }
      if (!cancelled) setAiSuggesting(false);
    };

    fetchSuggestions();
    return () => { cancelled = true; };
  }, [showCatReview, unresolvedGroups.length]);

  const saveCatReview = async () => {
    const keys = Object.keys(catAssignments);
    if (keys.length === 0) { setShowCatReview(false); return; }
    setSavingCatReview(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');

      // Save overrides for each raw merchant name in the group
      for (const matchKey of keys) {
        const a = catAssignments[matchKey];
        const group = unresolvedGroups.find(g => g.key === matchKey);
        const merchantNames = group?.merchants || [matchKey];

        for (const name of merchantNames) {
          await supabase.from('transaction_overrides')
            .delete()
            .eq('user_id', user.id)
            .eq('match_description', name);
          const { error: insertErr } = await supabase.from('transaction_overrides').insert({
            user_id: user.id,
            match_description: name,
            category: a.category,
            is_essential: a.isEssential,
          });
          if (insertErr) throw new Error(`Failed to save ${name}: ${insertErr.message}`);
        }
      }

      // Optimistic UI: remove categorised transactions from "Other"
      if (analysis) {
        const updated = { ...analysis };
        // Build set of all raw merchant names covered by assigned groups
        const assignedMerchants = new Set<string>();
        for (const matchKey of keys) {
          const group = unresolvedGroups.find(g => g.key === matchKey);
          (group?.merchants || [matchKey]).forEach(m => assignedMerchants.add(m));
        }

        for (const sectionKey of ['discretionary', 'non_discretionary'] as const) {
          const section = { ...(updated as any)[sectionKey] };
          section.items = [...(section.items || [])];
          const otherIdx = section.items.findIndex((i: BudgetCategory) => i.category === 'Other');
          if (otherIdx >= 0) {
            const otherCat = { ...section.items[otherIdx] };
            otherCat.transactions = (otherCat.transactions || []).filter(
              (tx: TransactionDetail) => !assignedMerchants.has(tx.merchant || tx.description)
            );
            otherCat.txs = otherCat.transactions.length;
            if (otherCat.txs === 0) {
              section.items.splice(otherIdx, 1);
            } else {
              otherCat.monthly = otherCat.transactions.reduce(
                (s: number, tx: TransactionDetail) => s + Math.abs(tx.amount), 0
              );
              section.items[otherIdx] = otherCat;
            }
            section.total = section.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
          }
          (updated as any)[sectionKey] = section;
        }

        LayoutAnimation.configureNext(SMOOTH_ANIM);
        setAnalysis(updated);
      }

      setShowCatReview(false);
      setCatAssignments({});

      // Re-enrich in background so scores/moves update
      syncInBackground(user.id);
    } catch (err: any) {
      if (Platform.OS === 'web') {
        window.alert(err.message || 'Could not save categories');
      } else {
        Alert.alert('Error', err.message || 'Could not save categories');
      }
    }
    setSavingCatReview(false);
  };

  const saveRecategorize = async () => {
    if (!recatTx || !recatTarget) return;
    setSavingRecat(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Save override so future enrichment uses this category (delete-then-insert, no unique constraint)
        const matchDesc = recatTx.tx.merchant || recatTx.tx.description;
        await supabase.from('transaction_overrides')
          .delete()
          .eq('user_id', user.id)
          .eq('match_description', matchDesc);
        await supabase.from('transaction_overrides').insert({
          user_id: user.id,
          match_description: matchDesc,
          category: recatTarget,
          is_essential: recatEssential,
        });
      }

      // Optimistic UI update: move transaction between categories
      if (analysis) {
        const updated = { ...analysis };
        const fromKey = recatTx.section === 'essential' ? 'non_discretionary' : 'discretionary';
        const toKey = recatEssential ? 'non_discretionary' : 'discretionary';
        const fromSection = { ...(updated as any)[fromKey] };
        const toSection = fromKey === toKey ? fromSection : { ...(updated as any)[toKey] };
        fromSection.items = [...(fromSection.items || [])];
        if (fromKey !== toKey) toSection.items = [...(toSection.items || [])];

        // Remove tx from source category
        const srcCatIdx = fromSection.items.findIndex((i: BudgetCategory) => i.category === recatTx.catKey);
        if (srcCatIdx >= 0) {
          const srcCat = { ...fromSection.items[srcCatIdx] };
          const txAmt = Math.abs(recatTx.tx.amount);
          srcCat.transactions = (srcCat.transactions || []).filter(
            (t: TransactionDetail) => !(t.description === recatTx.tx.description && t.date === recatTx.tx.date && t.amount === recatTx.tx.amount)
          );
          srcCat.monthly = Math.max(0, srcCat.monthly - txAmt / Math.max(1, (analysis.monthly_spending || 1) / (srcCat.monthly || 1)));
          srcCat.txs = Math.max(0, srcCat.txs - 1);
          if (srcCat.txs === 0) fromSection.items.splice(srcCatIdx, 1);
          else fromSection.items[srcCatIdx] = srcCat;
        }

        // Add tx to target category
        const destCatIdx = toSection.items.findIndex((i: BudgetCategory) => i.category === recatTarget);
        const txAmt = Math.abs(recatTx.tx.amount);
        if (destCatIdx >= 0) {
          const destCat = { ...toSection.items[destCatIdx] };
          destCat.transactions = [...(destCat.transactions || []), recatTx.tx];
          destCat.monthly += txAmt;
          destCat.txs += 1;
          toSection.items[destCatIdx] = destCat;
        } else {
          toSection.items.push({ category: recatTarget, monthly: txAmt, txs: 1, transactions: [recatTx.tx] });
        }

        fromSection.total = fromSection.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
        if (fromKey !== toKey) toSection.total = toSection.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);

        (updated as any)[fromKey] = fromSection;
        if (fromKey !== toKey) (updated as any)[toKey] = toSection;

        LayoutAnimation.configureNext(SMOOTH_ANIM);
        setAnalysis(updated);
      }

      setRecatTx(null);
      setRecatTarget('');

      // Trigger background re-enrichment so score/moves reflect the correction
      if (user) {
        syncInBackground(user.id);
      }
    } catch (err: any) {
      console.warn('[home] Recategorize failed:', err?.message);
    }
    setSavingRecat(false);
  };

  const doRemoveIncomeSource = async (sourceName: string) => {
    setRemovingSource(sourceName);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Delete-then-insert (no unique constraint on table)
        await supabase.from('transaction_overrides')
          .delete()
          .eq('user_id', user.id)
          .eq('match_description', sourceName);
        await supabase.from('transaction_overrides').insert({
          user_id: user.id,
          match_description: sourceName,
          category: 'Transfers',
          is_essential: false,
        });
      }

      if (analysis) {
        const updated = { ...analysis };
        const sources = [...(updated.income_sources || [])];
        const removed = sources.find((s) => s.source === sourceName);
        updated.income_sources = sources.filter((s) => s.source !== sourceName);
        if (removed) {
          updated.monthly_income = Math.max(0, (updated.monthly_income || 0) - removed.monthly);
          updated.surplus = (updated.surplus || 0) - removed.monthly;
        }
        LayoutAnimation.configureNext(SMOOTH_ANIM);
        setAnalysis(updated);
      }
    } catch (err: any) {
      console.warn('[home] Remove income source failed:', err?.message);
    }
    setRemovingSource(null);
  };

  const handleDeleteMove = (move: Move) => {
    const doDelete = async () => {
      if (!analysis) return;
      const updatedMoves = (analysis.all_moves || []).filter(m => m.action !== move.action);
      const updated = { ...analysis, all_moves: updatedMoves };

      LayoutAnimation.configureNext(SMOOTH_ANIM);
      setAnalysis(updated);

      // Persist to Supabase
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: latest } = await supabase.from('analyses')
            .select('id')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();
          if (latest?.id) {
            await supabase.from('analyses')
              .update({ all_moves: updatedMoves })
              .eq('id', latest.id);
          }
        }
      } catch {}
    };

    if (Platform.OS === 'web') {
      const ok = window.confirm(`Delete "${stripMd(move.action)}"?\n\nThis recommendation will be permanently removed.`);
      if (ok) doDelete();
    } else {
      Alert.alert(
        'Delete recommendation?',
        `Remove "${stripMd(move.action)}" from your insights?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: doDelete },
        ],
      );
    }
  };

  const handleRemoveIncomeSource = (sourceName: string) => {
    if (Platform.OS === 'web') {
      // Alert.alert may not work reliably on web — use confirm
      const ok = window.confirm(
        `Remove "${sourceName}"?\n\nThis will no longer be counted as income. This affects your surplus and recommendations.`
      );
      if (ok) doRemoveIncomeSource(sourceName);
    } else {
      Alert.alert(
        'Remove income source?',
        `"${sourceName}" will no longer be counted as income. This affects your surplus and recommendations.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => doRemoveIncomeSource(sourceName) },
        ],
      );
    }
  };

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [])
  );

  // Merge budget adjustments into an analysis object
  const mergeAdjustments = (base: Analysis, adjustments: any[]): Analysis => {
    if (!adjustments.length) return base;

    const updated = { ...base };
    const nonDisc = { ...((updated.non_discretionary as any) || { total: 0, items: [] }) };
    const disc = { ...((updated.discretionary as any) || { total: 0, items: [] }) };
    nonDisc.items = [...(nonDisc.items || [])];
    disc.items = [...(disc.items || [])];

    for (const adj of adjustments) {
      const section = adj.is_essential ? nonDisc : disc;
      const existingIdx = section.items.findIndex((i: BudgetCategory) => i.category === adj.category);
      const newTx = {
        date: new Date().toISOString().split('T')[0],
        merchant: adj.description,
        description: adj.description + ' (manual)',
        amount: -Math.abs(adj.monthly_amount),
      };

      if (existingIdx >= 0) {
        const existing = { ...section.items[existingIdx] };
        existing.monthly += adj.monthly_amount;
        existing.txs += 1;
        existing.transactions = [...(existing.transactions || []), newTx];
        section.items[existingIdx] = existing;
      } else {
        section.items.push({
          category: adj.category,
          monthly: adj.monthly_amount,
          txs: 1,
          transactions: [newTx],
        });
      }
      section.total = section.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
    }

    const totalManual = adjustments.reduce((s: number, a: any) => s + a.monthly_amount, 0);
    updated.non_discretionary = nonDisc;
    updated.discretionary = disc;
    updated.monthly_spending = (updated.monthly_spending || 0) + totalManual;
    updated.surplus = (updated.surplus || 0) - totalManual;
    return updated;
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      setUserName(user.user_metadata?.full_name?.split(' ')[0] || '');

      // ── Record daily streak ──
      try {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const { data: streak } = await supabase
          .from('user_streaks')
          .select('current_streak, longest_streak, last_active_date, total_active_days')
          .eq('user_id', user.id)
          .single();

        if (streak) {
          if (streak.last_active_date !== today) {
            const lastDate = new Date(streak.last_active_date);
            const todayDate = new Date(today);
            const diffDays = Math.floor((todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));

            const newStreak = diffDays === 1 ? streak.current_streak + 1 : 1;
            const newLongest = Math.max(streak.longest_streak, newStreak);

            await supabase.from('user_streaks').update({
              current_streak: newStreak,
              longest_streak: newLongest,
              last_active_date: today,
              total_active_days: streak.total_active_days + 1,
              updated_at: new Date().toISOString(),
            }).eq('user_id', user.id);
          }
        } else {
          await supabase.from('user_streaks').insert({
            user_id: user.id,
            current_streak: 1,
            longest_streak: 1,
            last_active_date: today,
            total_active_days: 1,
          });
        }
      } catch {}

      // Fetch budget adjustments + debt accounts
      let adjustments: any[] = [];
      try {
        const [adjRes, debtRes] = await Promise.all([
          supabase
            .from('budget_adjustments')
            .select('description, category, monthly_amount, is_essential')
            .eq('user_id', user.id),
          supabase
            .from('debt_accounts')
            .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, last_updated, source')
            .eq('user_id', user.id),
        ]);
        if (adjRes.data) adjustments = adjRes.data;
        if (debtRes.data) setDebtAccounts(debtRes.data);
      } catch {}

      // Use the latest in-memory result from processing if available.
      const lastResult = getLastResult();
      if (lastResult) {
        setAnalysis(mergeAdjustments(lastResult, adjustments));
        setLoading(false);
        // Still trigger background sync for fresh data
        syncInBackground(user.id);
        return;
      }

      const { data, error } = await supabase
        .from('analyses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error) {
        console.warn('[home] Failed to fetch analysis:', error.message);
      }

      setAnalysis(data ? mergeAdjustments(data, adjustments) : null);

      // Trigger background sync if user has an existing analysis
      if (data) {
        syncInBackground(user.id);
      }
    } catch (err: any) {
      console.warn('[home] loadData error:', err?.message);
      setAnalysis(null);
    }
    setLoading(false);
  };

  // Background sync: refresh bank data via TrueLayer and re-run analysis
  const syncInBackground = async (userId: string) => {
    try {
      setSyncing(true);

      const result = await syncBankData(userId);
      if (!result) { setSyncing(false); return; }

      // Update debt accounts: merge synced with any manual debts
      try {
        const { data: allDebt } = await supabase
          .from('debt_accounts')
          .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, last_updated, source')
          .eq('user_id', userId);
        if (allDebt) setDebtAccounts(allDebt);
      } catch {
        if (result.debtAccounts.length > 0) setDebtAccounts(result.debtAccounts);
      }

      // Update adaptive weekly context
      if (result.weeklyContext) setWeeklyCtx(result.weeklyContext);

      // Re-fetch budget adjustments and apply for display
      let budgetAdjustments: any[] = [];
      try {
        const { data: freshAdj } = await supabase
          .from('budget_adjustments')
          .select('description, category, monthly_amount, is_essential')
          .eq('user_id', userId);
        if (freshAdj) budgetAdjustments = freshAdj;
      } catch {}

      setAnalysis(mergeAdjustments(result.analysis, budgetAdjustments));
    } catch (err: any) {
      console.warn('[home] Background sync failed:', err?.message);
    }
    setSyncing(false);
  };

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // ── Derived data ──
  const moves = analysis?.all_moves ?? [];
  const income = analysis?.monthly_income ?? 0;
  const incomeSources = analysis?.income_sources ?? [];

  // Only show high + medium effort moves on dashboard; low effort → plan page only
  // Sort: high effort first, then medium
  const highEffortMoves = moves.filter((m: Move) => m.effort === 'high');
  const mediumEffortMoves = moves.filter((m: Move) => m.effort === 'medium');
  const dashboardMoves = [...highEffortMoves, ...mediumEffortMoves];

  // Primary income source only
  const primaryIncome = incomeSources.find((s: IncomeSource) => s.isSalary)
    || (incomeSources.length > 0
      ? incomeSources.reduce((a, b) => a.avgAmount > b.avgAmount ? a : b)
      : null);

  const nonDisc = analysis?.non_discretionary as any;
  const disc = analysis?.discretionary as any;
  const nonDiscTotal = nonDisc?.total ?? 0;
  const discTotal = disc?.total ?? 0;
  const nonDiscItems: BudgetCategory[] = nonDisc?.items ?? [];
  const discItems: BudgetCategory[] = disc?.items ?? [];
  const leftToDecide = Math.max(0, income - nonDiscTotal - discTotal);

  // Bar segment proportions
  const barTotal = nonDiscTotal + discTotal + leftToDecide || 1;
  const nonDiscFlex = nonDiscTotal / barTotal;
  const discFlex = discTotal / barTotal;
  const leftFlex = leftToDecide / barTotal;

  // Percentages of income — use largest-remainder method so they always sum to 100%
  const [nonDiscPct, discPct, leftPct] = (() => {
    if (income <= 0) return [0, 0, 0];
    const rawPcts = [
      (nonDiscTotal / income) * 100,
      (discTotal / income) * 100,
      (leftToDecide / income) * 100,
    ];
    const floored = rawPcts.map(Math.floor);
    const remainders = rawPcts.map((r, i) => r - floored[i]);
    let gap = 100 - floored.reduce((a, b) => a + b, 0);
    const indices = [0, 1, 2].sort((a, b) => remainders[b] - remainders[a]);
    for (const idx of indices) {
      if (gap <= 0) break;
      floored[idx]++;
      gap--;
    }
    return floored as [number, number, number];
  })();

  // ── Safe-to-spend weekly calculation ──
  // Use adaptive budget from sync if available (accounts for committed payments
  // like rent/transfers that already consumed part of this period's income)
  const staticWeeklyBudget = leftToDecide / 4.33;
  const weeklyBudget = weeklyCtx?.adaptiveBudget ?? staticWeeklyBudget;

  // Get start of current week (Monday)
  const getWeekStart = () => {
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    monday.setHours(0, 0, 0, 0);
    return monday;
  };

  const weekStart = getWeekStart();
  const allDiscTxs: TransactionDetail[] = discItems.flatMap(
    (item: BudgetCategory) => item.transactions ?? []
  );
  const spentThisWeek = allDiscTxs
    .filter((tx) => new Date(tx.date) >= weekStart)
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

  const weeklyRemaining = Math.max(0, weeklyBudget - spentThisWeek);
  const weeklyUsedPct = weeklyBudget > 0
    ? Math.min(100, Math.round((spentThisWeek / weeklyBudget) * 100))
    : 0;
  const weeklyHealthy = spentThisWeek <= weeklyBudget;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.scroll}>
      {/* ── Header with Bocy ── */}
      <View style={s.headerRow}>
        <View style={s.headerLeft}>
          <View style={s.bocyHeaderWrap}>
            <BocyFace mood={getBocyMood(analysis)} size="sm" breathing />
          </View>
          <View>
            <Text style={s.greeting}>
              Hello, {userName || 'there'}
            </Text>
            {syncing && (
              <Text style={s.syncText}>Syncing latest transactions...</Text>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={s.menuButton}
          onPress={() => router.push('/(main)/profile')}
        >
          <View style={s.menuLine} />
          <View style={[s.menuLine, s.menuLineShort]} />
          <View style={s.menuLine} />
        </TouchableOpacity>
      </View>

      {!analysis ? (
        /* ── Empty State ── */
        <View style={s.emptyState}>
          <View style={s.emptyBocyWrap}>
            <BocyFace mood="neutral" size="lg" breathing />
          </View>
          <Text style={s.emptyTitle}>Your #1 financial move awaits</Text>
          <Text style={s.emptyDesc}>
            Connect your bank account so Bocy can analyse your transactions and find the most impactful action you can take right now.
          </Text>
          <TouchableOpacity
            style={s.ctaButton}
            onPress={() => router.push('/(main)/connect')}
          >
            <Text style={s.ctaText}>Connect your bank</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── Unresolved transactions nudge ── */}
          {unresolvedTxCount > 0 && (
            <TouchableOpacity
              style={s.reviewBanner}
              onPress={() => { setCatAssignments({}); setShowCatReview(true); }}
              activeOpacity={0.7}
            >
              <Text style={s.reviewBannerText}>
                {unresolvedTxCount} transaction{unresolvedTxCount !== 1 ? 's' : ''} couldn't be categorised.{' '}
                <Text style={s.reviewBannerLink}>Tell me what they are</Text>
              </Text>
            </TouchableOpacity>
          )}

          {/* ── Income arrival alert ── */}
          {weeklyCtx?.incomeArrivedThisWeek && weeklyCtx.recentIncomeEvents.length > 0 && (
            <AnimGlyph delay={0}>
              <View style={s.incomeAlert}>
                <Text style={s.incomeAlertTitle}>Income received</Text>
                <Text style={s.incomeAlertText}>
                  {weeklyCtx.recentIncomeEvents.map((e) =>
                    `\u00a3${Math.round(e.amount).toLocaleString()} from ${e.source}`
                  ).join(', ')}
                  {' '}landed this week.
                  {weeklyCtx.committedThisWeek > 0
                    ? ` \u00a3${Math.round(weeklyCtx.committedThisWeek).toLocaleString()} already committed to bills & essentials.`
                    : ''}
                </Text>
                <Text style={s.incomeAlertBudget}>
                  Adaptive safe-to-spend: {'\u00a3'}{Math.round(weeklyCtx.adaptiveBudget).toLocaleString()}/week
                </Text>
              </View>
            </AnimGlyph>
          )}

          {/* ══════════════════════════════════════════════
              CARD 1 — YOUR INSIGHTS
              ══════════════════════════════════════════════ */}
          <View style={s.card}>
            <AnimGlyph delay={0}>
              <Text style={s.cardTitle}>Your Insights</Text>
            </AnimGlyph>

            {dashboardMoves.length > 0 ? dashboardMoves.slice(0, 2).map((move: Move, i: number) => {
              const effortClr = move.effort === 'high' ? colors.green
                : move.effort === 'medium' ? colors.dim : colors.lavender;
              return (
                <AnimGlyph key={i} delay={i * 120}>
                  <View
                    accessibilityRole="summary"
                    accessibilityLabel={`Insight: ${move.action}, saves ${move.annualImpact} pounds per year`}
                    style={s.moveItemFull}
                  >
                    <Text style={s.moveTitle}>
                      {stripMd(move.action)}
                    </Text>

                    {/* Impact + effort on one line */}
                    <View style={s.moveMeta}>
                      <Text style={s.moveImpact}>
                        +{'\u00a3'}{(move.annualImpact || 0).toLocaleString()}/yr
                      </Text>
                      {move.effort && (
                        <View style={[s.effortPill, { borderColor: effortClr + '40' }]}>
                          <Text style={[s.effortPillText, { color: effortClr }]}>
                            {move.effort}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Action buttons */}
                    <View style={s.moveActions}>
                      <TouchableOpacity
                        style={s.moveApproveBtn}
                        onPress={() => router.push({ pathname: '/(main)/(tabs)/plan', params: { highlight: String(i) } })}
                      >
                        <Text style={s.moveApproveBtnText}>View</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={s.moveDeleteBtn}
                        onPress={() => handleDeleteMove(move)}
                      >
                        <Text style={s.moveDeleteBtnText}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </AnimGlyph>
              );
            }) : (
              <Text style={s.noDataText}>
                No actionable insights yet. Upload a statement to get started.
              </Text>
            )}

            {dashboardMoves.length > 2 && (
              <TouchableOpacity
                style={s.viewAllBtn}
                onPress={() => router.push('/(main)/(tabs)/plan')}
                activeOpacity={0.7}
              >
                <Text style={[s.viewAllText, { color: colors.green }]}>
                  View plan {'\u203A'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 2 — YOUR INCOME
              ══════════════════════════════════════════════ */}
          <View style={s.card} accessibilityRole="summary" accessibilityLabel={`Monthly income: ${Math.round(income)} pounds`}>
            <AnimGlyph delay={50}>
              <View style={s.cardTitleRow}>
                <Text style={s.cardTitle}>Your income</Text>
                <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'income' ? null : 'income')}>
                  <Text style={s.infoIcon}>i</Text>
                </TouchableOpacity>
              </View>
            </AnimGlyph>
            {infoCard === 'income' && (
              <View style={s.infoBox}>
                <Text style={s.infoBoxText}>
                  Income is detected from your bank account transactions only (not credit cards). Regular credits matching salary, benefit, or employer patterns are identified. Remove any that aren't real income.
                </Text>
              </View>
            )}

            <AnimGlyph delay={100}>
              <View style={s.bigNumberWrap}>
                <Text style={s.bigNumber} accessibilityRole="text">
                  {'\u00a3'}{Math.round(income).toLocaleString()}
                </Text>
                <Text style={s.bigNumberLabel}>monthly</Text>
              </View>
            </AnimGlyph>

            {incomeSources.length > 0 ? (
              <>
                <View style={s.divider} />
                <Text style={s.incomeSourcesHeader}>
                  {incomeSources.length} source{incomeSources.length !== 1 ? 's' : ''}
                </Text>
                {incomeSources.map((src: IncomeSource, i: number) => (
                  <AnimGlyph key={i} delay={150 + i * 80}>
                    <View style={s.sourceCard}>
                      <View style={s.sourceRow}>
                        <View style={s.sourceInfo}>
                          <Text style={s.sourceName}>{src.source}</Text>
                          <View style={s.sourceTagRow}>
                            <Text style={s.sourceFreq}>
                              {src.frequency.charAt(0).toUpperCase() + src.frequency.slice(1)}
                            </Text>
                            {src.isSalary && (
                              <View style={[s.primaryTag, { backgroundColor: colors.greenDim, borderColor: colors.green + '30' }]}>
                                <Text style={[s.primaryTagText, { color: colors.green }]}>PRIMARY</Text>
                              </View>
                            )}
                        </View>
                      </View>
                      <View style={s.sourceAmountWrap}>
                        <Text style={s.sourceAmount}>
                          {'\u00a3'}{Math.round(src.avgAmount).toLocaleString()}
                        </Text>
                        <Text style={s.sourceAmountPer}>
                          per {src.frequency === 'weekly' ? 'week' : src.frequency === 'fortnightly' ? 'fortnight' : 'month'}
                        </Text>
                      </View>
                    </View>
                    {/* Remove non-income */}
                    <TouchableOpacity
                      style={s.removeSourceBtn}
                      onPress={() => handleRemoveIncomeSource(src.source)}
                      disabled={removingSource === src.source}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      activeOpacity={0.6}
                    >
                      <Text style={s.removeSourceText}>
                        {removingSource === src.source ? 'Removing...' : 'Not income? Remove'}
                      </Text>
                    </TouchableOpacity>
                    </View>
                  </AnimGlyph>
                ))}
              </>
            ) : (
              <Text style={s.noDataText}>No income sources detected from bank accounts.</Text>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 3 — SAFE TO SPEND
              ══════════════════════════════════════════════ */}
          <View style={s.card}>
            <AnimGlyph delay={100}>
              <View style={s.cardTitleRow}>
                <Text style={s.cardTitle}>Safe to spend</Text>
                <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'safe' ? null : 'safe')}>
                  <Text style={s.infoIcon}>i</Text>
                </TouchableOpacity>
              </View>
            </AnimGlyph>
            {infoCard === 'safe' && (
              <View style={s.infoBox}>
                <Text style={s.infoBoxText}>
                  This is your weekly lifestyle budget: (Monthly income - Essentials) / 4.33, minus what you've already spent on lifestyle this month. It tells you how much discretionary spending you can still afford this week.
                </Text>
              </View>
            )}
            <Text style={s.cardSubtitle}>Your weekly lifestyle allowance</Text>

            {/* Big remaining number */}
            <AnimGlyph delay={150}>
              <View style={s.safeToSpendHero}>
                <Text style={[s.safeToSpendAmount, !weeklyHealthy && { color: colors.coral }]}>
                  {'\u00a3'}{Math.round(weeklyRemaining).toLocaleString()}
                </Text>
                <Text style={s.safeToSpendLabel}>left this week</Text>
              </View>
            </AnimGlyph>

            {/* Progress bar with breathing animation */}
            <View style={s.safeToSpendBar}>
              <BreathingBar
                color={weeklyHealthy ? colors.green : colors.coral}
                width={`${weeklyUsedPct}%`}
                style={s.safeToSpendBarFill}
              />
            </View>

            {/* Spent vs budget row */}
            <View style={s.safeToSpendRow}>
              <View>
                <Text style={s.safeToSpendMeta}>
                  {'\u00a3'}{Math.round(spentThisWeek).toLocaleString()} spent
                </Text>
              </View>
              <View>
                <Text style={s.safeToSpendMeta}>
                  {'\u00a3'}{Math.round(weeklyBudget).toLocaleString()} budget
                </Text>
              </View>
            </View>
          </View>

          {/* ══════════════════════════════════════════════
              CARD 4 — YOUR BUDGET REALITY
              ══════════════════════════════════════════════ */}
          <View style={s.card}>
            {/* Info icon for budget card */}
            <View style={s.cardTitleRow}>
              <View style={{ flex: 1 }} />
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'budget' ? null : 'budget')}>
                <Text style={s.infoIcon}>i</Text>
              </TouchableOpacity>
            </View>
            {infoCard === 'budget' && (
              <View style={s.infoBox}>
                <Text style={s.infoBoxText}>
                  Your spending is split into Essentials (rent, bills, groceries) and Lifestyle (dining, shopping, entertainment). Categories are determined by transaction enrichment and merchant matching. You can re-categorize any transaction by tapping it.
                </Text>
              </View>
            )}

            {/* Header */}
            <View style={s.budgetHeaderRow}>
              <Text style={s.cardTitle}>Your budget reality</Text>
            </View>

            {/* 3-segment stacked bar — monochrome */}
            <View style={s.budgetBar}>
              {nonDiscFlex > 0 && (
                <View style={[s.barSeg, { flex: nonDiscFlex, backgroundColor: colors.accent }]} />
              )}
              {discFlex > 0 && (
                <View style={[s.barSeg, { flex: discFlex, backgroundColor: colors.lavender }]} />
              )}
              {leftFlex > 0 && (
                <View style={[s.barSeg, { flex: leftFlex, backgroundColor: colors.green + '30' }]} />
              )}
            </View>

            {/* Summary row — always visible */}
            <View style={[s.summaryRow, !budgetExpanded && { marginBottom: 0 }]}>
              <AnimGlyph delay={80} style={s.summaryItem}>
                <Text style={[s.summaryAmount, { color: colors.accent }]}>
                  {'\u00a3'}{Math.round(nonDiscTotal).toLocaleString()}
                </Text>
                <Text style={s.summaryLabel}>Essentials</Text>
                <Text style={s.summaryPct}>{nonDiscPct}%</Text>
              </AnimGlyph>
              <AnimGlyph delay={160} style={s.summaryItem}>
                <Text style={[s.summaryAmount, { color: colors.lavender }]}>
                  {'\u00a3'}{Math.round(discTotal).toLocaleString()}
                </Text>
                <Text style={s.summaryLabel}>Lifestyle</Text>
                <Text style={s.summaryPct}>{discPct}%</Text>
              </AnimGlyph>
              <AnimGlyph delay={240} style={s.summaryItem}>
                <Text style={[s.summaryAmount, { color: colors.green }]}>
                  {'\u00a3'}{Math.round(leftToDecide).toLocaleString()}
                </Text>
                <Text style={s.summaryLabel}>Left to decide</Text>
                <Text style={[s.summaryPct, { color: colors.green }]}>{leftPct}%</Text>
              </AnimGlyph>
            </View>

            {/* Collapsible breakdown sections */}
            {budgetExpanded && (
              <>
                {/* Non-negotiable breakdown */}
                  <>
                    <View style={s.breakdownHeaderRow}>
                      <Text style={s.breakdownHeader}>ESSENTIALS</Text>
                      <TouchableOpacity
                        style={s.addItemBtn}
                        onPress={() => {
                          LayoutAnimation.configureNext(SMOOTH_ANIM);
                          setAddItemEssential(true);
                          setAddItemError('');
                          setShowAddItem(true);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={[s.addItemLabel, { color: colors.green }]}>Add item</Text>
                        <Text style={[s.addItemIcon, { color: colors.green, borderColor: colors.green + '40' }]}>+</Text>
                      </TouchableOpacity>
                    </View>
                    {nonDiscItems.length === 0 && (
                      <Text style={s.noDataText}>No essential items yet. Add one to track it.</Text>
                    )}
                    {nonDiscItems.map((item: BudgetCategory, i: number) => {
                      const key = `nd-${item.category}`;
                      const isExpanded = expandedCategories.has(key);
                      const txs: TransactionDetail[] = (item.transactions ?? []).filter(tx => isCurrentMonth(tx.date));
                      const pctOfSection = nonDiscTotal > 0 ? Math.round((item.monthly / nonDiscTotal) * 100) : 0;
                      return (
                        <View key={i}>
                          <TouchableOpacity
                            activeOpacity={0.7}
                            onPress={() => toggleCategory(key)}
                            style={[s.dataRow, i === nonDiscItems.length - 1 && !isExpanded && s.dataRowLast]}
                          >
                            <View style={s.dataRowLeft}>
                              <Text style={[s.catArrow, { color: colors.text }]}>{isExpanded ? '\u25BC' : '\u25B6'}</Text>
                              <View style={s.catInfo}>
                                <Text style={s.dataLabel}>{item.category}</Text>
                                <Text style={s.dataMeta}>
                                  {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of essentials
                                </Text>
                              </View>
                            </View>
                            <View style={s.dataRowRight}>
                              <Text style={[s.dataValue, { color: colors.text }]}>
                                {'\u00a3'}{Math.round(item.monthly).toLocaleString()}
                              </Text>
                            </View>
                          </TouchableOpacity>
                          {isExpanded && txs.length > 0 && (
                            <View style={s.txDropdown}>
                              {txs.map((tx, j) => (
                                <TouchableOpacity
                                  key={j}
                                  style={[s.txRow, j === txs.length - 1 && s.txRowLast]}
                                  onLongPress={() => {
                                    setRecatTx({ tx, catKey: item.category, section: 'essential' });
                                    setRecatTarget('');
                                    setRecatEssential(true);
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <View style={s.txLeft}>
                                    <Text style={s.txMerchant}>{tx.merchant}</Text>
                                    <Text style={s.txDate}>{formatDate(tx.date)}</Text>
                                  </View>
                                  <View style={s.txRightCol}>
                                    <Text style={[s.txAmount, { color: colors.text2 }]}>
                                      {'\u00a3'}{Math.abs(tx.amount).toFixed(2)}
                                    </Text>
                                    <Text style={s.txRecatHint}>Hold to move</Text>
                                  </View>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                          {isExpanded && txs.length === 0 && (
                            <View style={s.txDropdown}>
                              <Text style={s.txEmpty}>No transaction details available</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </>

                {/* Lifestyle spending */}
                  <>
                    <View style={[s.breakdownHeaderRow, { marginTop: 28 }]}>
                      <Text style={s.breakdownHeader}>LIFESTYLE</Text>
                      <TouchableOpacity
                        style={s.addItemBtn}
                        onPress={() => {
                          LayoutAnimation.configureNext(SMOOTH_ANIM);
                          setAddItemEssential(false);
                          setAddItemError('');
                          setShowAddItem(true);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={[s.addItemLabel, { color: colors.green }]}>Add item</Text>
                        <Text style={[s.addItemIcon, { color: colors.green, borderColor: colors.green + '40' }]}>+</Text>
                      </TouchableOpacity>
                    </View>
                    {discItems.length === 0 && (
                      <Text style={s.noDataText}>No lifestyle items yet. Add one to track it.</Text>
                    )}
                    {discItems.map((item: BudgetCategory, i: number) => {
                      const key = `d-${item.category}`;
                      const isExpanded = expandedCategories.has(key);
                      const txs: TransactionDetail[] = (item.transactions ?? []).filter(tx => isCurrentMonth(tx.date));
                      const pctOfSection = discTotal > 0 ? Math.round((item.monthly / discTotal) * 100) : 0;
                      return (
                        <View key={i}>
                          <TouchableOpacity
                            activeOpacity={0.7}
                            onPress={() => toggleCategory(key)}
                            style={[s.dataRow, i === discItems.length - 1 && !isExpanded && s.dataRowLast]}
                          >
                            <View style={s.dataRowLeft}>
                              <Text style={[s.catArrow, { color: colors.dim }]}>{isExpanded ? '\u25BC' : '\u25B6'}</Text>
                              <View style={s.catInfo}>
                                <Text style={s.dataLabel}>{item.category}</Text>
                                <Text style={s.dataMeta}>
                                  {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of lifestyle
                                </Text>
                              </View>
                            </View>
                            <View style={s.dataRowRight}>
                              <Text style={[s.dataValue, { color: colors.dim }]}>
                                {'\u00a3'}{Math.round(item.monthly).toLocaleString()}
                              </Text>
                            </View>
                          </TouchableOpacity>
                          {isExpanded && txs.length > 0 && (
                            <View style={s.txDropdown}>
                              {txs.map((tx, j) => (
                                <TouchableOpacity
                                  key={j}
                                  style={[s.txRow, j === txs.length - 1 && s.txRowLast]}
                                  onLongPress={() => {
                                    setRecatTx({ tx, catKey: item.category, section: 'lifestyle' });
                                    setRecatTarget('');
                                    setRecatEssential(false);
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <View style={s.txLeft}>
                                    <Text style={s.txMerchant}>{tx.merchant}</Text>
                                    <Text style={s.txDate}>{formatDate(tx.date)}</Text>
                                  </View>
                                  <View style={s.txRightCol}>
                                    <Text style={[s.txAmount, { color: colors.dim }]}>
                                      {'\u00a3'}{Math.abs(tx.amount).toFixed(2)}
                                    </Text>
                                    <Text style={s.txRecatHint}>Hold to move</Text>
                                  </View>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                          {isExpanded && txs.length === 0 && (
                            <View style={s.txDropdown}>
                              <Text style={s.txEmpty}>No transaction details available</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </>

                <Text style={s.cardFooter}>Tap any category to expand transactions</Text>

                <TouchableOpacity
                  onPress={() => {
                    LayoutAnimation.configureNext(SMOOTH_ANIM);
                    setBudgetExpanded(false);
                  }}
                  style={s.viewTransactionsBtn}
                >
                  <Text style={s.viewTransactionsText}>Hide transactions</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Quick add buttons — always visible when collapsed */}
            {!budgetExpanded && (
              <View style={s.quickAddRow}>
                <TouchableOpacity
                  style={s.quickAddBtn}
                  onPress={() => {
                    LayoutAnimation.configureNext(SMOOTH_ANIM);
                    setAddItemEssential(true);
                    setAddItemError('');
                    setAddItemDesc('');
                    setAddItemAmount('');
                    setAddItemCategory('');
                    setShowAddItem(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={s.quickAddIcon}>+</Text>
                  <Text style={s.quickAddText}>Add essential</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.quickAddBtn}
                  onPress={() => {
                    LayoutAnimation.configureNext(SMOOTH_ANIM);
                    setAddItemEssential(false);
                    setAddItemError('');
                    setAddItemDesc('');
                    setAddItemAmount('');
                    setAddItemCategory('');
                    setShowAddItem(true);
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={s.quickAddIcon}>+</Text>
                  <Text style={s.quickAddText}>Add lifestyle</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* View transactions button */}
            {!budgetExpanded && (
              <TouchableOpacity
                onPress={() => {
                  LayoutAnimation.configureNext(SMOOTH_ANIM);
                  setBudgetExpanded(true);
                }}
                style={s.viewTransactionsBtn}
              >
                <Text style={s.viewTransactionsText}>View transactions</Text>
              </TouchableOpacity>
            )}

          </View>

          {/* ══════════════════════════════════════════════
              CARD 5 — DEBT ACCOUNTS
              ══════════════════════════════════════════════ */}
          {debtAccounts.length > 0 && (() => {
            const totalDebt = debtAccounts.reduce((s: number, d: any) => s + (d.outstanding_balance || 0), 0);
            const totalLimit = debtAccounts.reduce((s: number, d: any) => s + (d.credit_limit || 0), 0);
            const overallUtil = totalLimit > 0 ? Math.round((totalDebt / totalLimit) * 100) : null;
            return (
              <View style={s.card}>
                <AnimGlyph delay={50}>
                  <View style={s.cardTitleRow}>
                    <Text style={s.cardTitle}>Your debt</Text>
                    <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'debt' ? null : 'debt')}>
                      <Text style={s.infoIcon}>i</Text>
                    </TouchableOpacity>
                  </View>
                </AnimGlyph>
                {infoCard === 'debt' && (
                  <View style={s.infoBox}>
                    <Text style={s.infoBoxText}>
                      Debt balances are pulled from your connected accounts via Open Banking, or added manually in your profile. Utilisation shows how much of your credit limit is currently used. Over 75% utilisation can affect your credit score.
                    </Text>
                  </View>
                )}
                <Text style={s.cardSubtitle}>
                  {debtAccounts.length} account{debtAccounts.length !== 1 ? 's' : ''}
                  {overallUtil != null ? ` · ${overallUtil}% utilised` : ''}
                </Text>

                {/* Total debt hero */}
                <AnimGlyph delay={100}>
                  <View style={s.debtHero}>
                    <Text style={s.debtHeroAmount}>
                      {'\u00a3'}{Math.round(totalDebt).toLocaleString()}
                    </Text>
                    <Text style={s.debtHeroLabel}>total outstanding</Text>
                  </View>
                </AnimGlyph>

                {/* Individual accounts */}
                {debtAccounts.map((d: any, i: number) => {
                  const bal = d.outstanding_balance || 0;
                  const lim = d.credit_limit || 0;
                  const util = lim > 0 ? Math.round((bal / lim) * 100) : null;
                  const isHigh = util != null && util > 75;
                  const typeLabel = d.account_type === 'credit_card' ? 'Credit card'
                    : d.account_type === 'overdraft' ? 'Overdraft'
                    : d.account_type === 'overdraft_facility' ? 'Overdraft facility'
                    : d.account_type === 'personal_loan' ? 'Personal loan'
                    : d.account_type === 'student_loan' ? 'Student loan'
                    : d.account_type === 'car_finance' ? 'Car finance'
                    : d.account_type === 'bnpl' ? 'BNPL'
                    : d.account_type || 'Account';
                  return (
                    <AnimGlyph key={i} delay={150 + i * 80}>
                      <View
                        style={[s.debtRow, i === debtAccounts.length - 1 && s.debtRowLast]}
                      >
                      <View style={s.debtRowLeft}>
                        <Text style={s.debtName}>{d.account_name}</Text>
                        <Text style={s.debtType}>{typeLabel}</Text>
                      </View>
                      <View style={s.debtRowRight}>
                        <Text style={[s.debtBalance, isHigh && { color: colors.coral }]}>
                          {'\u00a3'}{Math.round(bal).toLocaleString()}
                        </Text>
                        {lim > 0 && (
                          <Text style={[s.debtUtil, isHigh && { color: colors.coral }]}>
                            / {'\u00a3'}{Math.round(lim).toLocaleString()} ({util}%)
                          </Text>
                        )}
                      </View>
                      </View>
                    </AnimGlyph>
                  );
                })}
              </View>
            );
          })()}

          {/* Add budget item modal */}
          <Modal visible={showAddItem} transparent animationType="fade" onRequestClose={() => { setAddItemError(''); setShowAddItem(false); }}>
            <Pressable style={s.modalOverlay} onPress={() => { setAddItemError(''); setShowAddItem(false); }}>
              <Pressable style={s.modalContent} onPress={() => {}}>
                <View style={s.modalHeader}>
                  <Text style={s.modalTitle}>Add budget item</Text>
                  <TouchableOpacity style={s.modalCloseIcon} onPress={() => { setAddItemError(''); setShowAddItem(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={s.modalCloseIconText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={s.modalSubtitle}>
                  For expenses not in your bank data (rent via partner, cash, etc.)
                </Text>

                <TextInput
                  style={s.modalInput}
                  placeholder="Description (e.g. Rent)"
                  placeholderTextColor={colors.muted}
                  value={addItemDesc}
                  onChangeText={setAddItemDesc}
                />

                <TextInput
                  style={s.modalInput}
                  placeholder="Monthly amount"
                  placeholderTextColor={colors.muted}
                  keyboardType="numeric"
                  value={addItemAmount}
                  onChangeText={setAddItemAmount}
                />

                {/* Category picker */}
                <Text style={s.modalLabel}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.categoryScroll}>
                  {BUDGET_CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[s.categoryChip, addItemCategory === cat && s.categoryChipActive]}
                      onPress={() => setAddItemCategory(cat)}
                    >
                      <Text style={[s.categoryChipText, addItemCategory === cat && s.categoryChipTextActive]}>
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* Essential toggle */}
                <View style={s.essentialRow}>
                  <Text style={s.modalLabel}>Type</Text>
                  <View style={s.toggleRow}>
                    <TouchableOpacity
                      style={[s.toggleOption, addItemEssential && s.toggleOptionActive]}
                      onPress={() => setAddItemEssential(true)}
                    >
                      <Text style={[s.toggleText, addItemEssential && s.toggleTextActive]}>Essential</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.toggleOption, !addItemEssential && s.toggleOptionLifestyle]}
                      onPress={() => setAddItemEssential(false)}
                    >
                      <Text style={[s.toggleText, !addItemEssential && s.toggleTextLifestyle]}>Lifestyle</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Error message */}
                {addItemError ? (
                  <Text style={s.addItemErrorText}>{addItemError}</Text>
                ) : null}

                {/* Actions */}
                <View style={s.modalActions}>
                  <TouchableOpacity
                    style={s.modalCancel}
                    onPress={() => { setAddItemError(''); setShowAddItem(false); }}
                  >
                    <Text style={s.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      s.modalSave,
                      (!addItemDesc.trim() || !addItemCategory || !addItemAmount) && s.modalSaveDisabled,
                    ]}
                    onPress={saveAddItem}
                    disabled={addItemSaving}
                  >
                    {addItemSaving ? (
                      <ActivityIndicator color={colors.bg} size="small" />
                    ) : (
                      <Text style={s.modalSaveText}>Add</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Verify move detail modal */}
          <Modal visible={!!verifyMove} transparent animationType="fade" onRequestClose={() => setVerifyMove(null)}>
            <Pressable style={s.modalOverlay} onPress={() => setVerifyMove(null)}>
              <Pressable style={s.modalContentScrollable} onPress={() => {}}>
                <View style={s.modalHeader}>
                  <Text style={s.modalTitle}>Verify recommendation</Text>
                  <TouchableOpacity style={s.modalCloseIcon} onPress={() => setVerifyMove(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={s.modalCloseIconText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView showsVerticalScrollIndicator={false} bounces={false} contentContainerStyle={{ paddingBottom: 8 }}>

                  {verifyMove && (
                    <>
                      <Text style={s.verifySection}>WHAT</Text>
                      <Text style={s.verifyText}>{stripMd(verifyMove.action)}</Text>

                      <Text style={s.verifySection}>WHY</Text>
                      <Text style={s.verifyText}>{stripMd(verifyMove.strategy)}</Text>

                      <Text style={s.verifySection}>HOW</Text>
                      {(verifyMove.steps || []).map((step, i) => (
                        <Text key={i} style={s.verifyStep}>{i + 1}. {stripMd(step)}</Text>
                      ))}

                      <Text style={s.verifySection}>EFFECT</Text>
                      <Text style={s.verifyText}>
                        {stripMd(verifyMove.effect || '')}
                        {verifyMove.timeline ? `\n${stripMd(verifyMove.timeline)}` : ''}
                      </Text>

                      <View style={s.verifyActions}>
                        <TouchableOpacity
                          style={s.moveApproveBtn}
                          onPress={() => { setVerifyMove(null); router.push('/(main)/(tabs)/plan'); }}
                        >
                          <Text style={s.moveApproveBtnText}>Continue to plan</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={s.moveVerifyBtn}
                          onPress={() => setVerifyMove(null)}
                        >
                          <Text style={s.moveVerifyBtnText}>Close</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </ScrollView>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Re-categorize transaction modal */}
          <Modal visible={!!recatTx} transparent animationType="fade" onRequestClose={() => setRecatTx(null)}>
            <Pressable style={s.modalOverlay} onPress={() => setRecatTx(null)}>
              <Pressable style={s.modalContent} onPress={() => {}}>
                <View style={s.modalHeader}>
                  <Text style={s.modalTitle}>Move transaction</Text>
                  <TouchableOpacity style={s.modalCloseIcon} onPress={() => setRecatTx(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={s.modalCloseIconText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
                {recatTx && (
                  <>
                    <Text style={s.modalSubtitle}>
                      "{recatTx.tx.merchant}" ({'\u00a3'}{Math.abs(recatTx.tx.amount).toFixed(2)}) is currently in {recatTx.catKey}. Choose the correct category:
                    </Text>

                    <Text style={s.modalLabel}>Category</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.categoryScroll}>
                      {BUDGET_CATEGORIES.map((cat) => (
                        <TouchableOpacity
                          key={cat}
                          style={[s.categoryChip, recatTarget === cat && s.categoryChipActive]}
                          onPress={() => setRecatTarget(cat)}
                        >
                          <Text style={[s.categoryChipText, recatTarget === cat && s.categoryChipTextActive]}>
                            {cat}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>

                    <View style={s.essentialRow}>
                      <Text style={s.modalLabel}>Type</Text>
                      <View style={s.toggleRow}>
                        <TouchableOpacity
                          style={[s.toggleOption, recatEssential && s.toggleOptionActive]}
                          onPress={() => setRecatEssential(true)}
                        >
                          <Text style={[s.toggleText, recatEssential && s.toggleTextActive]}>Essential</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[s.toggleOption, !recatEssential && s.toggleOptionLifestyle]}
                          onPress={() => setRecatEssential(false)}
                        >
                          <Text style={[s.toggleText, !recatEssential && s.toggleTextLifestyle]}>Lifestyle</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    <View style={s.modalActions}>
                      <TouchableOpacity style={s.modalCancel} onPress={() => setRecatTx(null)}>
                        <Text style={s.modalCancelText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[s.modalSave, !recatTarget && s.modalSaveDisabled]}
                        onPress={saveRecategorize}
                        disabled={savingRecat || !recatTarget}
                      >
                        {savingRecat ? (
                          <ActivityIndicator color={colors.bg} size="small" />
                        ) : (
                          <Text style={s.modalSaveText}>Move</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </Pressable>
            </Pressable>
          </Modal>

          {/* ── Categorise uncategorised transactions modal ── */}
          <Modal visible={showCatReview} transparent animationType="fade">
            <View style={s.catReviewOverlay}>
              <View style={s.catReviewContainer}>
                <View style={s.catReviewHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.modalTitle}>Categorise transactions</Text>
                    <Text style={s.catReviewSubtitle}>
                      {aiSuggesting
                        ? 'Bocy is suggesting categories...'
                        : Object.keys(catAssignments).length > 0
                          ? 'Review suggestions, adjust any, then accept'
                          : 'Tap a category for each merchant'}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setShowCatReview(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={s.catReviewClose}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>

                {aiSuggesting && (
                  <View style={s.aiSuggestBar}>
                    <ActivityIndicator color={colors.green} size="small" />
                    <Text style={s.aiSuggestText}>Analysing merchants...</Text>
                  </View>
                )}

                <ScrollView style={s.catReviewList} showsVerticalScrollIndicator={false}>
                  {unresolvedGroups.map((group) => {
                    const assigned = catAssignments[group.key];
                    return (
                      <View key={group.key} style={[s.catReviewRow, assigned && s.catReviewRowDone]}>
                        <View style={s.catReviewRowHeader}>
                          <Text style={s.catReviewMerchant} numberOfLines={1}>
                            {assigned ? '\u2713 ' : ''}{group.label}
                          </Text>
                          <Text style={s.catReviewAmount}>
                            {group.txs.length} txn{group.txs.length !== 1 ? 's' : ''} {'\u00b7'} {'\u00a3'}{group.total.toFixed(2)}
                          </Text>
                        </View>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                          {BUDGET_CATEGORIES.filter(c => c !== 'Other').map((cat) => (
                            <TouchableOpacity
                              key={cat}
                              style={[s.categoryChip, assigned?.category === cat && s.categoryChipActive]}
                              onPress={() => {
                                setCatAssignments((prev) => ({
                                  ...prev,
                                  [group.key]: { category: cat, isEssential: ESSENTIAL_CATS.has(cat) },
                                }));
                              }}
                            >
                              <Text style={[
                                s.categoryChipText,
                                assigned?.category === cat && s.categoryChipTextActive,
                              ]}>{cat}</Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    );
                  })}
                </ScrollView>

                {/* Done button */}
                <TouchableOpacity
                  style={[s.catReviewDone, Object.keys(catAssignments).length === 0 && s.modalSaveDisabled]}
                  onPress={saveCatReview}
                  disabled={savingCatReview || Object.keys(catAssignments).length === 0}
                >
                  {savingCatReview ? (
                    <ActivityIndicator color={colors.bg} size="small" />
                  ) : (
                    <Text style={s.catReviewDoneText}>
                      Done{Object.keys(catAssignments).length > 0
                        ? ` (${Object.keys(catAssignments).length} categorised)`
                        : ''}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </Modal>

        </>
      )}
    </ScrollView>
  );
}

// ── Nothing OS Design System Styles ──

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  scroll: {
    padding: 24,
    paddingTop: 68,
    paddingBottom: 60,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: c.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Header ──
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 40,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  bocyHeaderWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  greeting: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: c.text,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  menuButton: {
    padding: 10,
    gap: 4,
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  menuLine: {
    width: 20,
    height: 1.5,
    backgroundColor: c.text,
    borderRadius: 1,
  },
  menuLineShort: {
    width: 12,
    backgroundColor: c.dim,
  },
  syncText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
    marginTop: 6,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // ── Empty State ──
  emptyState: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
  emptyBocyWrap: {
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: c.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
    letterSpacing: -0.2,
  },
  emptyDesc: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  ctaButton: {
    backgroundColor: c.accent,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    borderRadius: 100,
    alignItems: 'center',
    width: '100%',
  },
  ctaText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.bg,
    letterSpacing: 0.3,
  },

  // ── Shared Card — Nothing OS: border-defined, card surface fill ──
  card: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.accentDim,
    borderRadius: 24,
    padding: 28,
    paddingTop: 32,
    paddingBottom: 32,
    marginBottom: 24,
    overflow: 'hidden',
  },
  cardTitle: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.text2,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  cardSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
    lineHeight: 22,
    marginBottom: 28,
  },
  noDataText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
    lineHeight: 22,
  },

  // ── Card title row with info icon ──
  cardTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoIcon: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    width: 22,
    height: 22,
    lineHeight: 22,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: c.accentDim,
    borderRadius: 11,
    overflow: 'hidden',
  },
  infoBox: {
    backgroundColor: c.mintDim,
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: c.mintDim,
  },
  infoBoxText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    lineHeight: 18,
  },

  // ── Emergency fund info ──
  emergencyInfoBox: {
    backgroundColor: c.greenDim,
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: c.green + '20',
  },
  emergencyInfoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  emergencyInfoIcon: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.green,
    width: 20,
    height: 20,
    lineHeight: 20,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: c.green + '40',
    borderRadius: 10,
    overflow: 'hidden',
  },
  emergencyInfoTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.green,
    letterSpacing: 0.3,
  },
  emergencyInfoText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    lineHeight: 18,
  },

  // ── Card 1: Move items ──
  moveItemFull: {
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: c.mintDim,
  },
  moveTitle: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: c.text,
    lineHeight: 24,
  },
  moveMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  moveImpact: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '700',
    color: c.green,
  },
  effortPill: {
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: c.accentDim,
    backgroundColor: 'transparent',
  },
  effortPillText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  moveExpanded: {
    marginTop: 12,
    gap: 10,
  },
  moveStrategy: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    lineHeight: 20,
    marginTop: 8,
  },
  moveActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  moveApproveBtn: {
    flex: 1,
    backgroundColor: c.accent,
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
  },
  moveApproveBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.bg,
  },
  moveVerifyBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.accentDim,
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
  },
  moveVerifyBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.dim,
  },
  moveDeleteBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.accentDim,
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
  },
  moveDeleteBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
  },
  viewAllBtn: {
    alignItems: 'center',
    paddingVertical: 16,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
  },
  viewAllText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // ── Card 2: Income ──
  bigNumberWrap: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingBottom: 32,
  },
  bigNumber: {
    fontFamily: fonts.mono,
    fontSize: 52,
    fontWeight: '300',
    color: c.text,
    letterSpacing: -2,
  },
  bigNumberLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    marginTop: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  divider: {
    height: 1,
    backgroundColor: c.mintDim,
    marginBottom: 4,
  },
  sourceCard: {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
  },
  sourceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  sourceInfo: {
    flex: 1,
    marginRight: 12,
  },
  sourceName: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: c.text,
    lineHeight: 24,
    marginBottom: 8,
  },
  sourceTagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sourceFreq: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
    letterSpacing: 0.3,
  },
  primaryTag: {
    backgroundColor: c.mintDim,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: c.accentDim,
  },
  primaryTagText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: '600',
    color: c.text,
    letterSpacing: 1,
  },
  sourceAmountWrap: {
    alignItems: 'flex-end',
  },
  sourceAmount: {
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: '300',
    color: c.text,
  },
  sourceAmountPer: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    marginTop: 2,
  },
  incomeSourcesHeader: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 1,
    marginBottom: 4,
    marginTop: 8,
    textTransform: 'uppercase',
  },
  removeSourceBtn: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 100,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.coralDim,
  },
  removeSourceText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.coral,
    letterSpacing: 0.3,
  },

  // ── Card 3: Safe to Spend ──
  safeToSpendHero: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingBottom: 28,
  },
  safeToSpendAmount: {
    fontFamily: fonts.mono,
    fontSize: 48,
    fontWeight: '300',
    color: c.text,
    letterSpacing: -2,
  },
  safeToSpendLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    marginTop: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  safeToSpendBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
    marginBottom: 16,
  },
  safeToSpendBarFill: {
    height: '100%',
    borderRadius: 2,
  },
  safeToSpendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  safeToSpendMeta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
    letterSpacing: 0.3,
  },

  // ── Card 4: Budget Reality ──
  budgetHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  expandHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
    marginTop: 2,
  },
  expandToggle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: c.mintDim,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  expandToggleText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
  },
  budgetBar: {
    flexDirection: 'row',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 8,
    marginBottom: 32,
    gap: 2,
  },
  barSeg: {
    borderRadius: 2,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 36,
    paddingHorizontal: 4,
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
    paddingVertical: 8,
  },
  summaryAmount: {
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: '300',
  },
  summaryLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.text2,
    marginTop: 8,
  },
  summaryPct: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    marginTop: 4,
    letterSpacing: 0.5,
  },
  breakdownHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  breakdownHeader: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: c.dim,
  },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addItemLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.text,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  addItemIcon: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.text,
    width: 20,
    height: 20,
    lineHeight: 18,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: c.accentDim,
    borderRadius: 10,
    overflow: 'hidden',
  },
  dataRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    minHeight: 48,
    borderBottomWidth: 1,
    borderBottomColor: c.mintDim,
  },
  dataRowLast: {
    borderBottomWidth: 0,
  },
  dataRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  catArrow: {
    fontFamily: fonts.mono,
    fontSize: 8,
    marginTop: 4,
    width: 14,
  },
  catInfo: {
    flex: 1,
  },
  dataLabel: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.text,
    letterSpacing: 0.2,
  },
  dataMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    marginTop: 4,
    letterSpacing: 0.3,
  },
  dataRowRight: {
    alignItems: 'flex-end',
  },
  dataValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '400',
  },

  // ── Transaction dropdown ──
  txDropdown: {
    backgroundColor: 'transparent',
    borderLeftWidth: 1,
    borderLeftColor: c.border,
    marginLeft: 10,
    marginBottom: 8,
    paddingLeft: 14,
    paddingVertical: 6,
  },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.mintDim,
  },
  txRowLast: {
    borderBottomWidth: 0,
  },
  txLeft: {
    flex: 1,
    marginRight: 12,
  },
  txMerchant: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
  },
  txDate: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    marginTop: 3,
    letterSpacing: 0.3,
  },
  txAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '400',
  },
  txRightCol: {
    alignItems: 'flex-end',
  },
  txRecatHint: {
    fontFamily: fonts.mono,
    fontSize: 8,
    color: c.muted,
    marginTop: 3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  txEmpty: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
    paddingVertical: 8,
  },
  breakdownSubtext: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
    marginBottom: 12,
    lineHeight: 18,
  },
  cardFooter: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    textAlign: 'center',
    marginTop: 16,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  viewTransactionsBtn: {
    alignItems: 'center',
    paddingVertical: 18,
    marginTop: 4,
  },
  viewTransactionsText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.green,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // ── Card 5: Debt accounts ──
  debtHero: {
    alignItems: 'center',
    paddingVertical: 20,
    paddingBottom: 28,
  },
  debtHeroAmount: {
    fontFamily: fonts.mono,
    fontSize: 44,
    fontWeight: '300',
    color: c.coral,
    letterSpacing: -2,
  },
  debtHeroLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    marginTop: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  debtRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.mintDim,
  },
  debtRowLast: {
    borderBottomWidth: 0,
  },
  debtRowLeft: {
    flex: 1,
    marginRight: 12,
  },
  debtName: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.text,
  },
  debtType: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    marginTop: 3,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  debtRowRight: {
    alignItems: 'flex-end',
  },
  debtBalance: {
    fontFamily: fonts.mono,
    fontSize: 16,
    fontWeight: '400',
    color: c.text,
  },
  debtUtil: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    marginTop: 3,
    letterSpacing: 0.3,
  },

  // ── Quick add buttons (collapsed) ──
  quickAddRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  quickAddBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: c.green + '30',
    borderRadius: 12,
    borderStyle: 'dashed',
  },
  quickAddIcon: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.green,
  },
  quickAddText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.green,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },

  // ── Modal — Nothing OS: dark glass, border-defined ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: c.card,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: c.accentDim,
    width: '100%',
    maxWidth: 400,
  },
  modalContentScrollable: {
    backgroundColor: c.card,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: c.accentDim,
    width: '100%',
    maxWidth: 400,
    maxHeight: '80%',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  modalCloseIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseIconText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
  },
  modalTitle: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.text,
    letterSpacing: 1,
    textTransform: 'uppercase',
    flex: 1,
  },
  modalSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    marginBottom: 20,
    lineHeight: 18,
  },
  modalInput: {
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: c.text,
    marginBottom: 12,
  },
  modalLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
    letterSpacing: 1,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  categoryScroll: {
    marginBottom: 16,
    maxHeight: 36,
  },
  categoryChip: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 100,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginRight: 8,
  },
  categoryChipActive: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  categoryChipText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
  },
  categoryChipTextActive: {
    color: c.bg,
  },
  essentialRow: {
    marginBottom: 20,
  },
  toggleRow: {
    flexDirection: 'row',
    gap: 8,
  },
  toggleOption: {
    flex: 1,
    backgroundColor: 'transparent',
    borderRadius: 100,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  toggleOptionActive: {
    borderColor: c.accent,
    backgroundColor: c.mintDim,
  },
  toggleOptionLifestyle: {
    borderColor: c.accent,
    backgroundColor: c.mintDim,
  },
  toggleText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
    letterSpacing: 0.3,
  },
  toggleTextActive: {
    color: c.text,
  },
  toggleTextLifestyle: {
    color: c.text,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.accentDim,
  },
  modalCancelText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.dim,
  },
  modalSave: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: c.accent,
  },
  modalSaveDisabled: {
    opacity: 0.3,
  },
  addItemErrorText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.coral,
    marginBottom: 12,
    lineHeight: 18,
  },
  modalSaveText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },

  // ── Verify modal ──
  verifySection: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 2,
    color: c.dim,
    marginTop: 16,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  verifyText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.text2,
    lineHeight: 22,
  },
  verifyStep: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
    lineHeight: 22,
    marginLeft: 4,
  },
  verifyActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },

  // ── Review banner for unresolved transactions ──
  reviewBanner: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  reviewBannerText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
    lineHeight: 20,
  },
  reviewBannerLink: {
    color: c.green,
    fontFamily: fonts.semibold,
  },

  // ── Income arrival alert ──
  incomeAlert: {
    backgroundColor: c.greenDim,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  incomeAlertTitle: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.green,
    marginBottom: 4,
  },
  incomeAlertText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
    lineHeight: 20,
  },
  incomeAlertBudget: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.green,
    marginTop: 6,
  },

  // ── Categorise review modal ──
  catReviewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    padding: spacing.md,
  },
  catReviewContainer: {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.border,
    maxHeight: '85%',
    overflow: 'hidden',
  },
  catReviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  catReviewSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    marginTop: 4,
  },
  catReviewClose: {
    fontFamily: fonts.medium,
    fontSize: 18,
    color: c.muted,
    padding: 4,
  },
  catReviewList: {
    padding: spacing.md,
  },
  catReviewRow: {
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  catReviewRowDone: {
    borderColor: c.green + '40',
    backgroundColor: c.greenDim,
  },
  catReviewRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  catReviewMerchant: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.text,
  },
  catReviewMeta: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.dim,
    marginTop: 2,
  },
  catReviewAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.text2,
    marginLeft: spacing.sm,
  },
  catReviewDone: {
    backgroundColor: c.green,
    margin: spacing.md,
    marginTop: 0,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  catReviewDoneText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.bg,
  },

  // ── AI suggest loading bar ──
  aiSuggestBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    backgroundColor: c.greenDim,
  },
  aiSuggestText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.green,
    letterSpacing: 0.3,
  },
});
