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
import Paywall from '@/components/Paywall';
import Card, { AnimatedCard, AnimGlyph, BreathingBar, ProgressBar, CardTitle, CardTitleRow, InfoIcon, InfoBox, CardDivider, SectionDot, SMOOTH_ANIM } from '@/components/Card';
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

  const { isPro } = useSubscription();
  const [showPaywall, setShowPaywall] = useState(false);
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
  const [budgetExpanded, setBudgetExpanded] = useState(false);
  const userIdRef = useRef<string | null>(null);

  // Custom weekly spending limit
  const [customWeeklyLimit, setCustomWeeklyLimit] = useState<number | null>(null);
  const [showLimitEditor, setShowLimitEditor] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [breakdownExpanded, setBreakdownExpanded] = useState(false);
  const [budgetPeriod, setBudgetPeriod] = useState<'year' | 'month' | 'week'>('month');
  const budgetPeriodInitialised = useRef(false);

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

      setUserName(user.user_metadata?.full_name?.split(' ')[0] || '');
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

      const result = await requestSync(userId, force);
      if (!result) { setSyncing(false); return; }

      // Surface connection issues to the user
      if (result.connectionIssues?.length > 0) {
        const banks = result.expiredBankNames ?? [];
        if (result.connectionIssues.includes('token_expired') || result.connectionIssues.includes('no_connection')) {
          setConnectionWarning({ message: 'all_expired', banks });
        } else if (result.connectionIssues.includes('some_connections_expired')) {
          setConnectionWarning({ message: 'some_expired', banks });
        }
      } else if (result.dataSource === 'fallback') {
        setConnectionWarning({ message: 'fallback', banks: [] });
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
      <View style={s.headerRow}>
        <View style={s.headerLeft}>
          <View style={s.bocyHeaderWrap}>
            <BocyFace mood={getBocyMood(analysis)} size="sm" breathing />
          </View>
          <View>
            <Text style={s.greeting}>
              {userName || 'Hey'}
            </Text>
            {syncing ? (
              <Text style={s.syncText}>Syncing...</Text>
            ) : lastSynced > 0 ? (
              <Text style={s.syncText}>{formatTimeAgo(lastSynced)}</Text>
            ) : null}
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

      {/* ── Connection warning ── */}
      {connectionWarning && !connectionDismissed && (
        <View style={s.connectionBanner}>
          <TouchableOpacity style={s.connectionBannerBody} onPress={() => router.push('/(main)/connect')} activeOpacity={0.8}>
            <View style={{ flex: 1 }}>
              {connectionWarning.banks.length > 0
                ? connectionWarning.banks.map((bank, idx) => (
                    <Text key={idx} style={s.connectionBannerText}>Reconnect {bank}</Text>
                  ))
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

                <View style={{ marginTop: 20, gap: 12 }}>
                  {(weeklyCtx.committedThisWeek ?? 0) > 0 && (
                    <View style={s.focusSplitRow}>
                      <Text style={s.focusSplitLabel}>Bills & essentials</Text>
                      <Text style={[s.focusSplitValue, { color: colors.coral }]}>
                        -{'\u00a3'}{Math.round(weeklyCtx.committedThisWeek ?? 0).toLocaleString()}
                      </Text>
                    </View>
                  )}
                  {moves.length > 0 && moves[0].monthlyImpact > 0 && (
                    <View style={s.focusSplitRow}>
                      <Text style={s.focusSplitLabel}>{stripMd(moves[0].action)}</Text>
                      <Text style={[s.focusSplitValue, { color: colors.green }]}>
                        {'\u00a3'}{Math.round(moves[0].monthlyImpact / 4.33).toLocaleString()}/wk
                      </Text>
                    </View>
                  )}
                  <View style={[s.focusSplitRow, { borderTopWidth: 1, borderTopColor: colors.mintDim, paddingTop: 12 }]}>
                    <Text style={[s.focusSplitLabel, { fontFamily: fonts.semibold, color: colors.text }]}>Safe to spend</Text>
                    <Text style={[s.focusSplitValue, { fontFamily: fonts.mono, fontSize: 20, color: weeklyHealthy ? colors.text : colors.coral }]}>
                      {'\u00a3'}{Math.round(weeklyBudget).toLocaleString()}/wk
                    </Text>
                  </View>
                </View>

                <TouchableOpacity
                  style={[s.heroCta, { marginTop: 24 }]}
                  onPress={() => {
                    dismissIncome();
                    router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: 'I just got paid. Walk me through what to do.' } });
                  }}
                >
                  <Text style={s.heroCtaText}>Talk to Bocy about this</Text>
                </TouchableOpacity>
              </Card>
            </AnimGlyph>
          ) : (
            /* ── Weekly budget status (default) ── */
            <AnimGlyph delay={0}>
              <Card variant="hero" accentBar accentBarColor={weeklyHealthy ? colors.green : colors.coral}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.heroLabel}>THIS WEEK</Text>
                    <Text style={[s.safeToSpendAmount, !weeklyHealthy && { color: colors.coral }, { fontSize: 40 }]}>
                      {'\u00a3'}{Math.round(weeklyRemaining).toLocaleString()}
                    </Text>
                    <Text style={s.safeToSpendLabel}>left to spend</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.safeToSpendMeta}>
                      {'\u00a3'}{Math.round(spentThisWeek).toLocaleString()} spent
                    </Text>
                    <Text style={[s.safeToSpendMeta, { marginTop: 4 }]}>
                      of {'\u00a3'}{Math.round(weeklyBudget).toLocaleString()}
                    </Text>
                  </View>
                </View>

                <ProgressBar
                  percent={weeklyUsedPct}
                  color={weeklyHealthy ? colors.green : colors.coral}
                  height={4}
                  breathing
                  style={{ marginTop: 20, marginBottom: 8 }}
                />

                {/* Top move teaser */}
                {dashboardMoves.length > 0 && (
                  <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.mintDim }}>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.green, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>
                      #1 MOVE
                    </Text>
                    <Text style={{ fontFamily: fonts.medium, fontSize: 15, color: colors.text, lineHeight: 22 }}>
                      {stripMd(dashboardMoves[0].action)}
                    </Text>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.green, marginTop: 4 }}>
                      +{'\u00a3'}{(dashboardMoves[0].annualImpact || 0).toLocaleString()}/yr
                    </Text>
                  </View>
                )}
              </Card>
            </AnimGlyph>
          )}
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
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <SectionDot color={colors.green} />
                      <Text style={s.moveSectionLabel}>IN PROGRESS</Text>
                    </View>
                  </View>
                  {userPlans.map((plan) => (
                    <Card key={plan.id} variant="active" style={{ marginBottom: spacing.md }}>
                      <Text style={s.moveAction}>{stripMd(plan.action)}</Text>
                      {plan.monthly_saving != null && (
                        <Text style={s.moveImpactText}>{'\u00a3'}{plan.monthly_saving}/mo</Text>
                      )}
                    </Card>
                  ))}
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
                            <View style={[s.moveBadge, { backgroundColor: colors.green, borderColor: colors.green }]}>
                              <Text style={[s.moveBadgeText, { color: colors.bg }]}>{'\u2713'}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={s.moveAction}>{stripMd(move.action)}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                <Text style={s.moveImpactText}>{'\u00a3'}{move.monthlyImpact}/mo</Text>
                                <Text style={{ fontSize: 10, color: colors.muted }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                              </View>
                              {!isExpanded && steps.length > 0 && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                                  <ProgressBar percent={Math.round(stepProgress * 100)} color={colors.green} height={3} style={{ flex: 1 }} />
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{doneSteps.length}/{steps.length}</Text>
                                </View>
                              )}
                            </View>
                          </View>
                        </TouchableOpacity>
                        {isExpanded && (
                          <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.mintDim }}>
                            {move.strategy && <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22, marginBottom: 16 }}>{stripMd(move.strategy)}</Text>}
                            {steps.map((step: string, j: number) => {
                              const isDone = doneSteps.includes(j);
                              return (
                                <TouchableOpacity key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.mintDim }} onPress={() => togglePlanStep(moveKey, j, move.action)} activeOpacity={0.7}>
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
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <SectionDot color={colors.accent} />
                      <Text style={s.moveSectionLabel}>YOUR MOVES</Text>
                    </View>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.green }}>
                      {'\u00a3'}{Math.round(opportunityMoves.reduce((s, m) => s + (m.monthlyImpact || 0), 0))}/mo potential
                    </Text>
                  </View>
                  {(isPro ? opportunityMoves : opportunityMoves.slice(0, 2)).map((move, seqIdx) => {
                    const i = move._sortIdx;
                    const isExpanded = expandedMove === i;
                    const moveKey = `move-${i}`;
                    const providerActions = getProviderActions(move);
                    return (
                      <Card key={`opp-${i}`} variant="default" style={{ marginBottom: spacing.md }}>
                        <TouchableOpacity onPress={() => setExpandedMove(isExpanded ? null : i)} activeOpacity={0.8}>
                          <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                            <View style={s.moveBadge}>
                              <Text style={s.moveBadgeText}>{seqIdx + 1}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={s.moveAction}>{stripMd(move.action)}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                <Text style={s.moveImpactText}>{'\u00a3'}{move.monthlyImpact}/mo</Text>
                                <View style={[s.effortPill, { backgroundColor: `${effortColor(move.effort)}15` }]}>
                                  <Text style={[s.effortPillText, { color: effortColor(move.effort) }]}>{effortLabel(move.effort)}</Text>
                                </View>
                                <Text style={{ fontSize: 10, color: colors.muted, marginLeft: 'auto' }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                              </View>
                              {!isExpanded && move.merchants && move.merchants.length > 0 && (
                                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
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
                          <View style={{ marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.mintDim }}>
                            {move.strategy && <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22, marginBottom: 16 }}>{stripMd(move.strategy)}</Text>}

                            <TouchableOpacity style={[s.heroCta, { marginBottom: 16, paddingVertical: 12 }]} onPress={() => handleStartMove(i, move)} activeOpacity={0.8}>
                              <Text style={s.heroCtaText}>Start this move</Text>
                            </TouchableOpacity>

                            {move.merchants && move.merchants.length > 0 && (
                              <View style={{ marginBottom: 16 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.text2, textTransform: 'uppercase', marginBottom: 8 }}>WHERE YOUR MONEY GOES</Text>
                                {move.merchants.map((m: string, j: number) => (
                                  <View key={j} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
                                    <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
                                    <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2 }}>{m}</Text>
                                  </View>
                                ))}
                              </View>
                            )}

                            {(move.steps || []).length > 0 && (
                              <View style={{ marginBottom: 16 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.text2, textTransform: 'uppercase', marginBottom: 8 }}>STEPS</Text>
                                {(move.steps || []).map((step: string, j: number) => (
                                  <View key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.mintDim }}>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.dim, width: 22, textAlign: 'center' }}>{j + 1}</Text>
                                    <Text style={{ flex: 1, fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 }}>{stripMd(step)}</Text>
                                  </View>
                                ))}
                              </View>
                            )}

                            {move.effect && (
                              <View style={{ marginBottom: 16 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.text2, textTransform: 'uppercase', marginBottom: 8 }}>OUTCOME</Text>
                                <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text, lineHeight: 22 }}>{stripMd(move.effect)}</Text>
                              </View>
                            )}

                            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
                              <View style={{ flex: 1, backgroundColor: colors.mintDim, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, alignItems: 'center' }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.green }}>{'\u00a3'}{move.monthlyImpact || 0}</Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.dim, marginTop: 2 }}>per month</Text>
                              </View>
                              <View style={{ flex: 1, backgroundColor: colors.mintDim, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, alignItems: 'center' }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.green }}>{'\u00a3'}{move.annualImpact || 0}</Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.dim, marginTop: 2 }}>per year</Text>
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

                            <TouchableOpacity style={{ alignItems: 'center', paddingVertical: 8 }} onPress={() => handleDeleteMove(move)}>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.coral }}>Delete</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </Card>
                    );
                  })}

                  {!isPro && opportunityMoves.length > 2 && (
                    <Card variant="upgrade" accentBar accentBarColor={colors.green} onPress={() => setShowPaywall(true)} style={{ marginBottom: spacing.md, alignItems: 'center' }}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.green, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>PRO</Text>
                      <Text style={{ fontFamily: fonts.semibold, fontSize: 16, color: colors.text, textAlign: 'center' }}>
                        +{opportunityMoves.length - 2} more moves locked
                      </Text>
                      <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.dim, textAlign: 'center', marginTop: 4, marginBottom: 12 }}>
                        Unlock your full action plan
                      </Text>
                      <View style={[s.heroCta, { paddingVertical: 12 }]}>
                        <Text style={[s.heroCtaText, { fontSize: 13 }]}>See plans</Text>
                      </View>
                    </Card>
                  )}
                </>
              )}
            </>
          )}

          {/* ══════════════════════════════════════════════
              BUDGET — collapsed by default
              ══════════════════════════════════════════════ */}
          {/* ── Budget overview — collapsed by default ── */}
          <View onLayout={(e) => { cardPositions.current.budget = e.nativeEvent.layout.y; }}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setBudgetExpanded(!budgetExpanded); }}
              style={s.collapsedSectionBtn}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <SectionDot color={overallPctUsed > 100 ? colors.coral : colors.accent} />
                <Text style={s.moveSectionLabel}>BUDGET</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: overallPctUsed > 100 ? colors.coral : colors.text2 }}>
                  {'\u00a3'}{Math.round(periodSpendTotal).toLocaleString()} / {'\u00a3'}{Math.round(periodIncome).toLocaleString()}
                </Text>
                <Text style={{ fontSize: 10, color: colors.muted }}>{budgetExpanded ? '\u25B2' : '\u25BC'}</Text>
              </View>
            </TouchableOpacity>

            {budgetExpanded && (
              <Card accentBar accentBarColor={overallPctUsed > 100 ? colors.coral : colors.accent} style={{ marginBottom: spacing.md }}>
                <ProgressBar percent={overallPctUsed} color={overallPctUsed > 100 ? colors.coral : overallPctUsed > 85 ? colors.amber : colors.green} height={6} style={{ marginBottom: 20 }} />

                <View style={s.sectionBlock}>
                  <View style={s.sectionHeaderRow}>
                    <Text style={[s.sectionLabel, { color: colors.text }]}>Essentials</Text>
                    <Text style={[s.sectionStatus, { color: essentialsOnTrack ? colors.green : colors.coral }]}>
                      {'\u00a3'}{Math.round(periodNonDiscTotal).toLocaleString()} of {'\u00a3'}{Math.round(periodNonDiscBudget).toLocaleString()}
                    </Text>
                  </View>
                  <ProgressBar percent={essentialsPctUsed} color={essentialsOnTrack ? colors.text2 : colors.coral} height={4} />
                </View>

                <View style={s.sectionBlock}>
                  <View style={s.sectionHeaderRow}>
                    <Text style={[s.sectionLabel, { color: colors.text2 }]}>Lifestyle</Text>
                    <Text style={[s.sectionStatus, { color: lifestyleOnTrack ? colors.green : colors.coral }]}>
                      {'\u00a3'}{Math.round(periodDiscTotal).toLocaleString()} of {'\u00a3'}{Math.round(periodDiscBudget).toLocaleString()}
                    </Text>
                  </View>
                  <ProgressBar percent={lifestylePctUsed} color={lifestyleOnTrack ? colors.dim : colors.coral} height={4} />
                </View>

                <View style={[s.sectionBlock, { borderBottomWidth: 0 }]}>
                  <View style={s.sectionHeaderRow}>
                    <Text style={[s.sectionLabel, { color: colors.text2 }]}>Remaining</Text>
                    <Text style={[s.sectionStatus, { color: periodRemaining > 0 ? colors.green : colors.coral }]}>
                      {'\u00a3'}{Math.round(periodRemaining).toLocaleString()}
                    </Text>
                  </View>
                </View>

                {/* Period toggle */}
                <View style={[s.periodToggleRow, { marginBottom: 0, marginTop: 8 }]}>
                  {(['month', 'week'] as const).map((p) => (
                    <TouchableOpacity key={p} style={[s.periodBtn, budgetPeriod === p && { backgroundColor: colors.accent }]} onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setBudgetPeriod(p); }}>
                      <Text style={[s.periodBtnText, budgetPeriod === p && { color: colors.bg }]}>{p === 'month' ? 'Monthly' : 'Weekly'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </Card>
            )}
          </View>

          {/* ── Transactions — collapsed by default ── */}
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setTxCardExpanded(prev => !prev); }}
            style={s.collapsedSectionBtn}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <SectionDot color={colors.dim} />
              <Text style={s.moveSectionLabel}>TRANSACTIONS</Text>
            </View>
            <Text style={{ fontSize: 10, color: colors.muted }}>{txCardExpanded ? '\u25B2' : '\u25BC'}</Text>
          </TouchableOpacity>

          {txCardExpanded && (
            <Card style={{ marginBottom: spacing.md }} accentBar={false}>
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
                    {isExp && item.txs.map((tx, j) => (
                      <TouchableOpacity key={j} style={s.txRow} onLongPress={() => { setRecatTx({ tx, catKey: item.category, section: 'essential' }); setRecatTarget(''); setRecatEssential(true); }} activeOpacity={0.7}>
                        <View style={s.txLeft}>
                          <Text style={s.txMerchant}>{tx.merchant}</Text>
                          <Text style={s.txDate}>{formatDate(tx.date)}</Text>
                        </View>
                        <Text style={[s.txAmount, { color: colors.text2 }]}>{'\u00a3'}{Math.abs(tx.amount).toFixed(2)}</Text>
                      </TouchableOpacity>
                    ))}
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
                    {isExp && item.txs.map((tx, j) => (
                      <TouchableOpacity key={j} style={s.txRow} onLongPress={() => { setRecatTx({ tx, catKey: item.category, section: 'lifestyle' }); setRecatTarget(''); setRecatEssential(false); }} activeOpacity={0.7}>
                        <View style={s.txLeft}>
                          <Text style={s.txMerchant}>{tx.merchant}</Text>
                          <Text style={s.txDate}>{formatDate(tx.date)}</Text>
                        </View>
                        <Text style={[s.txAmount, { color: colors.dim }]}>{'\u00a3'}{Math.abs(tx.amount).toFixed(2)}</Text>
                      </TouchableOpacity>
                    ))}
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

      <Paywall visible={showPaywall} onClose={() => setShowPaywall(false)} feature="moves" />
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
          actionLabel="Talk to Bocy"
          actionPrefill="I just got paid. Walk me through what to do first."
          fingerprint={incomeFingerprint ? `income:${incomeFingerprint}` : undefined}
        />
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
    paddingBottom: 80,
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

  // ── Connection warning banner ──
  connectionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.md,
    marginBottom: spacing.lg,
    paddingVertical: 10,
    paddingLeft: 14,
    paddingRight: 6,
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
    fontSize: 14,
    color: c.text2,
    flex: 1,
  },
  focusSplitValue: {
    fontFamily: fonts.mono,
    fontSize: 15,
    letterSpacing: -0.3,
  },

  // ── Moves section ──
  moveSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  moveSectionLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    color: c.text2,
    textTransform: 'uppercase',
  },
  moveAction: {
    fontFamily: fonts.medium,
    fontSize: 15,
    color: c.text,
    lineHeight: 22,
  },
  moveImpactText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.green,
  },
  moveBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: c.mintDim,
    borderWidth: 1,
    borderColor: c.accentDim,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.sm,
    marginTop: 2,
  },
  moveBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
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
    backgroundColor: c.green,
    borderColor: c.green,
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
    paddingVertical: 16,
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
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
    borderColor: c.mintDim,
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
    fontSize: 11,
    color: c.green,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 16,
  },
  heroAction: {
    fontFamily: fonts.semibold,
    fontSize: 22,
    color: c.text,
    lineHeight: 30,
    letterSpacing: -0.3,
  },
  heroMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  heroImpact: {
    fontFamily: fonts.mono,
    fontSize: 18,
    color: c.green,
  },
  heroStrategy: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    lineHeight: 20,
    marginTop: 16,
  },
  heroActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 24,
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
    fontSize: 15,
    color: c.bg,
    letterSpacing: 0.3,
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
    fontSize: 14,
    color: c.dim,
  },
  heroMore: {
    alignItems: 'center',
    paddingTop: 20,
    marginTop: 20,
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
  },
  heroMoreText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.green,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },

  // ── Card 1: Move items (kept for modals) ──
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
    color: c.green,
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
    paddingVertical: 24,
    paddingBottom: 28,
  },
  safeToSpendAmount: {
    fontFamily: fonts.mono,
    fontSize: 48,
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

  // ── Breakdown section ──
  breakdownSection: {
    marginTop: 20,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
  },
  breakdownTitle: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    letterSpacing: 1,
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
    borderTopWidth: 1,
    borderTopColor: c.mintDim,
    marginTop: 6,
    paddingTop: 10,
  },
  breakdownAdaptive: {
    backgroundColor: c.greenDim,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    marginBottom: 6,
  },
  breakdownAdaptiveLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.green,
    letterSpacing: 0.8,
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
    marginBottom: 20,
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
  periodToggleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 28,
  },
  periodBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: c.border,
  },
  periodBtnText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    letterSpacing: 0.5,
  },
  periodTotalRow: {
    alignItems: 'center',
    marginBottom: 8,
  },
  periodTotalAmount: {
    fontFamily: fonts.mono,
    fontSize: 28,
    letterSpacing: -0.5,
    textAlign: 'center',
  },
  periodTotalOf: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: c.dim,
  },
  periodTotalLabel: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    marginTop: 6,
    textAlign: 'center',
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
    marginTop: 20,
    marginBottom: 32,
  },
  progressFill: {
    height: 6,
    borderRadius: 3,
  },
  sectionBlock: {
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
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
    fontSize: 18,
  },
  sectionBudget: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
  },
  progressTrackSmall: {
    height: 4,
    borderRadius: 2,
    backgroundColor: c.mintDim,
    overflow: 'hidden',
  },
  progressFillSmall: {
    height: 4,
    borderRadius: 2,
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
    borderColor: c.border,
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
    color: c.accent,
    letterSpacing: 0.5,
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
    color: c.green,
  },
  subsLinkArrow: {
    fontFamily: fonts.regular,
    fontSize: 18,
    color: c.green,
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
    backgroundColor: c.greenDim,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.25)',
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
    color: c.green,
  },
  incomeAlertDismiss: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.green,
    opacity: 0.5,
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
