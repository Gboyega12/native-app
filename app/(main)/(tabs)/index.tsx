import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  LayoutAnimation, Platform, UIManager, TextInput, Modal, Alert, Animated, Easing, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getLastResult } from '@/app/(main)/processing';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import { colors, fonts, spacing, radius } from '@/theme';
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

// Nothing OS — monochrome extended palette
const gold = '#A7A7A7';
const goldSoft = 'rgba(255,255,255,0.04)';

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
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedMoves, setExpandedMoves] = useState<Set<number>>(new Set());
  const [budgetExpanded, setBudgetExpanded] = useState(false);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);

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

  const ESSENTIAL_CATS = new Set(['Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport', 'Childcare', 'Health', 'Education', 'Debt Payments', 'Savings']);

  const BUDGET_CATEGORIES = [
    'Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport',
    'Dining', 'Shopping', 'Entertainment', 'Subscriptions', 'Health',
    'Childcare', 'Education', 'Charity', 'Transfers', 'Savings', 'Investments', 'Other',
  ];

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
    // Group by merchant/description — user assigns one category per merchant
    const groups = new Map<string, { key: string; txs: TransactionDetail[]; total: number }>();
    for (const tx of txs) {
      const key = tx.merchant || tx.description;
      if (!groups.has(key)) groups.set(key, { key, txs: [], total: 0 });
      const g = groups.get(key)!;
      g.txs.push(tx);
      g.total += Math.abs(tx.amount);
    }
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [analysis]);

  const unresolvedTxCount = useMemo(
    () => unresolvedGroups.reduce((sum, g) => sum + g.txs.length, 0),
    [unresolvedGroups],
  );

  const saveCatReview = async () => {
    const keys = Object.keys(catAssignments);
    if (keys.length === 0) { setShowCatReview(false); return; }
    setSavingCatReview(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');

      // Save overrides using delete-then-insert (no unique constraint on table)
      for (const matchKey of keys) {
        const a = catAssignments[matchKey];
        // Remove any existing override for this merchant
        await supabase.from('transaction_overrides')
          .delete()
          .eq('user_id', user.id)
          .eq('match_description', matchKey);
        // Insert the new override
        const { error: insertErr } = await supabase.from('transaction_overrides').insert({
          user_id: user.id,
          match_description: matchKey,
          category: a.category,
          is_essential: a.isEssential,
        });
        if (insertErr) throw new Error(`Failed to save ${matchKey}: ${insertErr.message}`);
      }

      // Optimistic UI: remove categorised transactions from "Other"
      if (analysis) {
        const updated = { ...analysis };
        const assignedKeys = new Set(keys);

        for (const sectionKey of ['discretionary', 'non_discretionary'] as const) {
          const section = { ...(updated as any)[sectionKey] };
          section.items = [...(section.items || [])];
          const otherIdx = section.items.findIndex((i: BudgetCategory) => i.category === 'Other');
          if (otherIdx >= 0) {
            const otherCat = { ...section.items[otherIdx] };
            otherCat.transactions = (otherCat.transactions || []).filter(
              (tx: TransactionDetail) => !assignedKeys.has(tx.merchant || tx.description)
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
            .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, last_updated')
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

      // Try TrueLayer sync for fresh data
      let csvData: string | null = null;
      try {
        const res = await fetch('/api/truelayer/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: userId }),
        });
        const data = await res.json();
        if (data.success && data.csv_data) {
          csvData = data.csv_data;
        }
      } catch {}

      // If TrueLayer sync failed, fall back to existing CSV from ALL bank_data rows
      if (!csvData) {
        try {
          const { data: bankRows } = await supabase
            .from('bank_data')
            .select('csv_data')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });
          if (bankRows && bankRows.length > 0) {
            // Merge CSVs: take header from first, data lines from all
            const allLines: string[] = ['Date,Description,Amount'];
            for (const row of bankRows) {
              if (!row.csv_data) continue;
              const lines = row.csv_data.split('\n');
              // Skip header line (first line) from each CSV
              allLines.push(...lines.slice(1).filter((l: string) => l.trim()));
            }
            csvData = allLines.join('\n');
          }
        } catch {}
      }

      if (!csvData) {
        setSyncing(false);
        return;
      }

      // Fetch user's transaction overrides + budget adjustments
      let overrides: any[] = [];
      let budgetAdjustments: any[] = [];
      try {
        const [overrideRes, adjustmentRes] = await Promise.all([
          supabase
            .from('transaction_overrides')
            .select('match_description, category, is_essential')
            .eq('user_id', userId),
          supabase
            .from('budget_adjustments')
            .select('description, category, monthly_amount, is_essential')
            .eq('user_id', userId),
        ]);
        if (overrideRes.data) overrides = overrideRes.data;
        if (adjustmentRes.data) budgetAdjustments = adjustmentRes.data;
      } catch {}

      // Fetch debt accounts and identity for personalisation
      let debtAccountsData: any[] = [];
      let identityData: any = null;
      try {
        const [debtRes, idRes] = await Promise.all([
          supabase
            .from('debt_accounts')
            .select('account_name, account_type, outstanding_balance, credit_limit')
            .eq('user_id', userId),
          supabase
            .from('user_identity')
            .select('*')
            .eq('user_id', userId)
            .single(),
        ]);
        if (debtRes.data) debtAccountsData = debtRes.data;
        if (idRes.data) identityData = idRes.data;
      } catch {}

      // Re-run enrichment engine with fresh data (fast, ~1 second)
      const result = EnrichmentEngine.enrich(csvData, overrides, debtAccountsData, identityData);
      if (result.enrichedTransactions.length === 0) {
        setSyncing(false);
        return;
      }

      // Fetch goals for move ranking
      let goals: Goals | null = null;
      const { data: goalsData } = await supabase
        .from('goals')
        .select('*')
        .eq('user_id', userId)
        .single();
      goals = goalsData;

      // Run move engine
      const ukpf = determineFlowchartPosition(result.profile, goals, debtAccountsData, identityData);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;

      const allMoves = rankedMoves;
      // Filter out recommendations the user has dismissed so they don't reappear.
      // Dismissed moves are stored in plan_progress with a 'dismissed-' key prefix.
      try {
        const { data: progressRows } = await supabase
          .from('plan_progress')
          .select('move_key, move_action')
          .eq('user_id', userId)
          .like('move_key', 'dismissed-%');
        if (progressRows && progressRows.length > 0) {
          const dismissedActions = new Set(progressRows.map((r: any) => r.move_action));
          for (let i = allMoves.length - 1; i >= 0; i--) {
            if (dismissedActions.has(allMoves[i].action)) allMoves.splice(i, 1);
          }
        }
      } catch {}

      const topMove = allMoves[0] || null;

      // Build raw analysis WITHOUT budget adjustments (those are applied at display time)
      const rawNonDisc = result.profile.budgetReality.nonDiscretionary;
      const rawDisc = result.profile.budgetReality.discretionary;

      const rawAnalysis: Analysis = {
        user_id: userId,
        archetype: result.archetype.key,
        decision_score: result.decisionScore.score,
        monthly_income: Math.round(result.profile.monthly.income),
        monthly_spending: Math.round(result.profile.monthly.spending),
        surplus: Math.round(result.profile.monthly.surplus),
        non_discretionary: rawNonDisc,
        discretionary: rawDisc,
        income_sources: result.profile.incomeSources,
        top_move: topMove || ({} as any),
        all_moves: allMoves,
        behavioral_patterns: result.behavioralPatterns,
        goal_context: goalTrajectory,
      };

      // Upsert to Supabase — update latest row instead of creating duplicates
      const { data: existingRow } = await supabase
        .from('analyses')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (existingRow?.id) {
        await supabase.from('analyses').update({
          archetype: rawAnalysis.archetype,
          decision_score: rawAnalysis.decision_score,
          monthly_income: rawAnalysis.monthly_income,
          monthly_spending: rawAnalysis.monthly_spending,
          surplus: rawAnalysis.surplus,
          non_discretionary: rawAnalysis.non_discretionary,
          discretionary: rawAnalysis.discretionary,
          income_sources: rawAnalysis.income_sources,
          top_move: rawAnalysis.top_move,
          all_moves: rawAnalysis.all_moves,
          behavioral_patterns: rawAnalysis.behavioral_patterns,
          goal_context: rawAnalysis.goal_context,
        }).eq('id', existingRow.id);
      } else {
        await supabase.from('analyses').insert({
          user_id: userId,
          archetype: rawAnalysis.archetype,
          decision_score: rawAnalysis.decision_score,
          monthly_income: rawAnalysis.monthly_income,
          monthly_spending: rawAnalysis.monthly_spending,
          surplus: rawAnalysis.surplus,
          non_discretionary: rawAnalysis.non_discretionary,
          discretionary: rawAnalysis.discretionary,
          income_sources: rawAnalysis.income_sources,
          top_move: rawAnalysis.top_move,
          all_moves: rawAnalysis.all_moves,
          behavioral_patterns: rawAnalysis.behavioral_patterns,
          goal_context: rawAnalysis.goal_context,
        });
      }

      // ── Save score snapshot on background sync ──
      try {
        const savingsRate = rawAnalysis.monthly_income > 0
          ? Math.round((rawAnalysis.surplus / rawAnalysis.monthly_income) * 100) : 0;
        await supabase.from('score_history').insert({
          user_id: userId,
          decision_score: rawAnalysis.decision_score,
          monthly_income: rawAnalysis.monthly_income,
          monthly_spending: rawAnalysis.monthly_spending,
          surplus: rawAnalysis.surplus,
          savings_rate: savingsRate,
          subscription_count: result.profile.metrics.subscriptionCount || 0,
          debt_account_count: result.profile.metrics.debtAccountCount || 0,
          archetype: rawAnalysis.archetype,
        });
      } catch {}

      // Re-fetch budget adjustments right before merging so we capture
      // any items the user added while the sync was running.
      try {
        const { data: freshAdj } = await supabase
          .from('budget_adjustments')
          .select('description, category, monthly_amount, is_essential')
          .eq('user_id', userId);
        if (freshAdj) budgetAdjustments = freshAdj;
      } catch {}

      // Apply budget adjustments for display only (not saved)
      const updatedAnalysis = mergeAdjustments(rawAnalysis, budgetAdjustments);

      // Sync debt accounts from ALL bank_data.card_balances
      try {
        const { data: bankRows } = await supabase
          .from('bank_data')
          .select('card_balances')
          .eq('user_id', userId)
          .not('card_balances', 'is', null);

        if (bankRows && bankRows.length > 0) {
          const debtRows: any[] = [];
          for (const row of bankRows) {
            if (!Array.isArray(row.card_balances)) continue;
            for (const card of row.card_balances) {
              const { error: upsertErr } = await supabase.from('debt_accounts').upsert({
                user_id: userId,
                account_name: card.name || 'Card',
                account_type: card.type || 'credit_card',
                outstanding_balance: card.balance,
                credit_limit: card.limit,
                source: 'truelayer',
                last_updated: new Date().toISOString(),
              }, { onConflict: 'user_id,account_name' });
              if (!upsertErr) {
                debtRows.push({
                  account_name: card.name || 'Card',
                  account_type: card.type || 'credit_card',
                  outstanding_balance: card.balance,
                  credit_limit: card.limit,
                });
              }
            }
          }
          if (debtRows.length > 0) setDebtAccounts(debtRows);
        }
      } catch {}

      // Update dashboard
      setAnalysis(updatedAnalysis);
    } catch (err: any) {
      console.warn('[home] Background sync failed:', err?.message);
    }
    setSyncing(false);
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color="#FFFFFF" size="large" />
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
  const weeklyBudget = leftToDecide / 4.33;

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
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll}>
      {/* ── Header with Bocy ── */}
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <View style={styles.bocyHeaderWrap}>
            <BocyFace mood={getBocyMood(analysis)} size="sm" breathing />
          </View>
          <View>
            <Text style={styles.greeting}>
              Hello, {userName || 'there'}
            </Text>
            {syncing && (
              <Text style={styles.syncText}>Syncing latest transactions...</Text>
            )}
          </View>
        </View>
        <TouchableOpacity
          style={styles.menuButton}
          onPress={() => router.push('/(main)/profile')}
        >
          <View style={styles.menuLine} />
          <View style={[styles.menuLine, styles.menuLineShort]} />
          <View style={styles.menuLine} />
        </TouchableOpacity>
      </View>

      {!analysis ? (
        /* ── Empty State ── */
        <View style={styles.emptyState}>
          <View style={styles.emptyBocyWrap}>
            <BocyFace mood="neutral" size="lg" breathing />
          </View>
          <Text style={styles.emptyTitle}>Your #1 financial move awaits</Text>
          <Text style={styles.emptyDesc}>
            Connect your bank account so Bocy can analyse your transactions and find the most impactful action you can take right now.
          </Text>
          <TouchableOpacity
            style={styles.ctaButton}
            onPress={() => router.push('/(main)/connect')}
          >
            <Text style={styles.ctaText}>Connect your bank</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── Unresolved transactions nudge ── */}
          {unresolvedTxCount > 0 && (
            <TouchableOpacity
              style={styles.reviewBanner}
              onPress={() => { setCatAssignments({}); setShowCatReview(true); }}
              activeOpacity={0.7}
            >
              <Text style={styles.reviewBannerText}>
                {unresolvedTxCount} transaction{unresolvedTxCount !== 1 ? 's' : ''} couldn't be categorised.{' '}
                <Text style={styles.reviewBannerLink}>Tell me what they are</Text>
              </Text>
            </TouchableOpacity>
          )}

          {/* ══════════════════════════════════════════════
              CARD 1 — YOUR INSIGHTS
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            <AnimGlyph delay={0}>
              <Text style={styles.cardTitle}>Your Insights</Text>
            </AnimGlyph>

            {dashboardMoves.length > 0 ? dashboardMoves.slice(0, 2).map((move: Move, i: number) => {
              const effortClr = move.effort === 'high' ? colors.green
                : move.effort === 'medium' ? colors.dim : '#666666';
              return (
                <AnimGlyph key={i} delay={i * 120}>
                  <View
                    accessibilityRole="summary"
                    accessibilityLabel={`Insight: ${move.action}, saves ${move.annualImpact} pounds per year`}
                    style={styles.moveItemFull}
                  >
                    <Text style={styles.moveTitle}>
                      {stripMd(move.action)}
                    </Text>

                    {/* Impact + effort on one line */}
                    <View style={styles.moveMeta}>
                      <Text style={styles.moveImpact}>
                        +{'\u00a3'}{(move.annualImpact || 0).toLocaleString()}/yr
                      </Text>
                      {move.effort && (
                        <View style={[styles.effortPill, { borderColor: effortClr + '40' }]}>
                          <Text style={[styles.effortPillText, { color: effortClr }]}>
                            {move.effort}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Action buttons */}
                    <View style={styles.moveActions}>
                      <TouchableOpacity
                        style={styles.moveApproveBtn}
                        onPress={() => router.push({ pathname: '/(main)/(tabs)/plan', params: { highlight: String(i) } })}
                      >
                        <Text style={styles.moveApproveBtnText}>View</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.moveDeleteBtn}
                        onPress={() => handleDeleteMove(move)}
                      >
                        <Text style={styles.moveDeleteBtnText}>Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </AnimGlyph>
              );
            }) : (
              <Text style={styles.noDataText}>
                No actionable insights yet. Upload a statement to get started.
              </Text>
            )}

            {dashboardMoves.length > 2 && (
              <TouchableOpacity
                style={styles.viewAllBtn}
                onPress={() => router.push('/(main)/(tabs)/plan')}
                activeOpacity={0.7}
              >
                <Text style={[styles.viewAllText, { color: colors.green }]}>
                  View plan {'\u203A'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 2 — YOUR INCOME
              ══════════════════════════════════════════════ */}
          <View style={styles.card} accessibilityRole="summary" accessibilityLabel={`Monthly income: ${Math.round(income)} pounds`}>
            <AnimGlyph delay={50}>
              <View style={styles.cardTitleRow}>
                <Text style={styles.cardTitle}>Your income</Text>
                <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'income' ? null : 'income')}>
                  <Text style={styles.infoIcon}>i</Text>
                </TouchableOpacity>
              </View>
            </AnimGlyph>
            {infoCard === 'income' && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  Income is detected from your bank account transactions only (not credit cards). Regular credits matching salary, benefit, or employer patterns are identified. Remove any that aren't real income.
                </Text>
              </View>
            )}

            <AnimGlyph delay={100}>
              <View style={styles.bigNumberWrap}>
                <Text style={styles.bigNumber} accessibilityRole="text">
                  {'\u00a3'}{Math.round(income).toLocaleString()}
                </Text>
                <Text style={styles.bigNumberLabel}>monthly</Text>
              </View>
            </AnimGlyph>

            {incomeSources.length > 0 ? (
              <>
                <View style={styles.divider} />
                <Text style={styles.incomeSourcesHeader}>
                  {incomeSources.length} source{incomeSources.length !== 1 ? 's' : ''}
                </Text>
                {incomeSources.map((src: IncomeSource, i: number) => (
                  <AnimGlyph key={i} delay={150 + i * 80}>
                    <View style={styles.sourceCard}>
                      <View style={styles.sourceRow}>
                        <View style={styles.sourceInfo}>
                          <Text style={styles.sourceName}>{src.source}</Text>
                          <View style={styles.sourceTagRow}>
                            <Text style={styles.sourceFreq}>
                              {src.frequency.charAt(0).toUpperCase() + src.frequency.slice(1)}
                            </Text>
                            {src.isSalary && (
                              <View style={[styles.primaryTag, { backgroundColor: colors.greenDim, borderColor: colors.green + '30' }]}>
                                <Text style={[styles.primaryTagText, { color: colors.green }]}>PRIMARY</Text>
                              </View>
                            )}
                        </View>
                      </View>
                      <View style={styles.sourceAmountWrap}>
                        <Text style={styles.sourceAmount}>
                          {'\u00a3'}{Math.round(src.avgAmount).toLocaleString()}
                        </Text>
                        <Text style={styles.sourceAmountPer}>
                          per {src.frequency === 'weekly' ? 'week' : src.frequency === 'fortnightly' ? 'fortnight' : 'month'}
                        </Text>
                      </View>
                    </View>
                    {/* Remove non-income */}
                    <TouchableOpacity
                      style={styles.removeSourceBtn}
                      onPress={() => handleRemoveIncomeSource(src.source)}
                      disabled={removingSource === src.source}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      activeOpacity={0.6}
                    >
                      <Text style={styles.removeSourceText}>
                        {removingSource === src.source ? 'Removing...' : 'Not income? Remove'}
                      </Text>
                    </TouchableOpacity>
                    </View>
                  </AnimGlyph>
                ))}
              </>
            ) : (
              <Text style={styles.noDataText}>No income sources detected from bank accounts.</Text>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 3 — SAFE TO SPEND
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            <AnimGlyph delay={100}>
              <View style={styles.cardTitleRow}>
                <Text style={styles.cardTitle}>Safe to spend</Text>
                <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'safe' ? null : 'safe')}>
                  <Text style={styles.infoIcon}>i</Text>
                </TouchableOpacity>
              </View>
            </AnimGlyph>
            {infoCard === 'safe' && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  This is your weekly lifestyle budget: (Monthly income - Essentials) / 4.33, minus what you've already spent on lifestyle this month. It tells you how much discretionary spending you can still afford this week.
                </Text>
              </View>
            )}
            <Text style={styles.cardSubtitle}>Your weekly lifestyle allowance</Text>

            {/* Big remaining number */}
            <AnimGlyph delay={150}>
              <View style={styles.safeToSpendHero}>
                <Text style={[styles.safeToSpendAmount, !weeklyHealthy && { color: colors.coral }]}>
                  {'\u00a3'}{Math.round(weeklyRemaining).toLocaleString()}
                </Text>
                <Text style={styles.safeToSpendLabel}>left this week</Text>
              </View>
            </AnimGlyph>

            {/* Progress bar with breathing animation */}
            <View style={styles.safeToSpendBar}>
              <BreathingBar
                color={weeklyHealthy ? colors.green : colors.coral}
                width={`${weeklyUsedPct}%`}
                style={styles.safeToSpendBarFill}
              />
            </View>

            {/* Spent vs budget row */}
            <View style={styles.safeToSpendRow}>
              <View>
                <Text style={styles.safeToSpendMeta}>
                  {'\u00a3'}{Math.round(spentThisWeek).toLocaleString()} spent
                </Text>
              </View>
              <View>
                <Text style={styles.safeToSpendMeta}>
                  {'\u00a3'}{Math.round(weeklyBudget).toLocaleString()} budget
                </Text>
              </View>
            </View>
          </View>

          {/* ══════════════════════════════════════════════
              CARD 4 — YOUR BUDGET REALITY
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            {/* Info icon for budget card */}
            <View style={styles.cardTitleRow}>
              <View style={{ flex: 1 }} />
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'budget' ? null : 'budget')}>
                <Text style={styles.infoIcon}>i</Text>
              </TouchableOpacity>
            </View>
            {infoCard === 'budget' && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  Your spending is split into Essentials (rent, bills, groceries) and Lifestyle (dining, shopping, entertainment). Categories are determined by transaction enrichment and merchant matching. You can re-categorize any transaction by tapping it.
                </Text>
              </View>
            )}

            {/* Header */}
            <View style={styles.budgetHeaderRow}>
              <Text style={styles.cardTitle}>Your budget reality</Text>
            </View>

            {/* 3-segment stacked bar — monochrome */}
            <View style={styles.budgetBar}>
              {nonDiscFlex > 0 && (
                <View style={[styles.barSeg, { flex: nonDiscFlex, backgroundColor: '#FFFFFF' }]} />
              )}
              {discFlex > 0 && (
                <View style={[styles.barSeg, { flex: discFlex, backgroundColor: '#666666' }]} />
              )}
              {leftFlex > 0 && (
                <View style={[styles.barSeg, { flex: leftFlex, backgroundColor: colors.green + '30' }]} />
              )}
            </View>

            {/* Summary row — always visible */}
            <View style={[styles.summaryRow, !budgetExpanded && { marginBottom: 0 }]}>
              <AnimGlyph delay={80} style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: '#FFFFFF' }]}>
                  {'\u00a3'}{Math.round(nonDiscTotal).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Essentials</Text>
                <Text style={styles.summaryPct}>{nonDiscPct}%</Text>
              </AnimGlyph>
              <AnimGlyph delay={160} style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: '#999999' }]}>
                  {'\u00a3'}{Math.round(discTotal).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Lifestyle</Text>
                <Text style={styles.summaryPct}>{discPct}%</Text>
              </AnimGlyph>
              <AnimGlyph delay={240} style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: colors.green }]}>
                  {'\u00a3'}{Math.round(leftToDecide).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Left to decide</Text>
                <Text style={[styles.summaryPct, { color: colors.green }]}>{leftPct}%</Text>
              </AnimGlyph>
            </View>

            {/* Collapsible breakdown sections */}
            {budgetExpanded && (
              <>
                {/* Non-negotiable breakdown */}
                  <>
                    <View style={styles.breakdownHeaderRow}>
                      <Text style={styles.breakdownHeader}>ESSENTIALS</Text>
                      <TouchableOpacity
                        style={styles.addItemBtn}
                        onPress={() => {
                          LayoutAnimation.configureNext(SMOOTH_ANIM);
                          setAddItemEssential(true);
                          setAddItemError('');
                          setShowAddItem(true);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={[styles.addItemLabel, { color: colors.green }]}>Add item</Text>
                        <Text style={[styles.addItemIcon, { color: colors.green, borderColor: colors.green + '40' }]}>+</Text>
                      </TouchableOpacity>
                    </View>
                    {nonDiscItems.length === 0 && (
                      <Text style={styles.noDataText}>No essential items yet. Add one to track it.</Text>
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
                            style={[styles.dataRow, i === nonDiscItems.length - 1 && !isExpanded && styles.dataRowLast]}
                          >
                            <View style={styles.dataRowLeft}>
                              <Text style={[styles.catArrow, { color: colors.text }]}>{isExpanded ? '\u25BC' : '\u25B6'}</Text>
                              <View style={styles.catInfo}>
                                <Text style={styles.dataLabel}>{item.category}</Text>
                                <Text style={styles.dataMeta}>
                                  {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of essentials
                                </Text>
                              </View>
                            </View>
                            <View style={styles.dataRowRight}>
                              <Text style={[styles.dataValue, { color: colors.text }]}>
                                {'\u00a3'}{Math.round(item.monthly).toLocaleString()}
                              </Text>
                            </View>
                          </TouchableOpacity>
                          {isExpanded && txs.length > 0 && (
                            <View style={styles.txDropdown}>
                              {txs.map((tx, j) => (
                                <TouchableOpacity
                                  key={j}
                                  style={[styles.txRow, j === txs.length - 1 && styles.txRowLast]}
                                  onLongPress={() => {
                                    setRecatTx({ tx, catKey: item.category, section: 'essential' });
                                    setRecatTarget('');
                                    setRecatEssential(true);
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <View style={styles.txLeft}>
                                    <Text style={styles.txMerchant}>{tx.merchant}</Text>
                                    <Text style={styles.txDate}>{formatDate(tx.date)}</Text>
                                  </View>
                                  <View style={styles.txRightCol}>
                                    <Text style={[styles.txAmount, { color: colors.text2 }]}>
                                      {'\u00a3'}{Math.abs(tx.amount).toFixed(2)}
                                    </Text>
                                    <Text style={styles.txRecatHint}>Hold to move</Text>
                                  </View>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                          {isExpanded && txs.length === 0 && (
                            <View style={styles.txDropdown}>
                              <Text style={styles.txEmpty}>No transaction details available</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </>

                {/* Lifestyle spending */}
                  <>
                    <View style={[styles.breakdownHeaderRow, { marginTop: 28 }]}>
                      <Text style={styles.breakdownHeader}>LIFESTYLE</Text>
                      <TouchableOpacity
                        style={styles.addItemBtn}
                        onPress={() => {
                          LayoutAnimation.configureNext(SMOOTH_ANIM);
                          setAddItemEssential(false);
                          setAddItemError('');
                          setShowAddItem(true);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={[styles.addItemLabel, { color: colors.green }]}>Add item</Text>
                        <Text style={[styles.addItemIcon, { color: colors.green, borderColor: colors.green + '40' }]}>+</Text>
                      </TouchableOpacity>
                    </View>
                    {discItems.length === 0 && (
                      <Text style={styles.noDataText}>No lifestyle items yet. Add one to track it.</Text>
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
                            style={[styles.dataRow, i === discItems.length - 1 && !isExpanded && styles.dataRowLast]}
                          >
                            <View style={styles.dataRowLeft}>
                              <Text style={[styles.catArrow, { color: colors.dim }]}>{isExpanded ? '\u25BC' : '\u25B6'}</Text>
                              <View style={styles.catInfo}>
                                <Text style={styles.dataLabel}>{item.category}</Text>
                                <Text style={styles.dataMeta}>
                                  {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of lifestyle
                                </Text>
                              </View>
                            </View>
                            <View style={styles.dataRowRight}>
                              <Text style={[styles.dataValue, { color: colors.dim }]}>
                                {'\u00a3'}{Math.round(item.monthly).toLocaleString()}
                              </Text>
                            </View>
                          </TouchableOpacity>
                          {isExpanded && txs.length > 0 && (
                            <View style={styles.txDropdown}>
                              {txs.map((tx, j) => (
                                <TouchableOpacity
                                  key={j}
                                  style={[styles.txRow, j === txs.length - 1 && styles.txRowLast]}
                                  onLongPress={() => {
                                    setRecatTx({ tx, catKey: item.category, section: 'lifestyle' });
                                    setRecatTarget('');
                                    setRecatEssential(false);
                                  }}
                                  activeOpacity={0.7}
                                >
                                  <View style={styles.txLeft}>
                                    <Text style={styles.txMerchant}>{tx.merchant}</Text>
                                    <Text style={styles.txDate}>{formatDate(tx.date)}</Text>
                                  </View>
                                  <View style={styles.txRightCol}>
                                    <Text style={[styles.txAmount, { color: colors.dim }]}>
                                      {'\u00a3'}{Math.abs(tx.amount).toFixed(2)}
                                    </Text>
                                    <Text style={styles.txRecatHint}>Hold to move</Text>
                                  </View>
                                </TouchableOpacity>
                              ))}
                            </View>
                          )}
                          {isExpanded && txs.length === 0 && (
                            <View style={styles.txDropdown}>
                              <Text style={styles.txEmpty}>No transaction details available</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </>

                <Text style={styles.cardFooter}>Tap any category to expand transactions</Text>

                <TouchableOpacity
                  onPress={() => {
                    LayoutAnimation.configureNext(SMOOTH_ANIM);
                    setBudgetExpanded(false);
                  }}
                  style={styles.viewTransactionsBtn}
                >
                  <Text style={styles.viewTransactionsText}>Hide transactions</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Quick add buttons — always visible when collapsed */}
            {!budgetExpanded && (
              <View style={styles.quickAddRow}>
                <TouchableOpacity
                  style={styles.quickAddBtn}
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
                  <Text style={styles.quickAddIcon}>+</Text>
                  <Text style={styles.quickAddText}>Add essential</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.quickAddBtn}
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
                  <Text style={styles.quickAddIcon}>+</Text>
                  <Text style={styles.quickAddText}>Add lifestyle</Text>
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
                style={styles.viewTransactionsBtn}
              >
                <Text style={styles.viewTransactionsText}>View transactions</Text>
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
              <View style={styles.card}>
                <AnimGlyph delay={50}>
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardTitle}>Your debt</Text>
                    <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'debt' ? null : 'debt')}>
                      <Text style={styles.infoIcon}>i</Text>
                    </TouchableOpacity>
                  </View>
                </AnimGlyph>
                {infoCard === 'debt' && (
                  <View style={styles.infoBox}>
                    <Text style={styles.infoBoxText}>
                      Debt balances are pulled from your connected credit cards via Open Banking (TrueLayer). Utilisation shows how much of your credit limit is currently used. Over 75% utilisation can affect your credit score.
                    </Text>
                  </View>
                )}
                <Text style={styles.cardSubtitle}>
                  {debtAccounts.length} account{debtAccounts.length !== 1 ? 's' : ''}
                  {overallUtil != null ? ` · ${overallUtil}% utilised` : ''}
                </Text>

                {/* Total debt hero */}
                <AnimGlyph delay={100}>
                  <View style={styles.debtHero}>
                    <Text style={styles.debtHeroAmount}>
                      {'\u00a3'}{Math.round(totalDebt).toLocaleString()}
                    </Text>
                    <Text style={styles.debtHeroLabel}>total outstanding</Text>
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
                    : d.account_type || 'Account';
                  return (
                    <AnimGlyph key={i} delay={150 + i * 80}>
                      <View
                        style={[styles.debtRow, i === debtAccounts.length - 1 && styles.debtRowLast]}
                      >
                      <View style={styles.debtRowLeft}>
                        <Text style={styles.debtName}>{d.account_name}</Text>
                        <Text style={styles.debtType}>{typeLabel}</Text>
                      </View>
                      <View style={styles.debtRowRight}>
                        <Text style={[styles.debtBalance, isHigh && { color: colors.coral }]}>
                          {'\u00a3'}{Math.round(bal).toLocaleString()}
                        </Text>
                        {lim > 0 && (
                          <Text style={[styles.debtUtil, isHigh && { color: colors.coral }]}>
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
            <Pressable style={styles.modalOverlay} onPress={() => { setAddItemError(''); setShowAddItem(false); }}>
              <Pressable style={styles.modalContent} onPress={() => {}}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Add budget item</Text>
                  <TouchableOpacity style={styles.modalCloseIcon} onPress={() => { setAddItemError(''); setShowAddItem(false); }} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={styles.modalCloseIconText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.modalSubtitle}>
                  For expenses not in your bank data (rent via partner, cash, etc.)
                </Text>

                <TextInput
                  style={styles.modalInput}
                  placeholder="Description (e.g. Rent)"
                  placeholderTextColor={colors.muted}
                  value={addItemDesc}
                  onChangeText={setAddItemDesc}
                />

                <TextInput
                  style={styles.modalInput}
                  placeholder="Monthly amount"
                  placeholderTextColor={colors.muted}
                  keyboardType="numeric"
                  value={addItemAmount}
                  onChangeText={setAddItemAmount}
                />

                {/* Category picker */}
                <Text style={styles.modalLabel}>Category</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
                  {BUDGET_CATEGORIES.map((cat) => (
                    <TouchableOpacity
                      key={cat}
                      style={[styles.categoryChip, addItemCategory === cat && styles.categoryChipActive]}
                      onPress={() => setAddItemCategory(cat)}
                    >
                      <Text style={[styles.categoryChipText, addItemCategory === cat && styles.categoryChipTextActive]}>
                        {cat}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                {/* Essential toggle */}
                <View style={styles.essentialRow}>
                  <Text style={styles.modalLabel}>Type</Text>
                  <View style={styles.toggleRow}>
                    <TouchableOpacity
                      style={[styles.toggleOption, addItemEssential && styles.toggleOptionActive]}
                      onPress={() => setAddItemEssential(true)}
                    >
                      <Text style={[styles.toggleText, addItemEssential && styles.toggleTextActive]}>Essential</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.toggleOption, !addItemEssential && styles.toggleOptionLifestyle]}
                      onPress={() => setAddItemEssential(false)}
                    >
                      <Text style={[styles.toggleText, !addItemEssential && styles.toggleTextLifestyle]}>Lifestyle</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Error message */}
                {addItemError ? (
                  <Text style={styles.addItemErrorText}>{addItemError}</Text>
                ) : null}

                {/* Actions */}
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.modalCancel}
                    onPress={() => { setAddItemError(''); setShowAddItem(false); }}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalSave,
                      (!addItemDesc.trim() || !addItemCategory || !addItemAmount) && styles.modalSaveDisabled,
                    ]}
                    onPress={saveAddItem}
                    disabled={addItemSaving}
                  >
                    {addItemSaving ? (
                      <ActivityIndicator color={colors.bg} size="small" />
                    ) : (
                      <Text style={styles.modalSaveText}>Add</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Verify move detail modal */}
          <Modal visible={!!verifyMove} transparent animationType="fade" onRequestClose={() => setVerifyMove(null)}>
            <Pressable style={styles.modalOverlay} onPress={() => setVerifyMove(null)}>
              <Pressable style={styles.modalContentScrollable} onPress={() => {}}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Verify recommendation</Text>
                  <TouchableOpacity style={styles.modalCloseIcon} onPress={() => setVerifyMove(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={styles.modalCloseIconText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView showsVerticalScrollIndicator={false} bounces={false} contentContainerStyle={{ paddingBottom: 8 }}>

                  {verifyMove && (
                    <>
                      <Text style={styles.verifySection}>WHAT</Text>
                      <Text style={styles.verifyText}>{stripMd(verifyMove.action)}</Text>

                      <Text style={styles.verifySection}>WHY</Text>
                      <Text style={styles.verifyText}>{stripMd(verifyMove.strategy)}</Text>

                      <Text style={styles.verifySection}>HOW</Text>
                      {(verifyMove.steps || []).map((step, i) => (
                        <Text key={i} style={styles.verifyStep}>{i + 1}. {stripMd(step)}</Text>
                      ))}

                      <Text style={styles.verifySection}>EFFECT</Text>
                      <Text style={styles.verifyText}>
                        {stripMd(verifyMove.effect || '')}
                        {verifyMove.timeline ? `\n${stripMd(verifyMove.timeline)}` : ''}
                      </Text>

                      <View style={styles.verifyActions}>
                        <TouchableOpacity
                          style={styles.moveApproveBtn}
                          onPress={() => { setVerifyMove(null); router.push('/(main)/(tabs)/plan'); }}
                        >
                          <Text style={styles.moveApproveBtnText}>Continue to plan</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.moveVerifyBtn}
                          onPress={() => setVerifyMove(null)}
                        >
                          <Text style={styles.moveVerifyBtnText}>Close</Text>
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
            <Pressable style={styles.modalOverlay} onPress={() => setRecatTx(null)}>
              <Pressable style={styles.modalContent} onPress={() => {}}>
                <View style={styles.modalHeader}>
                  <Text style={styles.modalTitle}>Move transaction</Text>
                  <TouchableOpacity style={styles.modalCloseIcon} onPress={() => setRecatTx(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={styles.modalCloseIconText}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>
                {recatTx && (
                  <>
                    <Text style={styles.modalSubtitle}>
                      "{recatTx.tx.merchant}" ({'\u00a3'}{Math.abs(recatTx.tx.amount).toFixed(2)}) is currently in {recatTx.catKey}. Choose the correct category:
                    </Text>

                    <Text style={styles.modalLabel}>Category</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
                      {BUDGET_CATEGORIES.map((cat) => (
                        <TouchableOpacity
                          key={cat}
                          style={[styles.categoryChip, recatTarget === cat && styles.categoryChipActive]}
                          onPress={() => setRecatTarget(cat)}
                        >
                          <Text style={[styles.categoryChipText, recatTarget === cat && styles.categoryChipTextActive]}>
                            {cat}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>

                    <View style={styles.essentialRow}>
                      <Text style={styles.modalLabel}>Type</Text>
                      <View style={styles.toggleRow}>
                        <TouchableOpacity
                          style={[styles.toggleOption, recatEssential && styles.toggleOptionActive]}
                          onPress={() => setRecatEssential(true)}
                        >
                          <Text style={[styles.toggleText, recatEssential && styles.toggleTextActive]}>Essential</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[styles.toggleOption, !recatEssential && styles.toggleOptionLifestyle]}
                          onPress={() => setRecatEssential(false)}
                        >
                          <Text style={[styles.toggleText, !recatEssential && styles.toggleTextLifestyle]}>Lifestyle</Text>
                        </TouchableOpacity>
                      </View>
                    </View>

                    <View style={styles.modalActions}>
                      <TouchableOpacity style={styles.modalCancel} onPress={() => setRecatTx(null)}>
                        <Text style={styles.modalCancelText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.modalSave, !recatTarget && styles.modalSaveDisabled]}
                        onPress={saveRecategorize}
                        disabled={savingRecat || !recatTarget}
                      >
                        {savingRecat ? (
                          <ActivityIndicator color={colors.bg} size="small" />
                        ) : (
                          <Text style={styles.modalSaveText}>Move</Text>
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
            <View style={styles.catReviewOverlay}>
              <View style={styles.catReviewContainer}>
                <View style={styles.catReviewHeader}>
                  <View>
                    <Text style={styles.modalTitle}>Categorise transactions</Text>
                    <Text style={styles.catReviewSubtitle}>
                      Tap a category for each merchant
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setShowCatReview(false)} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={styles.catReviewClose}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>

                <ScrollView style={styles.catReviewList} showsVerticalScrollIndicator={false}>
                  {unresolvedGroups.map((group) => {
                    const assigned = catAssignments[group.key];
                    return (
                      <View key={group.key} style={[styles.catReviewRow, assigned && styles.catReviewRowDone]}>
                        <View style={styles.catReviewRowHeader}>
                          <Text style={styles.catReviewMerchant} numberOfLines={1}>
                            {assigned ? '\u2713 ' : ''}{group.key}
                          </Text>
                          <Text style={styles.catReviewAmount}>
                            {group.txs.length} txn{group.txs.length !== 1 ? 's' : ''} {'\u00b7'} {'\u00a3'}{group.total.toFixed(2)}
                          </Text>
                        </View>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                          {BUDGET_CATEGORIES.filter(c => c !== 'Other').map((cat) => (
                            <TouchableOpacity
                              key={cat}
                              style={[styles.categoryChip, assigned?.category === cat && styles.categoryChipActive]}
                              onPress={() => {
                                setCatAssignments((prev) => ({
                                  ...prev,
                                  [group.key]: { category: cat, isEssential: ESSENTIAL_CATS.has(cat) },
                                }));
                              }}
                            >
                              <Text style={[
                                styles.categoryChipText,
                                assigned?.category === cat && styles.categoryChipTextActive,
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
                  style={[styles.catReviewDone, Object.keys(catAssignments).length === 0 && styles.modalSaveDisabled]}
                  onPress={saveCatReview}
                  disabled={savingCatReview || Object.keys(catAssignments).length === 0}
                >
                  {savingCatReview ? (
                    <ActivityIndicator color={colors.bg} size="small" />
                  ) : (
                    <Text style={styles.catReviewDoneText}>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: 24,
    paddingTop: 68,
    paddingBottom: 60,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: colors.bg,
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
    color: colors.text,
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
    backgroundColor: colors.text,
    borderRadius: 1,
  },
  menuLineShort: {
    width: 12,
    backgroundColor: colors.dim,
  },
  syncText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
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
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
    letterSpacing: -0.2,
  },
  emptyDesc: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: spacing.xl,
    paddingHorizontal: spacing.md,
  },
  ctaButton: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    paddingHorizontal: spacing.xl,
    borderRadius: 100,
    alignItems: 'center',
    width: '100%',
  },
  ctaText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: '#000000',
    letterSpacing: 0.3,
  },

  // ── Shared Card — Nothing OS: border-defined, no fill ──
  card: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
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
    color: colors.text2,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  cardSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
    lineHeight: 22,
    marginBottom: 28,
  },
  noDataText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.dim,
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
    color: colors.dim,
    width: 22,
    height: 22,
    lineHeight: 22,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 11,
    overflow: 'hidden',
  },
  infoBox: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  infoBoxText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    lineHeight: 18,
  },

  // ── Emergency fund info ──
  emergencyInfoBox: {
    backgroundColor: colors.greenDim,
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: colors.green + '20',
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
    color: colors.green,
    width: 20,
    height: 20,
    lineHeight: 20,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.green + '40',
    borderRadius: 10,
    overflow: 'hidden',
  },
  emergencyInfoTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.green,
    letterSpacing: 0.3,
  },
  emergencyInfoText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    lineHeight: 18,
  },

  // ── Card 1: Move items ──
  moveItemFull: {
    paddingVertical: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  moveTitle: {
    fontFamily: fonts.medium,
    fontSize: 16,
    color: colors.text,
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
    color: colors.green,
  },
  effortPill: {
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
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
    color: colors.dim,
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
    backgroundColor: '#FFFFFF',
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
  },
  moveApproveBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: '#000000',
  },
  moveVerifyBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
  },
  moveVerifyBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.dim,
  },
  moveDeleteBtn: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingVertical: 10,
    borderRadius: 100,
    alignItems: 'center',
  },
  moveDeleteBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
  },
  viewAllBtn: {
    alignItems: 'center',
    paddingVertical: 16,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  viewAllText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.text,
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
    color: colors.text,
    letterSpacing: -2,
  },
  bigNumberLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginBottom: 4,
  },
  sourceCard: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
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
    color: colors.text,
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
    color: colors.text2,
    letterSpacing: 0.3,
  },
  primaryTag: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  primaryTagText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: 1,
  },
  sourceAmountWrap: {
    alignItems: 'flex-end',
  },
  sourceAmount: {
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: '300',
    color: colors.text,
  },
  sourceAmountPer: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  incomeSourcesHeader: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
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
    borderColor: 'rgba(224,82,82,0.25)',
  },
  removeSourceText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.coral,
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
    color: colors.text,
    letterSpacing: -2,
  },
  safeToSpendLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  safeToSpendBar: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.06)',
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
    color: colors.text2,
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
    color: colors.muted,
    marginTop: 2,
  },
  expandToggle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  expandToggleText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
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
    color: colors.text2,
    marginTop: 8,
  },
  summaryPct: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
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
    color: colors.dim,
  },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addItemLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.text,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  addItemIcon: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
    width: 20,
    height: 20,
    lineHeight: 18,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
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
    borderBottomColor: 'rgba(255,255,255,0.05)',
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
    color: colors.text,
    letterSpacing: 0.2,
  },
  dataMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
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
    borderLeftColor: 'rgba(255,255,255,0.08)',
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
    borderBottomColor: 'rgba(255,255,255,0.03)',
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
    color: colors.text2,
  },
  txDate: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
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
    color: colors.muted,
    marginTop: 3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  txEmpty: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    paddingVertical: 8,
  },
  breakdownSubtext: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    marginBottom: 12,
    lineHeight: 18,
  },
  cardFooter: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
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
    color: colors.green,
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
    color: colors.coral,
    letterSpacing: -2,
  },
  debtHeroLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
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
    borderBottomColor: 'rgba(255,255,255,0.05)',
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
    color: colors.text,
  },
  debtType: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
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
    color: colors.text,
  },
  debtUtil: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
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
    borderColor: colors.green + '30',
    borderRadius: 12,
    borderStyle: 'dashed',
  },
  quickAddIcon: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.green,
  },
  quickAddText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.green,
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
    backgroundColor: '#0A0A0A',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    width: '100%',
    maxWidth: 400,
  },
  modalContentScrollable: {
    backgroundColor: '#0A0A0A',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
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
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCloseIconText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
  },
  modalTitle: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.text,
    letterSpacing: 1,
    textTransform: 'uppercase',
    flex: 1,
  },
  modalSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: 20,
    lineHeight: 18,
  },
  modalInput: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    marginBottom: 12,
  },
  modalLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
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
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 100,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginRight: 8,
  },
  categoryChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  categoryChipText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
  },
  categoryChipTextActive: {
    color: '#000000',
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
    borderColor: 'rgba(255,255,255,0.10)',
  },
  toggleOptionActive: {
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  toggleOptionLifestyle: {
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  toggleText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
    letterSpacing: 0.3,
  },
  toggleTextActive: {
    color: colors.text,
  },
  toggleTextLifestyle: {
    color: colors.text,
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
    borderColor: 'rgba(255,255,255,0.12)',
  },
  modalCancelText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.dim,
  },
  modalSave: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  modalSaveDisabled: {
    opacity: 0.3,
  },
  addItemErrorText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.coral,
    marginBottom: 12,
    lineHeight: 18,
  },
  modalSaveText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: '#000000',
  },

  // ── Verify modal ──
  verifySection: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 2,
    color: colors.dim,
    marginTop: 16,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  verifyText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    lineHeight: 22,
  },
  verifyStep: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  reviewBannerText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text2,
    lineHeight: 20,
  },
  reviewBannerLink: {
    color: colors.green,
    fontFamily: fonts.semibold,
  },

  // ── Categorise review modal ──
  catReviewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    padding: spacing.md,
  },
  catReviewContainer: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
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
    borderBottomColor: colors.border,
  },
  catReviewSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    marginTop: 4,
  },
  catReviewClose: {
    fontFamily: fonts.medium,
    fontSize: 18,
    color: colors.muted,
    padding: 4,
  },
  catReviewList: {
    padding: spacing.md,
  },
  catReviewRow: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  catReviewRowDone: {
    borderColor: 'rgba(0,212,170,0.25)',
    backgroundColor: 'rgba(0,212,170,0.04)',
  },
  catReviewRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  catReviewMerchant: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  catReviewMeta: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    marginTop: 2,
  },
  catReviewAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text2,
    marginLeft: spacing.sm,
  },
  catReviewDone: {
    backgroundColor: colors.green,
    margin: spacing.md,
    marginTop: 0,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  catReviewDoneText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
  },
});
