import { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  LayoutAnimation, Platform, UIManager, TextInput, Modal, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getLastResult } from '@/app/(main)/processing';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { rankMoves, determineFlowchartPosition, calcGoalTrajectory } from '@/lib/move-engine';
import { colors, fonts, spacing, radius } from '@/theme';
import type { Analysis, BudgetCategory, TransactionDetail, IncomeSource, Move, Goals } from '@/lib/types';

/** Strip markdown bold/italic markers from text rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Extended palette matching the BOCY design
const gold = '#E8C55A';
const goldSoft = 'rgba(232, 197, 90, 0.15)';

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
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleMove = (idx: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
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

  const BUDGET_CATEGORIES = [
    'Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport',
    'Dining', 'Shopping', 'Entertainment', 'Subscriptions', 'Health',
    'Childcare', 'Education', 'Charity', 'Other',
  ];

  const saveAddItem = async () => {
    const amount = parseFloat(addItemAmount);
    if (!addItemDesc.trim() || !addItemCategory || isNaN(amount) || amount <= 0) return;

    setAddItemSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      await supabase.from('budget_adjustments').insert({
        user_id: user.id,
        description: addItemDesc.trim(),
        category: addItemCategory,
        monthly_amount: amount,
        is_essential: addItemEssential,
      });

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

        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setAnalysis(updated);
      }

      // Reset form and close
      setAddItemDesc('');
      setAddItemAmount('');
      setAddItemCategory('');
      setAddItemEssential(true);
      setShowAddItem(false);
    } catch (err: any) {
      console.warn('[home] Failed to save budget item:', err?.message);
    }
    setAddItemSaving(false);
  };

  const saveRecategorize = async () => {
    if (!recatTx || !recatTarget) return;
    setSavingRecat(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Save override so future enrichment uses this category
        await supabase.from('transaction_overrides').upsert({
          user_id: user.id,
          match_description: recatTx.tx.merchant || recatTx.tx.description,
          category: recatTarget,
          is_essential: recatEssential,
        }, { onConflict: 'user_id,match_description' });
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

        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setAnalysis(updated);
      }

      setRecatTx(null);
      setRecatTarget('');
    } catch (err: any) {
      console.warn('[home] Recategorize failed:', err?.message);
    }
    setSavingRecat(false);
  };

  const handleRemoveIncomeSource = (sourceName: string) => {
    Alert.alert(
      'Remove income source?',
      `"${sourceName}" will no longer be counted as income. This affects your surplus and recommendations.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemovingSource(sourceName);
            try {
              const { data: { user } } = await supabase.auth.getUser();
              if (user) {
                // Save override to mark this as a transfer (not income)
                await supabase.from('transaction_overrides').upsert({
                  user_id: user.id,
                  match_description: sourceName,
                  category: 'Transfers',
                  is_essential: false,
                }, { onConflict: 'user_id,match_description' });
              }

              // Optimistic update
              if (analysis) {
                const updated = { ...analysis };
                const sources = [...(updated.income_sources || [])];
                const removed = sources.find((s) => s.source === sourceName);
                updated.income_sources = sources.filter((s) => s.source !== sourceName);
                if (removed) {
                  updated.monthly_income = Math.max(0, (updated.monthly_income || 0) - removed.monthly);
                  updated.surplus = (updated.surplus || 0) - removed.monthly;
                }
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setAnalysis(updated);
              }
            } catch (err: any) {
              console.warn('[home] Remove income source failed:', err?.message);
            }
            setRemovingSource(null);
          },
        },
      ],
    );
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

      // Re-run enrichment engine with fresh data (fast, ~1 second)
      const result = EnrichmentEngine.enrich(csvData, overrides);
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
      const ukpf = determineFlowchartPosition(result.profile, goals);
      const rankedMoves = rankMoves(result.decisionStack, result.profile, goals);
      const topRanked = rankedMoves[0] || null;
      const goalTrajectory = topRanked ? topRanked.trajectory : null;

      const allMoves = rankedMoves;
      const topMove = allMoves[0] || null;

      // Merge manual budget adjustments into the enrichment result
      const nonDisc = { ...result.profile.budgetReality.nonDiscretionary };
      const disc = { ...result.profile.budgetReality.discretionary };
      nonDisc.items = [...(nonDisc.items || [])];
      disc.items = [...(disc.items || [])];

      for (const adj of budgetAdjustments) {
        const section = adj.is_essential ? nonDisc : disc;
        const existing = section.items.find((i: BudgetCategory) => i.category === adj.category);
        if (existing) {
          existing.monthly += adj.monthly_amount;
          existing.txs += 1;
          existing.transactions = [...(existing.transactions || []), {
            date: new Date().toISOString().split('T')[0],
            merchant: adj.description,
            description: adj.description + ' (manual)',
            amount: -Math.abs(adj.monthly_amount),
          }];
        } else {
          section.items.push({
            category: adj.category,
            monthly: adj.monthly_amount,
            txs: 1,
            transactions: [{
              date: new Date().toISOString().split('T')[0],
              merchant: adj.description,
              description: adj.description + ' (manual)',
              amount: -Math.abs(adj.monthly_amount),
            }],
          });
        }
        section.total = section.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
      }

      const totalManualSpend = budgetAdjustments.reduce((s: number, a: any) => s + a.monthly_amount, 0);

      const updatedAnalysis: Analysis = {
        user_id: userId,
        archetype: result.archetype.key,
        decision_score: result.decisionScore.score,
        monthly_income: Math.round(result.profile.monthly.income),
        monthly_spending: Math.round(result.profile.monthly.spending + totalManualSpend),
        surplus: Math.round(result.profile.monthly.surplus - totalManualSpend),
        non_discretionary: nonDisc,
        discretionary: disc,
        income_sources: result.profile.incomeSources,
        top_move: topMove || ({} as any),
        all_moves: allMoves,
        behavioral_patterns: result.behavioralPatterns,
        goal_context: goalTrajectory,
      };

      // Save to Supabase
      await supabase.from('analyses').insert({
        user_id: userId,
        archetype: updatedAnalysis.archetype,
        decision_score: updatedAnalysis.decision_score,
        monthly_income: updatedAnalysis.monthly_income,
        monthly_spending: updatedAnalysis.monthly_spending,
        surplus: updatedAnalysis.surplus,
        non_discretionary: updatedAnalysis.non_discretionary,
        discretionary: updatedAnalysis.discretionary,
        income_sources: updatedAnalysis.income_sources,
        top_move: updatedAnalysis.top_move,
        all_moves: updatedAnalysis.all_moves,
        behavioral_patterns: updatedAnalysis.behavioral_patterns,
        goal_context: updatedAnalysis.goal_context,
      });

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
      {/* ── Header ── */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.greeting}>
            Hello, {userName || 'there'}
          </Text>
          {syncing && (
            <Text style={styles.syncText}>Syncing latest transactions...</Text>
          )}
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
          <Text style={styles.emptyIcon}>B</Text>
          <Text style={styles.emptyTitle}>Your #1 financial move awaits</Text>
          <Text style={styles.emptyDesc}>
            Connect your bank account so I can analyse your transactions and identify the single most impactful action you can take right now.
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
          {/* ══════════════════════════════════════════════
              CARD 1 — YOUR TOP MONEY MOVES
              ══════════════════════════════════════════════ */}
          <View style={styles.card}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Your top moves</Text>
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'moves' ? null : 'moves')}>
                <Text style={styles.infoIcon}>i</Text>
              </TouchableOpacity>
            </View>
            {infoCard === 'moves' && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  These recommendations are ranked by financial impact using the UKPF flowchart priority system, weighted by your goals and effort level. Higher-impact, lower-effort actions rank first.
                </Text>
              </View>
            )}
            <Text style={styles.cardSubtitle}>Ranked by impact on your finances</Text>

            {dashboardMoves.length > 0 ? dashboardMoves.map((move: Move, i: number) => {
              const isOpen = expandedMoves.has(i);
              const effortColor = move.effort === 'high' ? colors.coral
                : move.effort === 'medium' ? gold : colors.accent;
              return (
                <TouchableOpacity
                  key={i}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${i + 1}: ${move.action}, saves ${move.annualImpact} pounds per year`}
                  accessibilityHint="Tap to see details"
                  onPress={() => toggleMove(i)}
                  style={styles.moveItem}
                >
                  {/* Rank number */}
                  <Text style={styles.moveRank}>{i + 1}</Text>

                  {/* Content */}
                  <View style={styles.moveContent}>
                    {/* Title — the clear hero */}
                    <Text style={styles.moveTitle} numberOfLines={isOpen ? undefined : 2}>
                      {stripMd(move.action)}
                    </Text>

                    {/* Impact + effort on one line */}
                    <View style={styles.moveMeta}>
                      <Text style={styles.moveImpact}>
                        +{'\u00a3'}{(move.annualImpact || 0).toLocaleString()}/yr
                      </Text>
                      {move.effort && (
                        <View style={[styles.effortPill, { backgroundColor: effortColor + '1A' }]}>
                          <Text style={[styles.effortPillText, { color: effortColor }]}>
                            {move.effort}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Expanded: strategy + action buttons */}
                    {isOpen && (
                      <View style={styles.moveExpanded}>
                        <Text style={styles.moveStrategy}>{stripMd(move.strategy)}</Text>
                        <View style={styles.moveActions}>
                          <TouchableOpacity
                            style={styles.moveApproveBtn}
                            onPress={() => router.push('/(main)/(tabs)/plan')}
                          >
                            <Text style={styles.moveApproveBtnText}>Approve</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={styles.moveVerifyBtn}
                            onPress={() => setVerifyMove(move)}
                          >
                            <Text style={styles.moveVerifyBtnText}>Verify</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </View>
                </TouchableOpacity>
              );
            }) : (
              <Text style={styles.noDataText}>
                No actionable moves yet. Upload a statement to get started.
              </Text>
            )}
          </View>

          {/* ══════════════════════════════════════════════
              CARD 2 — YOUR INCOME
              ══════════════════════════════════════════════ */}
          <View style={styles.card} accessibilityRole="summary" accessibilityLabel={`Monthly income: ${Math.round(income)} pounds`}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Your income</Text>
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'income' ? null : 'income')}>
                <Text style={styles.infoIcon}>i</Text>
              </TouchableOpacity>
            </View>
            {infoCard === 'income' && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  Income is detected from your bank account transactions only (not credit cards). Regular credits matching salary, benefit, or employer patterns are identified. Remove any that aren't real income.
                </Text>
              </View>
            )}

            <View style={styles.bigNumberWrap}>
              <Text style={styles.bigNumber} accessibilityRole="text">
                {'\u00a3'}{Math.round(income).toLocaleString()}
              </Text>
              <Text style={styles.bigNumberLabel}>monthly</Text>
            </View>

            {incomeSources.length > 0 ? (
              <>
                <View style={styles.divider} />
                <Text style={styles.incomeSourcesHeader}>
                  {incomeSources.length} source{incomeSources.length !== 1 ? 's' : ''}
                </Text>
                {incomeSources.map((src: IncomeSource, i: number) => (
                  <View key={i} style={styles.sourceCard}>
                    <View style={styles.sourceRow}>
                      <View style={styles.sourceInfo}>
                        <Text style={styles.sourceName}>{src.source}</Text>
                        <View style={styles.sourceTagRow}>
                          <Text style={styles.sourceFreq}>
                            {src.frequency.charAt(0).toUpperCase() + src.frequency.slice(1)}
                          </Text>
                          {src.isSalary && (
                            <View style={styles.primaryTag}>
                              <Text style={styles.primaryTagText}>PRIMARY</Text>
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
                    >
                      <Text style={styles.removeSourceText}>
                        {removingSource === src.source ? 'Removing...' : 'Not income? Remove'}
                      </Text>
                    </TouchableOpacity>
                  </View>
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
            <View style={styles.cardTitleRow}>
              <Text style={styles.cardTitle}>Safe to spend</Text>
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'safe' ? null : 'safe')}>
                <Text style={styles.infoIcon}>i</Text>
              </TouchableOpacity>
            </View>
            {infoCard === 'safe' && (
              <View style={styles.infoBox}>
                <Text style={styles.infoBoxText}>
                  This is your weekly lifestyle budget: (Monthly income - Essentials) / 4.33, minus what you've already spent on lifestyle this month. It tells you how much discretionary spending you can still afford this week.
                </Text>
              </View>
            )}
            <Text style={styles.cardSubtitle}>Your weekly lifestyle allowance</Text>

            {/* Big remaining number */}
            <View style={styles.safeToSpendHero}>
              <Text style={[styles.safeToSpendAmount, !weeklyHealthy && { color: colors.coral }]}>
                {'\u00a3'}{Math.round(weeklyRemaining).toLocaleString()}
              </Text>
              <Text style={styles.safeToSpendLabel}>left this week</Text>
            </View>

            {/* Progress bar */}
            <View style={styles.safeToSpendBar}>
              <View
                style={[
                  styles.safeToSpendBarFill,
                  {
                    width: `${weeklyUsedPct}%`,
                    backgroundColor: weeklyHealthy ? colors.accent : colors.coral,
                  },
                ]}
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

            {/* Tappable header to toggle breakdown */}
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setBudgetExpanded((prev) => !prev);
              }}
              style={styles.budgetHeaderRow}
            >
              <View>
                <Text style={styles.cardTitle}>Your budget reality</Text>
                {!budgetExpanded && (
                  <Text style={styles.expandHint}>Tap to see full breakdown</Text>
                )}
              </View>
              <View style={styles.expandToggle}>
                <Text style={styles.expandToggleText}>{budgetExpanded ? '\u25B2' : '\u25BC'}</Text>
              </View>
            </TouchableOpacity>

            {/* 3-segment stacked bar */}
            <View style={styles.budgetBar}>
              {nonDiscFlex > 0 && (
                <View style={[styles.barSeg, { flex: nonDiscFlex, backgroundColor: colors.coral }]} />
              )}
              {discFlex > 0 && (
                <View style={[styles.barSeg, { flex: discFlex, backgroundColor: gold }]} />
              )}
              {leftFlex > 0 && (
                <View style={[styles.barSeg, { flex: leftFlex, backgroundColor: colors.accent }]} />
              )}
            </View>

            {/* Summary row — always visible */}
            <View style={[styles.summaryRow, !budgetExpanded && { marginBottom: 0 }]}>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: colors.coral }]}>
                  {'\u00a3'}{Math.round(nonDiscTotal).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Non-negotiable</Text>
                <Text style={styles.summaryPct}>{nonDiscPct}%</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: gold }]}>
                  {'\u00a3'}{Math.round(discTotal).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Lifestyle</Text>
                <Text style={styles.summaryPct}>{discPct}%</Text>
              </View>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryAmount, { color: colors.accent }]}>
                  {'\u00a3'}{Math.round(leftToDecide).toLocaleString()}
                </Text>
                <Text style={styles.summaryLabel}>Left to decide</Text>
                <Text style={styles.summaryPct}>{leftPct}%</Text>
              </View>
            </View>

            {/* Collapsible breakdown sections */}
            {budgetExpanded && (
              <>
                {/* Non-negotiable breakdown */}
                {nonDiscItems.length > 0 && (
                  <>
                    <View style={styles.breakdownHeaderRow}>
                      <Text style={styles.breakdownHeader}>ESSENTIALS</Text>
                      <TouchableOpacity
                        style={styles.addItemBtn}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setShowAddItem(true);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={styles.addItemLabel}>Add item</Text>
                        <Text style={styles.addItemIcon}>+</Text>
                      </TouchableOpacity>
                    </View>
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
                              <Text style={[styles.catArrow, { color: colors.coral }]}>{isExpanded ? '\u25BC' : '\u25B6'}</Text>
                              <View style={styles.catInfo}>
                                <Text style={styles.dataLabel}>{item.category}</Text>
                                <Text style={styles.dataMeta}>
                                  {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of essentials
                                </Text>
                              </View>
                            </View>
                            <View style={styles.dataRowRight}>
                              <Text style={[styles.dataValue, { color: colors.coral }]}>
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
                                    <Text style={[styles.txAmount, { color: colors.coral }]}>
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
                )}

                {/* Lifestyle spending */}
                {discItems.length > 0 && (
                  <>
                    <View style={[styles.breakdownHeaderRow, { marginTop: 28 }]}>
                      <Text style={styles.breakdownHeader}>LIFESTYLE</Text>
                      <TouchableOpacity
                        style={styles.addItemBtn}
                        onPress={() => {
                          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                          setShowAddItem(true);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Text style={styles.addItemLabel}>Add item</Text>
                        <Text style={styles.addItemIcon}>+</Text>
                      </TouchableOpacity>
                    </View>
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
                              <Text style={[styles.catArrow, { color: gold }]}>{isExpanded ? '\u25BC' : '\u25B6'}</Text>
                              <View style={styles.catInfo}>
                                <Text style={styles.dataLabel}>{item.category}</Text>
                                <Text style={styles.dataMeta}>
                                  {item.txs} txn{item.txs !== 1 ? 's' : ''} · {pctOfSection}% of lifestyle
                                </Text>
                              </View>
                            </View>
                            <View style={styles.dataRowRight}>
                              <Text style={[styles.dataValue, { color: gold }]}>
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
                                    <Text style={[styles.txAmount, { color: gold }]}>
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
                )}

                <Text style={styles.cardFooter}>Tap any category to expand transactions</Text>
              </>
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
                <View style={styles.cardTitleRow}>
                  <Text style={styles.cardTitle}>Your debt</Text>
                  <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setInfoCard(infoCard === 'debt' ? null : 'debt')}>
                    <Text style={styles.infoIcon}>i</Text>
                  </TouchableOpacity>
                </View>
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
                <View style={styles.debtHero}>
                  <Text style={styles.debtHeroAmount}>
                    {'\u00a3'}{Math.round(totalDebt).toLocaleString()}
                  </Text>
                  <Text style={styles.debtHeroLabel}>total outstanding</Text>
                </View>

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
                    <View
                      key={i}
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
                  );
                })}
              </View>
            );
          })()}

          {/* Add budget item modal */}
          <Modal visible={showAddItem} transparent animationType="fade">
            <View style={styles.modalOverlay}>
              <View style={styles.modalContent}>
                <Text style={styles.modalTitle}>Add budget item</Text>
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

                {/* Actions */}
                <View style={styles.modalActions}>
                  <TouchableOpacity
                    style={styles.modalCancel}
                    onPress={() => setShowAddItem(false)}
                  >
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.modalSave,
                      (!addItemDesc.trim() || !addItemCategory || !addItemAmount) && styles.modalSaveDisabled,
                    ]}
                    onPress={saveAddItem}
                    disabled={addItemSaving || !addItemDesc.trim() || !addItemCategory || !addItemAmount}
                  >
                    {addItemSaving ? (
                      <ActivityIndicator color={colors.bg} size="small" />
                    ) : (
                      <Text style={styles.modalSaveText}>Add</Text>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>

          {/* Verify move detail modal */}
          <Modal visible={!!verifyMove} transparent animationType="fade">
            <View style={styles.modalOverlay}>
              <ScrollView style={{ maxHeight: '80%' }}>
                <View style={styles.modalContent}>
                  <Text style={styles.modalTitle}>Verify recommendation</Text>

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
                          <Text style={styles.moveVerifyBtnText}>Discard</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              </ScrollView>
            </View>
          </Modal>

          {/* Re-categorize transaction modal */}
          <Modal visible={!!recatTx} transparent animationType="fade">
            <View style={styles.modalOverlay}>
              <View style={styles.modalContent}>
                <Text style={styles.modalTitle}>Move transaction</Text>
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
              </View>
            </View>
          </Modal>

        </>
      )}
    </ScrollView>
  );
}

// ── Styles ──

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scroll: {
    padding: 20,
    paddingTop: 56,
    paddingBottom: 48,
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
    marginBottom: 32,
  },
  greeting: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: colors.text,
    letterSpacing: -0.2,
  },
  menuButton: {
    padding: 10,
    gap: 5,
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuLine: {
    width: 22,
    height: 2,
    backgroundColor: colors.text,
    borderRadius: 1,
  },
  menuLineShort: {
    width: 16,
    backgroundColor: colors.dim,
  },
  syncText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
    marginTop: 4,
  },

  // ── Empty State ──
  emptyState: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
  emptyIcon: {
    fontFamily: fonts.heading,
    fontSize: 40,
    color: colors.accent,
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontFamily: fonts.semibold,
    fontSize: 20,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
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
    borderRadius: radius.md,
    alignItems: 'center',
    width: '100%',
  },
  ctaText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },

  // ── Shared Card ──
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 16,
    padding: 24,
    paddingTop: 28,
    paddingBottom: 28,
    marginBottom: 24,
    overflow: 'hidden',
  },
  cardTitle: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    letterSpacing: -0.2,
    marginBottom: 6,
  },
  cardSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    lineHeight: 20,
    marginBottom: 24,
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
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.dim,
    width: 22,
    height: 22,
    lineHeight: 22,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 11,
    overflow: 'hidden',
  },
  infoBox: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    padding: 12,
    marginTop: 8,
    marginBottom: 8,
  },
  infoBoxText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    lineHeight: 18,
  },

  // ── Card 1: Recommendations ──
  // ── Card 1: Move items ──
  moveItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 14,
    gap: 14,
  },
  moveRank: {
    fontFamily: fonts.mono,
    fontSize: 28,
    fontWeight: '800',
    color: 'rgba(255,255,255,0.10)',
    lineHeight: 32,
    width: 28,
    textAlign: 'center',
  },
  moveContent: {
    flex: 1,
  },
  moveTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    lineHeight: 22,
  },
  moveMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
  },
  moveImpact: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
  },
  effortPill: {
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 7,
  },
  effortPillText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'capitalize',
    letterSpacing: 0.3,
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
  },
  moveActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  moveApproveBtn: {
    flex: 1,
    backgroundColor: colors.accent,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  moveApproveBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.bg,
  },
  moveVerifyBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  moveVerifyBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.dim,
  },

  // ── Card 2: Income ──
  bigNumberWrap: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingBottom: 28,
  },
  bigNumber: {
    fontFamily: fonts.mono,
    fontSize: 48,
    fontWeight: '800',
    color: colors.accent,
    letterSpacing: -1,
  },
  bigNumberLabel: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginBottom: 4,
  },
  sourceCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    borderRadius: 12,
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
    fontFamily: fonts.heading,
    fontSize: 16,
    color: colors.text,
    lineHeight: 21,
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
    color: 'rgba(122,239,199,0.6)',
  },
  primaryTag: {
    backgroundColor: colors.accentDim,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  primaryTagText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    fontWeight: '600',
    color: colors.accent,
    letterSpacing: 0.8,
  },
  sourceAmountWrap: {
    alignItems: 'flex-end',
  },
  sourceAmount: {
    fontFamily: fonts.mono,
    fontSize: 20,
    fontWeight: '800',
    color: colors.accent,
  },
  sourceAmountPer: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  incomeSourcesHeader: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 0.5,
    marginBottom: 4,
    marginTop: 8,
  },
  removeSourceBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  removeSourceText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
  },

  // ── Card 3: Safe to Spend ──
  safeToSpendHero: {
    alignItems: 'center',
    paddingVertical: 16,
    paddingBottom: 20,
  },
  safeToSpendAmount: {
    fontFamily: fonts.mono,
    fontSize: 44,
    fontWeight: '800',
    color: colors.accent,
    letterSpacing: -1,
  },
  safeToSpendLabel: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
    marginTop: 4,
  },
  safeToSpendBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
    marginBottom: 16,
  },
  safeToSpendBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  safeToSpendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  safeToSpendMeta: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.muted,
  },

  // ── Card 4: Budget Reality ──
  budgetHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
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
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  expandToggleText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.dim,
  },
  budgetBar: {
    flexDirection: 'row',
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 20,
  },
  barSeg: {
    borderRadius: 0,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  summaryItem: {
    alignItems: 'center',
    flex: 1,
  },
  summaryAmount: {
    fontFamily: fonts.mono,
    fontSize: 18,
    fontWeight: '800',
  },
  summaryLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    marginTop: 2,
  },
  summaryPct: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 1,
  },
  breakdownHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  breakdownHeader: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  addItemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addItemLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
  },
  addItemIcon: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: colors.accent,
    width: 22,
    height: 22,
    lineHeight: 20,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: 11,
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
    fontSize: 10,
    marginTop: 4,
    width: 14,
  },
  catInfo: {
    flex: 1,
  },
  dataLabel: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: colors.dim,
  },
  dataMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  dataRowRight: {
    alignItems: 'flex-end',
  },
  dataValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: '600',
  },

  // ── Transaction dropdown ──
  txDropdown: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(255,255,255,0.06)',
    marginLeft: 10,
    marginBottom: 8,
    paddingLeft: 14,
    paddingVertical: 6,
  },
  txRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 9,
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
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text2,
  },
  txDate: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  txAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    fontWeight: '600',
  },
  txRightCol: {
    alignItems: 'flex-end',
  },
  txRecatHint: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: colors.muted,
    marginTop: 2,
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
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 16,
  },

  // ── Card 5: Debt accounts ──
  debtHero: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingBottom: 20,
  },
  debtHeroAmount: {
    fontFamily: fonts.mono,
    fontSize: 40,
    fontWeight: '800',
    color: colors.coral,
    letterSpacing: -1,
  },
  debtHeroLabel: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
    marginTop: 4,
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
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  debtType: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  debtRowRight: {
    alignItems: 'flex-end',
  },
  debtBalance: {
    fontFamily: fonts.mono,
    fontSize: 16,
    fontWeight: '700',
    color: colors.text,
  },
  debtUtil: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },

  // ── Add item button ──

  // ── Modal ──
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: colors.accentDim,
  },
  modalTitle: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
    marginBottom: 4,
  },
  modalSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: 20,
    lineHeight: 18,
  },
  modalInput: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    marginBottom: 12,
  },
  modalLabel: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.muted,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  categoryScroll: {
    marginBottom: 16,
    maxHeight: 36,
  },
  categoryChip: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginRight: 8,
  },
  categoryChipActive: {
    backgroundColor: colors.accentDim,
  },
  categoryChipText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
  },
  categoryChipTextActive: {
    color: colors.accent,
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
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  toggleOptionActive: {
    borderColor: colors.coral,
    backgroundColor: 'rgba(232,96,99,0.1)',
  },
  toggleOptionLifestyle: {
    borderColor: '#E8C55A',
    backgroundColor: 'rgba(232,197,90,0.1)',
  },
  toggleText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
  },
  toggleTextActive: {
    color: colors.coral,
  },
  toggleTextLifestyle: {
    color: '#E8C55A',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  modalCancelText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.dim,
  },
  modalSave: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  modalSaveDisabled: {
    opacity: 0.4,
  },
  modalSaveText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.bg,
  },

  // ── Verify modal ──
  verifySection: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    color: colors.accent,
    marginTop: 16,
    marginBottom: 6,
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
});
