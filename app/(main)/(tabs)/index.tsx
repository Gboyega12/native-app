import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, ActivityIndicator,
  LayoutAnimation, Platform, UIManager, TextInput, Modal, Alert, Pressable,
  RefreshControl, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { getLastResult } from '@/app/(main)/processing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestSync, onSyncComplete, getLastSyncTime, invalidateSyncCache } from '@/lib/sync-coordinator';
import type { WeeklyContext } from '@/lib/sync';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import { BocyFace, getBocyMood } from '@/components/Bocy';
import type { Analysis, BudgetCategory, TransactionDetail, IncomeSource, Move, Goals } from '@/lib/types';
import { useSubscription } from '@/lib/subscription';
import Card, { AnimatedCard, AnimGlyph, BreathingBar, CardTitle, CardTitleRow, InfoIcon, InfoBox, ExpandDots, SMOOTH_ANIM, ConnectorDots, type ConnectorDotsHandle } from '@/components/Card';
import Walkthrough, { useWalkthrough } from '@/components/Walkthrough';
import InsightModal from '@/components/InsightModal';

/** Strip markdown bold/italic markers from text rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

/** Human-friendly "X ago" label from epoch ms */
function formatTimeAgo(epochMs: number): string {
  const diffSec = Math.round((Date.now() - epochMs) / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}


export default function Home() {
  const router = useRouter();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [expandedMoves, setExpandedMoves] = useState<Set<number>>(new Set());
  const [txCardExpanded, setTxCardExpanded] = useState(false);
  const [debtAccounts, setDebtAccounts] = useState<any[]>([]);
  const [weeklyCtx, setWeeklyCtx] = useState<WeeklyContext | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number>(0);
  const [latestTxDate, setLatestTxDate] = useState<string | null>(null);
  const [syncDataSource, setSyncDataSource] = useState<'truelayer' | 'fallback' | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [connectionWarning, setConnectionWarning] = useState<{ message: string; banks: string[] } | null>(null);
  const [connectionDismissed, setConnectionDismissed] = useState(false);
  const [incomeDismissed, setIncomeDismissed] = useState(false);
  const { showWalkthrough, dismissWalkthrough } = useWalkthrough();
  const dashScrollRef = useRef<ScrollView>(null);
  const cardPositions = useRef<Record<string, number>>({});

  // ── Connection banner dismiss ──
  // Keyed by the sorted bank names. Dismissing stores these bank names.
  // Banner only reappears if the set of expired banks actually changes
  // (i.e. a new bank expires, or the user reconnects and a different one lapses).
  // Cleared automatically when all connections sync OK (connectionWarning = null).
  const CONN_DISMISS_KEY = 'dismiss:conn:banks';

  useEffect(() => {
    if (!connectionWarning) return; // Don't reset — keep dismissed state until warning arrives
    AsyncStorage.getItem(CONN_DISMISS_KEY).then((stored) => {
      if (!stored) { setConnectionDismissed(false); return; }
      // Compare stored bank fingerprint with current warning
      const currentFingerprint = connectionWarning.banks.sort().join(',');
      setConnectionDismissed(stored === currentFingerprint);
    }).catch(() => {});
  }, [connectionWarning]);

  // When connections are healthy, clear the stored dismiss so future warnings are fresh
  useEffect(() => {
    if (connectionWarning === null) {
      AsyncStorage.removeItem(CONN_DISMISS_KEY).catch(() => {});
    }
  }, [connectionWarning]);

  // ── Income banner dismiss ──
  // Keyed by a fingerprint of the actual income events (source + amount).
  // Stays dismissed until genuinely different income arrives.
  const INCOME_DISMISS_KEY = 'dismiss:income:events';

  const incomeFingerprint = useMemo(() => {
    const events = Array.isArray(weeklyCtx?.recentIncomeEvents) ? weeklyCtx.recentIncomeEvents : [];
    if (events.length === 0) return '';
    return events.map((e) => `${e?.source ?? ''}:${Math.round(e?.amount ?? 0)}`).sort().join('|');
  }, [weeklyCtx?.recentIncomeEvents]);

  useEffect(() => {
    if (!incomeFingerprint) return; // No income events yet — keep current state
    AsyncStorage.getItem(INCOME_DISMISS_KEY).then((stored) => {
      setIncomeDismissed(stored === incomeFingerprint);
    }).catch(() => {});
  }, [incomeFingerprint]);

  const dismissConnection = () => {
    setConnectionDismissed(true);
    if (connectionWarning) {
      AsyncStorage.setItem(CONN_DISMISS_KEY, connectionWarning.banks.sort().join(',')).catch(() => {});
    }
  };
  const dismissIncome = () => {
    setIncomeDismissed(true);
    if (incomeFingerprint) {
      AsyncStorage.setItem(INCOME_DISMISS_KEY, incomeFingerprint).catch(() => {});
    }
  };

  // ── Show insight modal on app open when income arrives ──
  useEffect(() => {
    if (weeklyCtx?.incomeArrivedThisWeek && Array.isArray(weeklyCtx?.recentIncomeEvents) && weeklyCtx.recentIncomeEvents.length > 0 && !incomeDismissed) {
      // Small delay to let the dashboard render first
      const timer = setTimeout(() => setShowInsightModal(true), 600);
      return () => clearTimeout(timer);
    }
  }, [weeklyCtx?.incomeArrivedThisWeek, incomeDismissed]);

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

  const isCurrentYear = (dateStr: string) => {
    return new Date(dateStr).getFullYear() === new Date().getFullYear();
  };

  const isCurrentMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  };

  const isCurrentWeek = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    monday.setHours(0, 0, 0, 0);
    return d >= monday;
  };

  const { isTrial, trialDaysLeft } = useSubscription();
  const [showInsightModal, setShowInsightModal] = useState(false);
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

  // Previous month snapshot for real income comparison
  const [prevSnapshot, setPrevSnapshot] = useState<{ monthly_spending: number; monthly_income: number } | null>(null);

  // ── Plan data (merged from plan page) ──
  const [userPlans, setUserPlans] = useState<any[]>([]);
  const [planProgress, setPlanProgress] = useState<Record<string, { move_key: string; move_action: string; approved: boolean; completed_steps: number[] }>>({});
  const [expandedMove, setExpandedMove] = useState<number | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [budgetExpanded, setBudgetExpanded] = useState(false);
  const [showAllMoves, setShowAllMoves] = useState(false);
  const userIdRef = useRef<string | null>(null);

  // Custom weekly spending limit
  const [customWeeklyLimit, setCustomWeeklyLimit] = useState<number | null>(null);
  const [showLimitEditor, setShowLimitEditor] = useState(false);
  const [showWeeklyInfo, setShowWeeklyInfo] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [breakdownExpanded, setBreakdownExpanded] = useState(false);
  const [budgetPeriod, setBudgetPeriod] = useState<'year' | 'month' | 'week'>('month');
  const budgetPeriodInitialised = useRef(false);
  const connectorDotsRef = useRef<ConnectorDotsHandle>(null);
  const txManuallyCollapsed = useRef(false);

  // Default budget period matches salary frequency
  useEffect(() => {
    if (budgetPeriodInitialised.current) return;
    const sources = Array.isArray(analysis?.income_sources) ? analysis.income_sources : [];
    const primary = sources.find((s: IncomeSource) => s?.isSalary)
      || (sources.length > 0
        ? sources.reduce((a: IncomeSource, b: IncomeSource) => (a?.avgAmount ?? 0) > (b?.avgAmount ?? 0) ? a : b)
        : null);
    if (!primary) return;
    budgetPeriodInitialised.current = true;
    const freq = primary.frequency;
    if (freq === 'weekly' || freq === 'fortnightly') setBudgetPeriod('week');
    else setBudgetPeriod('month');
  }, [analysis]);

  // Load custom weekly limit from storage
  useEffect(() => {
    AsyncStorage.getItem('custom_weekly_limit').then((val) => {
      if (val) setCustomWeeklyLimit(parseFloat(val));
    }).catch(() => {});
  }, []);

  // Categorise review modal state
  const [showCatReview, setShowCatReview] = useState(false);
  const [catAssignments, setCatAssignments] = useState<Record<string, { category: string; isEssential: boolean; aiSuggested?: boolean }>>({});
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
      const items = (section as any)?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item?.category === 'Other') {
          txs.push(...(Array.isArray(item.transactions) ? item.transactions : []));
        }
      }
    }
    // Group by normalized merchant/description — user assigns one category per group
    const groups = new Map<string, { key: string; label: string; merchants: string[]; txs: TransactionDetail[]; total: number }>();
    for (const tx of txs) {
      if (!tx) continue;
      const raw = tx.merchant || tx.description || '';
      const normalized = normalizeMerchant(raw);
      if (!groups.has(normalized)) groups.set(normalized, { key: normalized, label: raw, merchants: [], txs: [], total: 0 });
      const g = groups.get(normalized)!;
      if (!g.merchants.includes(raw)) g.merchants.push(raw);
      g.txs.push(tx);
      g.total += Math.abs(tx.amount ?? 0);
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

        const suggestions: Record<string, { category: string; isEssential: boolean; aiSuggested?: boolean }> = {};
        for (const cls of data.classifications) {
          const group = unresolvedGroups[cls.index];
          if (!group) continue;
          const category = mapClaudeCategory(cls.category);
          if (category === 'Other') continue;
          suggestions[group.key] = { category, isEssential: ESSENTIAL_CATS.has(category), aiSuggested: true };
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
            .maybeSingle();
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
      // Invalidate cached sync so returning from connect screen always fetches fresh data
      invalidateSyncCache();
      loadData();
      // Subscribe to sync completions from other screens
      const unsub = onSyncComplete((result) => {
        if (!result) return;
        if (result.weeklyContext) setWeeklyCtx(result.weeklyContext);
      });
      return () => unsub();
    }, [])
  );

  // Merge budget adjustments into an analysis object
  const mergeAdjustments = (base: Analysis, adjustments: any[]): Analysis => {
    if (!base || !adjustments.length) return base;

    const updated = { ...base };
    const nonDisc = { ...((updated.non_discretionary as any) || { total: 0, items: [] }) };
    const disc = { ...((updated.discretionary as any) || { total: 0, items: [] }) };
    nonDisc.items = [...(Array.isArray(nonDisc.items) ? nonDisc.items : [])];
    disc.items = [...(Array.isArray(disc.items) ? disc.items : [])];

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

      const rawName = user.user_metadata?.full_name?.split(' ')[0] || '';
      setUserName(rawName ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : '');
      userIdRef.current = user.id;

      // ── Record daily streak ──
      try {
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const { data: streak } = await supabase
          .from('user_streaks')
          .select('current_streak, longest_streak, last_active_date, total_active_days')
          .eq('user_id', user.id)
          .maybeSingle();

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

      // Fetch user plans + progress (merged from plan page)
      try {
        const [plansRes, progressRes] = await Promise.all([
          supabase.from('user_plans').select('*').eq('user_id', user.id)
            .eq('status', 'active').order('created_at', { ascending: false }),
          supabase.from('plan_progress').select('*').eq('user_id', user.id),
        ]);
        setUserPlans(plansRes.data || []);
        const progressMap: Record<string, any> = {};
        for (const row of (progressRes.data || [])) {
          if (!row.move_key.startsWith('dismissed-')) {
            progressMap[row.move_key] = {
              move_key: row.move_key,
              move_action: row.move_action,
              approved: row.approved,
              completed_steps: row.completed_steps || [],
            };
          }
        }
        setPlanProgress(progressMap);
      } catch {}

      // Fetch the latest persisted analysis from Supabase.
      // Only fall back to in-memory result if Supabase has nothing.
      // This eliminates the visual "flash" of showing stale in-memory data
      // before Supabase data arrives.
      const { data, error } = await supabase
        .from('analyses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn('[home] Failed to fetch analysis:', error.message);
      }

      const lastResult = getLastResult();
      if (data) {
        setAnalysis(mergeAdjustments(data, adjustments));
      } else if (lastResult) {
        // Fallback: use in-memory result only if Supabase has nothing yet
        setAnalysis(mergeAdjustments(lastResult, adjustments));
      }

      // Fetch previous month's snapshot for real income comparison
      try {
        const now = new Date();
        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        const { data: prevData } = await supabase
          .from('score_history')
          .select('monthly_spending, monthly_income')
          .eq('user_id', user.id)
          .gte('created_at', prevMonth.toISOString())
          .lte('created_at', prevMonthEnd.toISOString())
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        setPrevSnapshot(prevData ?? null);
      } catch {
        setPrevSnapshot(null);
      }

      // Trigger background sync if user has any analysis data
      if (data || lastResult) {
        syncInBackground(user.id);
      }
    } catch (err: any) {
      console.warn('[home] loadData error:', err?.message);
      setAnalysis(null);
    }
    setLoading(false);
  };

  // Pull-to-refresh handler — force a fresh TrueLayer fetch
  const onRefresh = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setRefreshing(true);
      invalidateSyncCache();
      await syncInBackground(user.id, true);
    } catch (err: any) {
      console.warn('[home] onRefresh error:', err?.message);
    }
    setRefreshing(false);
  }, []);

  // Background sync: refresh bank data via TrueLayer and re-run analysis
  const syncInBackground = async (userId: string, force: boolean = false) => {
    try {
      setSyncing(true);
      setSyncError(null);

      const result = await requestSync(userId, force);
      if (!result) {
        setSyncing(false);
        setSyncError('Sync returned no data — pull down to retry');
        return;
      }

      // Track data freshness
      setSyncDataSource(result.dataSource);
      if (result.latestTransactionDate) setLatestTxDate(result.latestTransactionDate);

      // Surface connection issues to the user
      if (result.connectionIssues?.length > 0) {
        const banks = result.expiredBankNames ?? [];
        if (result.connectionIssues.includes('token_expired') || result.connectionIssues.includes('no_connection')) {
          setConnectionWarning({ message: 'all_expired', banks });
        } else if (result.connectionIssues.includes('some_connections_expired')) {
          setConnectionWarning({ message: 'some_expired', banks });
        } else if (result.connectionIssues.includes('sync_failed')) {
          setConnectionWarning({ message: 'sync_failed', banks: [] });
        }
      } else if (result.dataSource === 'fallback') {
        // Check how stale the fallback data is
        const txAge = result.latestTransactionDate
          ? Math.floor((Date.now() - new Date(result.latestTransactionDate).getTime()) / (1000 * 60 * 60 * 24))
          : 999;
        if (txAge >= 2) {
          setConnectionWarning({ message: 'stale_data', banks: [] });
        } else {
          setConnectionWarning({ message: 'fallback', banks: [] });
        }
      } else if (result.expiringConnections?.length > 0) {
        // Proactive warning: connections approaching 90-day consent expiry
        const expiringBanks = result.expiringConnections.map(
          (c: { name: string; daysLeft: number }) => `${c.name} (${c.daysLeft}d left)`
        );
        setConnectionWarning({ message: 'expiring', banks: expiringBanks });
      } else {
        // All connections synced OK — clear warning
        setConnectionWarning(null);
      }

      // Warn if data is stale (latest transaction > 2 days old)
      if (result.latestTransactionDate) {
        const txAge = Math.floor((Date.now() - new Date(result.latestTransactionDate).getTime()) / (1000 * 60 * 60 * 24));
        if (txAge >= 2) {
          setSyncError(`Transactions are ${txAge} days old — pull down to retry`);
        }
      }

      // Update debt accounts: merge synced with any manual debts
      try {
        const { data: allDebt } = await supabase
          .from('debt_accounts')
          .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, last_updated, source')
          .eq('user_id', userId);
        if (allDebt) setDebtAccounts(allDebt);
      } catch {
        if (result.debtAccounts?.length > 0) setDebtAccounts(result.debtAccounts);
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

      // Only update analysis if sync returned materially different data
      // to avoid a visual flash when the numbers haven't changed
      const fresh = mergeAdjustments(result.analysis, budgetAdjustments);
      setAnalysis((prev) => {
        if (
          prev &&
          prev.monthly_income === fresh.monthly_income &&
          prev.monthly_spending === fresh.monthly_spending &&
          prev.surplus === fresh.surplus &&
          prev.decision_score === fresh.decision_score
        ) {
          return prev; // No material change — skip re-render
        }
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        return fresh;
      });
      setLastSynced(getLastSyncTime());
    } catch (err: any) {
      console.warn('[home] Background sync failed:', err?.message);
      setSyncError('Sync failed — pull down to retry');
    }
    setSyncing(false);
  };

  // ── Plan handlers (merged from plan page) ──
  const effortOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const effortColor = (e: string) => e === 'low' ? colors.lavender : e === 'medium' ? colors.dim : colors.green;
  const effortLabel = (e: string) => e === 'low' ? 'Quick win' : e === 'medium' ? 'Some effort' : 'Big move';

  const togglePlanStep = (key: string, stepIndex: number, moveAction: string) => {
    setPlanProgress((prev) => {
      const row = prev[key] || { move_key: key, move_action: moveAction, approved: true, completed_steps: [] };
      const steps = [...row.completed_steps];
      const idx = steps.indexOf(stepIndex);
      if (idx >= 0) steps.splice(idx, 1); else steps.push(stepIndex);
      const updated = { ...row, completed_steps: steps };
      // Persist
      const uid = userIdRef.current;
      if (uid) {
        supabase.from('plan_progress').upsert({
          user_id: uid, move_key: key, move_action: moveAction,
          approved: updated.approved, completed_steps: steps,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,move_key' }).then(() => {});
      }
      return { ...prev, [key]: updated };
    });
  };

  const handleStartMove = async (index: number, move: Move) => {
    const uid = userIdRef.current;
    if (!uid) return;
    const key = `move-${index}`;
    if (planProgress[key]?.approved) return;
    const row = { move_key: key, move_action: move.action, approved: true, completed_steps: [] as number[] };
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setPlanProgress((prev) => ({ ...prev, [key]: row }));
    await supabase.from('plan_progress').upsert({
      user_id: uid, move_key: key, move_action: move.action,
      approved: true, completed_steps: [],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,move_key' });
  };

  const handleStopMove = async (index: number) => {
    const uid = userIdRef.current;
    if (!uid) return;
    const key = `move-${index}`;
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setPlanProgress((prev) => { const u = { ...prev }; delete u[key]; return u; });
    await supabase.from('plan_progress').delete().eq('user_id', uid).eq('move_key', key);
  };

  /** Generate actionable steps for user plans */
  const getPlanSteps = (plan: any): string[] => {
    const action = (plan.action || '').toLowerCase();
    if (action.includes('emergency') || action.includes('buffer')) {
      return [
        'Set aside your target amount on payday',
        'Automate it so you don\'t have to think about it',
        'Bocy will track your buffer progress each month',
      ];
    }
    if (action.includes('debt') || action.includes('credit') || action.includes('pay off')) {
      return [
        'List all debts with their interest rates',
        'Set up minimum payments on all debts',
        'Direct any extra to the highest-rate debt first',
        'Bocy will track your debt-free countdown',
      ];
    }
    if (action.includes('save') || action.includes('saving')) {
      return [
        'Set up automatic monthly transfer on payday',
        'Automate it — hands-free saving',
        'Bocy will update your progress each month',
      ];
    }
    if (action.includes('invest')) {
      return [
        'Start with a small monthly amount you won\'t miss',
        'Set it and forget it — don\'t check daily',
        'Bocy will flag when to review your approach',
      ];
    }
    if (action.includes('subscript') || action.includes('cancel')) {
      return [
        'Review active subscriptions this week',
        'Cancel the ones you haven\'t used in 30 days',
        'Bocy will check again next month',
      ];
    }
    return [
      'Break this goal into a weekly action',
      'Start with the smallest step this week',
      'Bocy will check in on your progress',
    ];
  };

  const handleRemovePlan = async (planId: string) => {
    const uid = userIdRef.current;
    if (!uid) return;
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setUserPlans((prev) => prev.filter((p) => p.id !== planId));
    setExpandedPlan(null);

    try {
      // Use the API endpoint (service-role key) so RLS doesn't block the delete
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', plan_id: planId, user_id: uid }),
      });
      if (!res.ok) throw new Error('API delete failed');
    } catch {
      // Fallback: delete directly via Supabase client (works on native)
      try {
        const { error } = await supabase
          .from('user_plans')
          .update({ status: 'dismissed' })
          .eq('id', planId)
          .eq('user_id', uid);

        if (error) {
          await supabase.from('user_plans').delete().eq('id', planId).eq('user_id', uid);
        }
      } catch (err: any) {
        console.warn('[home] Failed to delete plan:', err?.message);
      }
    }

    // Clean up any progress for this plan
    try {
      await supabase.from('plan_progress').delete().eq('user_id', uid).eq('move_key', `plan-${planId}`);
    } catch {}
  };


  /** Provider actions for a move */
  const PROVIDER_ACTIONS: Record<string, { label: string; sub?: string; phone?: string; url?: string }[]> = {
    debt: [
      { label: 'Call StepChange', sub: 'Free debt help', phone: '0800 138 1111' },
      { label: 'Visit StepChange', url: 'https://www.stepchange.org' },
    ],
    buffer: [{ label: 'Compare savings accounts', url: 'https://www.bocy.io/savings-comparison.html' }],
    savings: [{ label: 'Compare savings rates', url: 'https://www.bocy.io/savings-comparison.html' }],
    invest: [{ label: 'Compare ISAs', url: 'https://www.bocy.io/isa-comparison.html' }],
  };

  const getProviderActions = (move: Move) => {
    const a = (move.action || '').toLowerCase();
    const cat = move.category || '';
    if (cat === 'debt' || a.includes('debt')) return PROVIDER_ACTIONS.debt;
    if (cat === 'buffer' || a.includes('buffer') || a.includes('emergency')) return PROVIDER_ACTIONS.buffer;
    if (cat === 'savings' || a.includes('saving')) return PROVIDER_ACTIONS.savings;
    if (cat === 'invest' || a.includes('invest')) return PROVIDER_ACTIONS.invest;
    return [];
  };

  if (loading) {
    return (
      <View style={s.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  // ── Derived data ──
  const moves = Array.isArray(analysis?.all_moves) ? analysis.all_moves : [];
  const income = analysis?.monthly_income ?? 0;
  const incomeSources = Array.isArray(analysis?.income_sources) ? analysis.income_sources : [];
  const isVariableIncome = analysis?.is_variable_income ?? false;
  const incomeFloor = analysis?.income_floor ?? income;
  const incomeCV = analysis?.income_cv ?? 0;

  // Only show high + medium effort moves on dashboard; low effort → plan page only
  // Sort: high effort first, then medium
  const highEffortMoves = moves.filter((m: Move) => m.effort === 'high');
  const mediumEffortMoves = moves.filter((m: Move) => m.effort === 'medium');
  const dashboardMoves = [...highEffortMoves, ...mediumEffortMoves];

  // Primary income source only
  const primaryIncome = incomeSources.find((s: IncomeSource) => s.isSalary)
    || (incomeSources.length > 0
      ? incomeSources.reduce((a, b) => (a?.avgAmount ?? 0) > (b?.avgAmount ?? 0) ? a : b)
      : null);

  const nonDisc = analysis?.non_discretionary as any;
  const disc = analysis?.discretionary as any;
  const nonDiscTotal = nonDisc?.total ?? 0;
  const discTotal = disc?.total ?? 0;
  const nonDiscItems: BudgetCategory[] = Array.isArray(nonDisc?.items) ? nonDisc.items : [];
  const discItems: BudgetCategory[] = Array.isArray(disc?.items) ? disc.items : [];
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

  // ── Period-aware budget calculations ──
  // Budget targets = analysis monthly averages (what you'd normally spend)
  // Actual = real transactions in the selected period
  const txFilter = budgetPeriod === 'year' ? isCurrentYear : budgetPeriod === 'week' ? isCurrentWeek : isCurrentMonth;
  // periodDivisor converts monthly values: year = 1/12 (×12), month = 1, week = 4.33 (÷4.33)
  const periodDivisor = budgetPeriod === 'year' ? (1 / 12) : budgetPeriod === 'week' ? 4.33 : 1;

  const computePeriodCategory = (item: BudgetCategory) => {
    const txs = (Array.isArray(item?.transactions) ? item.transactions : []).filter(tx => tx?.date && txFilter(tx.date));
    const total = txs.reduce((sum, tx) => sum + Math.abs(tx?.amount ?? 0), 0);
    return { txs, total, count: txs.length };
  };

  const periodNonDiscData = nonDiscItems.map(item => ({
    ...item,
    ...computePeriodCategory(item),
    budget: item.monthly / periodDivisor,
  }));
  const periodDiscData = discItems.map(item => ({
    ...item,
    ...computePeriodCategory(item),
    budget: item.monthly / periodDivisor,
  }));

  const periodNonDiscTotal = periodNonDiscData.reduce((s, d) => s + d.total, 0);
  const periodDiscTotal = periodDiscData.reduce((s, d) => s + d.total, 0);
  const periodSpendTotal = periodNonDiscTotal + periodDiscTotal;

  // Budget targets for the period (from analysis averages)
  const periodNonDiscBudget = nonDiscTotal / periodDivisor;
  const periodDiscBudget = discTotal / periodDivisor;
  const periodIncome = income / periodDivisor;
  const periodTotalBudget = periodNonDiscBudget + periodDiscBudget;

  // Period labels for display
  const periodAdj = budgetPeriod === 'year' ? 'yearly' : budgetPeriod === 'week' ? 'weekly' : 'monthly';
  const periodSuffix = budgetPeriod === 'year' ? '/yr' : budgetPeriod === 'week' ? '/wk' : '/mo';
  const periodThisLabel = budgetPeriod === 'year' ? 'this year' : budgetPeriod === 'week' ? 'this week' : 'this month';

  // On-track status per section
  const essentialsOnTrack = periodNonDiscTotal <= periodNonDiscBudget * 1.05; // 5% tolerance
  const lifestyleOnTrack = periodDiscTotal <= periodDiscBudget * 1.05;
  const essentialsPctUsed = periodNonDiscBudget > 0 ? Math.min(150, Math.round((periodNonDiscTotal / periodNonDiscBudget) * 100)) : 0;
  const lifestylePctUsed = periodDiscBudget > 0 ? Math.min(150, Math.round((periodDiscTotal / periodDiscBudget) * 100)) : 0;
  const overallPctUsed = periodIncome > 0 ? Math.min(150, Math.round((periodSpendTotal / periodIncome) * 100)) : 0;

  // Remaining breakdown: prioritized by user's ranked plan
  const periodRemaining = Math.max(0, periodIncome - periodSpendTotal);
  const allMoves = analysis?.all_moves ?? [];
  const goalTarget = analysis?.goal_context?.targetAmount ?? 0;

  // Build allocations from ranked moves (top priority first)
  // Each move's monthlyImpact represents what should be set aside
  type Allocation = { label: string; amount: number; priority: number };
  const moveAllocations: Allocation[] = [];
  let allocBudget = periodRemaining;

  for (let i = 0; i < allMoves.length && allocBudget > 0; i++) {
    const move = allMoves[i];
    const impact = (move.monthlyImpact || 0) / periodDivisor;
    if (impact <= 0) continue;
    const amt = Math.min(impact, allocBudget);

    moveAllocations.push({ label: move.action, amount: amt, priority: i + 1 });
    allocBudget -= amt;
  }

  const freeToSpend = Math.max(0, allocBudget);

  // ── Safe-to-spend weekly calculation ──
  // Static weekly budget is the baseline: unallocated monthly / 4.33 weeks
  const staticWeeklyBudget = leftToDecide / 4.33;
  // Adaptive budget from sync may use stale analysis data where leftToDecide
  // was different, so always cap it at the current static weekly figure.
  // The adaptive budget should only LOWER the weekly figure, never raise it.
  const rawWeeklyBudget = weeklyCtx?.adaptiveBudget ?? staticWeeklyBudget;
  const calculatedWeeklyBudget = Math.min(rawWeeklyBudget, staticWeeklyBudget);

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
    (item: BudgetCategory) => Array.isArray(item?.transactions) ? item.transactions : []
  );
  const spentThisWeek = allDiscTxs
    .filter((tx) => tx?.date && new Date(tx.date) >= weekStart)
    .reduce((sum, tx) => sum + Math.abs(tx?.amount ?? 0), 0);

  // Apply custom limit if set (capped at calculated budget — user can lower, not inflate)
  const weeklyBudget = customWeeklyLimit !== null
    ? Math.min(customWeeklyLimit, calculatedWeeklyBudget)
    : calculatedWeeklyBudget;

  const weeklyRemaining = Math.max(0, weeklyBudget - spentThisWeek);
  const weeklyUsedPct = weeklyBudget > 0
    ? Math.min(100, Math.round((spentThisWeek / weeklyBudget) * 100))
    : 0;
  const weeklyHealthy = spentThisWeek <= weeklyBudget;

  // Save / reset custom weekly limit
  const saveCustomLimit = () => {
    const val = parseFloat(limitInput);
    if (!isNaN(val) && val > 0) {
      setCustomWeeklyLimit(val);
      AsyncStorage.setItem('custom_weekly_limit', String(val)).catch(() => {});
      setShowLimitEditor(false);
      setLimitInput('');
    }
  };
  const resetCustomLimit = () => {
    setCustomWeeklyLimit(null);
    AsyncStorage.removeItem('custom_weekly_limit').catch(() => {});
    setShowLimitEditor(false);
  };

  // ── Sorted moves for inline display ──
  const sortedMoves: (Move & { _sortIdx: number })[] = moves
    .map((m, i) => ({ ...m, _sortIdx: i }))
    .sort((a, b) => (effortOrder[a.effort] ?? 2) - (effortOrder[b.effort] ?? 2));
  const activePlanMoves = sortedMoves.filter((_, i) => planProgress[`move-${sortedMoves[i]._sortIdx}`]?.approved);
  const opportunityMoves = sortedMoves.filter((_, i) => !planProgress[`move-${sortedMoves[i]._sortIdx}`]?.approved);

  // ── Focus card type: what matters right now? ──
  const isPayday = !!weeklyCtx?.incomeArrivedThisWeek && !incomeDismissed;
  const focusType: 'payday' | 'budget' | 'move' = isPayday ? 'payday' : 'budget';

  return (
    <ScrollView
      ref={dashScrollRef}
      style={s.container}
      contentContainerStyle={[
        s.scroll,
        isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%', paddingHorizontal: horizontalPadding },
      ]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
          colors={[colors.accent]}
        />
      }
    >
      {/* ── Header ── */}
      <View style={s.headerWrap}>
        <View style={s.headerRow}>
          <View style={s.headerLeft}>
            <View style={s.bocyHeaderWrap} accessibilityLabel="Bocy mascot">
              <BocyFace mood={getBocyMood(analysis)} size="sm" breathing />
            </View>
            <Text style={s.greeting} accessibilityRole="header">
              Hi, {userName || 'there'}
            </Text>
          </View>
          <TouchableOpacity
            style={s.menuButton}
            onPress={() => router.push('/(main)/profile')}
            accessibilityRole="button"
            accessibilityLabel="Open profile menu"
          >
            <View style={s.menuLine} />
            <View style={[s.menuLine, s.menuLineShort]} />
            <View style={s.menuLine} />
          </TouchableOpacity>
        </View>
        {(syncing || lastSynced > 0 || syncError) && (
          <Text style={[s.syncText, syncError && !syncing ? { color: colors.coral } : undefined]}>
            {syncing ? 'Syncing...' : syncError ? syncError : syncDataSource === 'fallback' && latestTxDate
              ? `Data from ${formatTimeAgo(new Date(latestTxDate).getTime())} (cached)`
              : `Synced ${formatTimeAgo(lastSynced)}`}
          </Text>
        )}
      </View>

      {/* ── Connection warning ── */}
      {connectionWarning && !connectionDismissed && (
        <View style={s.connectionBanner}>
          <TouchableOpacity style={s.connectionBannerBody} onPress={() => router.push('/(main)/connect')} activeOpacity={0.8}>
            <View style={{ flex: 1 }}>
              {connectionWarning.message === 'stale_data'
                ? <Text style={s.connectionBannerText}>Transactions haven't updated in days — try reconnecting</Text>
                : connectionWarning.banks.length > 0
                ? connectionWarning.banks.map((bank, idx) => (
                    <Text key={idx} style={s.connectionBannerText}>Reconnect {bank}</Text>
                  ))
                : connectionWarning.message === 'sync_failed'
                ? <Text style={s.connectionBannerText}>Bank sync failed — try again later</Text>
                : <Text style={s.connectionBannerText}>Bank connection needs attention</Text>}
            </View>
            <Text style={s.connectionBannerAction}>Fix</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.bannerDismiss} onPress={dismissConnection} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={s.bannerDismissX}>{'\u2715'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {!analysis ? (
        <View style={s.emptyState}>
          <View style={s.emptyBocyWrap}>
            <BocyFace mood="neutral" size="lg" breathing />
          </View>
          <Text style={s.emptyTitle}>Your #1 financial move awaits</Text>
          <Text style={s.emptyDesc}>
            Connect your bank account so Bocy can analyse your transactions and find the most impactful action you can take right now.
          </Text>
          <TouchableOpacity style={s.ctaButton} onPress={() => router.push('/(main)/connect')}>
            <Text style={s.ctaText}>Connect your bank</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── Unresolved transactions nudge ── */}
          {unresolvedTxCount > 0 && (
            <TouchableOpacity style={s.reviewBanner} onPress={() => { setCatAssignments({}); setShowCatReview(true); }} activeOpacity={0.7}>
              <Text style={s.reviewBannerText}>
                {unresolvedTxCount} uncategorised transaction{unresolvedTxCount !== 1 ? 's' : ''}.{' '}
                <Text style={s.reviewBannerLink}>Fix now</Text>
              </Text>
            </TouchableOpacity>
          )}

          {/* ══════════════════════════════════════════════
              FOCUS CARD — one contextual card
              ══════════════════════════════════════════════ */}
          <View onLayout={(e) => { cardPositions.current.hero = e.nativeEvent.layout.y; }}>
          {focusType === 'payday' && weeklyCtx?.recentIncomeEvents ? (
            /* ── Payday split ── */
            <AnimGlyph delay={0}>
              <Card variant="hero">
                <Text style={s.heroLabel}>PAYDAY</Text>
                <Text style={s.heroAction}>
                  {weeklyCtx.recentIncomeEvents.map((e) =>
                    `\u00a3${Math.round(e?.amount ?? 0).toLocaleString()}`
                  ).join(' + ')}{' '}received
                </Text>

                <View style={{ marginTop: 24, gap: 14 }}>
                  {(weeklyCtx.committedThisWeek ?? 0) > 0 && (
                    <View style={s.focusSplitRow}>
                      <Text style={s.focusSplitLabel}>Bills & essentials</Text>
                      <Text style={[s.focusSplitValue, { color: colors.dim }]}>
                        -{'\u00a3'}{Math.round(weeklyCtx.committedThisWeek ?? 0).toLocaleString()}
                      </Text>
                    </View>
                  )}
                  {moves.length > 0 && moves[0].monthlyImpact > 0 && (
                    <View style={s.focusSplitRow}>
                      <Text style={s.focusSplitLabel}>{stripMd(moves[0].action)}</Text>
                      <Text style={[s.focusSplitValue, { color: colors.text2 }]}>
                        {'\u00a3'}{Math.round(moves[0].monthlyImpact / 4.33).toLocaleString()}/wk
                      </Text>
                    </View>
                  )}
                  <View style={[s.focusSplitRow, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 14 }]}>
                    <Text style={[s.focusSplitLabel, { fontFamily: fonts.semibold, color: colors.text }]}>Safe to spend</Text>
                    <Text style={[s.focusSplitValue, { fontFamily: fonts.mono, fontSize: 20, color: weeklyHealthy ? colors.text : colors.coral }]}>
                      {'\u00a3'}{Math.round(weeklyBudget).toLocaleString()}/wk
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  style={[s.heroCta, { marginTop: 28 }]}
                  onPress={() => {
                    dismissIncome();
                    router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: 'I just got paid. Walk me through what to do.' } });
                  }}
                >
                  <Text style={s.heroCtaText}>Ask Bocy about this</Text>
                </TouchableOpacity>
              </Card>
            </AnimGlyph>
          ) : (
            /* ── Weekly budget status (default) ── */
            <AnimGlyph delay={0}>
              <Card variant="hero">
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                      <Text style={[s.heroLabel, { marginBottom: 0 }]}>THIS WEEK</Text>
                      <TouchableOpacity
                        onPress={() => setShowWeeklyInfo(true)}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        accessibilityRole="button"
                        accessibilityLabel="How is this calculated?"
                      >
                        <View style={s.infoIconSmall}>
                          <Text style={s.infoIconSmallText}>?</Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                    <Text style={[s.safeToSpendAmount, !weeklyHealthy && { color: colors.coral }, { fontSize: 38 }]}>
                      {'\u00a3'}{Math.round(weeklyRemaining).toLocaleString()}
                    </Text>
                    <Text style={s.safeToSpendLabel}>left to spend</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.safeToSpendMeta}>
                      {'\u00a3'}{Math.round(spentThisWeek).toLocaleString()} spent
                    </Text>
                    <TouchableOpacity
                      onPress={() => { setLimitInput(customWeeklyLimit ? String(customWeeklyLimit) : String(Math.round(calculatedWeeklyBudget))); setShowLimitEditor(true); }}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Set custom weekly spending limit"
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                        <Text style={[s.safeToSpendMeta, { textDecorationLine: 'underline', textDecorationStyle: 'dotted' }]}>
                          of {'\u00a3'}{Math.round(weeklyBudget).toLocaleString()}
                        </Text>
                        <Text style={{ fontSize: 8, color: colors.dim }}>{'\u270E'}</Text>
                      </View>
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={[s.safeToSpendBar, { marginTop: 4 }]}>
                  <BreathingBar
                    color={weeklyHealthy ? colors.accent : colors.coral}
                    width={`${weeklyUsedPct}%`}
                    style={s.safeToSpendBarFill}
                  />
                </View>

                {/* Data freshness indicator */}
                {latestTxDate && (
                  <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: (() => {
                    const txAge = Math.floor((Date.now() - new Date(latestTxDate).getTime()) / (1000 * 60 * 60 * 24));
                    return txAge >= 2 ? colors.coral : colors.muted;
                  })(), letterSpacing: 0.5, marginTop: 10 }}>
                    {(() => {
                      const txAge = Math.floor((Date.now() - new Date(latestTxDate).getTime()) / (1000 * 60 * 60 * 24));
                      if (txAge === 0) return 'Transactions up to date';
                      if (txAge === 1) return 'Latest transaction: yesterday';
                      return `Latest transaction: ${txAge} days ago`;
                    })()}
                    {syncDataSource === 'fallback' ? ' (using cached data)' : ''}
                  </Text>
                )}

                {/* Top move teaser */}
                {dashboardMoves.length > 0 && (
                  <View style={{ marginTop: 24, paddingTop: 24, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.green, letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 10 }}>
                      #1 MOVE
                    </Text>
                    <Text style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.text, lineHeight: 24 }}>
                      {stripMd(dashboardMoves[0].action)}
                    </Text>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.green, marginTop: 8, letterSpacing: 0.3 }}>
                      +{'\u00a3'}{(dashboardMoves[0].annualImpact || 0).toLocaleString()}/yr
                    </Text>
                  </View>
                )}
              </Card>
            </AnimGlyph>
          )}
          </View>

          {/* Dot separator */}
          <View style={s.dotSeparator}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={[s.dot, { backgroundColor: colors.border }]} />
            ))}
          </View>

          {/* ══════════════════════════════════════════════
              YOUR MOVES — inline from Plan page
              ══════════════════════════════════════════════ */}
          {(activePlanMoves.length > 0 || userPlans.length > 0 || opportunityMoves.length > 0) && (
            <>
              {/* Active moves */}
              {(activePlanMoves.length > 0 || userPlans.length > 0) && (
                <>
                  <View style={s.moveSectionHeader}>
                    <Text style={s.moveSectionLabel}>IN PROGRESS</Text>
                  </View>
                  {userPlans.map((plan) => {
                    const isPlanExpanded = expandedPlan === plan.id;
                    const planKey = `plan-${plan.id}`;
                    const planSteps = getPlanSteps(plan);
                    const doneSteps = planProgress[planKey]?.completed_steps || [];
                    const stepProgress = planSteps.length > 0 ? doneSteps.length / planSteps.length : 0;
                    const nextStepIdx = planSteps.findIndex((_: string, idx: number) => !doneSteps.includes(idx));
                    return (
                      <Card key={plan.id} variant="active" style={{ marginBottom: spacing.md }}>
                        <TouchableOpacity onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setExpandedPlan(isPlanExpanded ? null : plan.id); }} activeOpacity={0.8}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                            <View style={[s.moveBadge, { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                              <Text style={[s.moveBadgeText, { color: colors.bg }]}>{'\u2713'}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={s.moveAction}>{stripMd(plan.action)}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
                                {plan.monthly_saving != null && (
                                  <Text style={s.moveImpactText}>{'\u00a3'}{plan.monthly_saving}/mo</Text>
                                )}
                                <Text style={{ fontSize: 10, color: colors.muted }}>{isPlanExpanded ? '\u25B2' : '\u25BC'}</Text>
                              </View>
                              {!isPlanExpanded && planSteps.length > 0 && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                  <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                    <View style={{ width: `${Math.round(stepProgress * 100)}%`, height: '100%', borderRadius: 1, backgroundColor: colors.accent }} />
                                  </View>
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{doneSteps.length}/{planSteps.length}</Text>
                                </View>
                              )}
                            </View>
                          </View>
                        </TouchableOpacity>
                        {isPlanExpanded && (
                          <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border }}>
                            <View style={{ position: 'absolute', top: 8, right: 0 }}>
                              <ExpandDots count={5} size={2.5} />
                            </View>
                            {/* Progress bar */}
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                              <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                <View style={{ width: `${Math.round(stepProgress * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: colors.accent }} />
                              </View>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{doneSteps.length}/{planSteps.length} done</Text>
                            </View>
                            {/* Step checklist */}
                            {planSteps.map((step: string, j: number) => {
                              const isDone = doneSteps.includes(j);
                              const isNext = j === nextStepIdx;
                              return (
                                <TouchableOpacity key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }} onPress={() => togglePlanStep(planKey, j, plan.action)} activeOpacity={0.7}>
                                  <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: isDone ? colors.accent : colors.dim, backgroundColor: isDone ? colors.accent : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                    {isDone && <Text style={{ color: colors.bg, fontSize: 12, fontWeight: '700' }}>{'\u2713'}</Text>}
                                  </View>
                                  <View style={{ flex: 1 }}>
                                    <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: isDone ? colors.muted : colors.text, textDecorationLine: isDone ? 'line-through' : 'none', lineHeight: 20 }}>{stripMd(step)}</Text>
                                    {isNext && !isDone && <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accent, marginTop: 2 }}>Do this next</Text>}
                                  </View>
                                </TouchableOpacity>
                              );
                            })}
                            {/* Ask Bocy button */}
                            <TouchableOpacity style={{ marginTop: 16, paddingVertical: 10, alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent }} onPress={() => router.push('/(main)/(tabs)/chat')} activeOpacity={0.7}>
                              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.accent }}>Ask Bocy about this</Text>
                            </TouchableOpacity>
                            {/* Delete plan button */}
                            <TouchableOpacity
                              style={{ marginTop: 10, paddingVertical: 8, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                              onPress={() => {
                                const title = 'Delete plan?';
                                const msg = `Remove "${stripMd(plan.action)}" from your plans?`;
                                if (Platform.OS === 'web') {
                                  if (window.confirm(`${title}\n\n${msg}`)) handleRemovePlan(plan.id);
                                } else {
                                  Alert.alert(title, msg, [
                                    { text: 'Cancel', style: 'cancel' },
                                    { text: 'Delete', style: 'destructive', onPress: () => handleRemovePlan(plan.id) },
                                  ]);
                                }
                              }}
                              activeOpacity={0.7}
                              accessibilityRole="button"
                              accessibilityLabel={`Delete plan: ${stripMd(plan.action)}`}
                            >
                              <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.muted }}>Delete plan</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </Card>
                    );
                  })}
                  {activePlanMoves.map((move, seqIdx) => {
                    const i = move._sortIdx;
                    const isExpanded = expandedMove === i;
                    const moveKey = `move-${i}`;
                    const steps = move.steps || [];
                    const doneSteps = planProgress[moveKey]?.completed_steps || [];
                    const stepProgress = steps.length > 0 ? doneSteps.length / steps.length : 0;
                    const nextStepIdx = steps.findIndex((_: string, idx: number) => !doneSteps.includes(idx));
                    return (
                      <Card key={`active-${i}`} variant="active" style={{ marginBottom: spacing.md }}>
                        <TouchableOpacity onPress={() => setExpandedMove(isExpanded ? null : i)} activeOpacity={0.8}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                            <View style={[s.moveBadge, { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                              <Text style={[s.moveBadgeText, { color: colors.bg }]}>{'\u2713'}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={s.moveAction}>{stripMd(move.action)}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
                                <Text style={s.moveImpactText}>{'\u00a3'}{move.monthlyImpact}/mo</Text>
                                <Text style={{ fontSize: 10, color: colors.muted }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                              </View>
                              {!isExpanded && steps.length > 0 && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                  <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                    <View style={{ width: `${Math.round(stepProgress * 100)}%`, height: '100%', borderRadius: 1, backgroundColor: colors.accent }} />
                                  </View>
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{doneSteps.length}/{steps.length}</Text>
                                </View>
                              )}
                            </View>
                          </View>
                        </TouchableOpacity>
                        {isExpanded && (
                          <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.border }}>
                            <View style={{ position: 'absolute', top: 8, right: 0 }}>
                              <ExpandDots count={5} size={2.5} />
                            </View>
                            {move.strategy && <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22, marginBottom: 16 }}>{stripMd(move.strategy)}</Text>}
                            {steps.map((step: string, j: number) => {
                              const isDone = doneSteps.includes(j);
                              return (
                                <TouchableOpacity key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }} onPress={() => togglePlanStep(moveKey, j, move.action)} activeOpacity={0.7}>
                                  <View style={[s.checkbox, isDone && s.checkboxDone]}>
                                    {isDone && <Text style={s.checkmark}>{'\u2713'}</Text>}
                                  </View>
                                  <Text style={[s.checklistText, isDone && s.checklistTextDone]}>{stripMd(step)}</Text>
                                </TouchableOpacity>
                              );
                            })}
                            <TouchableOpacity style={[s.heroCta, { marginTop: 16, paddingVertical: 12 }]} onPress={() => router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Tell me more about: "${stripMd(move.action)}"` } })}>
                              <Text style={s.heroCtaText}>Ask Bocy about this</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={{ marginTop: 12, alignItems: 'center', paddingVertical: 8 }} onPress={() => handleStopMove(i)}>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.coral }}>Remove from plan</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </Card>
                    );
                  })}
                </>
              )}

              {/* Opportunity moves */}
              {opportunityMoves.length > 0 && (
                <>
                  <View style={s.moveSectionHeader}>
                    <Text style={s.moveSectionLabel}>YOUR MOVES</Text>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.green, letterSpacing: 0.3 }}>
                      {'\u00a3'}{Math.round(opportunityMoves.reduce((s, m) => s + (m.monthlyImpact || 0), 0))}/mo potential
                    </Text>
                  </View>
                  {(showAllMoves ? opportunityMoves : opportunityMoves.slice(0, 2)).map((move, seqIdx) => {
                    const i = move._sortIdx;
                    const isExpanded = expandedMove === i;
                    const moveKey = `move-${i}`;
                    const providerActions = getProviderActions(move);
                    return (
                      <Card key={`opp-${i}`} variant="default" style={{ marginBottom: spacing.md }}>
                        <TouchableOpacity onPress={() => setExpandedMove(isExpanded ? null : i)} activeOpacity={0.8}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                            <View style={[s.moveBadge, seqIdx === 0 && { borderColor: colors.green }]}>
                              <Text style={[s.moveBadgeText, seqIdx === 0 && { color: colors.green }]}>{seqIdx + 1}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={s.moveAction}>{stripMd(move.action)}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 }}>
                                <Text style={s.moveImpactText}>{'\u00a3'}{move.monthlyImpact}/mo</Text>
                                <View style={[s.effortPill, { backgroundColor: `${effortColor(move.effort)}15` }]}>
                                  <Text style={[s.effortPillText, { color: effortColor(move.effort) }]}>{effortLabel(move.effort)}</Text>
                                </View>
                                <Text style={{ fontSize: 10, color: colors.muted, marginLeft: 'auto' }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                              </View>
                              {!isExpanded && move.merchants && move.merchants.length > 0 && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                                  {move.merchants.slice(0, 3).map((m: string, j: number) => (
                                    <View key={j} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 100, paddingVertical: 2, paddingHorizontal: 8 }}>
                                      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.text2 }}>{m}</Text>
                                    </View>
                                  ))}
                                </View>
                              )}
                            </View>
                          </View>
                        </TouchableOpacity>

                        {!isExpanded && (
                          <TouchableOpacity style={[s.heroCta, { marginTop: 12, paddingVertical: 10 }]} onPress={() => handleStartMove(i, move)} activeOpacity={0.8}>
                            <Text style={[s.heroCtaText, { fontSize: 13 }]}>Start this move</Text>
                          </TouchableOpacity>
                        )}

                        {isExpanded && (
                          <View style={{ marginTop: 20, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.border }}>
                            <View style={{ position: 'absolute', top: 12, right: 0 }}>
                              <ExpandDots count={5} size={2.5} />
                            </View>
                            {move.strategy && <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 24, marginBottom: 20 }}>{stripMd(move.strategy)}</Text>}

                            <TouchableOpacity style={[s.heroCta, { marginBottom: 20, paddingVertical: 12 }]} onPress={() => handleStartMove(i, move)} activeOpacity={0.8}>
                              <Text style={s.heroCtaText}>Start this move</Text>
                            </TouchableOpacity>

                            {move.merchants && move.merchants.length > 0 && (
                              <View style={{ marginBottom: 20 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.text2, textTransform: 'uppercase', marginBottom: 12 }}>WHERE YOUR MONEY GOES</Text>
                                {move.merchants.map((m: string, j: number) => (
                                  <View key={j} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
                                    <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
                                    <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2 }}>{m}</Text>
                                  </View>
                                ))}
                              </View>
                            )}

                            {(move.steps || []).length > 0 && (
                              <View style={{ marginBottom: 20 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.text2, textTransform: 'uppercase', marginBottom: 12 }}>STEPS</Text>
                                {(move.steps || []).map((step: string, j: number) => (
                                  <View key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.dim, width: 24, textAlign: 'center' }}>{j + 1}</Text>
                                    <Text style={{ flex: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 24 }}>{stripMd(step)}</Text>
                                  </View>
                                ))}
                              </View>
                            )}

                            {move.effect && (
                              <View style={{ marginBottom: 20 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.text2, textTransform: 'uppercase', marginBottom: 10 }}>OUTCOME</Text>
                                <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text, lineHeight: 24 }}>{stripMd(move.effect)}</Text>
                              </View>
                            )}

                            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
                              <View style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 16, alignItems: 'center' }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.green, letterSpacing: -0.5 }}>{'\u00a3'}{move.monthlyImpact || 0}</Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, marginTop: 6, letterSpacing: 1, textTransform: 'uppercase' }}>per month</Text>
                              </View>
                              <View style={{ flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 16, alignItems: 'center' }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.green, letterSpacing: -0.5 }}>{'\u00a3'}{move.annualImpact || 0}</Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, marginTop: 6, letterSpacing: 1, textTransform: 'uppercase' }}>per year</Text>
                              </View>
                            </View>

                            {providerActions.length > 0 && (
                              <View style={{ gap: 8, marginBottom: 12 }}>
                                {providerActions.map((pa, j) => (
                                  <TouchableOpacity key={j} style={{ borderWidth: 1, borderColor: colors.accentDim, borderRadius: 100, paddingVertical: 12, alignItems: 'center' }} onPress={() => pa.url ? Linking.openURL(pa.url) : pa.phone ? Linking.openURL(`tel:${pa.phone}`) : null}>
                                    <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.text }}>{pa.label}</Text>
                                    {pa.sub && <Text style={{ fontFamily: fonts.regular, fontSize: 10, color: colors.dim, marginTop: 2 }}>{pa.sub}</Text>}
                                  </TouchableOpacity>
                                ))}
                              </View>
                            )}

                            <TouchableOpacity style={{ borderWidth: 1, borderColor: colors.accentDim, borderRadius: 100, paddingVertical: 12, alignItems: 'center', marginBottom: 8 }} onPress={() => router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Tell me more about: "${stripMd(move.action)}"` } })}>
                              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.text }}>Ask Bocy about this</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                              style={{ alignItems: 'center', paddingVertical: 8, minHeight: 44, justifyContent: 'center' }}
                              onPress={() => handleDeleteMove(move)}
                              accessibilityRole="button"
                              accessibilityLabel={`Delete recommendation: ${stripMd(move.action)}`}
                            >
                              <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.coral }}>Delete</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </Card>
                    );
                  })}

                  {/* View more button for progressive disclosure */}
                  {!showAllMoves && opportunityMoves.length > 2 && (
                    <TouchableOpacity
                      style={s.viewMoreBtn}
                      onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setShowAllMoves(true); }}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={`View ${opportunityMoves.length - 2} more moves`}
                    >
                      <Text style={s.viewMoreText}>View {opportunityMoves.length - 2} more moves</Text>
                      <Text style={s.viewMoreArrow}>{'\u25BC'}</Text>
                    </TouchableOpacity>
                  )}

                </>
              )}
            </>
          )}

          {/* Dot separator */}
          <View style={s.dotSeparator}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={[s.dot, { backgroundColor: colors.border }]} />
            ))}
          </View>

          {/* ══════════════════════════════════════════════
              BUDGET — collapsed by default
              ══════════════════════════════════════════════ */}
          <View onLayout={(e) => { cardPositions.current.budget = e.nativeEvent.layout.y; }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                LayoutAnimation.configureNext(SMOOTH_ANIM);
                const opening = !budgetExpanded;
                setBudgetExpanded(opening);
                if (opening && !txManuallyCollapsed.current) setTxCardExpanded(true);
                if (!opening) { setTxCardExpanded(false); txManuallyCollapsed.current = false; }
              }}
              style={s.collapsedSectionBtn}
            >
              <Text style={s.moveSectionLabel}>BUDGET</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: overallPctUsed > 100 ? colors.coral : colors.dim, letterSpacing: 0.3 }}>
                  {'\u00a3'}{Math.round(periodSpendTotal).toLocaleString()} / {'\u00a3'}{Math.round(periodIncome).toLocaleString()}
                </Text>
                <Text style={{ fontSize: 9, color: colors.muted }}>{budgetExpanded ? '\u25B2' : '\u25BC'}</Text>
              </View>
            </TouchableOpacity>

            {budgetExpanded && (
              <Card style={{ marginBottom: spacing.md }}>
                <View style={{ position: 'absolute', top: 16, right: 20, zIndex: 1 }}>
                  <ExpandDots count={6} size={3} />
                </View>

                {/* Period toggle — at top so thumb doesn't block the connector animation below */}
                <View style={[s.periodToggleRow, { marginBottom: 20, marginTop: 0 }]}>
                  {(['year', 'month', 'week'] as const).map((p) => (
                    <TouchableOpacity key={p} style={[s.periodBtn, budgetPeriod === p && { backgroundColor: colors.accent }]} onPress={() => {
                      LayoutAnimation.configureNext(SMOOTH_ANIM);
                      setBudgetPeriod(p);
                      connectorDotsRef.current?.pulse();
                    }}>
                      <Text style={[s.periodBtnText, budgetPeriod === p && { color: colors.bg }]}>{p === 'year' ? 'Annual' : p === 'month' ? 'Monthly' : 'Weekly'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Big centered spend number */}
                <View style={s.periodTotalRow}>
                  <Text style={[s.periodTotalAmount, { fontSize: 32, color: overallPctUsed > 100 ? colors.coral : colors.text }]}>
                    {'\u00a3'}{Math.round(periodSpendTotal).toLocaleString()}
                  </Text>
                  <Text style={s.periodTotalOf}>
                    of {'\u00a3'}{Math.round(periodIncome).toLocaleString()}
                  </Text>
                </View>

                {/* Overall progress bar with percentage label */}
                <View style={s.sectionHeaderRow}>
                  <View style={{ flex: 1 }} />
                  <Text style={[s.sectionStatus, { color: overallPctUsed > 100 ? colors.coral : colors.muted, marginBottom: 6 }]}>
                    {overallPctUsed}%
                  </Text>
                </View>
                <View style={[s.progressTrack, { marginTop: 0 }]}>
                  <View style={[
                    s.progressFill,
                    {
                      width: `${Math.min(100, overallPctUsed)}%`,
                      backgroundColor: overallPctUsed > 100 ? colors.coral : overallPctUsed > 85 ? colors.amber : colors.accent,
                    },
                  ]} />
                </View>

                <View style={s.sectionBlockNoRule}>
                  <View style={s.sectionHeaderRow}>
                    <Text style={[s.sectionLabel, { color: colors.text }]}>Essentials</Text>
                    <Text style={[s.sectionStatus, { color: essentialsOnTrack ? colors.green : colors.coral }]}>
                      {'\u00a3'}{Math.round(periodNonDiscTotal).toLocaleString()} of {'\u00a3'}{Math.round(periodNonDiscBudget).toLocaleString()}
                    </Text>
                  </View>
                  <View style={s.progressTrackSmall}>
                    <View style={[
                      s.progressFillSmall,
                      {
                        width: `${Math.min(100, essentialsPctUsed)}%`,
                        backgroundColor: essentialsOnTrack ? colors.text2 : colors.coral,
                      },
                    ]} />
                  </View>
                </View>

                <View style={s.sectionBlockNoRule}>
                  <View style={s.sectionHeaderRow}>
                    <Text style={[s.sectionLabel, { color: colors.text2 }]}>Lifestyle</Text>
                    <Text style={[s.sectionStatus, { color: lifestyleOnTrack ? colors.dim : colors.coral }]}>
                      {'\u00a3'}{Math.round(periodDiscTotal).toLocaleString()} of {'\u00a3'}{Math.round(periodDiscBudget).toLocaleString()}
                    </Text>
                  </View>
                  <View style={s.progressTrackSmall}>
                    <View style={[
                      s.progressFillSmall,
                      {
                        width: `${Math.min(100, lifestylePctUsed)}%`,
                        backgroundColor: lifestyleOnTrack ? colors.dim : colors.coral,
                      },
                    ]} />
                  </View>
                </View>

                <View style={s.sectionBlockNoRule}>
                  <View style={s.sectionHeaderRow}>
                    <Text style={[s.sectionLabel, { color: colors.text2 }]}>Remaining</Text>
                    <Text style={[s.sectionStatus, { color: periodRemaining > 0 ? colors.green : colors.coral }]}>
                      {'\u00a3'}{Math.round(periodRemaining).toLocaleString()}
                    </Text>
                  </View>
                </View>
              </Card>
            )}
          </View>

          {/* Vertical connector pipe between Budget and Transactions */}
          <View style={{ alignItems: 'center', marginVertical: -4 }}>
            <ConnectorDots ref={connectorDotsRef} />
          </View>

          {/* ── Transactions — collapsed by default ── */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => {
              LayoutAnimation.configureNext(SMOOTH_ANIM);
              setTxCardExpanded(prev => {
                if (prev) txManuallyCollapsed.current = true;
                return !prev;
              });
            }}
            style={s.collapsedSectionBtn}
          >
            <Text style={s.moveSectionLabel}>TRANSACTIONS</Text>
            <Text style={{ fontSize: 10, color: colors.muted }}>{txCardExpanded ? '\u25B2' : '\u25BC'}</Text>
          </TouchableOpacity>

          {txCardExpanded && (
            <Card style={{ marginBottom: spacing.md }}>
              <View style={{ position: 'absolute', top: 16, right: 20, zIndex: 1 }}>
                <ExpandDots count={6} size={3} />
              </View>
              {periodNonDiscData.filter(d => d.count > 0).map((item, i: number) => {
                const key = `nd-${item.category}`;
                const isExp = expandedCategories.has(key);
                return (
                  <View key={`nd-${i}`}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => toggleCategory(key)} style={s.dataRow}>
                      <View style={s.dataRowLeft}>
                        <Text style={[s.catArrow, { color: colors.text }]}>{isExp ? '\u25BC' : '\u25B6'}</Text>
                        <Text style={s.dataLabel}>{item.category}</Text>
                      </View>
                      <Text style={[s.dataValue, { color: colors.text }]}>{'\u00a3'}{Math.round(item.total).toLocaleString()}</Text>
                    </TouchableOpacity>
                    {isExp && (
                      <>
                        <View style={{ alignSelf: 'flex-end', marginTop: 2, marginBottom: -4 }}>
                          <ExpandDots count={4} size={2} />
                        </View>
                        {item.txs.map((tx, j) => (
                          <TouchableOpacity key={j} style={s.txRow} onLongPress={() => { setRecatTx({ tx, catKey: item.category, section: 'essential' }); setRecatTarget(''); setRecatEssential(true); }} activeOpacity={0.7}>
                            <View style={s.txLeft}>
                              <Text style={s.txMerchant}>{tx.merchant}</Text>
                              <Text style={s.txDate}>{formatDate(tx.date)}</Text>
                            </View>
                            <Text style={[s.txAmount, { color: colors.text2 }]}>{'\u00a3'}{Math.abs(tx.amount).toFixed(2)}</Text>
                          </TouchableOpacity>
                        ))}
                      </>
                    )}
                  </View>
                );
              })}
              {periodDiscData.filter(d => d.count > 0).map((item, i: number) => {
                const key = `d-${item.category}`;
                const isExp = expandedCategories.has(key);
                return (
                  <View key={`d-${i}`}>
                    <TouchableOpacity activeOpacity={0.7} onPress={() => toggleCategory(key)} style={s.dataRow}>
                      <View style={s.dataRowLeft}>
                        <Text style={[s.catArrow, { color: colors.dim }]}>{isExp ? '\u25BC' : '\u25B6'}</Text>
                        <Text style={s.dataLabel}>{item.category}</Text>
                      </View>
                      <Text style={[s.dataValue, { color: colors.dim }]}>{'\u00a3'}{Math.round(item.total).toLocaleString()}</Text>
                    </TouchableOpacity>
                    {isExp && (
                      <>
                        <View style={{ alignSelf: 'flex-end', marginTop: 2, marginBottom: -4 }}>
                          <ExpandDots count={4} size={2} />
                        </View>
                        {item.txs.map((tx, j) => (
                          <TouchableOpacity key={j} style={s.txRow} onLongPress={() => { setRecatTx({ tx, catKey: item.category, section: 'lifestyle' }); setRecatTarget(''); setRecatEssential(false); }} activeOpacity={0.7}>
                            <View style={s.txLeft}>
                              <Text style={s.txMerchant}>{tx.merchant}</Text>
                              <Text style={s.txDate}>{formatDate(tx.date)}</Text>
                            </View>
                            <Text style={[s.txAmount, { color: colors.dim }]}>{'\u00a3'}{Math.abs(tx.amount).toFixed(2)}</Text>
                          </TouchableOpacity>
                        ))}
                      </>
                    )}
                  </View>
                );
              })}
              <Text style={s.cardFooter}>Hold a transaction to re-categorise</Text>
            </Card>
          )}

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
                  <TouchableOpacity
                    onPress={() => setShowCatReview(false)}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel="Close categorisation modal"
                    style={s.catReviewCloseBtn}
                  >
                    <Text style={s.catReviewClose}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>

                {aiSuggesting && (
                  <View style={s.aiSuggestBar}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={s.aiSuggestText}>Analysing merchants...</Text>
                  </View>
                )}

                <ScrollView style={s.catReviewList} showsVerticalScrollIndicator={false}>
                  {unresolvedGroups.map((group) => {
                    const assigned = catAssignments[group.key];
                    const isAiSuggested = assigned?.aiSuggested === true;
                    return (
                      <View
                        key={group.key}
                        style={[
                          s.catReviewRow,
                          assigned && s.catReviewRowDone,
                          isAiSuggested && s.catReviewRowAi,
                        ]}
                        accessibilityLabel={`${group.label}, ${group.txs.length} transactions, ${assigned ? `categorised as ${assigned.category}` : 'not yet categorised'}${isAiSuggested ? ', AI suggested' : ''}`}
                      >
                        <View style={s.catReviewRowHeader}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.catReviewMerchant} numberOfLines={1}>
                              {assigned ? '\u2713 ' : ''}{group.label}
                            </Text>
                            {isAiSuggested && (
                              <Text style={s.aiSuggestedLabel}>Bocy suggested</Text>
                            )}
                          </View>
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
                                  [group.key]: { category: cat, isEssential: ESSENTIAL_CATS.has(cat), aiSuggested: false },
                                }));
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={`${cat}${assigned?.category === cat ? ', selected' : ''}`}
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
                  accessibilityRole="button"
                  accessibilityLabel={`Save ${Object.keys(catAssignments).length} categorised transactions`}
                  accessibilityState={{ disabled: savingCatReview || Object.keys(catAssignments).length === 0 }}
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

      {analysis && <Walkthrough visible={showWalkthrough} onDismiss={dismissWalkthrough} scrollRef={dashScrollRef} cardPositions={cardPositions} router={router} />}

      {/* ── Income arrival insight modal ── */}
      {weeklyCtx?.incomeArrivedThisWeek && Array.isArray(weeklyCtx?.recentIncomeEvents) && weeklyCtx.recentIncomeEvents.length > 0 && (
        <InsightModal
          visible={showInsightModal}
          onDismiss={() => { setShowInsightModal(false); dismissIncome(); }}
          onAction={(prefill) => router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prefill || 'I just got paid. Walk me through what to do first.' } })}
          type="payday"
          tag="PAYDAY"
          title="Income received"
          body={
            weeklyCtx.recentIncomeEvents.map((e) =>
              `\u00a3${Math.round(e?.amount ?? 0).toLocaleString()} from ${e?.source ?? 'unknown'}`
            ).join(', ') +
            ' landed this week.' +
            ((weeklyCtx.committedThisWeek ?? 0) > 0
              ? ` \u00a3${Math.round(weeklyCtx.committedThisWeek).toLocaleString()} already committed to bills.`
              : '') +
            ' Want me to walk you through where it should go?'
          }
          actionLabel="Ask Bocy"
          actionPrefill="I just got paid. Walk me through what to do first."
          fingerprint={incomeFingerprint ? `income:${incomeFingerprint}` : undefined}
        />
      )}

      {/* ── Weekly info explainability modal ── */}
      <Modal visible={showWeeklyInfo} transparent animationType="fade" onRequestClose={() => setShowWeeklyInfo(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setShowWeeklyInfo(false)}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <Text style={s.modalTag}>HOW IT WORKS</Text>
            <Text style={s.modalTitle}>Your weekly budget</Text>

            <View style={s.modalDotSep}>
              {Array.from({ length: 3 }).map((_, i) => (
                <View key={i} style={[s.modalDot, { backgroundColor: colors.border }]} />
              ))}
            </View>

            <Text style={s.modalBody}>
              This is how much you can freely spend this week without touching your essentials or goals. It updates automatically every Monday.
            </Text>

            <View style={s.modalBreakdown}>
              <View style={s.modalBreakdownRow}>
                <Text style={s.modalBreakdownLabel}>Monthly income</Text>
                <Text style={s.modalBreakdownValue}>{'\u00a3'}{Math.round(income).toLocaleString()}</Text>
              </View>
              <View style={s.modalBreakdownRow}>
                <Text style={s.modalBreakdownLabel}>Essentials</Text>
                <Text style={[s.modalBreakdownValue, { color: colors.coral }]}>-{'\u00a3'}{Math.round(nonDiscTotal).toLocaleString()}</Text>
              </View>
              <View style={s.modalBreakdownRow}>
                <Text style={s.modalBreakdownLabel}>Lifestyle budget</Text>
                <Text style={[s.modalBreakdownValue, { color: colors.coral }]}>-{'\u00a3'}{Math.round(discTotal).toLocaleString()}</Text>
              </View>
              <View style={[s.modalBreakdownRow, { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12, marginTop: 4 }]}>
                <Text style={[s.modalBreakdownLabel, { fontFamily: fonts.semibold, color: colors.text }]}>Unallocated monthly</Text>
                <Text style={[s.modalBreakdownValue, { fontFamily: fonts.semibold, color: colors.text }]}>{'\u00a3'}{Math.round(leftToDecide).toLocaleString()}</Text>
              </View>
              <View style={s.modalBreakdownRow}>
                <Text style={s.modalBreakdownLabel}>{'\u00f7'} 4.33 weeks</Text>
                <Text style={[s.modalBreakdownValue, { color: colors.green }]}>{'\u00a3'}{Math.round(calculatedWeeklyBudget).toLocaleString()}/wk</Text>
              </View>
              {customWeeklyLimit !== null && (
                <View style={s.modalBreakdownRow}>
                  <Text style={[s.modalBreakdownLabel, { color: colors.accent }]}>Your custom limit</Text>
                  <Text style={[s.modalBreakdownValue, { color: colors.accent }]}>{'\u00a3'}{Math.round(customWeeklyLimit).toLocaleString()}/wk</Text>
                </View>
              )}
            </View>

            <TouchableOpacity
              style={s.modalCloseBtn}
              onPress={() => setShowWeeklyInfo(false)}
              activeOpacity={0.8}
            >
              <Text style={s.modalCloseBtnText}>Got it</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Custom weekly limit editor modal ── */}
      <Modal visible={showLimitEditor} transparent animationType="fade" onRequestClose={() => setShowLimitEditor(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setShowLimitEditor(false)}>
          <Pressable style={s.modalContent} onPress={() => {}}>
            <Text style={s.modalTag}>SET YOUR LIMIT</Text>
            <Text style={s.modalTitle}>Weekly spending target</Text>

            <Text style={[s.modalBody, { marginBottom: spacing.lg }]}>
              Set what you want to spend per week after essentials are covered. This can't exceed your calculated budget of {'\u00a3'}{Math.round(calculatedWeeklyBudget).toLocaleString()}/wk.
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: spacing.lg }}>
              <Text style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.text }}>{'\u00a3'}</Text>
              <TextInput
                style={s.limitEditorInput}
                value={limitInput}
                onChangeText={setLimitInput}
                keyboardType="numeric"
                placeholder={String(Math.round(calculatedWeeklyBudget))}
                placeholderTextColor={colors.muted}
                autoFocus
                selectTextOnFocus
              />
              <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.dim }}>/wk</Text>
            </View>

            <TouchableOpacity
              style={s.modalCloseBtn}
              onPress={saveCustomLimit}
              activeOpacity={0.8}
            >
              <Text style={s.modalCloseBtnText}>Set limit</Text>
            </TouchableOpacity>

            {customWeeklyLimit !== null && (
              <TouchableOpacity
                style={s.modalResetBtn}
                onPress={resetCustomLimit}
                activeOpacity={0.7}
              >
                <Text style={s.modalResetBtnText}>Reset to auto ({'\u00a3'}{Math.round(calculatedWeeklyBudget)}/wk)</Text>
              </TouchableOpacity>
            )}
          </Pressable>
        </Pressable>
      </Modal>
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
    paddingBottom: 120,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: c.bg,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Header ──
  headerWrap: {
    marginBottom: 40,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  bocyHeaderWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  greeting: {
    fontFamily: fonts.medium,
    fontSize: 18,
    color: c.text,
    letterSpacing: -0.2,
  },
  menuButton: {
    padding: 10,
    gap: 5,
    minWidth: 44,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  menuLine: {
    width: 18,
    height: 1.5,
    backgroundColor: c.text,
    borderRadius: 1,
  },
  menuLineShort: {
    width: 10,
    backgroundColor: c.dim,
  },
  syncText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.muted,
    marginTop: 6,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginLeft: 40,
  },

  // ── Connection warning banner ──
  connectionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 8,
    backgroundColor: c.amberDim,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.amber + '30',
  },
  connectionBannerBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  connectionBannerText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.amber,
    flex: 1,
  },
  connectionBannerAction: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.amber,
    marginLeft: spacing.sm,
  },
  bannerDismiss: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  bannerDismissX: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.amber,
    opacity: 0.6,
  },

  // ── Focus card split rows ──
  focusSplitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  focusSplitLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    flex: 1,
  },
  focusSplitValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    letterSpacing: -0.3,
  },

  // ── Dot separator ──
  dotSeparator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },

  // ── Moves section ──
  moveSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: 36,
    marginBottom: 18,
  },
  moveSectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 3,
    color: c.muted,
    textTransform: 'uppercase',
  },
  moveAction: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: c.text,
    lineHeight: 24,
  },
  moveImpactText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
    letterSpacing: 0.3,
    marginTop: 2,
  },
  moveBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
    marginTop: 2,
  },
  moveBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
  },
  viewMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    borderStyle: 'dashed',
  },
  viewMoreText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  viewMoreArrow: {
    fontSize: 9,
    color: c.muted,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.accentDim,
    marginRight: spacing.sm,
    marginTop: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxDone: {
    backgroundColor: c.accent,
    borderColor: c.accent,
  },
  checkmark: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.bg,
  },
  checklistText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.text2,
    lineHeight: 22,
  },
  checklistTextDone: {
    textDecorationLine: 'line-through',
    color: c.muted,
  },

  // ── Collapsed section button ──
  collapsedSectionBtn: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 22,
    marginTop: 8,
  },

  // ── Empty State ──
  emptyState: {
    marginTop: 64,
    alignItems: 'center',
  },
  emptyBocyWrap: {
    marginBottom: 32,
  },
  emptyTitle: {
    fontFamily: fonts.medium,
    fontSize: 17,
    color: c.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
    letterSpacing: -0.3,
  },
  emptyDesc: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.dim,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 40,
    paddingHorizontal: spacing.lg,
  },
  ctaButton: {
    backgroundColor: c.accent,
    paddingVertical: 15,
    paddingHorizontal: spacing.xl,
    borderRadius: 100,
    alignItems: 'center',
    width: '100%',
  },
  ctaText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
    letterSpacing: 0.2,
  },

  cardTitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  cardSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    lineHeight: 20,
    marginBottom: 24,
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
    borderColor: c.border,
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
    borderColor: c.border,
  },
  infoBoxText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    lineHeight: 18,
  },
  infoBoxCalc: {
    marginTop: 12,
    gap: 6,
  },
  infoBoxCalcRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoBoxCalcTotal: {
    borderTopWidth: 1,
    borderTopColor: c.border,
    marginTop: 4,
    paddingTop: 8,
  },
  infoBoxCalcLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
  },
  infoBoxCalcValue: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
  },

  heroLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  heroAction: {
    fontFamily: fonts.semibold,
    fontSize: 20,
    color: c.text,
    lineHeight: 30,
    letterSpacing: -0.4,
  },
  heroMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  heroImpact: {
    fontFamily: fonts.mono,
    fontSize: 16,
    color: c.text,
  },
  heroStrategy: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    lineHeight: 20,
    marginTop: 18,
  },
  heroActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 28,
  },
  heroCta: {
    flex: 2,
    backgroundColor: c.accent,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  heroCtaText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
    letterSpacing: 0.2,
  },
  heroSecondary: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  heroSecondaryText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.dim,
  },
  heroMore: {
    alignItems: 'center',
    paddingTop: 20,
    marginTop: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  heroMoreText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // ── Card 1: Move items (kept for modals) ──
  moveItemFull: {
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
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
    fontSize: 13,
    color: c.text2,
    letterSpacing: 0.3,
  },
  effortPill: {
    borderRadius: 100,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: 'transparent',
  },
  effortPillText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.dim,
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
    borderColor: c.border,
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
    borderColor: c.border,
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  viewAllText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // ── Card 2: Income ──
  bigNumberWrap: {
    alignItems: 'center',
    paddingVertical: 28,
    paddingBottom: 36,
  },
  bigNumber: {
    fontFamily: fonts.mono,
    fontSize: 48,
    color: c.text,
    letterSpacing: -2,
  },
  bigNumberLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    marginTop: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.border,
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
    borderColor: c.border,
  },
  primaryTagText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.text,
    letterSpacing: 1,
  },
  sourceAmountWrap: {
    alignItems: 'flex-end',
  },
  sourceAmount: {
    fontFamily: fonts.mono,
    fontSize: 20,
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
    paddingVertical: 32,
    paddingBottom: 36,
  },
  safeToSpendAmount: {
    fontFamily: fonts.mono,
    fontSize: 44,
    color: c.text,
    letterSpacing: -2,
  },
  safeToSpendLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    marginTop: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  safeToSpendBar: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
    marginBottom: 20,
  },
  safeToSpendBarFill: {
    height: '100%',
    borderRadius: 1.5,
  },
  safeToSpendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  safeToSpendMeta: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    letterSpacing: 0.3,
  },

  // ── Breakdown section ──
  breakdownSection: {
    marginTop: 24,
    paddingTop: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  breakdownTitle: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  breakdownLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
  },
  breakdownValue: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.text2,
    letterSpacing: 0.3,
  },
  breakdownBold: {
    fontFamily: fonts.semibold,
    color: c.text,
  },
  breakdownDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    marginTop: 6,
    paddingTop: 10,
  },
  breakdownAdaptive: {
    backgroundColor: c.mintDim,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: c.border,
  },
  breakdownAdaptiveLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.text2,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  breakdownActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  adjustBtn: {
    flex: 1,
    backgroundColor: c.accent,
    paddingVertical: 12,
    borderRadius: 100,
    alignItems: 'center',
  },
  adjustBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.bg,
    letterSpacing: 0.3,
  },
  resetBtn: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center',
  },
  resetBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
    letterSpacing: 0.3,
  },
  limitEditor: {
    marginTop: 14,
    backgroundColor: c.mintDim,
    borderRadius: 12,
    padding: 14,
  },
  limitEditorLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  limitEditorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  limitEditorCurrency: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: c.text,
  },
  limitEditorInput: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 18,
    color: c.text,
    borderBottomWidth: 1,
    borderBottomColor: c.accent,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  limitEditorSave: {
    backgroundColor: c.accent,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 100,
  },
  limitEditorSaveText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.bg,
  },
  limitEditorCancel: {
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  limitEditorCancelText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
  },
  limitEditorHint: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.muted,
    marginTop: 8,
    lineHeight: 16,
  },

  // ── Card 4: Budget Reality ──
  budgetHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  expandHint: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.muted,
    marginTop: 2,
  },
  expandToggle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: c.border,
  },
  expandToggleText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.muted,
  },
  periodToggleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginBottom: 28,
  },
  periodBtn: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: c.border,
  },
  periodBtnText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 0.8,
  },
  periodTotalRow: {
    alignItems: 'center',
    marginBottom: 8,
  },
  periodTotalAmount: {
    fontFamily: fonts.mono,
    fontSize: 26,
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  periodTotalOf: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: c.dim,
  },
  periodTotalLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
    marginTop: 6,
    textAlign: 'center',
  },
  progressTrack: {
    height: 3,
    borderRadius: 1.5,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
    marginTop: 16,
    marginBottom: 28,
  },
  progressFill: {
    height: 3,
    borderRadius: 1.5,
  },
  sectionBlock: {
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  sectionBlockNoRule: {
    paddingVertical: 16,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  sectionLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
  },
  sectionStatus: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  sectionAmountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 12,
  },
  sectionSpent: {
    fontFamily: fonts.mono,
    fontSize: 16,
  },
  sectionBudget: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
  },
  progressTrackSmall: {
    height: 2,
    borderRadius: 1,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
  },
  progressFillSmall: {
    height: 2,
    borderRadius: 1,
  },
  allocationList: {
    marginTop: 12,
    gap: 10,
  },
  allocationHeading: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: c.muted,
    marginBottom: 4,
  },
  allocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  allocationRank: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.accent,
    width: 20,
  },
  allocationLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    flex: 1,
  },
  allocationAmount: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.dim,
  },
  allocationHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
    marginTop: 8,
    fontStyle: 'italic',
  },
  allocationItem: {
    paddingVertical: 6,
  },
  allocationItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  allocationUnallocated: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  allocationUnallocatedLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.muted,
  },
  allocationUnallocatedAmount: {
    fontFamily: fonts.mono,
    fontSize: 14,
  },
  allocationUpgrade: {
    marginTop: 10,
    paddingVertical: 10,
  },
  allocationUpgradeText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.muted,
    lineHeight: 18,
  },
  allocationUpgradeBtn: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    marginTop: 6,
  },
  variableIncomeFootnote: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.muted,
    marginTop: 16,
    textAlign: 'center',
  },
  txCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 4,
  },
  txCardTitle: {
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: c.text,
  },
  txCardChevron: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
  },
  budgetBar: {
    flexDirection: 'row',
    height: 3,
    borderRadius: 1.5,
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
    fontSize: 18,
  },
  summaryLabel: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.dim,
    marginTop: 8,
  },
  summaryPct: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
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
    borderColor: c.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  dataRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    minHeight: 52,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  dataRowLast: {
    borderBottomWidth: 0,
  },
  dataRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  txRowLast: {
    borderBottomWidth: 0,
  },
  txLeft: {
    flex: 1,
    marginRight: 16,
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
    fontSize: 11,
    color: c.text2,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // ── Subscription shortcut ──
  subsLink: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  subsLinkText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.text,
  },
  subsLinkArrow: {
    fontFamily: fonts.regular,
    fontSize: 18,
    color: c.text2,
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
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
    borderColor: c.border,
    borderRadius: 12,
    borderStyle: 'dashed',
  },
  quickAddIcon: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.dim,
  },
  quickAddText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
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
    borderColor: c.border,
    width: '100%',
    maxWidth: 400,
  },
  modalContentScrollable: {
    backgroundColor: c.card,
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: c.border,
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
    borderColor: c.border,
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
    color: c.text,
    fontFamily: fonts.semibold,
    textDecorationLine: 'underline',
  },

  // ── Income arrival alert ──
  incomeAlert: {
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  incomeAlertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  incomeAlertTitle: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.text,
  },
  incomeAlertDismiss: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.muted,
    paddingLeft: 8,
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
    color: c.text,
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
    maxWidth: 560,
    alignSelf: 'center' as const,
    width: '100%',
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
  catReviewCloseBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catReviewClose: {
    fontFamily: fonts.medium,
    fontSize: 18,
    color: c.muted,
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
    borderColor: c.accentDim,
    backgroundColor: c.mintDim,
  },
  catReviewRowAi: {
    borderColor: c.green,
    borderLeftWidth: 3,
  },
  aiSuggestedLabel: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.green,
    letterSpacing: 0.5,
    textTransform: 'uppercase' as const,
    marginTop: 2,
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
    backgroundColor: c.accent,
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
    backgroundColor: c.mintDim,
  },
  aiSuggestText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
    letterSpacing: 0.3,
  },

  // ── Info icon (small) on hero card ──
  infoIconSmall: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.dim,
    justifyContent: 'center',
    alignItems: 'center',
  },
  infoIconSmallText: {
    fontFamily: fonts.mono,
    fontSize: 9,
    color: c.dim,
    marginTop: -1,
  },

  // ── Weekly info / limit modals ──
  modalTag: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  modalDotSep: {
    flexDirection: 'row',
    gap: 6,
    marginVertical: spacing.md,
  },
  modalDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },
  modalBody: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: c.text2,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  modalBreakdown: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: 10,
  },
  modalBreakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  modalBreakdownLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.text2,
  },
  modalBreakdownValue: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.text2,
    letterSpacing: 0.3,
  },
  modalCloseBtn: {
    backgroundColor: c.accent,
    paddingVertical: 14,
    borderRadius: 100,
    alignItems: 'center',
  },
  modalCloseBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.bg,
    letterSpacing: 0.2,
  },
  modalResetBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: spacing.sm,
  },
  modalResetBtnText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.dim,
    letterSpacing: 0.3,
  },
  limitEditorInput: {
    flex: 1,
    fontFamily: fonts.mono,
    fontSize: 28,
    color: c.text,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    letterSpacing: -0.5,
  },
});
