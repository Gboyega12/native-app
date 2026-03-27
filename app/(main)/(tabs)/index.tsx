import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, FlatList, ActivityIndicator,
  LayoutAnimation, TextInput, Modal, Pressable, Animated, Easing, PanResponder,
  RefreshControl, Linking, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { hapticLight, hapticMedium, hapticSuccess, hapticWarning, hapticTick } from '@/lib/haptics';
import { getLastResult } from '@/app/(main)/processing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { requestSync, onSyncComplete, getLastSyncTime, invalidateSyncCache } from '@/lib/sync-coordinator';
import type { WeeklyContext } from '@/lib/sync';
import type { ReactiveEvent } from '@/lib/reactive-engine';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import { BocyFace, getBocyMood } from '@/components/Bocy';
import { hydrateSubGoals, repairDebtSubGoals, resolveDebtDisplayName } from '@/lib/types';
import { classifyDebtAccounts } from '@/lib/debt-engine';
import type { Analysis, BudgetCategory, TransactionDetail, IncomeSource, Move, Goals, MoveSubGoal, MoveSubGoalType, Insight, Investment } from '@/lib/types';
import { classifyAccounts, type AccountBuckets } from '@/lib/account-classifier';
import Card, { AnimatedCard, AnimGlyph, BreathingBar, CardTitle, CardTitleRow, InfoIcon, InfoBox, ExpandDots, SMOOTH_ANIM, HorizontalConnectorDots } from '@/components/Card';
import AnimatedNumber from '@/components/AnimatedNumber';
import { DashboardSkeleton } from '@/components/Skeleton';
import { WeeklySparkline } from '@/components/Charts';
import Walkthrough, { useWalkthrough } from '@/components/Walkthrough';
import InsightModal from '@/components/InsightModal';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { useAppData } from '@/hooks/useAppData';
import EnrichmentEngine from '@/lib/enrichment-engine';
import { formatTimeAgo, formatTxDateAge } from '@/lib/date-utils';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';

// Cache the beforeinstallprompt event for the install modal
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    (window as any).__pwaInstallPrompt = e;
  });
}

/** Strip markdown bold/italic markers from text rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');



export default function Home() {
  const router = useRouter();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet, horizontalPadding, width: screenWidth } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
  const { isOnline, isActive } = useOnlineStatus();
  // ── Shared data from AppDataProvider (eliminates redundant fetches across tabs) ──
  const appData = useAppData();
  // Local overrides — Home screen applies mergeAdjustments and optimistic updates
  // on top of the shared analysis, so we keep local state that shadows the context.
  const [analysisLocal, setAnalysisLocal] = useState<Analysis | null>(null);
  const [loadingLocal, setLoadingLocal] = useState(true);
  // Derive effective values: prefer local override, fall back to shared context
  const analysis = analysisLocal ?? appData.analysis;
  const setAnalysis = setAnalysisLocal;
  const loading = loadingLocal && appData.loading;
  const userName = appData.userName;
  const debtAccounts = appData.debtAccounts;
  const setDebtAccounts = appData.setDebtAccounts;
  const investments = appData.investments;
  const weeklyCtx = appData.weeklyCtx;
  const setWeeklyCtx = appData.setWeeklyCtx;

  const [expandedMoves, setExpandedMoves] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState<number>(0);
  const [latestTxDate, setLatestTxDate] = useState<string | null>(null);
  const [syncDataSource, setSyncDataSource] = useState<'finexer' | 'fallback' | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [connectionWarning, setConnectionWarning] = useState<{ message: string; banks: string[] } | null>(null);
  const [connectionDismissed, setConnectionDismissed] = useState(true); // Default hidden; show only after confirming not dismissed
  const [incomeDismissed, setIncomeDismissed] = useState(false);
  const [hasBankConnection, setHasBankConnection] = useState(false);
  const { showWalkthrough, dismissWalkthrough } = useWalkthrough();
  const dashScrollRef = useRef<ScrollView>(null);
  const cardPositions = useRef<Record<string, number>>({});
  const syncRetryRef = useRef<number>(0);
  const overridesSavedAt = useRef<number>(0); // Timestamp of last override save — syncs started before this are rejected
  const overriddenMerchants = useRef<Set<string>>(new Set()); // Merchant keys categorised by user — reject sync results that still show these in "Other"
  const [savedOverrideKeys, setSavedOverrideKeys] = useState<Set<string>>(new Set()); // Persisted override match_descriptions from Supabase — used to filter unresolvedGroups
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const toggleCategory = useCallback((key: string) => {
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const [retriesExhausted, setRetriesExhausted] = useState(false);
  const heroScrollX = useRef(new Animated.Value(0)).current;
  const [heroPage, setHeroPage] = useState(0);
  const [verificationStatus, setVerificationStatus] = useState<'draft' | 'verifying' | 'verified' | null>(null);
  const verifyPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissCache = useRef<Record<string, string>>({});

  // Review modal animation
  const reviewModalFade = useRef(new Animated.Value(0)).current;
  const reviewModalSlide = useRef(new Animated.Value(40)).current;

  // ── Safety timeout: if bank is connected but no analysis after 3 minutes, show escape hatch ──
  useEffect(() => {
    if (analysis || !hasBankConnection || retriesExhausted) return;
    const timer = setTimeout(() => {
      setRetriesExhausted(true);
      console.warn('[home] Safety timeout — showing action buttons after 3 minutes');
    }, 3 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [analysis, hasBankConnection, retriesExhausted]);

  // ── Connection banner dismiss ──
  // Keyed by the sorted bank names. Dismissing stores these bank names.
  // Banner only reappears if the set of expired banks actually changes
  // (i.e. a new bank expires, or the user reconnects and a different one lapses).
  const CONN_DISMISS_KEY = 'dismiss:conn:banks';

  // Hydrate dismiss cache on mount (once)
  useEffect(() => {
    AsyncStorage.getItem(CONN_DISMISS_KEY).then((stored) => {
      if (stored) dismissCache.current[CONN_DISMISS_KEY] = stored;
    }).catch(() => {});
  }, []);

  // When warning changes, compare synchronously against cache
  useEffect(() => {
    if (!connectionWarning) return; // warning cleared = leave dismiss state alone
    const currentFingerprint = connectionWarning.banks.sort().join(',');
    if (dismissCache.current[CONN_DISMISS_KEY] === currentFingerprint) {
      setConnectionDismissed(true); // same banks as dismissed — stay hidden
    } else {
      setConnectionDismissed(false); // new bank set — show banner
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
    trackEvent('Connection Warning Dismissed');
    setConnectionDismissed(true);
    if (connectionWarning) {
      const fp = connectionWarning.banks.sort().join(',');
      dismissCache.current[CONN_DISMISS_KEY] = fp;
      AsyncStorage.setItem(CONN_DISMISS_KEY, fp).catch(() => {});
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

  // ── Show install-app modal once after first analysis (post-onboarding) ──
  useEffect(() => {
    if (!analysis) return;
    if (typeof window === 'undefined') return;
    // Skip if already installed as standalone PWA
    if (window.matchMedia?.('(display-mode: standalone)')?.matches || (window.navigator as any)?.standalone) return;
    AsyncStorage.getItem('install_modal_shown').then((v) => {
      if (!v) {
        const timer = setTimeout(() => setShowInstallModal(true), 1500);
        return () => clearTimeout(timer);
      }
    }).catch(() => {});
  }, [!!analysis]);

  const toggleMove = (idx: number) => {
    trackEvent('Move Toggled', { move_index: idx });
    hapticMedium();
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setExpandedMoves((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const [showInsightModal, setShowInsightModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [infoCard, setInfoCard] = useState<string | null>(null);
  const [removingSource, setRemovingSource] = useState<string | null>(null);

  // Previous month snapshot for real income comparison
  // Previous month snapshot — from shared context
  const prevSnapshot = appData.prevSnapshot;

  // ── Reactive engine state ──
  const [reactiveEvents, setReactiveEvents] = useState<ReactiveEvent[]>([]);
  const [showReactiveModal, setShowReactiveModal] = useState(false);
  const [reactiveEventIndex, setReactiveEventIndex] = useState(0);
  // ── Plan data (merged from plan page) ──
  // ── Plan data — from shared context ──
  const userPlans = appData.userPlans;
  const planProgress = appData.planProgress;
  const setPlanProgress = appData.setPlanProgress;
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [expandedMove, setExpandedMove] = useState<number | null>(null);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [incomeExpanded, setIncomeExpanded] = useState(false);
  const [debtExpanded, setDebtExpanded] = useState(false);
  const [investmentExpanded, setInvestmentExpanded] = useState(false);
  const [expandedIncomeSource, setExpandedIncomeSource] = useState<string | null>(null);
  const [showAllMoves, setShowAllMoves] = useState(false);
  const [expandedInsights, setExpandedInsights] = useState<Set<number>>(new Set());
  const [insightsSectionOpen, setInsightsSectionOpen] = useState(false);
  const [recsSectionOpen, setRecsSectionOpen] = useState(false);
  const [agentInsightsSectionOpen, setAgentInsightsSectionOpen] = useState(false);
  const [showAllInsights, setShowAllInsights] = useState(false);
  const [accountBuckets, setAccountBuckets] = useState<AccountBuckets | null>(null);
  const [userProperties, setUserProperties] = useState<Array<{ address: string; estimated_value: number; mortgage_balance: number | null; has_mortgage: boolean }>>([]);
  const [justCompleted, setJustCompleted] = useState<string | null>(null); // move key that was just completed
  const userIdRef = useRef<string | null>(null);

  // Custom weekly spending limit
  const [customWeeklyLimit, setCustomWeeklyLimit] = useState<number | null>(null);
  const [showLimitEditor, setShowLimitEditor] = useState(false);
  const [showWeeklyInfo, setShowWeeklyInfo] = useState(false);
  const [limitInput, setLimitInput] = useState('');
  const [breakdownExpanded, setBreakdownExpanded] = useState(false);


  // Load custom weekly limit from storage
  useEffect(() => {
    AsyncStorage.getItem('custom_weekly_limit').then((val) => {
      if (val) setCustomWeeklyLimit(parseFloat(val));
    }).catch(() => {});
  }, []);

  // Hydrate overridesSavedAt from AsyncStorage so the guard survives page refreshes
  useEffect(() => {
    AsyncStorage.getItem('overrides_saved_at').then((val) => {
      if (val) {
        const ts = parseInt(val, 10);
        if (ts) overridesSavedAt.current = ts;
      }
    }).catch(() => {});
  }, []);

  // Unified review modal state
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [catAssignments, setCatAssignments] = useState<Record<string, { category: string; isEssential: boolean; aiSuggested?: boolean }>>({});
  // AI confirm/reject state: confirmed keys accept AI suggestion, rejected keys have user override
  const [aiConfirmed, setAiConfirmed] = useState<Set<string>>(new Set());
  const [aiOverrides, setAiOverrides] = useState<Record<string, { category: string; isEssential: boolean }>>({});
  // Track which AI group is expanded for category change
  const [aiExpandedKey, setAiExpandedKey] = useState<string | null>(null);
  const [savingReview, setSavingReview] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [reviewModalVisible, setReviewModalVisible] = useState(false);

  // Animate review modal in/out (matching InsightModal pattern)
  useEffect(() => {
    if (showReviewModal) {
      setReviewModalVisible(true);
      Animated.parallel([
        Animated.timing(reviewModalFade, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(reviewModalSlide, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(reviewModalFade, { toValue: 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
        Animated.timing(reviewModalSlide, { toValue: 40, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      ]).start(() => setReviewModalVisible(false));
    }
  }, [showReviewModal]);

  const ESSENTIAL_CATS = new Set([
    'Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport',
    'Childcare', 'Health', 'Education', 'Debt Payments', 'Savings',
    // Granular enrichment categories that are essential
    'Council Tax', 'Energy', 'Water', 'Broadband & Phone', 'TV Licence',
  ]);

  const BUDGET_CATEGORIES = [
    'Rent', 'Mortgage', 'Bills', 'Insurance', 'Groceries', 'Transport', 'Travel',
    'Eating Out', 'Shopping', 'Entertainment', 'Subscriptions', 'Health',
    'Childcare', 'Education', 'Charity', 'Debt Payments', 'Transfers', 'Savings', 'Investments',
    'Refund', 'Internal Transfer', 'Other',
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
      'Refund': 'Refund', 'Refunds': 'Refund',
      'Internal Transfer': 'Internal Transfer', 'Internal Transfers': 'Internal Transfer',
      'Bank Transfer': 'Internal Transfer', 'Account Transfer': 'Internal Transfer',
    };
    const mapped = map[cat] || cat;
    return BUDGET_CATEGORIES.includes(mapped) ? mapped : 'Other';
  };


  // Normalize merchant names so similar transactions group together
  const normalizeMerchant = (raw: string) => {
    let n = raw.trim();
    // Remove common bank prefixes (Revolut, Monzo, HSBC, etc. patterns)
    n = n.replace(/^(PAYMENT TO |DIRECT DEBIT |DEBIT CARD PAYMENT |CARD PAYMENT TO |CARD PAYMENT |CONTACTLESS |POS |MOBILE-|BGC |FPO |STO |FPI |DPC |BBP |FASTER PAYMENT |STANDING ORDER )/i, '');
    // Remove trailing reference numbers (4+ digits, often transaction IDs)
    n = n.replace(/\s+[\dA-Z]{4,}$/, '');
    // Remove trailing card suffixes (e.g., "ON 28 DEC", "CD 1234", "GBP 12.34")
    n = n.replace(/\s+(ON \d{1,2} [A-Z]{3}|CD \d{4}|GBP \d+\.?\d*|REF\s*\S+)$/i, '');
    // Remove trailing dates (dd/mm, dd-mm, ddMMMyy patterns)
    n = n.replace(/\s+\d{2}[\/\-]\d{2}([\/\-]\d{2,4})?$/, '');
    n = n.replace(/\s+\d{2}[A-Z]{3}\d{2,4}$/i, '');
    // Remove location suffixes (city/country codes like "LONDON GB", "LDN GBR")
    n = n.replace(/\s+[A-Z]{2,3}\s+[A-Z]{2,3}$/, '');
    // Remove asterisk/star separators common in card processors ("AMZN*", "SQ *")
    n = n.replace(/^([A-Z]+)\s*\*\s*/, '$1 ');
    // Collapse whitespace and lowercase for matching
    n = n.replace(/\s+/g, ' ').trim().toLowerCase();
    return n;
  };

  // ── Unresolved transaction groups (for categorise modal) ──
  // Only shows truly unclassifiable items — transactions the enrichment engine
  // AND Claude AI couldn't identify. Medium/high confidence results are auto-applied.
  // Users can always re-categorise from the budget section.
  const unresolvedGroups = useMemo(() => {
    if (!analysis) return [];
    const txs: TransactionDetail[] = [];
    const seen = new Set<string>();
    for (const section of [analysis.discretionary, analysis.non_discretionary]) {
      const items = (section as any)?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item?.category === 'Other') {
          const otherTxs: TransactionDetail[] = Array.isArray(item.transactions) ? item.transactions : [];
          for (const tx of otherTxs) {
            if (!tx) continue;
            // Dedup: skip if we've already collected this transaction
            const key = `${tx.date}|${tx.description}|${tx.amount}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // Backwards compat: if confidence/classifiedBy undefined (cached pre-deploy data),
            // include all 'Other' txs as a conservative fallback
            if (tx.confidence !== undefined) {
              if (tx.confidence === 'low' && tx.classifiedBy === 'default') txs.push(tx);
            } else {
              txs.push(tx);
            }
          }
        }
      }
    }
    // Include person-to-person transfers so users can recategorise them (e.g. rent paid to partner)
    const personTransfers: any[] = Array.isArray((analysis as any)?.person_transfers) ? (analysis as any).person_transfers : [];
    for (const pt of personTransfers) {
      if (!pt) continue;
      const key = `${pt.date}|${pt.description}|${pt.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      txs.push({ ...pt, confidence: 'low', classifiedBy: 'default' });
    }
    // Group by normalized merchant/description — user assigns one category per group
    const groups = new Map<string, { key: string; label: string; merchants: string[]; txs: TransactionDetail[]; total: number }>();
    for (const tx of txs) {
      if (!tx) continue;
      const raw = tx.merchant || tx.description || '';
      const normalized = normalizeMerchant(raw);
      // Skip merchants that already have a persisted override — they were already
      // categorised by the user. This prevents the review modal from repopulating
      // with the same items after a sync overwrites the optimistic analysis state.
      if (savedOverrideKeys.has(normalized)) continue;
      if (!groups.has(normalized)) groups.set(normalized, { key: normalized, label: raw, merchants: [], txs: [], total: 0 });
      const g = groups.get(normalized)!;
      if (!g.merchants.includes(raw)) g.merchants.push(raw);
      g.txs.push(tx);
      g.total += Math.abs(tx.amount ?? 0);
    }
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [analysis, savedOverrideKeys]);

  // AI-classified transactions: only surface genuinely uncertain ones for review.
  // Medium/high confidence in a real category = auto-accepted (no review needed).
  // Only low-confidence or "Other" category AI classifications need user confirmation.
  const aiSuggestedGroups = useMemo(() => {
    if (!analysis) return [];
    const txs: TransactionDetail[] = [];
    const seen = new Set<string>();
    for (const section of [analysis.discretionary, analysis.non_discretionary]) {
      const items = (section as any)?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const sectionTxs: TransactionDetail[] = Array.isArray(item.transactions) ? item.transactions : [];
        for (const tx of sectionTxs) {
          if (!tx || (tx as any).classifiedBy !== 'claude_ai') continue;
          // Auto-accept: medium/high confidence in a real (non-Other) category
          // These are already correctly placed in the analysis — no review needed
          const isLowConfidence = tx.confidence === 'low' || tx.confidence === undefined;
          const isOtherCategory = item.category === 'Other';
          if (!isLowConfidence && !isOtherCategory) continue;
          const key = `${tx.date}|${tx.description}|${tx.amount}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Skip merchants user already has an override for
          const normalized = normalizeMerchant(tx.merchant || tx.description || '');
          if (savedOverrideKeys.has(normalized)) continue;
          txs.push(tx);
        }
      }
    }
    // Group by normalized merchant — same as unresolvedGroups
    const groups = new Map<string, { key: string; label: string; merchants: string[]; txs: TransactionDetail[]; total: number; aiCategory: string; aiEssential: boolean }>();
    for (const tx of txs) {
      const raw = tx.merchant || tx.description || '';
      const normalized = normalizeMerchant(raw);
      if (!groups.has(normalized)) {
        const mappedCat = mapClaudeCategory((tx as any).category || 'Other');
        groups.set(normalized, {
          key: normalized, label: raw, merchants: [], txs: [], total: 0,
          aiCategory: mappedCat, aiEssential: ESSENTIAL_CATS.has(mappedCat),
        });
      }
      const g = groups.get(normalized)!;
      if (!g.merchants.includes(raw)) g.merchants.push(raw);
      g.txs.push(tx);
      g.total += Math.abs(tx.amount ?? 0);
    }
    return Array.from(groups.values()).sort((a, b) => b.total - a.total);
  }, [analysis, savedOverrideKeys]);

  const unresolvedTxCount = useMemo(
    () => unresolvedGroups.reduce((sum, g) => sum + g.txs.length, 0),
    [unresolvedGroups],
  );

  const totalReviewCount = unresolvedGroups.length + aiSuggestedGroups.length;

  // §7c: Invisible learning signal — show when review count drops 30%+ from last month
  const lastReviewCount = (analysis as any)?.review_count_last_month;
  const showLearningSignal = lastReviewCount != null && lastReviewCount > 3
    && totalReviewCount > 0 && totalReviewCount < lastReviewCount * 0.7;

  // Auto-persist high-confidence AI classifications as overrides so the learning loop
  // kicks in immediately. These are transactions Claude classified with medium+ confidence
  // into a real category — they don't need user review, but they DO need to be saved
  // so future syncs don't re-classify the same merchant.
  useEffect(() => {
    if (!analysis) return;
    let cancelled = false;

    const persistConfidentAI = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      const toPersist: { merchant: string; category: string; isEssential: boolean }[] = [];
      for (const section of [analysis.discretionary, analysis.non_discretionary]) {
        const items = (section as any)?.items;
        if (!Array.isArray(items)) continue;
        const isEssentialSection = section === analysis.non_discretionary;
        for (const item of items) {
          if (item.category === 'Other') continue; // Only real categories
          const sectionTxs: TransactionDetail[] = Array.isArray(item.transactions) ? item.transactions : [];
          for (const tx of sectionTxs) {
            if (!tx || (tx as any).classifiedBy !== 'claude_ai') continue;
            if (tx.confidence === 'low' || tx.confidence === undefined) continue;
            const normalized = normalizeMerchant(tx.merchant || tx.description || '');
            if (savedOverrideKeys.has(normalized)) continue;
            if (!toPersist.find((p) => normalizeMerchant(p.merchant) === normalized)) {
              toPersist.push({ merchant: tx.merchant || tx.description || '', category: item.category, isEssential: isEssentialSection });
            }
          }
        }
      }

      if (toPersist.length === 0 || cancelled) return;

      const newKeys = new Set<string>();
      for (const item of toPersist) {
        if (cancelled) break;
        const name = item.merchant;
        try {
          await supabase.from('transaction_overrides')
            .delete()
            .eq('user_id', user.id)
            .eq('match_description', name);
          await supabase.from('transaction_overrides').insert({
            user_id: user.id,
            match_description: name,
            category: item.category,
            is_essential: item.isEssential,
          });
          newKeys.add(normalizeMerchant(name));
        } catch {}
      }

      if (!cancelled && newKeys.size > 0) {
        setSavedOverrideKeys((prev) => {
          const next = new Set(prev);
          for (const k of newKeys) next.add(k);
          return next;
        });
      }
    };

    persistConfidentAI();
    return () => { cancelled = true; };
  }, [analysis]);

  // Auto-suggest categories using Claude AI when modal opens
  useEffect(() => {
    if (!showReviewModal || unresolvedGroups.length === 0) return;
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
  }, [showReviewModal, unresolvedGroups.length]);


  const dismissReviewModal = useCallback(() => {
    const hasUnsaved = Object.keys(catAssignments).length > 0;
    if (hasUnsaved) {
      hapticWarning();
      Alert.alert('Discard changes?', `You have ${Object.keys(catAssignments).length} unsaved categorisations.`, [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => { setShowReviewModal(false); setCatAssignments({}); } },
      ]);
    } else {
      setShowReviewModal(false);
    }
  }, [catAssignments]);

  // Persist the current optimistic analysis state to Supabase so it survives page refreshes.
  // Strips budget adjustment synthetic transactions before saving so that
  // mergeAdjustments() doesn't double-count them when the analysis is next loaded.
  const persistAnalysis = async (updatedAnalysis: Analysis) => {
    try {
      const uid = userIdRef.current;
      if (!uid) return;

      // Strip budget-adjustment synthetic transactions (description ends with " (manual)")
      // from the persisted copy. mergeAdjustments() re-adds them at display time.
      const stripManualTxs = (section: any) => {
        if (!section?.items || !Array.isArray(section.items)) return section;
        const cleaned = { ...section, items: section.items.map((item: BudgetCategory) => {
          const realTxs = (item.transactions || []).filter(
            (tx: TransactionDetail) => !tx.description?.endsWith(' (manual)')
          );
          if (realTxs.length === item.transactions?.length) return item;
          const realMonthly = realTxs.reduce((s: number, tx: TransactionDetail) => s + Math.abs(tx.amount), 0);
          return { ...item, transactions: realTxs, txs: realTxs.length, monthly: realMonthly };
        }).filter((item: BudgetCategory) => item.txs > 0)};
        cleaned.total = cleaned.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
        return cleaned;
      };

      const cleanNonDisc = stripManualTxs(updatedAnalysis.non_discretionary);
      const cleanDisc = stripManualTxs(updatedAnalysis.discretionary);
      const manualSpend = (updatedAnalysis.non_discretionary as any)?.total - cleanNonDisc.total
        + (updatedAnalysis.discretionary as any)?.total - cleanDisc.total;

      const { data: latest } = await supabase.from('analyses')
        .select('id')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (latest?.id) {
        await supabase.from('analyses').update({
          non_discretionary: cleanNonDisc,
          discretionary: cleanDisc,
          monthly_income: updatedAnalysis.monthly_income ?? null,
          monthly_spending: (updatedAnalysis.monthly_spending || 0) - manualSpend,
          surplus: (updatedAnalysis.surplus || 0) + manualSpend,
          person_transfers: (updatedAnalysis as any).person_transfers ?? null,
        }).eq('id', latest.id);
      }
    } catch (err: any) {
      console.warn('[home] persistAnalysis failed:', err?.message);
    }
  };

  const saveReview = async () => {
    // Merge AI confirmed/overridden items with manual categorizations
    // into a single map: merchantKey → { category, isEssential, group }
    const allOverrides: Array<{ key: string; category: string; isEssential: boolean; merchants: string[] }> = [];

    // 1. AI confirmed items (keep AI-suggested category)
    for (const group of aiSuggestedGroups) {
      if (aiConfirmed.has(group.key)) {
        allOverrides.push({ key: group.key, category: group.aiCategory, isEssential: group.aiEssential, merchants: group.merchants });
      }
    }
    // 2. AI overridden items (user changed the category)
    for (const [key, override] of Object.entries(aiOverrides)) {
      const group = aiSuggestedGroups.find((g) => g.key === key);
      if (group) {
        allOverrides.push({ key, category: override.category, isEssential: override.isEssential, merchants: group.merchants });
      }
    }
    // 3. Manual categorizations (existing unresolvedGroups chip picker)
    for (const [key, assignment] of Object.entries(catAssignments)) {
      const group = unresolvedGroups.find((g) => g.key === key);
      allOverrides.push({ key, category: assignment.category, isEssential: assignment.isEssential, merchants: group?.merchants || [key] });
    }

    if (allOverrides.length === 0) { setShowReviewModal(false); return; }

    const aiCount = aiConfirmed.size + Object.keys(aiOverrides).length;
    trackEvent('Unified Review Saved', { categories: allOverrides.length, aiConfirmed: aiCount, manualCategorised: Object.keys(catAssignments).length });
    setSavingReview(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');

      // ── Save category overrides (with learning loop propagation) ──
      // Phase 3: For each override, also find any other merchant name variants
      // across the full analysis that normalize to the same key. This ensures
      // "TESCO EXPRESS LONDON GB" and "TESCO STORES 4521" both get the override.
      for (const item of allOverrides) {
        const allVariants = new Set(item.merchants);
        if (analysis) {
          const { merchantVariants } = findMatchingTransactions(analysis, item.key);
          for (const v of merchantVariants) allVariants.add(v);
        }

        for (const name of allVariants) {
          await supabase.from('transaction_overrides')
            .delete()
            .eq('user_id', user.id)
            .eq('match_description', name);
          const { error: insertErr } = await supabase.from('transaction_overrides').insert({
            user_id: user.id,
            match_description: name,
            category: item.category,
            is_essential: item.isEssential,
          });
          if (insertErr) throw new Error(`Failed to save ${name}: ${insertErr.message}`);
        }
        // Update merchants list for optimistic UI below
        item.merchants = Array.from(allVariants);
      }

      // ── Optimistic UI: move transactions to their target categories ──
      if (analysis) {
        const updated = { ...analysis };

        // Build a map of normalized merchant key → { target category, isEssential }
        // Uses normalized keys so the learning loop catches all variants
        const normalizedToTarget = new Map<string, { category: string; isEssential: boolean }>();
        for (const item of allOverrides) {
          normalizedToTarget.set(item.key, { category: item.category, isEssential: item.isEssential });
        }

        // Deep-clone both sections so mutations are safe
        const disc = { ...((updated as any).discretionary || { total: 0, items: [] }) };
        disc.items = [...(disc.items || [])].map((i: BudgetCategory) => ({ ...i, transactions: [...(i.transactions || [])] }));
        const nonDisc = { ...((updated as any).non_discretionary || { total: 0, items: [] }) };
        nonDisc.items = [...(nonDisc.items || [])].map((i: BudgetCategory) => ({ ...i, transactions: [...(i.transactions || [])] }));

        // Collect transactions that need to move (from any category, not just "Other")
        // Phase 3: match by normalized merchant key so ALL variants get moved
        const removedTxs: { tx: TransactionDetail; target: { category: string; isEssential: boolean } }[] = [];
        // Analysis window in months — needed to maintain monthly normalization
        // (category monthly values = total / months, not raw totals)
        const analysisMonths = (updated as any).analysis_months || 1;

        for (const section of [disc, nonDisc]) {
          for (let catIdx = section.items.length - 1; catIdx >= 0; catIdx--) {
            const cat = section.items[catIdx];
            const kept: TransactionDetail[] = [];
            for (const tx of (cat.transactions || [])) {
              const txNorm = normalizeMerchant(tx.merchant || tx.description || '');
              const target = normalizedToTarget.get(txNorm);
              if (target && target.category !== cat.category) {
                removedTxs.push({ tx, target });
              } else {
                kept.push(tx);
              }
            }
            cat.transactions = kept;
            cat.txs = kept.length;
            if (cat.txs === 0) {
              section.items.splice(catIdx, 1);
            } else {
              cat.monthly = kept.reduce((s: number, tx: TransactionDetail) => s + Math.abs(tx.amount), 0) / analysisMonths;
            }
          }
        }

        // Non-spending categories: excluded from budget totals
        const NON_SPENDING_CATS = new Set(['Refund', 'Internal Transfer']);

        // Add removed transactions to their target categories in the correct section
        for (const { tx, target } of removedTxs) {
          if (NON_SPENDING_CATS.has(target.category)) continue;
          const destSection = target.isEssential ? nonDisc : disc;
          const destIdx = destSection.items.findIndex((i: BudgetCategory) => i.category === target.category);
          const txAmt = Math.abs(tx.amount) / analysisMonths;
          if (destIdx >= 0) {
            destSection.items[destIdx].transactions.push(tx);
            destSection.items[destIdx].monthly += txAmt;
            destSection.items[destIdx].txs += 1;
          } else {
            destSection.items.push({ category: target.category, monthly: txAmt, txs: 1, transactions: [tx] });
          }
        }

        // Recalculate section totals
        disc.total = disc.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
        nonDisc.total = nonDisc.items.reduce((s: number, i: BudgetCategory) => s + i.monthly, 0);
        (updated as any).discretionary = disc;
        (updated as any).non_discretionary = nonDisc;

        // Recalculate top-level spending and surplus so the income card stays in sync
        const newSpending = Math.round(disc.total + nonDisc.total);
        const income = updated.monthly_income || 0;
        updated.monthly_spending = newSpending;
        updated.surplus = Math.round(income - newSpending - (updated.monthly_savings || 0));

        // Recalculate income sources if any overrides affect income merchants
        if (Array.isArray(updated.income_sources) && updated.income_sources.length > 0) {
          const updatedSources = updated.income_sources.filter((s) => {
            const sourceNorm = normalizeMerchant(s.source);
            return !normalizedToTarget.has(sourceNorm);
          });
          if (updatedSources.length !== updated.income_sources.length) {
            const removedIncome = updated.income_sources
              .filter((s) => normalizedToTarget.has(normalizeMerchant(s.source)))
              .reduce((sum, s) => sum + s.monthly, 0);
            updated.income_sources = updatedSources;
            updated.monthly_income = Math.max(0, (updated.monthly_income || 0) - removedIncome);
            updated.surplus = Math.round((updated.monthly_income || 0) - newSpending - (updated.monthly_savings || 0));
          }
        }

        // Remove classified person transfers (using normalized matching)
        if (Array.isArray((updated as any).person_transfers)) {
          (updated as any).person_transfers = (updated as any).person_transfers.filter(
            (t: any) => !normalizedToTarget.has(normalizeMerchant(t?.merchant || t?.description || ''))
          );
        }

        LayoutAnimation.configureNext(SMOOTH_ANIM);
        setAnalysis(updated);
        persistAnalysis(updated);
      }

      // ── Completion celebration ──
      hapticSuccess();
      setSaveSuccess(true);
      await new Promise((resolve) => setTimeout(resolve, 600));

      setShowReviewModal(false);
      setCatAssignments({});
      setAiConfirmed(new Set());
      setAiOverrides({});
      setAiExpandedKey(null);
      setSaveSuccess(false);

      // §5: Fire-and-forget global merchant category votes
      for (const item of allOverrides) {
        for (const m of item.merchants) {
          fetch('/api/global-overrides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ merchant: m, category: item.category, is_essential: item.isEssential }),
          }).catch(() => {}); // Best-effort, don't block save
        }
      }

      // Track which merchants were just categorised so unresolvedGroups/aiSuggestedGroups filter them
      setSavedOverrideKeys((prev) => {
        const next = new Set(prev);
        for (const item of allOverrides) {
          for (const m of item.merchants) {
            const key = normalizeMerchant(m);
            overriddenMerchants.current.add(key);
            next.add(key);
          }
        }
        return next;
      });

      // Re-sync so the enrichment engine re-runs with the new overrides
      overridesSavedAt.current = Date.now();
      AsyncStorage.setItem('overrides_saved_at', String(overridesSavedAt.current)).catch(() => {});
      invalidateSyncCache();
      const uid = userIdRef.current;
      if (uid) setTimeout(() => syncInBackground(uid, true), 10_000);
    } catch (err: any) {
      setSaveSuccess(false);
      Alert.alert('Couldn\u2019t save', err.message || 'Check your connection and try again.');
    }
    setSavingReview(false);
  };

  // ── Learning loop helper: find ALL transactions matching a normalized merchant ──
  // across every category in both discretionary and non_discretionary sections.
  // Returns the transactions AND their variant merchant names for override persistence.
  const findMatchingTransactions = (updated: any, normalizedKey: string, excludeCategory?: string) => {
    const matches: { tx: TransactionDetail; section: 'discretionary' | 'non_discretionary'; catIdx: number; category: string }[] = [];
    const merchantVariants = new Set<string>();

    for (const sectionKey of ['discretionary', 'non_discretionary'] as const) {
      const section = (updated as any)[sectionKey];
      if (!section?.items) continue;
      for (let catIdx = 0; catIdx < section.items.length; catIdx++) {
        const cat = section.items[catIdx];
        if (excludeCategory && cat.category === excludeCategory) continue;
        for (const tx of (cat.transactions || [])) {
          const txMerchant = tx.merchant || tx.description || '';
          if (normalizeMerchant(txMerchant) === normalizedKey) {
            matches.push({ tx, section: sectionKey, catIdx, category: cat.category });
            merchantVariants.add(txMerchant);
          }
        }
      }
    }

    // Also check person_transfers
    if (Array.isArray((updated as any).person_transfers)) {
      for (const pt of (updated as any).person_transfers) {
        const ptMerchant = pt?.merchant || pt?.description || '';
        if (normalizeMerchant(ptMerchant) === normalizedKey) {
          merchantVariants.add(ptMerchant);
        }
      }
    }

    return { matches, merchantVariants };
  };


  const doRemoveIncomeSource = async (sourceName: string) => {
    trackEvent('Income Source Removed');
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
    trackEvent('Move Deleted');
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

    const ok = window.confirm(`Delete "${stripMd(move.action)}"?\n\nThis recommendation will be permanently removed.`);
    if (ok) doDelete();
  };

  const handleRemoveIncomeSource = (sourceName: string) => {
    const ok = window.confirm(
      `Remove "${sourceName}"?\n\nThis will no longer be counted as income. This affects your surplus and recommendations.`
    );
    if (ok) doRemoveIncomeSource(sourceName);
  };

  useFocusEffect(
    useCallback(() => {
      trackScreen('Home');
      // Invalidate cached sync so returning from connect screen always fetches fresh data
      invalidateSyncCache();
      loadData();
      // Subscribe to sync completions for screen-specific reactive events.
      // Shared data (weeklyCtx, planProgress, analysis) is updated by AppDataProvider.
      const unsub = onSyncComplete((result) => {
        if (!result) return;
        // Surface reactive events from syncs triggered by other screens
        if (result.reactive?.events?.length) {
          setReactiveEvents(result.reactive.events);
          setReactiveEventIndex(0);
          if (!result.weeklyContext?.incomeArrivedThisWeek) {
            setTimeout(() => setShowReactiveModal(true), 800);
          }
        }
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

  // ── Background verification polling ──
  // When an analysis is saved as 'draft', /api/verify runs Claude AI in the background.
  // Poll every 3s (max 5 attempts = 15s) until the analysis is 'verified', then refresh.
  // Fast polling ensures Claude AI classifications surface quickly, reducing manual review.
  const startVerifyPolling = (userId: string, adjustments: any[]) => {
    if (verifyPollRef.current) clearTimeout(verifyPollRef.current);
    let attempts = 0;
    const poll = async () => {
      attempts++;
      if (attempts > 5) {
        setVerificationStatus('verified'); // Stop showing indicator after max attempts
        return;
      }
      try {
        const { data: row } = await supabase
          .from('analyses')
          .select('verification_status, segment, decision_score, monthly_income, monthly_spending, surplus, non_discretionary, discretionary, income_sources, top_move, all_moves, behavioral_patterns, goal_context')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (row?.verification_status === 'verified') {
          setVerificationStatus('verified');
          setAnalysis(mergeAdjustments(row, adjustments));
          return;
        }
      } catch {}
      verifyPollRef.current = setTimeout(poll, 3_000);
    };
    verifyPollRef.current = setTimeout(poll, 3_000);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (verifyPollRef.current) clearTimeout(verifyPollRef.current);
    };
  }, []);

  const loadData = async () => {
    setLoadingLocal(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoadingLocal(false); return; }
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

      // Refresh shared context data (analysis, debt, plans, progress, prevSnapshot).
      // This single call replaces the 6+ independent Supabase queries that were here.
      // The snapshot gives us immediate access to fresh data (React state may not be updated yet).
      const snapshot = await appData.refresh();

      // Load persisted transaction overrides so unresolvedGroups can exclude
      // merchants the user has already categorised (survives app restarts).
      try {
        const { data: overrides } = await supabase
          .from('transaction_overrides')
          .select('match_description')
          .eq('user_id', user.id);
        if (overrides && overrides.length > 0) {
          const keys = new Set(overrides.map((o: { match_description: string }) => normalizeMerchant(o.match_description)));
          setSavedOverrideKeys(keys);
        }
      } catch {}

      // Use fresh budget adjustments for mergeAdjustments
      const adjustments = snapshot.budgetAdjustments;

      // Apply mergeAdjustments to create the local analysis override.
      // The shared context has the raw analysis; the Home screen merges budget adjustments.
      const rawAnalysis = snapshot.analysis;
      const lastResult = getLastResult();
      // Guard: if an override was saved but no post-override sync has completed yet,
      // prefer the in-memory result (which has the optimistic update).
      // The guard is cleared when a sync started after the override is accepted (line 1343).
      const pendingOverride = !!overridesSavedAt.current;
      if (rawAnalysis && !pendingOverride) {
        setAnalysis(mergeAdjustments(rawAnalysis, adjustments));
        // Track verification status and start polling if not verified yet
        const status = (rawAnalysis as any).verification_status || 'verified';
        setVerificationStatus(status);
        if (status === 'draft' || status === 'verifying') {
          startVerifyPolling(user.id, adjustments);
        }
      } else if (lastResult) {
        // Fallback: use in-memory result only if Supabase has nothing yet
        setAnalysis(mergeAdjustments(lastResult, adjustments));
        setVerificationStatus('draft');
        startVerifyPolling(user.id, adjustments);
      }

      // Check if user has a bank connection even if no analysis exists yet.
      if (!rawAnalysis && !lastResult) {
        try {
          const { count } = await supabase
            .from('bank_data')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', user.id);
          setHasBankConnection((count ?? 0) > 0);
        } catch {
          setHasBankConnection(false);
        }
      }

      // Fetch account balances + properties for Net Worth card (non-critical, swallow errors)
      try {
        const [{ data: bankRow }, { data: propRows }] = await Promise.all([
          supabase
            .from('bank_data')
            .select('account_balances')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle(),
          supabase
            .from('properties')
            .select('address, estimated_value, mortgage_balance, has_mortgage')
            .eq('user_id', user.id),
        ]);
        if (bankRow?.account_balances && Array.isArray(bankRow.account_balances)) {
          setAccountBuckets(classifyAccounts(bankRow.account_balances));
        }
        if (propRows && propRows.length > 0) {
          setUserProperties(propRows);
        }
      } catch {}

      // Trigger background sync if user has any data or a bank connection.
      // Always force-sync on first load to ensure open banking data is fresh.
      // Also force when data was previously stale (fallback) to retry Finexer.
      const shouldForce = true;
      syncInBackground(user.id, shouldForce);
    } catch (err: any) {
      console.warn('[home] loadData error:', err?.message);
      setAnalysis(null);
    }
    setLoadingLocal(false);
  };

  // Pull-to-refresh handler — force a fresh Finexer fetch
  const onRefresh = useCallback(async () => {
    trackEvent('Home Refreshed');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setRefreshing(true);
      invalidateSyncCache();
      await syncInBackground(user.id, true);
      hapticSuccess();
    } catch (err: any) {
      console.warn('[home] onRefresh error:', err?.message);
    }
    setRefreshing(false);
  }, []);

  // Background sync: refresh bank data via Finexer and re-run analysis
  const syncInBackground = async (userId: string, force: boolean = false) => {
    // Skip sync when offline or app is backgrounded
    if (!isOnline || !isActive) return;
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

      // Surface connection issues to the user.
      // Only show reconnect banners for genuine expiry / missing connections.
      // Transient sync failures (sync_failed) should NOT show a scary
      // "reconnect" banner — fall through to data freshness checks instead.
      let nextWarning: typeof connectionWarning = null;
      const hasRealConnectionIssue = result.connectionIssues?.some(
        (i: string) => i === 'token_expired' || i === 'no_connection' || i === 'some_connections_expired'
      );

      if (hasRealConnectionIssue) {
        const banks = result.expiredBankNames ?? [];
        if (result.connectionIssues.includes('token_expired') || result.connectionIssues.includes('no_connection')) {
          nextWarning = { message: 'all_expired', banks };
        } else if (result.connectionIssues.includes('some_connections_expired')) {
          nextWarning = { message: 'some_expired', banks };
        }
      } else if (result.dataSource === 'fallback') {
        // Sync fell back to cached data. If data is >24h old, escalate to
        // reconnect prompt — persistent failures likely mean a dead token.
        if (result.latestTransactionDate) {
          const ageMs = Date.now() - new Date(result.latestTransactionDate).getTime();
          if (ageMs > 24 * 60 * 60 * 1000) {
            nextWarning = { message: 'all_expired', banks: result.expiredBankNames ?? [] };
          }
        }
      } else if (result.expiringConnections?.length > 0) {
        // Proactive warning: connections approaching 90-day consent expiry
        const expiringBanks = result.expiringConnections.map(
          (c: { name: string; daysLeft: number }) => `${c.name} (${c.daysLeft}d left)`
        );
        nextWarning = { message: 'expiring', banks: expiringBanks };
      }

      setConnectionWarning(nextWarning);

      // Warn if data is stale — but only when sync actually failed (fallback).
      // When Finexer synced successfully, stale data just means the bank
      // hasn't posted recent transactions — "pull down to retry" won't help.
      if (result.dataSource === 'fallback' && result.latestTransactionDate) {
        const txAge = Math.floor((Date.now() - new Date(result.latestTransactionDate).getTime()) / (1000 * 60 * 60 * 24));
        if (txAge >= 2) {
          setSyncError(`Transactions are ${txAge} days old — pull down to refresh`);
        }
      } else if (result.dataSource === 'finexer') {
        // Finexer sync succeeded — clear any stale error from previous fallback
        setSyncError(null);
      }

      // Update debt accounts: merge synced with any manual debts
      try {
        const { data: allDebt } = await supabase
          .from('debt_accounts')
          .select('account_name, account_type, outstanding_balance, credit_limit, interest_rate, minimum_payment, last_updated, source, is_default_apr, provider_name, connection_id, account_id')
          .eq('user_id', userId);
        if (allDebt) setDebtAccounts(allDebt);
      } catch {
        if (result.debtAccounts?.length > 0) setDebtAccounts(result.debtAccounts);
      }

      // Update adaptive weekly context
      if (result.weeklyContext) setWeeklyCtx(result.weeklyContext);

      // ── Handle reactive engine events ──
      if (result.reactive) {
        if (result.reactive.events.length > 0) {
          setReactiveEvents(result.reactive.events);
          setReactiveEventIndex(0);
          // Show reactive modal after a short delay (don't compete with payday modal)
          if (!result.weeklyContext?.incomeArrivedThisWeek) {
            setTimeout(() => setShowReactiveModal(true), 800);
          }
        }
        // Merge verified steps into local plan progress so checkboxes + progress bars update
        if (result.reactive.verifiedSteps && Object.keys(result.reactive.verifiedSteps).length > 0) {
          setPlanProgress((prev) => {
            const updated = { ...prev };
            for (const [key, steps] of Object.entries(result.reactive!.verifiedSteps)) {
              if (updated[key]) {
                updated[key] = { ...updated[key], completed_steps: steps };
              }
            }
            return updated;
          });
        }
      }

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
      if (!result.analysis) {
        // Bank is connected but enrichment found no usable transactions yet.
        // Schedule a retry — transactions may take time to settle from the bank.
        if (result.connectionIssues?.includes('no_transactions_yet')) {
          setHasBankConnection(true);
          const retryCount = (syncRetryRef.current ?? 0);
          if (retryCount < 5) {
            syncRetryRef.current = retryCount + 1;
            setRetriesExhausted(false);
            const delayMs = Math.min(30_000 * Math.pow(1.5, retryCount), 120_000);
            console.log(`[home] No transactions yet — retry ${retryCount + 1}/5 in ${Math.round(delayMs / 1000)}s`);
            setTimeout(() => syncInBackground(userId, true), delayMs);
          } else {
            // All retries exhausted — show escape hatch
            setRetriesExhausted(true);
            console.warn('[home] All sync retries exhausted — showing action buttons');
          }
        }
        setSyncing(false);
        return;
      }
      // Reset retry counter on successful analysis
      syncRetryRef.current = 0;
      setRetriesExhausted(false);
      const fresh = mergeAdjustments(result.analysis, budgetAdjustments);
      setAnalysis((prev) => {
        // Deterministic guard: reject sync results from syncs that started
        // BEFORE the user's last override save. Those syncs fetched stale
        // overrides and their enrichment result is incorrect.
        if (overridesSavedAt.current && result.syncStartedAt < overridesSavedAt.current) {
          return prev;
        }

        // Merchant-key guard: if we recently categorised merchants, check whether
        // the incoming sync result still has them in "Other" with classifiedBy=default.
        // If so, the enrichment engine hasn't ingested our overrides yet — reject.
        if (overriddenMerchants.current.size > 0) {
          const stillStale = new Set<string>();
          for (const section of [fresh.discretionary, fresh.non_discretionary]) {
            const items = (section as any)?.items;
            if (!Array.isArray(items)) continue;
            for (const item of items) {
              if (item?.category !== 'Other') continue;
              for (const tx of (item.transactions || [])) {
                if (!tx) continue;
                const key = normalizeMerchant(tx.merchant || tx.description || '');
                if (overriddenMerchants.current.has(key)) {
                  // Still in "Other" with default classification — stale result
                  if (!tx.classifiedBy || tx.classifiedBy === 'default') {
                    stillStale.add(key);
                  }
                }
              }
            }
          }
          if (stillStale.size > 0) {
            console.log(`[home] Rejecting sync: ${stillStale.size} overridden merchants still in Other`);
            return prev;
          }
          // All overridden merchants are correctly classified — clear the guard
          overriddenMerchants.current = new Set();
        }

        // Clear the timestamp guard now that we've accepted a post-override sync
        if (overridesSavedAt.current && result.syncStartedAt >= overridesSavedAt.current) {
          overridesSavedAt.current = 0;
          AsyncStorage.removeItem('overrides_saved_at').catch(() => {});
        }

        // Count unresolved items to detect reclassifications/overrides
        const unresolvedCount = (a: Analysis | null) => {
          if (!a) return 0;
          let count = 0;
          for (const section of [a.discretionary, a.non_discretionary]) {
            const items = (section as any)?.items;
            if (!Array.isArray(items)) continue;
            const other = items.find((i: any) => i?.category === 'Other');
            if (other) count += other.txs || 0;
          }
          count += ((a as any)?.person_transfers?.length || 0);
          return count;
        };
        // Check if moves changed (top move action or move count)
        const prevMoves = Array.isArray(prev?.all_moves) ? prev.all_moves : [];
        const freshMoves = Array.isArray(fresh.all_moves) ? fresh.all_moves : [];
        const movesChanged = prevMoves.length !== freshMoves.length ||
          prevMoves[0]?.action !== freshMoves[0]?.action;

        if (
          prev &&
          !movesChanged &&
          prev.monthly_income === fresh.monthly_income &&
          prev.monthly_spending === fresh.monthly_spending &&
          prev.surplus === fresh.surplus &&
          prev.decision_score === fresh.decision_score &&
          unresolvedCount(prev) === unresolvedCount(fresh)
        ) {
          return prev; // No material change — skip re-render
        }
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        return fresh;
      });
      setLastSynced(getLastSyncTime());

      // Trigger push notifications for payday, spending limits, tax deadlines
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          fetch('/api/notifications/trigger', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ user_id: userId }),
          }).catch(() => {}); // Fire and forget
        }
      } catch {}
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
  const commitmentColor = (c: string) => c === 'one_time' ? colors.lavender : c === 'short_term' ? colors.dim : colors.green;
  const commitmentLabel = (c: string) => c === 'one_time' ? 'One-off' : c === 'short_term' ? 'Few months' : 'Ongoing';

  const togglePlanStep = (key: string, stepIndex: number, moveAction: string, totalSteps?: number) => {
    trackEvent('Plan Step Toggled', { action: moveAction, step: stepIndex });
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
      // Trigger celebration when all steps just completed
      if (totalSteps && steps.length >= totalSteps && idx < 0) {
        setTimeout(() => {
          LayoutAnimation.configureNext(SMOOTH_ANIM);
          setJustCompleted(key);
        }, 300);
        // Auto-clear celebration after a few seconds
        setTimeout(() => setJustCompleted(null), 3500);
      }
      return { ...prev, [key]: updated };
    });
  };

  const handleStartMove = async (index: number, move: Move) => {
    trackEvent('Move Started', { action: move.action });
    const uid = userIdRef.current;
    if (!uid) return;
    const key = `move-${index}`;
    if (planProgress[key]?.approved) return;
    const sgs = hydrateSubGoals(move, debtAccounts);
    const row = { move_key: key, move_action: move.action, approved: true, completed_steps: [] as number[], sub_goals: sgs, updated_at: new Date().toISOString() };
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setPlanProgress((prev) => ({ ...prev, [key]: row }));
    const upsertData: any = {
      user_id: uid, move_key: key, move_action: move.action,
      approved: true, completed_steps: [],
      updated_at: new Date().toISOString(),
    };
    if (sgs && sgs.length > 0) upsertData.sub_goals = sgs;
    await supabase.from('plan_progress').upsert(upsertData, { onConflict: 'user_id,move_key' });
  };

  const handleStopMove = async (index: number) => {
    trackEvent('Move Stopped');
    const uid = userIdRef.current;
    if (!uid) return;
    const key = `move-${index}`;
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    setPlanProgress((prev) => { const u = { ...prev }; delete u[key]; return u; });
    await supabase.from('plan_progress').delete().eq('user_id', uid).eq('move_key', key);
  };

  /** Generate data-driven, surgical steps for user plans using real account data */
  const generatePlanSteps = (plan: any): string[] => {
    const action = (plan.action || '').toLowerCase();
    const activeDebts = debtAccounts.filter((d: any) => (d.outstanding_balance || 0) > 0);

    // ── Debt plans: one step per real debt account with name, balance, APR ──
    if (action.includes('debt') || action.includes('credit') || action.includes('pay off')) {
      if (activeDebts.length > 0) {
        // Sort by interest rate descending (avalanche method)
        const sorted = [...activeDebts].sort((a: any, b: any) => (b.interest_rate || 0) - (a.interest_rate || 0));
        return sorted.map((d: any, i: number) => {
          const name = d.account_name || 'Debt';
          const balance = Math.round(d.outstanding_balance || 0);
          const apr = d.interest_rate ? `${Math.round(d.interest_rate * 100)}% APR` : '';
          const min = d.minimum_payment ? Math.round(d.minimum_payment) : 0;
          const payment = i === 0 && plan.monthly_saving
            ? `£${Math.round(plan.monthly_saving)}/mo`
            : min > 0 ? `£${min}/mo minimum` : '';
          const details = [apr, payment].filter(Boolean).join(' · ');
          return `${i === 0 ? 'Pay down' : 'Then clear'} ${name} — £${balance.toLocaleString()}${details ? ` (${details})` : ''}`;
        });
      }
      return [
        'Connect your credit cards so Bocy can build a precise payoff plan',
        'Bocy will track each debt by name, balance, and interest rate',
      ];
    }

    // ── Buffer/emergency plans: real surplus amount + timeline ──
    if (action.includes('emergency') || action.includes('buffer')) {
      const steps: string[] = [];
      const target = plan.target_amount ? Math.round(plan.target_amount) : 0;
      const monthly = plan.monthly_saving ? Math.round(plan.monthly_saving) : 0;
      const surplus = analysis?.surplus ? Math.round(analysis.surplus) : 0;
      const transferAmt = monthly || surplus;
      if (transferAmt > 0 && target > 0) {
        const months = Math.ceil(target / transferAmt);
        steps.push(`Transfer £${transferAmt}/mo on payday → reaches £${target.toLocaleString()} in ${months} months`);
      } else if (target > 0) {
        steps.push(`Target: £${target.toLocaleString()} emergency buffer`);
      }
      steps.push('Set up automatic standing order so it happens without thinking');
      return steps;
    }

    // ── Savings/deposit plans: real amounts ──
    if (action.includes('save') || action.includes('saving') || action.includes('deposit')) {
      const steps: string[] = [];
      const target = plan.target_amount ? Math.round(plan.target_amount) : 0;
      const monthly = plan.monthly_saving ? Math.round(plan.monthly_saving) : 0;
      const surplus = analysis?.surplus ? Math.round(analysis.surplus) : 0;
      const transferAmt = monthly || surplus;
      if (transferAmt > 0 && target > 0) {
        const months = Math.ceil(target / transferAmt);
        steps.push(`Transfer £${transferAmt}/mo → reaches £${target.toLocaleString()} in ${months} months`);
      } else if (transferAmt > 0) {
        steps.push(`Transfer £${transferAmt}/mo into savings on payday`);
      }
      steps.push('Automate it — set up a standing order so you don\'t have to think');
      return steps;
    }

    // ── Subscription plans: real merchants from analysis ──
    if (action.includes('subscript') || action.includes('cancel')) {
      const subs = extractSubscriptionsFromAnalysis();
      if (subs.length > 0) {
        return subs.slice(0, 5).map((s) =>
          `Cancel ${s.name} — £${Math.round(s.monthly * 100) / 100}/mo`
        );
      }
      return ['Review active subscriptions this week', 'Cancel the ones you haven\'t used in 30 days'];
    }

    // ── Spending reduction: real category amounts ──
    if (action.includes('reduce') || action.includes('cut') || action.includes('spending')) {
      const categories = extractTopSpendingCategories();
      if (categories.length > 0) {
        return categories.slice(0, 3).map((c) => {
          const target = Math.round(c.monthly * 0.7); // suggest 30% reduction
          return `Reduce ${c.category} from £${Math.round(c.monthly)} to £${target}/mo`;
        });
      }
    }

    // ── Investment plans ──
    if (action.includes('invest')) {
      const monthly = plan.monthly_saving ? Math.round(plan.monthly_saving) : 0;
      if (monthly > 0) {
        return [
          `Set up £${monthly}/mo automatic investment`,
          'Start with a low-cost index fund — don\'t overthink it',
        ];
      }
      return [
        'Start with a small monthly amount you won\'t miss',
        'Automate it and don\'t check daily',
      ];
    }

    // ── Fallback: still actionable ──
    return [
      'Break this goal into a weekly action',
      'Start with the smallest step this week',
    ];
  };

  /** Extract subscription-like items from analysis for plan steps */
  const extractSubscriptionsFromAnalysis = (): { name: string; monthly: number }[] => {
    if (!analysis) return [];
    const subs: { name: string; monthly: number }[] = [];
    for (const section of [analysis.discretionary, analysis.non_discretionary]) {
      const items = (section as any)?.items;
      if (!Array.isArray(items)) continue;
      const subCat = items.find((i: any) => i?.category === 'Subscriptions');
      if (subCat?.transactions) {
        for (const tx of subCat.transactions) {
          const name = tx.merchant || tx.description;
          const existing = subs.find((s) => s.name === name);
          if (existing) existing.monthly += Math.abs(tx.amount);
          else subs.push({ name, monthly: Math.abs(tx.amount) });
        }
      }
    }
    return subs.sort((a, b) => b.monthly - a.monthly);
  };

  /** Extract top discretionary spending categories from analysis */
  const extractTopSpendingCategories = (): { category: string; monthly: number }[] => {
    if (!analysis?.discretionary) return [];
    const items = (analysis.discretionary as any)?.items;
    if (!Array.isArray(items)) return [];
    return items
      .filter((i: any) => i.category !== 'Other' && i.category !== 'Subscriptions')
      .sort((a: any, b: any) => b.monthly - a.monthly);
  };

  /** Generate sub-goals for user plans so debt/savings plans get progress bars */
  const generatePlanSubGoals = (plan: any): MoveSubGoal[] | undefined => {
    const action = (plan.action || '').toLowerCase();
    const activeDebts = debtAccounts.filter((d: any) => (d.outstanding_balance || 0) > 0);

    // Debt plans: one sub-goal per real debt account
    if ((action.includes('debt') || action.includes('credit') || action.includes('pay off')) && activeDebts.length > 0) {
      return activeDebts.map((d: any) => ({
        type: 'debt_clear' as MoveSubGoalType,
        target: resolveDebtDisplayName(d),
        startValue: Math.round(d.outstanding_balance || 0),
        targetValue: 0,
        currentValue: Math.round(d.outstanding_balance || 0),
      }));
    }

    // Buffer/savings plans: single sub-goal with target amount
    if ((action.includes('emergency') || action.includes('buffer') || action.includes('save') || action.includes('saving') || action.includes('deposit')) && plan.target_amount) {
      const target = Math.round(plan.target_amount);
      return [{
        type: (action.includes('buffer') || action.includes('emergency')) ? 'buffer_build' as MoveSubGoalType : 'savings_reach' as MoveSubGoalType,
        target: action.includes('deposit') ? 'House deposit'
          : action.includes('buffer') || action.includes('emergency') ? 'Emergency buffer'
          : 'Savings goal',
        startValue: 0,
        targetValue: target,
        currentValue: 0,
      }];
    }

    // Subscription plans: one sub-goal per subscription
    if (action.includes('subscript') || action.includes('cancel')) {
      const subs = extractSubscriptionsFromAnalysis();
      if (subs.length > 0) {
        return subs.slice(0, 5).map((s) => ({
          type: 'sub_cancel' as MoveSubGoalType,
          target: s.name,
          startValue: Math.round(s.monthly * 100) / 100,
          targetValue: 0,
        }));
      }
    }

    return undefined;
  };

  const handleRemovePlan = async (planId: string) => {
    trackEvent('Plan Deleted');
    const uid = userIdRef.current;
    if (!uid) return;
    LayoutAnimation.configureNext(SMOOTH_ANIM);
    // Optimistic update removed — refresh shared context after mutation below
    setExpandedPlan(null);

    try {
      // Use the API endpoint (service-role key) so RLS doesn't block the delete
      const { data: { session: sess } } = await supabase.auth.getSession();
      const res = await fetch('/api/plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sess?.access_token ? { Authorization: `Bearer ${sess.access_token}` } : {}) },
        body: JSON.stringify({ action: 'delete', plan_id: planId }),
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

    // Refresh shared context so userPlans reflects the deletion
    appData.refresh().catch(() => {});
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

  // ── Derived data ──
  const moves = Array.isArray(analysis?.all_moves) ? analysis.all_moves : [];
  const insightsData = Array.isArray(analysis?.insights) ? analysis.insights : [];
  const agentRecommendations = Array.isArray(analysis?.agent_recommendations) ? analysis.agent_recommendations : [];
  const agentInsights = Array.isArray(analysis?.agent_insights) ? analysis.agent_insights : [];
  const agentPipelineStatus = analysis?.agent_pipeline_status ?? null;
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
  const savingsTotal = analysis?.monthly_savings ?? 0;
  // Use analysis.surplus directly — it already subtracts spending AND savings
  const surplusTotal = Math.max(0, analysis?.surplus ?? 0);
  const leftToDecide = savingsTotal + surplusTotal; // combined for bar/percentage calculations

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

  const allMoves = analysis?.all_moves ?? [];
  const goalTarget = analysis?.goal_context?.targetAmount ?? 0;

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
    .filter((tx) => tx?.date && new Date(tx.date) >= weekStart && (tx?.amount ?? 0) < 0)
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);

  // Apply custom limit if set (capped at calculated budget — user can lower, not inflate)
  const weeklyBudget = customWeeklyLimit !== null
    ? Math.min(customWeeklyLimit, calculatedWeeklyBudget)
    : calculatedWeeklyBudget;

  const weeklyRemaining = Math.max(0, weeklyBudget - spentThisWeek);
  const weeklyUsedPct = weeklyBudget > 0
    ? Math.min(100, Math.round((spentThisWeek / weeklyBudget) * 100))
    : 0;
  const weeklyHealthy = spentThisWeek <= weeklyBudget;

  // ── Daily spending sparkline data (Mon–Today) ──
  const dailySpending = useMemo(() => {
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const ws = getWeekStart();
    const result: { label: string; amount: number }[] = [];
    const today = new Date();
    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(ws.getTime() + d * 86400000);
      if (dayDate > today) break;
      const dayStr = dayDate.toISOString().split('T')[0];
      const total = allDiscTxs
        .filter((tx) => tx?.date?.startsWith(dayStr) && (tx?.amount ?? 0) < 0)
        .reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
      result.push({ label: dayLabels[d], amount: total });
    }
    return result;
  }, [allDiscTxs]);

  // Save / reset custom weekly limit
  const saveCustomLimit = () => {
    trackEvent('Weekly Limit Set');
    const val = parseFloat(limitInput);
    if (!isNaN(val) && val > 0) {
      setCustomWeeklyLimit(val);
      AsyncStorage.setItem('custom_weekly_limit', String(val)).catch(() => {});
      setShowLimitEditor(false);
      setLimitInput('');
    }
  };
  const resetCustomLimit = () => {
    trackEvent('Weekly Limit Reset');
    setCustomWeeklyLimit(null);
    AsyncStorage.removeItem('custom_weekly_limit').catch(() => {});
    setShowLimitEditor(false);
  };

  // ── Sorted moves for inline display ──
  const sortedMoves: (Move & { _sortIdx: number })[] = moves
    .map((m, i) => ({ ...m, _sortIdx: i }))
    .sort((a, b) => (effortOrder[a.effort] ?? 2) - (effortOrder[b.effort] ?? 2));

  /** Check if a move has all steps/sub-goals completed */
  const isMoveCompleted = (move: Move & { _sortIdx: number }) => {
    const key = `move-${move._sortIdx}`;
    const prog = planProgress[key];
    if (!prog?.approved) return false;
    const sgs = repairDebtSubGoals(prog.sub_goals || hydrateSubGoals(move, debtAccounts) || [], debtAccounts);
    if (sgs.length > 0) return sgs.every((sg) => sg.completedAt);
    const steps = move.steps || [];
    if (steps.length > 0) return (prog.completed_steps || []).length >= steps.length;
    return false;
  };

  const approvedMoves = sortedMoves.filter((m) => planProgress[`move-${m._sortIdx}`]?.approved);
  const activePlanMoves = approvedMoves.filter((m) => !isMoveCompleted(m));
  const completedPlanMoves = approvedMoves.filter((m) => isMoveCompleted(m));
  const opportunityMoves = sortedMoves.filter((m) => !planProgress[`move-${m._sortIdx}`]?.approved);

  /** Check if a user plan has all steps/sub-goals completed */
  const isPlanCompleted = (plan: any) => {
    const planKey = `plan-${plan.id}`;
    const sgs = planProgress[planKey]?.sub_goals || generatePlanSubGoals(plan) || [];
    if (sgs.length > 0) {
      return sgs.every((sg: MoveSubGoal) => !!sg.completedAt);
    }
    const steps = generatePlanSteps(plan);
    const done = planProgress[planKey]?.completed_steps || [];
    return steps.length > 0 && done.length >= steps.length;
  };
  const activeUserPlans = userPlans.filter((p) => !isPlanCompleted(p));
  const completedUserPlans = userPlans.filter((p) => isPlanCompleted(p));

  const hasCompleted = completedPlanMoves.length > 0 || completedUserPlans.length > 0;
  const hasActive = activePlanMoves.length > 0 || activeUserPlans.length > 0;

  // ── Focus card type: what matters right now? ──
  const isPayday = !!weeklyCtx?.incomeArrivedThisWeek && !incomeDismissed;
  const focusType: 'payday' | 'budget' | 'move' = isPayday ? 'payday' : 'budget';

  // ── Swipe-up to dismiss payday card ──
  const paydayTranslateY = useRef(new Animated.Value(0)).current;
  const paydayOpacity = useRef(new Animated.Value(1)).current;
  const paydayPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 10 && g.dy < 0, // only swipe up
    onPanResponderMove: (_, g) => {
      if (g.dy < 0) {
        paydayTranslateY.setValue(g.dy);
        paydayOpacity.setValue(1 + g.dy / 200); // fade as you swipe
      }
    },
    onPanResponderRelease: (_, g) => {
      if (g.dy < -80) {
        // Dismiss
        Animated.parallel([
          Animated.timing(paydayTranslateY, { toValue: -300, duration: 250, easing: Easing.in(Easing.cubic), useNativeDriver: false }),
          Animated.timing(paydayOpacity, { toValue: 0, duration: 250, useNativeDriver: false }),
        ]).start(() => {
          hapticMedium();
          dismissIncome();
        });
      } else {
        // Snap back
        Animated.spring(paydayTranslateY, { toValue: 0, useNativeDriver: false }).start();
        Animated.spring(paydayOpacity, { toValue: 1, useNativeDriver: false }).start();
      }
    },
  }), []);

  if (loading) {
    return (
      <View style={[s.loadingContainer, { padding: 24 }]}>
        <DashboardSkeleton />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="home-screen">
    <ScrollView
      ref={dashScrollRef}
      style={s.container}
      testID="dashboard-scroll"
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
            onPress={() => { trackEvent('Profile Opened'); router.push('/(main)/profile'); }}
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
              ? `Data from ${formatTxDateAge(latestTxDate)} (cached)`
              : `Synced ${formatTimeAgo(lastSynced)}`}
          </Text>
        )}
        {verificationStatus && verificationStatus !== 'verified' && (
          <Text style={[s.syncText, { color: colors.accent }]}>
            Refining your analysis...
          </Text>
        )}
      </View>

      {/* ── Offline banner ── */}
      {!isOnline && (
        <View style={[s.connectionBanner, { borderColor: colors.muted }]}>
          <View style={s.connectionBannerBody}>
            <Text style={[s.connectionBannerText, { color: colors.muted }]}>You're offline — data may be stale</Text>
          </View>
        </View>
      )}

      {/* ── Connection warning ── */}
      {connectionWarning && !connectionDismissed && (
        <Card variant="default" style={{ marginBottom: spacing.lg, borderLeftWidth: 3, borderLeftColor: colors.amber }}>
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }} onPress={() => router.push({ pathname: '/(main)/connect', params: { from: 'banner', banks: connectionWarning.banks.join(',') } })} activeOpacity={0.8}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.amber }}>
                {connectionWarning.message === 'stale_data'
                  ? 'Bank connection needs attention'
                  : connectionWarning.banks.length > 1
                  ? `Reconnect ${connectionWarning.banks.length} bank accounts`
                  : connectionWarning.banks.length === 1
                  ? `Reconnect ${connectionWarning.banks[0]}`
                  : 'Bank connection needs attention'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ backgroundColor: `${colors.amber}20`, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 10 }}>
                <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.amber }}>Fix</Text>
              </View>
              <TouchableOpacity onPress={dismissConnection} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.amber, opacity: 0.6 }}>{'\u2715'}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Card>
      )}

      {!analysis ? (
        <View style={s.emptyState}>
          {/* Nature-themed gradient background */}
          <View style={s.emptyNatureBg}>
            <View style={[s.emptyNatureLayer, { backgroundColor: '#2D5A1E', opacity: 0.8 }]} />
            <View style={[s.emptyNatureLayer, { backgroundColor: '#4A8C2A', opacity: 0.4, top: '30%' }]} />
            {/* Glassmorphic card */}
            <View style={s.emptyGlassCard}>
              <View style={s.emptyBocyWrap}>
                <BocyFace mood={hasBankConnection ? 'thinking' : 'neutral'} size="lg" breathing />
              </View>
              {hasBankConnection ? (
                retriesExhausted ? (
                  <>
                    <Text style={s.emptyTitle}>Transactions aren't available yet</Text>
                    <Text style={s.emptyDesc}>
                      Your bank is connected but hasn't returned any transactions yet. This usually resolves within a few hours.
                    </Text>
                    <TouchableOpacity
                      style={s.ctaButton}
                      onPress={() => {
                        syncRetryRef.current = 0;
                        setRetriesExhausted(false);
                        supabase.auth.getUser().then(({ data: { user } }) => {
                          if (user) syncInBackground(user.id, true);
                        });
                      }}
                    >
                      <Text style={s.ctaText}>Try again</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.ctaButton, { backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', marginTop: spacing.sm }]}
                      onPress={() => router.push('/(main)/connect')}
                    >
                      <Text style={[s.ctaText, { color: colors.text }]}>Upload a statement instead</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <Text style={s.emptyTitle}>Building your financial picture</Text>
                    <Text style={s.emptyDesc}>
                      Your bank is connected. Transactions can take a little while to appear — your plan will be ready soon.
                    </Text>
                    <ActivityIndicator size="small" color="#fff" style={{ marginTop: spacing.md }} />
                  </>
                )
              ) : (
                <>
                  <Text style={s.emptyTitle}>Grow your wealth</Text>
                  <Text style={s.emptyDesc}>
                    Connect your bank so we can find the most impactful action you can take right now.
                  </Text>
                  <TouchableOpacity style={s.ctaButton} onPress={() => router.push('/(main)/connect')}>
                    <Text style={s.ctaText}>Connect your bank</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </View>
      ) : (
        <>
          {/* ── Unified review nudge ── */}
          {totalReviewCount > 0 && (
            <TouchableOpacity
              style={s.reviewBanner}
              onPress={() => {
                setCatAssignments({});
                setAiConfirmed(new Set());
                setAiOverrides({});
                setAiExpandedKey(null);
                setShowReviewModal(true);
                trackEvent('Review Modal Opened', { aiSuggested: aiSuggestedGroups.length, unresolved: unresolvedGroups.length });
              }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`${totalReviewCount} items to confirm. Tap to review.`}
            >
              <Text style={s.reviewBannerText}>
                {aiSuggestedGroups.length > 0
                  ? `${aiSuggestedGroups.length} item${aiSuggestedGroups.length !== 1 ? 's' : ''} to confirm`
                  : `${unresolvedGroups.length} item${unresolvedGroups.length !== 1 ? 's' : ''} to confirm`}.{' '}
                <Text style={s.reviewBannerLink}>Tap to review</Text>
                {showLearningSignal && (
                  <Text style={[s.reviewBannerText, { fontSize: 11, opacity: 0.7, marginTop: 2 }]}>
                    {'\n'}Less to review this month — your corrections are working
                  </Text>
                )}
              </Text>
            </TouchableOpacity>
          )}

          {/* ══════════════════════════════════════════════
              #1 MOVE CARD — standalone hero
              ══════════════════════════════════════════════ */}
          {dashboardMoves.length > 0 && (() => {
            const heroMove = dashboardMoves[0];
            const heroIdx = moves.indexOf(heroMove);
            const heroKey = `move-${heroIdx}`;
            const heroProgress = planProgress[heroKey];
            const heroActive = !!heroProgress?.approved;
            const heroSgs = repairDebtSubGoals(heroProgress?.sub_goals || hydrateSubGoals(heroMove, debtAccounts) || [], debtAccounts);
            const heroSteps = heroMove.steps || [];
            const heroHasSgs = heroSgs.length > 0;
            const heroDoneCount = heroHasSgs
              ? heroSgs.filter((sg: MoveSubGoal) => sg.completedAt).length
              : (heroProgress?.completed_steps || []).length;
            const heroTotal = heroHasSgs ? heroSgs.length : heroSteps.length;
            const heroFraction = heroTotal > 0 ? heroDoneCount / heroTotal : 0;
            const heroAllDone = heroTotal > 0 && heroDoneCount >= heroTotal;
            const daysSinceStart = heroProgress?.updated_at
              ? Math.max(1, Math.floor((Date.now() - new Date(heroProgress.updated_at).getTime()) / 86400000))
              : 1;
            const nextStep = heroSteps.find((_: string, idx: number) => !(heroProgress?.completed_steps || []).includes(idx));
            const nextSg = heroSgs.find((sg: MoveSubGoal) => !sg.completedAt);
            const heroCtaLabel = (() => {
              if (!heroActive) return 'Start this move';
              if (heroAllDone) return 'View completed move';
              if (nextSg) {
                const remaining = Math.round(nextSg.currentValue ?? nextSg.startValue);
                const payment = Math.round(heroMove.monthlyImpact || 0);
                const target = nextSg.target || 'debt';
                return payment > 0
                  ? `Next: pay \u00a3${payment} to ${target}`
                  : `Next: clear ${target} (\u00a3${remaining} left)`;
              }
              return nextStep ? `Next: ${nextStep.length > 30 ? nextStep.slice(0, 30) + '\u2026' : nextStep}` : 'View progress';
            })();
            return (
              <View onLayout={(e) => { cardPositions.current.hero = e.nativeEvent.layout.y; }} style={{ marginBottom: spacing.md }}>
                <AnimGlyph delay={0}>
                  <Card variant={heroActive ? 'active' : 'highlight'}>
                    {heroActive ? (
                      <>
                        <CardTitle color={heroAllDone ? colors.green : colors.accent}>
                          {heroAllDone ? 'MOVE COMPLETE \u2713' : `MOVE IN PROGRESS \u00B7 Day ${daysSinceStart}`}
                        </CardTitle>
                        <Text style={{ fontFamily: fonts.medium, fontSize: 18, color: colors.text, lineHeight: 28 }}>
                          {stripMd(heroMove.action)}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 24, marginTop: 16 }}>
                          <View>
                            <AnimatedNumber value={heroMove.monthlyImpact || 0} prefix={'\u00a3'} style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.green, letterSpacing: 0.3 }} />
                            <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 1, marginTop: 4 }}>per month</Text>
                          </View>
                          <View>
                            <AnimatedNumber value={heroMove.annualImpact || 0} prefix={'\u00a3'} style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.green, letterSpacing: 0.3 }} />
                            <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 1, marginTop: 4 }}>per year</Text>
                          </View>
                        </View>
                        {heroTotal > 0 && (
                          <View style={{ marginTop: 16 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                              <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                <View style={{ width: `${Math.round(heroFraction * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: heroAllDone ? colors.green : colors.accent }} />
                              </View>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{heroDoneCount}/{heroTotal}</Text>
                            </View>
                          </View>
                        )}
                      </>
                    ) : (
                      <>
                        <CardTitle color={colors.green}>YOUR #1 MOVE</CardTitle>
                        <Text style={{ fontFamily: fonts.medium, fontSize: 18, color: colors.text, lineHeight: 28 }}>
                          {stripMd(heroMove.action)}
                        </Text>
                        <View style={{ flexDirection: 'row', gap: 24, marginTop: 16 }}>
                          <View>
                            <AnimatedNumber value={heroMove.monthlyImpact || 0} prefix={'\u00a3'} style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.green, letterSpacing: 0.3 }} />
                            <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 1, marginTop: 4 }}>per month</Text>
                          </View>
                          <View>
                            <AnimatedNumber value={heroMove.annualImpact || 0} prefix={'\u00a3'} style={{ fontFamily: fonts.mono, fontSize: 20, color: colors.green, letterSpacing: 0.3 }} />
                            <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 1, marginTop: 4 }}>per year</Text>
                          </View>
                        </View>
                        {heroMove.effort && (
                          <View style={{ marginTop: 14 }}>
                            <View style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: heroMove.effort === 'low' ? 'rgba(147,130,220,0.12)' : heroMove.effort === 'high' ? 'rgba(76,175,80,0.12)' : 'rgba(150,150,150,0.12)' }}>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.5, color: heroMove.effort === 'low' ? '#9382DC' : heroMove.effort === 'high' ? colors.green : colors.dim }}>
                                {heroMove.effort === 'low' ? 'Quick win' : heroMove.effort === 'high' ? 'Big move' : 'Some effort'}
                              </Text>
                            </View>
                          </View>
                        )}
                      </>
                    )}
                    <TouchableOpacity
                      style={[s.heroCta, { marginTop: 24 }]}
                      onPress={() => {
                        if (heroActive) {
                          const y = cardPositions.current.moves;
                          if (y != null) dashScrollRef.current?.scrollTo({ y, animated: true });
                        } else {
                          handleStartMove(heroIdx, heroMove);
                        }
                      }}
                    >
                      <Text style={s.heroCtaText}>{heroCtaLabel}</Text>
                    </TouchableOpacity>
                  </Card>
                </AnimGlyph>
              </View>
            );
          })()}

          {/* ══════════════════════════════════════════════
              YOUR INSIGHTS — moves section with parent card design
              ══════════════════════════════════════════════ */}
          {(hasActive || hasCompleted || opportunityMoves.length > 0) && (
            <View onLayout={(e) => { cardPositions.current.moves = e.nativeEvent.layout.y; }}>
              {/* Active moves */}
              {hasActive && (
                <>
                  <View style={s.moveSectionHeader}>
                    <Text style={s.moveSectionLabel}>IN PROGRESS</Text>
                  </View>
                  {activeUserPlans.map((plan) => {
                    const isPlanExpanded = expandedPlan === plan.id;
                    const planKey = `plan-${plan.id}`;
                    const planSteps = generatePlanSteps(plan);
                    const planSgs = planProgress[planKey]?.sub_goals || generatePlanSubGoals(plan) || [];
                    const hasPlanSgs = planSgs.length > 0;
                    const doneSteps = planProgress[planKey]?.completed_steps || [];
                    const sgDoneCount = hasPlanSgs ? planSgs.filter((sg: MoveSubGoal) => sg.completedAt).length : 0;
                    const stepProgress = hasPlanSgs
                      ? (planSgs.length > 0 ? sgDoneCount / planSgs.length : 0)
                      : (planSteps.length > 0 ? doneSteps.length / planSteps.length : 0);
                    const progressTotal = hasPlanSgs ? planSgs.length : planSteps.length;
                    const progressDone = hasPlanSgs ? sgDoneCount : doneSteps.length;
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
                              {!isPlanExpanded && progressTotal > 0 && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                  <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                    <View style={{ width: `${Math.round(stepProgress * 100)}%`, height: '100%', borderRadius: 1, backgroundColor: colors.accent }} />
                                  </View>
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{progressDone}/{progressTotal}</Text>
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
                              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{progressDone}/{progressTotal} done</Text>
                            </View>
                            {/* Sub-goals with progress bars (when available) or step checklist */}
                            {hasPlanSgs ? planSgs.map((sg: MoveSubGoal, j: number) => {
                              const isDone = !!sg.completedAt;
                              const current = sg.currentValue ?? sg.startValue;
                              const pct = sg.type === 'sub_cancel'
                                ? (isDone ? 100 : 0)
                                : sg.type === 'spending_reduce'
                                  ? Math.min(100, Math.max(0, Math.round(((sg.startValue - current) / Math.max(1, sg.startValue - sg.targetValue)) * 100)))
                                  : sg.type === 'debt_clear'
                                    ? Math.min(100, Math.max(0, Math.round(((sg.startValue - current) / Math.max(1, sg.startValue)) * 100)))
                                    : Math.min(100, Math.max(0, Math.round((current / Math.max(1, sg.targetValue)) * 100)));
                              return (
                                <View key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                                  <View style={[s.checkbox, isDone && s.checkboxDone]}>
                                    {isDone && <Text style={s.checkmark}>{'\u2713'}</Text>}
                                  </View>
                                  <View style={{ flex: 1 }}>
                                    <Text style={[s.checklistText, isDone && s.checklistTextDone]}>{sg.target}</Text>
                                    {!isDone && (
                                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                        <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                          <View style={{ width: `${pct}%`, height: '100%', borderRadius: 2, backgroundColor: colors.accent }} />
                                        </View>
                                        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                                          {sg.type === 'sub_cancel'
                                            ? `\u00a3${sg.startValue}/mo`
                                            : sg.type === 'debt_clear'
                                              ? `\u00a3${current} left`
                                              : sg.type === 'spending_reduce'
                                                ? `\u00a3${current} \u2192 \u00a3${sg.targetValue}`
                                                : `\u00a3${current}/\u00a3${sg.targetValue}`
                                          }
                                        </Text>
                                      </View>
                                    )}
                                    {isDone && <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.green, marginTop: 2 }}>{'\u2713'} Completed</Text>}
                                  </View>
                                </View>
                              );
                            }) : planSteps.map((step: string, j: number) => {
                              const isDone = doneSteps.includes(j);
                              const isNext = j === nextStepIdx;
                              return (
                                <TouchableOpacity key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }} onPress={() => togglePlanStep(planKey, j, plan.action, planSteps.length)} activeOpacity={0.7}>
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
                            <TouchableOpacity style={{ marginTop: 16, paddingVertical: 10, alignItems: 'center', borderRadius: radius.md, borderWidth: 1, borderColor: colors.accent }} onPress={() => { trackEvent('Ask Bocy From Move'); router.push('/(main)/(tabs)/chat'); }} activeOpacity={0.7}>
                              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.accent }}>Ask Bocy about this</Text>
                            </TouchableOpacity>
                            {/* Delete plan button */}
                            <TouchableOpacity
                              style={{ marginTop: 10, paddingVertical: 8, alignItems: 'center', minHeight: 44, justifyContent: 'center' }}
                              onPress={() => {
                                if (window.confirm(`Delete plan?\n\nRemove "${stripMd(plan.action)}" from your plans?`)) {
                                  handleRemovePlan(plan.id);
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
                    const moveSgs = repairDebtSubGoals(planProgress[moveKey]?.sub_goals || hydrateSubGoals(move, debtAccounts) || [], debtAccounts);
                    const hasSgs = moveSgs.length > 0;
                    const sgDoneCount = hasSgs ? moveSgs.filter((sg) => sg.completedAt).length : 0;
                    const stepProgress = hasSgs
                      ? (moveSgs.length > 0 ? sgDoneCount / moveSgs.length : 0)
                      : (steps.length > 0 ? doneSteps.length / steps.length : 0);
                    const progressTotal = hasSgs ? moveSgs.length : steps.length;
                    const progressDone = hasSgs ? sgDoneCount : doneSteps.length;
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
                              {!isExpanded && progressTotal > 0 && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                                  <View style={{ flex: 1, height: 2, borderRadius: 1, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                    <View style={{ width: `${Math.round(stepProgress * 100)}%`, height: '100%', borderRadius: 1, backgroundColor: colors.accent }} />
                                  </View>
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{progressDone}/{progressTotal}</Text>
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
                            {move.proof && (
                              <View style={{ backgroundColor: colors.mintDim, borderRadius: 10, padding: 14, marginBottom: 16 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.dim, textTransform: 'uppercase', marginBottom: 6 }}>THE MATH</Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2, lineHeight: 18 }}>{move.proof}</Text>
                              </View>
                            )}
                            {move.strategy && <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22, marginBottom: 16 }}>{stripMd(move.strategy)}</Text>}
                            {/* Trajectory confidence band — shows Monte Carlo timeline */}
                            {(move as any).trajectory?.confidence?.p50 > 0 && (move as any).trajectory?.confidence?.p50 < 120 && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16, paddingHorizontal: 2 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1, color: colors.dim, textTransform: 'uppercase' }}>TIMELINE</Text>
                                <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                                <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.accent }}>
                                  {(move as any).trajectory.confidence.p50}mo
                                </Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                                  ({(move as any).trajectory.confidence.p10}{'\u2013'}{(move as any).trajectory.confidence.p90})
                                </Text>
                                {(move as any).trajectory.confidence.hitRate12m > 0 && (move as any).trajectory.confidence.hitRate12m < 100 && (
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.green }}>
                                    {(move as any).trajectory.confidence.hitRate12m}% in 12mo
                                  </Text>
                                )}
                              </View>
                            )}
                            {(() => {
                              // Show sub-goal progress bars when available, otherwise legacy steps
                              const sgs: MoveSubGoal[] = repairDebtSubGoals(planProgress[moveKey]?.sub_goals || hydrateSubGoals(move, debtAccounts) || [], debtAccounts);
                              if (sgs.length > 0) {
                                const doneSgs = sgs.filter((sg) => sg.completedAt);
                                const sgProgress = sgs.length > 0 ? doneSgs.length / sgs.length : 0;
                                return (
                                  <>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                                      <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                        <View style={{ width: `${Math.round(sgProgress * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: colors.accent }} />
                                      </View>
                                      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{doneSgs.length}/{sgs.length} done</Text>
                                    </View>
                                    {sgs.map((sg, j) => {
                                      const isDone = !!sg.completedAt;
                                      const current = sg.currentValue ?? sg.startValue;
                                      const pct = sg.type === 'sub_cancel'
                                        ? (isDone ? 100 : 0)
                                        : sg.type === 'spending_reduce'
                                          ? Math.min(100, Math.max(0, Math.round(((sg.startValue - current) / (sg.startValue - sg.targetValue)) * 100)))
                                          : sg.type === 'debt_clear'
                                            ? (sg.startValue > 0 ? Math.min(100, Math.max(0, Math.round(((sg.startValue - current) / sg.startValue) * 100))) : 0)
                                            : Math.min(100, Math.max(0, Math.round((current / sg.targetValue) * 100)));
                                      return (
                                        <View key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                                          <View style={[s.checkbox, isDone && s.checkboxDone]}>
                                            {isDone && <Text style={s.checkmark}>{'\u2713'}</Text>}
                                          </View>
                                          <View style={{ flex: 1 }}>
                                            <Text style={[s.checklistText, isDone && s.checklistTextDone]}>{sg.target}</Text>
                                            {!isDone && (
                                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                                                <View style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: colors.mintDim, overflow: 'hidden' }}>
                                                  <View style={{ width: `${pct}%`, height: '100%', borderRadius: 2, backgroundColor: colors.accent }} />
                                                </View>
                                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                                                  {sg.type === 'sub_cancel'
                                                    ? `\u00a3${sg.startValue}/mo`
                                                    : sg.type === 'debt_clear'
                                                      ? `\u00a3${current} left`
                                                      : sg.type === 'spending_reduce'
                                                        ? `\u00a3${current} \u2192 \u00a3${sg.targetValue}`
                                                        : `\u00a3${current}/\u00a3${sg.targetValue}`
                                                  }
                                                </Text>
                                              </View>
                                            )}
                                            {isDone && <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.green, marginTop: 2 }}>{'\u2713'} Completed</Text>}
                                          </View>
                                        </View>
                                      );
                                    })}
                                  </>
                                );
                              }
                              return steps.map((step: string, j: number) => {
                                const isDone = doneSteps.includes(j);
                                return (
                                  <TouchableOpacity key={j} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }} onPress={() => togglePlanStep(moveKey, j, move.action, steps.length)} activeOpacity={0.7}>
                                    <View style={[s.checkbox, isDone && s.checkboxDone]}>
                                      {isDone && <Text style={s.checkmark}>{'\u2713'}</Text>}
                                    </View>
                                    <Text style={[s.checklistText, isDone && s.checklistTextDone]}>{stripMd(step)}</Text>
                                  </TouchableOpacity>
                                );
                              });
                            })()}
                            <TouchableOpacity style={[s.heroCta, { marginTop: 16, paddingVertical: 12 }]} onPress={() => { trackEvent('Ask Bocy From Move'); router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Tell me more about: "${stripMd(move.action)}"` } }); }}>
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

              {/* Celebration banner — shown briefly when a move is just completed */}
              {justCompleted && (
                <Card variant="highlight" style={{ marginBottom: spacing.md, alignItems: 'center', paddingVertical: 20 }}>
                  <Text style={{ fontFamily: fonts.medium, fontSize: 16, color: colors.accent, marginBottom: 4 }}>Move completed!</Text>
                  <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.muted }}>Nice work — keep the momentum going.</Text>
                </Card>
              )}

              {/* Completed moves */}
              {hasCompleted && (
                <>
                  <View style={s.moveSectionHeader}>
                    <Text style={s.moveSectionLabel}>DONE</Text>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accent, letterSpacing: 0.3 }}>
                      {completedPlanMoves.length + completedUserPlans.length} completed
                    </Text>
                  </View>
                  {completedUserPlans.map((plan) => {
                    const planKey = `plan-${plan.id}`;
                    const planSteps = generatePlanSteps(plan);
                    return (
                      <Card key={plan.id} style={{ marginBottom: spacing.md, opacity: 0.75 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                          <View style={[s.moveBadge, { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                            <Text style={[s.moveBadgeText, { color: colors.bg }]}>{'\u2713'}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={[s.moveAction, { textDecorationLine: 'line-through', color: colors.muted }]}>{stripMd(plan.action)}</Text>
                            <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accent, marginTop: 4 }}>{'\u2713'} {planSteps.length}/{planSteps.length} steps done</Text>
                          </View>
                        </View>
                        <TouchableOpacity
                          style={{ marginTop: 12, alignItems: 'center', paddingVertical: 8 }}
                          onPress={() => {
                            const title = 'Remove completed plan?';
                            const msg = `Remove "${stripMd(plan.action)}" from your list?`;
                            if (window.confirm(`${title}\n\n${msg}`)) handleRemovePlan(plan.id);
                          }}
                        >
                          <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.muted }}>Remove</Text>
                        </TouchableOpacity>
                      </Card>
                    );
                  })}
                  {completedPlanMoves.map((move) => {
                    const i = move._sortIdx;
                    const moveKey = `move-${i}`;
                    const sgs = repairDebtSubGoals(planProgress[moveKey]?.sub_goals || hydrateSubGoals(move, debtAccounts) || [], debtAccounts);
                    const steps = move.steps || [];
                    const totalItems = sgs.length > 0 ? sgs.length : steps.length;
                    return (
                      <Card key={`done-${i}`} style={{ marginBottom: spacing.md, opacity: 0.75 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                          <View style={[s.moveBadge, { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                            <Text style={[s.moveBadgeText, { color: colors.bg }]}>{'\u2713'}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={[s.moveAction, { textDecorationLine: 'line-through', color: colors.muted }]}>{stripMd(move.action)}</Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accent }}>{'\u2713'} {totalItems > 0 ? `${totalItems}/${totalItems} done` : 'Completed'}</Text>
                              {move.monthlyImpact != null && (
                                <Text style={[s.moveImpactText, { color: colors.muted }]}>{'\u00a3'}{move.monthlyImpact}/mo saved</Text>
                              )}
                            </View>
                          </View>
                        </View>
                        <TouchableOpacity style={{ marginTop: 12, alignItems: 'center', paddingVertical: 8 }} onPress={() => handleStopMove(i)}>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.muted }}>Remove</Text>
                        </TouchableOpacity>
                      </Card>
                    );
                  })}
                </>
              )}

              {/* Opportunity moves — parent card design */}
              {opportunityMoves.length > 0 && (
                <Card style={{ marginBottom: spacing.md }}>
                  <CardTitleRow
                    title="Your Insights"
                    right={
                      <View style={{ backgroundColor: `${colors.green}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.green }}>
                          {'\u00a3'}{Math.round(opportunityMoves.reduce((s, m) => s + (m.monthlyImpact || 0), 0))}/mo
                        </Text>
                      </View>
                    }
                  />
                  <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 1, marginBottom: 12, marginTop: -4 }}>
                    {opportunityMoves.length} move{opportunityMoves.length !== 1 ? 's' : ''} available {'\u00B7'} tap to explore
                  </Text>
                  {/* First 2 moves always visible */}
                  {opportunityMoves.slice(0, 2).map((move, seqIdx) => {
                    const i = move._sortIdx;
                    const isExpanded = expandedMove === i;
                    const moveKey = `move-${i}`;
                    const providerActions = getProviderActions(move);
                    return (
                      <View key={`opp-${i}`}>
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
                                {move.commitment_level && (
                                  <View style={[s.effortPill, { backgroundColor: `${commitmentColor(move.commitment_level)}15` }]}>
                                    <Text style={[s.effortPillText, { color: commitmentColor(move.commitment_level) }]}>{commitmentLabel(move.commitment_level)}</Text>
                                  </View>
                                )}
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
                            {move.proof && (
                              <View style={{ backgroundColor: colors.mintDim, borderRadius: 10, padding: 14, marginBottom: 20 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, letterSpacing: 2, color: colors.dim, textTransform: 'uppercase', marginBottom: 6 }}>THE MATH</Text>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2, lineHeight: 18 }}>{move.proof}</Text>
                              </View>
                            )}
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

                            <TouchableOpacity style={{ borderWidth: 1, borderColor: colors.accentDim, borderRadius: 100, paddingVertical: 12, alignItems: 'center', marginBottom: 8 }} onPress={() => { trackEvent('Ask Bocy From Move'); router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Tell me more about: "${stripMd(move.action)}"` } }); }}>
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
                      </View>
                    );
                  })}

                  {/* Collapsible "Other moves" section within parent card */}
                  {opportunityMoves.length > 2 && (
                    <>
                      <TouchableOpacity
                        onPress={() => { hapticLight(); LayoutAnimation.configureNext(SMOOTH_ANIM); setShowAllMoves(!showAllMoves); }}
                        activeOpacity={0.7}
                        style={{ paddingVertical: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}
                      >
                        <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.accent, letterSpacing: 0.3 }}>
                          {showAllMoves ? 'Show less' : `${opportunityMoves.length - 2} more move${opportunityMoves.length - 2 !== 1 ? 's' : ''}`}
                        </Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accent }}>{showAllMoves ? '\u25B2' : '\u25BC'}</Text>
                      </TouchableOpacity>
                      {showAllMoves && opportunityMoves.slice(2).map((move, rawIdx) => {
                        const seqIdx = rawIdx + 2;
                        const i = move._sortIdx;
                        const isExpanded = expandedMove === i;
                        const providerActions = getProviderActions(move);
                        return (
                          <View key={`opp-${i}`}>
                            <TouchableOpacity onPress={() => setExpandedMove(isExpanded ? null : i)} activeOpacity={0.8}>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                                <View style={{ width: 4, height: 28, borderRadius: 2, backgroundColor: colors.accent }} />
                                <View style={{ flex: 1 }}>
                                  <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text, lineHeight: 22 }} numberOfLines={isExpanded ? undefined : 2}>
                                    {stripMd(move.action)}
                                  </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                  <View style={{ backgroundColor: `${colors.green}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.green }}>
                                      {'\u00a3'}{move.monthlyImpact}/mo
                                    </Text>
                                  </View>
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.dim }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                                </View>
                              </View>
                            </TouchableOpacity>
                            {isExpanded && (
                              <View style={{ marginLeft: 14, marginBottom: 8 }}>
                                {move.strategy && <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.text2, lineHeight: 18, marginBottom: 8 }}>{stripMd(move.strategy)}</Text>}
                                <TouchableOpacity style={[s.heroCta, { paddingVertical: 10 }]} onPress={() => handleStartMove(i, move)} activeOpacity={0.8}>
                                  <Text style={[s.heroCtaText, { fontSize: 13 }]}>Start this move</Text>
                                </TouchableOpacity>
                              </View>
                            )}
                          </View>
                        );
                      })}
                    </>
                  )}
                </Card>
              )}
            </View>
          )}

          {/* ══════════════════════════════════════════════
              DAILY SPENDING — standalone card connected to open banking
              ══════════════════════════════════════════════ */}
          <Card variant="hero" style={{ marginBottom: spacing.md }}>
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
                <AnimatedNumber
                  value={weeklyRemaining}
                  prefix={'\u00a3'}
                  style={[s.safeToSpendAmount, !weeklyHealthy && { color: colors.coral }, { fontSize: 38 }]}
                />
                <Text style={s.safeToSpendLabel}>left to spend</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <AnimatedNumber
                  value={spentThisWeek}
                  prefix={'\u00a3'}
                  suffix=" spent"
                  style={s.safeToSpendMeta}
                />
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
                if (syncDataSource === 'fallback') return txAge >= 2 ? colors.coral : colors.muted;
                return txAge >= 3 ? colors.amber : colors.muted;
              })(), letterSpacing: 0.5, marginTop: 10 }}>
                {(() => {
                  const txAge = Math.floor((Date.now() - new Date(latestTxDate).getTime()) / (1000 * 60 * 60 * 24));
                  if (syncDataSource === 'fallback') {
                    if (txAge === 0) return 'Using cached data \u2014 transactions up to date';
                    if (txAge === 1) return 'Using cached data \u2014 last transaction: yesterday';
                    return `Using cached data \u2014 last transaction: ${txAge} days ago`;
                  }
                  if (txAge === 0) return 'Transactions up to date';
                  if (txAge === 1) return 'Bank synced \u2014 latest transaction: yesterday';
                  return `Bank synced \u2014 latest transaction: ${txAge} days ago`;
                })()}
              </Text>
            )}

            {/* Daily spending sparkline */}
            {dailySpending.length > 1 && (
              <View style={{ marginTop: 20, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 2, marginBottom: 10 }}>
                  DAILY SPENDING
                </Text>
                <WeeklySparkline days={dailySpending} height={40} />
              </View>
            )}
          </Card>

          {/* ══════════════════════════════════════════════
              HIGHLIGHTS — detected inefficiencies in a parent card
              ══════════════════════════════════════════════ */}
          {insightsData.length > 0 && (
            <Card style={{ marginBottom: spacing.md }}>
              <CardTitleRow
                title="Highlights"
                right={
                  <View style={{ backgroundColor: `${colors.coral}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.coral }}>
                      {'\u00a3'}{Math.round(insightsData.reduce((sum: number, ins: Insight) => sum + ins.annualImpact, 0)).toLocaleString()}/yr
                    </Text>
                  </View>
                }
              />
              <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 1, marginBottom: 12, marginTop: -4 }}>
                {insightsData.length} inefficienc{insightsData.length === 1 ? 'y' : 'ies'} detected {'\u00B7'} tap to explore
              </Text>
              {/* First 2 insights always visible */}
              {insightsData.slice(0, 2).map((insight: Insight, idx: number) => {
                const isExpanded = expandedInsights.has(idx);
                return (
                  <TouchableOpacity key={`insight-${idx}`} activeOpacity={0.7} onPress={() => {
                    trackEvent('Insight Tapped', { index: idx, statement: insight.statement?.slice(0, 40) });
                    hapticLight();
                    LayoutAnimation.configureNext(SMOOTH_ANIM);
                    setExpandedInsights(prev => { const next = new Set(prev); if (next.has(idx)) next.delete(idx); else next.add(idx); return next; });
                  }}>
                    <View style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View style={{ width: 4, height: 28, borderRadius: 2, backgroundColor: idx === 0 ? colors.coral : colors.accent }} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text, lineHeight: 22 }} numberOfLines={isExpanded ? undefined : 2}>
                            {insight.statement}
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <View style={{ backgroundColor: `${colors.accent}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accent }}>
                              {'\u00a3'}{Math.round(insight.annualImpact).toLocaleString()}/yr
                            </Text>
                          </View>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.dim }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                        </View>
                      </View>
                      {isExpanded && (
                        <View style={{ marginTop: 8, marginLeft: 14 }}>
                          {insight.longTermImpact != null && insight.longTermImpact > insight.annualImpact && (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                              <View style={{ backgroundColor: `${colors.coral}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.coral }}>
                                  {'\u00a3'}{Math.round(insight.longTermImpact).toLocaleString()} over 5yr
                                </Text>
                              </View>
                              {insight.linkedMoveCategory && (
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted, textTransform: 'uppercase' }}>
                                  {insight.linkedMoveCategory}
                                </Text>
                              )}
                            </View>
                          )}
                          <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.text2, lineHeight: 18 }}>
                            {insight.cause}
                          </Text>
                          {insight.implication && (
                            <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.green, lineHeight: 18, marginTop: 6 }}>
                              {insight.implication}
                            </Text>
                          )}
                          <TouchableOpacity
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}
                            onPress={() => {
                              trackEvent('Insight Ask Bocy', { statement: insight.statement?.slice(0, 40) });
                              router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Tell me more about this: "${insight.statement}"` } });
                            }}
                            activeOpacity={0.7}
                          >
                            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accent, textDecorationLine: 'underline' }}>Ask Bocy about this</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
              {/* Remaining insights in collapsible dropdown */}
              {insightsData.length > 2 && (
                <>
                  <TouchableOpacity
                    onPress={() => { hapticLight(); LayoutAnimation.configureNext(SMOOTH_ANIM); setInsightsSectionOpen(!insightsSectionOpen); }}
                    activeOpacity={0.7}
                    style={{ paddingVertical: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 }}
                  >
                    <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.accent, letterSpacing: 0.3 }}>
                      {insightsSectionOpen ? 'Show less' : `${insightsData.length - 2} more insight${insightsData.length - 2 !== 1 ? 's' : ''}`}
                    </Text>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accent }}>{insightsSectionOpen ? '\u25B2' : '\u25BC'}</Text>
                  </TouchableOpacity>
                  {insightsSectionOpen && insightsData.slice(2).map((insight: Insight, rawIdx: number) => {
                    const idx = rawIdx + 2;
                    const isExpanded = expandedInsights.has(idx);
                    return (
                      <TouchableOpacity key={`insight-${idx}`} activeOpacity={0.7} onPress={() => {
                        trackEvent('Insight Tapped', { index: idx, statement: insight.statement?.slice(0, 40) });
                        hapticLight();
                        LayoutAnimation.configureNext(SMOOTH_ANIM);
                        setExpandedInsights(prev => { const next = new Set(prev); if (next.has(idx)) next.delete(idx); else next.add(idx); return next; });
                      }}>
                        <View style={{ paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                            <View style={{ width: 4, height: 28, borderRadius: 2, backgroundColor: colors.accent }} />
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text, lineHeight: 22 }} numberOfLines={isExpanded ? undefined : 2}>
                                {insight.statement}
                              </Text>
                            </View>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <View style={{ backgroundColor: `${colors.accent}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accent }}>
                                  {'\u00a3'}{Math.round(insight.annualImpact).toLocaleString()}/yr
                                </Text>
                              </View>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.dim }}>{isExpanded ? '\u25B2' : '\u25BC'}</Text>
                            </View>
                          </View>
                          {isExpanded && (
                            <View style={{ marginTop: 8, marginLeft: 14 }}>
                              {insight.longTermImpact != null && insight.longTermImpact > insight.annualImpact && (
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                  <View style={{ backgroundColor: `${colors.coral}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.coral }}>
                                      {'\u00a3'}{Math.round(insight.longTermImpact).toLocaleString()} over 5yr
                                    </Text>
                                  </View>
                                </View>
                              )}
                              <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.text2, lineHeight: 18 }}>
                                {insight.cause}
                              </Text>
                              {insight.implication && (
                                <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.green, lineHeight: 18, marginTop: 6 }}>
                                  {insight.implication}
                                </Text>
                              )}
                              <TouchableOpacity
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}
                                onPress={() => {
                                  router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Tell me more about this: "${insight.statement}"` } });
                                }}
                                activeOpacity={0.7}
                              >
                                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accent, textDecorationLine: 'underline' }}>Ask Bocy about this</Text>
                              </TouchableOpacity>
                            </View>
                          )}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </>
              )}
            </Card>
          )}

          {/* ══════════════════════════════════════════════
              AGENT RECOMMENDATIONS — ranked actions from wealth manager
              ══════════════════════════════════════════════ */}
          {agentRecommendations.length > 0 && (
            <View style={{ marginBottom: spacing.md }}>
              <TouchableOpacity style={s.moveSectionHeader} onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setRecsSectionOpen(!recsSectionOpen); }} activeOpacity={0.7}>
                <Text style={s.moveSectionLabel}>RECOMMENDED ACTIONS</Text>
                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.green, letterSpacing: 0.3 }}>
                  {agentRecommendations.length} action{agentRecommendations.length !== 1 ? 's' : ''} {recsSectionOpen ? '\u25B2' : '\u25BC'}
                </Text>
              </TouchableOpacity>
              {recsSectionOpen && agentRecommendations.slice(0, 5).map((rec, idx) => {
                const impactColor = rec.expected_impact > 500 ? colors.green : rec.expected_impact > 100 ? colors.accent : colors.text2;
                const riskColor = rec.downside_risk > 500 ? colors.coral : rec.downside_risk > 100 ? colors.amber : colors.muted;
                return (
                  <Card key={`agent-rec-${idx}`} variant="default" style={{ marginBottom: spacing.sm, borderLeftWidth: 3, borderLeftColor: idx === 0 ? colors.green : colors.accent }}>
                    <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text, lineHeight: 22 }}>
                      {rec.action}
                    </Text>
                    {/* Flow: source → destination */}
                    {(rec.source || rec.destination) && (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                        {rec.source ? (
                          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>{rec.source}</Text>
                        ) : null}
                        {rec.source && rec.destination ? (
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>{'\u2192'}</Text>
                        ) : null}
                        {rec.destination ? (
                          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>{rec.destination}</Text>
                        ) : null}
                        {rec.amount > 0 && (
                          <View style={{ backgroundColor: `${colors.accent}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8, marginLeft: 'auto' }}>
                            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accent }}>
                              {'\u00a3'}{Math.round(rec.amount).toLocaleString()}/mo
                            </Text>
                          </View>
                        )}
                      </View>
                    )}
                    {/* Impact & risk badges */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      {rec.expected_impact > 0 && (
                        <View style={{ backgroundColor: `${impactColor}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: impactColor }}>
                            +{'\u00a3'}{Math.round(rec.expected_impact).toLocaleString()}/yr
                          </Text>
                        </View>
                      )}
                      {rec.downside_risk > 0 && (
                        <View style={{ backgroundColor: `${riskColor}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: riskColor }}>
                            {'\u00a3'}{Math.round(rec.downside_risk).toLocaleString()} risk
                          </Text>
                        </View>
                      )}
                    </View>
                  </Card>
                );
              })}
            </View>
          )}

          {/* ══════════════════════════════════════════════
              AGENT INSIGHTS — inefficiencies detected by financial analyst
              ══════════════════════════════════════════════ */}
          {agentInsights.length > 0 && (
            <View style={{ marginBottom: spacing.md }}>
              <TouchableOpacity style={s.moveSectionHeader} onPress={() => { LayoutAnimation.configureNext(SMOOTH_ANIM); setAgentInsightsSectionOpen(!agentInsightsSectionOpen); }} activeOpacity={0.7}>
                <Text style={s.moveSectionLabel}>AGENT INSIGHTS</Text>
                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.coral, letterSpacing: 0.3 }}>
                  {'\u00a3'}{Math.round(agentInsights.reduce((sum, ai) => sum + (ai.annual_impact || 0), 0)).toLocaleString()}/yr impact {agentInsightsSectionOpen ? '\u25B2' : '\u25BC'}
                </Text>
              </TouchableOpacity>
              {agentInsightsSectionOpen && agentInsights.slice(0, 4).map((ai, idx) => {
                const confidenceColor = ai.confidence > 0.8 ? colors.green : ai.confidence > 0.5 ? colors.amber : colors.muted;
                return (
                  <TouchableOpacity
                    key={`agent-insight-${idx}`}
                    activeOpacity={0.7}
                    onPress={() => {
                      trackEvent('Agent Insight Tapped', { type: ai.type, description: ai.description?.slice(0, 40) });
                      hapticLight();
                      router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: `Explain this to me and what I should do: "${ai.description}"` } });
                    }}
                  >
                    <Card variant="default" style={{ marginBottom: spacing.sm, borderLeftWidth: 3, borderLeftColor: colors.coral }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text, lineHeight: 22 }}>
                            {ai.description}
                          </Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                            {ai.annual_impact > 0 && (
                              <View style={{ backgroundColor: `${colors.coral}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.coral }}>
                                  {'\u00a3'}{Math.round(ai.annual_impact).toLocaleString()}/yr
                                </Text>
                              </View>
                            )}
                            <View style={{ backgroundColor: `${confidenceColor}15`, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 }}>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: confidenceColor }}>
                                {Math.round(ai.confidence * 100)}% confidence
                              </Text>
                            </View>
                            {ai.type && (
                              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                {ai.type}
                              </Text>
                            )}
                          </View>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.accent, marginTop: 8 }}>
                            Tap to ask Bocy {'\u2192'}
                          </Text>
                        </View>
                      </View>
                    </Card>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {/* Dot separator */}
          <View style={s.dotSeparator}>
            {Array.from({ length: 5 }).map((_, i) => (
              <View key={i} style={[s.dot, { backgroundColor: colors.border }]} />
            ))}
          </View>

          {/* ══════════════════════════════════════════════
              INCOME — persistent income card, collapsed by default
              ══════════════════════════════════════════════ */}
          {income > 0 && (
          <View>
            <TouchableOpacity
              activeOpacity={0.7}
              onPress={() => {
                LayoutAnimation.configureNext(SMOOTH_ANIM);
                setIncomeExpanded(!incomeExpanded);
              }}
              style={[s.collapsedSectionBtn, !incomeExpanded && {
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 16,
                backgroundColor: colors.mintDim,
                paddingHorizontal: 20,
              }]}
            >
              <Text style={s.moveSectionLabel}>INCOME</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.text2, letterSpacing: 0.3 }}>
                  {'\u00a3'}{Math.round(income).toLocaleString()}/mo
                </Text>
                <Text style={{ fontSize: 12, color: colors.dim }}>{incomeExpanded ? '\u25B4' : '\u25BE'}</Text>
              </View>
            </TouchableOpacity>

            {incomeExpanded && (
              <Card style={{ marginBottom: spacing.md }}>
                {/* Read-only summary derived from transaction categorisation */}
                {[
                  { label: 'Income', value: income, color: colors.text },
                  { label: 'Essentials', value: nonDiscTotal, color: colors.coral },
                  { label: 'Lifestyle', value: discTotal, color: colors.dim },
                  { label: 'Surplus', value: surplusTotal, color: colors.text2 },
                ].map((row, idx, arr) => (
                  <View
                    key={row.label}
                    style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: idx === arr.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: colors.border }}
                  >
                    <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>{row.label}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 16, color: row.color }}>
                        {'\u00a3'}{Math.round(row.value).toLocaleString()}
                      </Text>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>/mo</Text>
                    </View>
                  </View>
                ))}

                {isVariableIncome && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.amber }} />
                    <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.amber, letterSpacing: 0.3 }}>
                      Variable — budget against {'\u00a3'}{Math.round(incomeFloor).toLocaleString()}/mo
                    </Text>
                  </View>
                )}

                {/* Income sources */}
                {incomeSources.length > 0 && (
                  <View style={{ marginTop: 20, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 2, marginBottom: 12 }}>
                      SOURCES
                    </Text>
                    {incomeSources.map((src: IncomeSource, i: number) => {
                      const srcKey = `${src.source}-${i}`;
                      const isExpanded = expandedIncomeSource === srcKey;
                      const hasTxs = Array.isArray(src.transactions) && src.transactions.length > 0;
                      return (
                        <View key={`inc-src-${i}`}>
                          <TouchableOpacity
                            activeOpacity={hasTxs ? 0.6 : 1}
                            onPress={() => {
                              if (!hasTxs) return;
                              LayoutAnimation.configureNext(SMOOTH_ANIM);
                              setExpandedIncomeSource(isExpanded ? null : srcKey);
                            }}
                            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 }}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>{src.source}</Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted, letterSpacing: 0.5 }}>
                                  {src.frequency}
                                </Text>
                                {src.isSalary && (
                                  <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: 'rgba(147,130,220,0.12)' }}>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 8, color: '#9382DC', letterSpacing: 0.5 }}>SALARY</Text>
                                  </View>
                                )}
                                {hasTxs && (
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.dim }}>
                                    {src.transactions!.length} txn{src.transactions!.length !== 1 ? 's' : ''} {isExpanded ? '\u25B4' : '\u25BE'}
                                  </Text>
                                )}
                              </View>
                            </View>
                            <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.text2, letterSpacing: 0.3 }}>
                              {'\u00a3'}{Math.round(src.avgAmount).toLocaleString()}
                              <Text style={{ fontSize: 10, color: colors.muted }}>/{src.frequency === 'weekly' ? 'wk' : src.frequency === 'fortnightly' ? '2wk' : 'mo'}</Text>
                            </Text>
                          </TouchableOpacity>
                          {isExpanded && src.transactions && (
                            <View style={{ marginLeft: 12, marginBottom: 8, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: colors.border }}>
                              {src.transactions.map((tx, ti) => (
                                <View key={`inc-tx-${ti}`} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 }}>
                                  <View style={{ flex: 1 }}>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>{tx.merchant || tx.description}</Text>
                                    <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, marginTop: 1 }}>
                                      {new Date(tx.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                                    </Text>
                                  </View>
                                  <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.green }}>
                                    {'\u00a3'}{Math.abs(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </Text>
                                </View>
                              ))}
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                )}
              </Card>
            )}
          </View>
          )}

          {/* ══════════════════════════════════════════════
              DEBT — connected debts, balances & utilisation
              ══════════════════════════════════════════════ */}
          {debtAccounts.length > 0 && (() => {
            const activeDebts = debtAccounts.filter((d: any) => (d.outstanding_balance || 0) > 0);
            if (activeDebts.length === 0) return null;
            const tiered = classifyDebtAccounts(activeDebts);
            const totalBalance = activeDebts.reduce((sum: number, d: any) => sum + (d.outstanding_balance || 0), 0);
            const totalLimit = activeDebts.reduce((sum: number, d: any) => sum + (d.credit_limit || 0), 0);
            const overallUtil = totalLimit > 0 ? Math.round((totalBalance / totalLimit) * 100) : null;
            const totalMinPayment = activeDebts.reduce((sum: number, d: any) => sum + (d.minimum_payment || 0), 0);
            const utilColor = overallUtil === null ? colors.muted : overallUtil > 75 ? colors.coral : overallUtil > 50 ? colors.amber : colors.green;
            return (
            <View>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  LayoutAnimation.configureNext(SMOOTH_ANIM);
                  setDebtExpanded(!debtExpanded);
                }}
                style={[s.collapsedSectionBtn, !debtExpanded && {
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 16,
                  backgroundColor: colors.coralDim || 'rgba(255,107,107,0.06)',
                  paddingHorizontal: 20,
                }]}
              >
                <Text style={s.moveSectionLabel}>DEBT</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.coral, letterSpacing: 0.3 }}>
                    {'\u00a3'}{Math.round(totalBalance).toLocaleString()}
                  </Text>
                  {overallUtil !== null && (
                    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: `${utilColor}18` }}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: utilColor, letterSpacing: 0.5 }}>
                        {overallUtil}% USED
                      </Text>
                    </View>
                  )}
                  <Text style={{ fontSize: 12, color: colors.dim }}>{debtExpanded ? '\u25B4' : '\u25BE'}</Text>
                </View>
              </TouchableOpacity>

              {debtExpanded && (
                <Card style={{ marginBottom: spacing.md }}>
                  {/* Hero total */}
                  <View style={s.debtHero}>
                    <Text style={s.debtHeroAmount}>
                      {'\u00a3'}{Math.round(totalBalance).toLocaleString()}
                    </Text>
                    <Text style={s.debtHeroLabel}>total outstanding</Text>
                  </View>

                  {/* Utilisation bar (credit-based debts only) */}
                  {totalLimit > 0 && (
                    <View style={{ marginBottom: 20 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted, letterSpacing: 1 }}>UTILISATION</Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: utilColor, letterSpacing: 0.3 }}>
                          {overallUtil}%
                        </Text>
                      </View>
                      <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' }}>
                        <View style={{ width: `${Math.min(overallUtil || 0, 100)}%`, height: '100%', borderRadius: 3, backgroundColor: utilColor }} />
                      </View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted }}>
                          {'\u00a3'}{Math.round(totalBalance).toLocaleString()} / {'\u00a3'}{Math.round(totalLimit).toLocaleString()}
                        </Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted }}>
                          {'\u00a3'}{Math.round(totalLimit - totalBalance).toLocaleString()} available
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Summary row: min payments */}
                  {totalMinPayment > 0 && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, marginBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.text2 }}>Min. payments</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.coral }}>
                          {'\u00a3'}{Math.round(totalMinPayment).toLocaleString()}
                        </Text>
                        <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>/mo</Text>
                      </View>
                    </View>
                  )}

                  {/* Individual debt rows */}
                  {tiered.map((debt, idx) => {
                    const name = resolveDebtDisplayName(debt);
                    const balance = debt.outstanding_balance || 0;
                    const limit = debt.credit_limit || 0;
                    const util = limit > 0 ? Math.round((balance / limit) * 100) : null;
                    const apr = debt.interest_rate || 0;
                    const debtUtilColor = util === null ? colors.muted : util > 75 ? colors.coral : util > 50 ? colors.amber : colors.green;
                    const tierBadgeColor = debt.tier === 'tier1_high' ? colors.coral : debt.tier === 'tier2_medium' ? colors.amber : colors.green;
                    return (
                      <View key={`debt-${idx}`} style={[s.debtRow, idx === tiered.length - 1 && s.debtRowLast]}>
                        <View style={s.debtRowLeft}>
                          <Text style={s.debtName}>{name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                            <Text style={s.debtType}>{debt.account_type || 'debt'}</Text>
                            {apr > 0 && (
                              <View style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, backgroundColor: `${tierBadgeColor}18` }}>
                                <Text style={{ fontFamily: fonts.mono, fontSize: 8, color: tierBadgeColor, letterSpacing: 0.3 }}>
                                  {(apr * 100).toFixed(1)}% APR
                                </Text>
                              </View>
                            )}
                          </View>
                          {/* Per-account utilisation bar */}
                          {util !== null && (
                            <View style={{ marginTop: 6 }}>
                              <View style={{ height: 3, borderRadius: 1.5, backgroundColor: colors.border, overflow: 'hidden', width: '80%' }}>
                                <View style={{ width: `${Math.min(util, 100)}%`, height: '100%', borderRadius: 1.5, backgroundColor: debtUtilColor }} />
                              </View>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: debtUtilColor, marginTop: 2 }}>
                                {util}% utilised
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={s.debtRowRight}>
                          <Text style={s.debtBalance}>
                            {'\u00a3'}{Math.round(balance).toLocaleString()}
                          </Text>
                          {debt.minimum_payment && debt.minimum_payment > 0 && (
                            <Text style={s.debtUtil}>
                              min {'\u00a3'}{Math.round(debt.minimum_payment).toLocaleString()}/mo
                            </Text>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </Card>
              )}
            </View>
            );
          })()}

          {/* ══════════════════════════════════════════════
              INVESTMENTS — portfolio overview
              ══════════════════════════════════════════════ */}
          {investments.length > 0 && (() => {
            const totalValue = investments.reduce((sum, i) => sum + (i.current_value || 0), 0);
            if (totalValue <= 0) return null;
            const totalCost = investments.reduce((sum, i) => sum + (i.purchase_cost || 0), 0);
            const hasGainLoss = totalCost > 0;
            const totalGain = hasGainLoss ? totalValue - totalCost : 0;
            const totalGainPct = hasGainLoss && totalCost > 0 ? ((totalGain / totalCost) * 100).toFixed(1) : null;
            const gainColor = totalGain >= 0 ? colors.green : colors.coral;

            // Group by asset class
            const ASSET_CLASS_COLORS: Record<string, string> = {
              stocks: colors.accent,
              bonds: colors.green,
              etfs: '#9382DC',
              crypto: colors.amber,
              property: colors.text2,
              pension: '#E8915C',
              other: colors.muted,
            };
            const byClass: Record<string, { items: typeof investments; total: number }> = {};
            for (const inv of investments) {
              const cls = inv.asset_class || 'other';
              if (!byClass[cls]) byClass[cls] = { items: [], total: 0 };
              byClass[cls].items.push(inv);
              byClass[cls].total += inv.current_value || 0;
            }
            const classRows = Object.entries(byClass)
              .sort((a, b) => b[1].total - a[1].total)
              .map(([cls, data]) => ({
                label: cls.charAt(0).toUpperCase() + cls.slice(1),
                key: cls,
                color: ASSET_CLASS_COLORS[cls] || colors.muted,
                total: data.total,
                count: data.items.length,
                items: data.items,
              }));

            return (
            <View>
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  LayoutAnimation.configureNext(SMOOTH_ANIM);
                  setInvestmentExpanded(!investmentExpanded);
                }}
                style={[s.collapsedSectionBtn, !investmentExpanded && {
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 16,
                  backgroundColor: colors.accentDim,
                  paddingHorizontal: 20,
                }]}
              >
                <Text style={s.moveSectionLabel}>INVESTMENTS</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.accent, letterSpacing: 0.3 }}>
                    {'\u00a3'}{Math.round(totalValue).toLocaleString()}
                  </Text>
                  <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: `${colors.muted}18` }}>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 0.5 }}>
                      {investments.length} HOLDING{investments.length !== 1 ? 'S' : ''}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 12, color: colors.dim }}>{investmentExpanded ? '\u25B4' : '\u25BE'}</Text>
                </View>
              </TouchableOpacity>

              {investmentExpanded && (
                <Card style={{ marginBottom: spacing.md }}>
                  {/* Hero total */}
                  <View style={{ alignItems: 'center', paddingVertical: 20, paddingHorizontal: 28 }}>
                    <Text style={{ fontFamily: fonts.mono, fontSize: 28, color: colors.accent, letterSpacing: -0.5 }}>
                      {'\u00a3'}{Math.round(totalValue).toLocaleString()}
                    </Text>
                    <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.muted, marginTop: 4 }}>
                      total portfolio value
                    </Text>
                  </View>

                  {/* Gain/Loss row */}
                  {hasGainLoss && (
                    <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: gainColor }}>
                        {totalGain >= 0 ? '+' : ''}{'\u00a3'}{Math.round(Math.abs(totalGain)).toLocaleString()}
                      </Text>
                      {totalGainPct && (
                        <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, backgroundColor: `${gainColor}18` }}>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: gainColor }}>
                            {totalGain >= 0 ? '+' : ''}{totalGainPct}%
                          </Text>
                        </View>
                      )}
                      <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.muted }}>unrealised</Text>
                    </View>
                  )}

                  {/* Asset allocation bar */}
                  <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 16 }}>
                    {classRows.map((r) => (
                      <View key={r.key} style={{ flex: r.total / totalValue, backgroundColor: r.color, marginRight: 1 }} />
                    ))}
                  </View>

                  {/* Asset class breakdown */}
                  {classRows.map((r, idx) => (
                    <View key={r.key} style={{ borderBottomWidth: idx === classRows.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: r.color }} />
                          <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>{r.label}</Text>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted }}>
                            {r.count} holding{r.count !== 1 ? 's' : ''}
                          </Text>
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: r.color }}>
                            {'\u00a3'}{Math.round(r.total).toLocaleString()}
                          </Text>
                          <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                            {Math.round((r.total / totalValue) * 100)}%
                          </Text>
                        </View>
                      </View>

                      {/* Individual holdings within class */}
                      {r.items.map((inv, invIdx) => {
                        const invGain = inv.purchase_cost ? inv.current_value - inv.purchase_cost : null;
                        const invGainColor = invGain !== null ? (invGain >= 0 ? colors.green : colors.coral) : colors.muted;
                        return (
                          <View key={inv.id || invIdx} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, paddingLeft: 24 }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.text2 }}>{inv.name}</Text>
                              {inv.platform && (
                                <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted }}>{inv.platform}</Text>
                              )}
                            </View>
                            <View style={{ alignItems: 'flex-end' }}>
                              <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.text }}>
                                {'\u00a3'}{Math.round(inv.current_value).toLocaleString()}
                              </Text>
                              {invGain !== null && (
                                <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: invGainColor }}>
                                  {invGain >= 0 ? '+' : ''}{'\u00a3'}{Math.round(Math.abs(invGain)).toLocaleString()}
                                </Text>
                              )}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </Card>
              )}
            </View>
            );
          })()}

          {/* ══════════════════════════════════════════════
              NET WORTH — account allocation breakdown (UHE/SHE only)
              ══════════════════════════════════════════════ */}
          {accountBuckets && (() => {
            const propertyEquity = userProperties.reduce((sum, p) => {
              const equity = p.estimated_value - (p.has_mortgage && p.mortgage_balance ? p.mortgage_balance : 0);
              return sum + Math.max(0, equity);
            }, 0);
            const totalMortgageDebt = userProperties.reduce((sum, p) => sum + (p.has_mortgage && p.mortgage_balance ? p.mortgage_balance : 0), 0);
            const totalAssets = accountBuckets.cash.total + accountBuckets.savings.total + accountBuckets.isa.total + accountBuckets.investments.total + accountBuckets.pension.total + propertyEquity;
            if (totalAssets <= 0) return null;
            const bucketRows = [
              { label: 'Cash', amount: accountBuckets.cash.total, color: colors.text2, count: accountBuckets.cash.accounts.length },
              { label: 'Savings', amount: accountBuckets.savings.total, color: colors.green, count: accountBuckets.savings.accounts.length },
              { label: 'ISA', amount: accountBuckets.isa.total, color: '#9382DC', count: accountBuckets.isa.accounts.length },
              { label: 'Pension', amount: accountBuckets.pension.total, color: colors.amber, count: 0 },
              { label: 'Investments', amount: accountBuckets.investments.total, color: colors.coral, count: accountBuckets.investments.accounts.length },
              { label: 'Property', amount: propertyEquity, color: '#6BB5E0', count: userProperties.length },
            ].filter(r => r.amount > 0);
            return (
              <Card style={{ marginBottom: spacing.md }}>
                <CardTitleRow
                  title="Net Worth"
                  right={
                    <Text style={{ fontFamily: fonts.mono, fontSize: 16, color: colors.text, letterSpacing: 0.3 }}>
                      {'\u00a3'}{Math.round(totalAssets).toLocaleString()}
                    </Text>
                  }
                />
                {totalMortgageDebt > 0 && (
                  <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted, letterSpacing: 0.5, marginTop: -4, marginBottom: 4 }}>
                    Gross property: {'\u00a3'}{Math.round(userProperties.reduce((s, p) => s + p.estimated_value, 0)).toLocaleString()} {'\u00B7'} Mortgage debt: {'\u00a3'}{Math.round(totalMortgageDebt).toLocaleString()}
                  </Text>
                )}
                {/* Allocation bar */}
                <View style={{ flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', marginTop: 12, marginBottom: 16 }}>
                  {bucketRows.map((r) => (
                    <View key={r.label} style={{ flex: r.amount / totalAssets, backgroundColor: r.color, marginRight: 1 }} />
                  ))}
                </View>
                {/* Bucket rows */}
                {bucketRows.map((r, idx) => (
                  <View key={r.label} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: idx === bucketRows.length - 1 ? 0 : StyleSheet.hairlineWidth, borderBottomColor: colors.border }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: r.color }} />
                      <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.text }}>{r.label}</Text>
                      {r.count > 0 && (
                        <Text style={{ fontFamily: fonts.mono, fontSize: 9, color: colors.muted }}>
                          {r.count} acct{r.count !== 1 ? 's' : ''}
                        </Text>
                      )}
                      {r.label === 'Pension' && accountBuckets.pension.estimated && (
                        <Text style={{ fontFamily: fonts.mono, fontSize: 8, color: colors.dim }}>est.</Text>
                      )}
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: r.color }}>
                        {'\u00a3'}{Math.round(r.amount).toLocaleString()}
                      </Text>
                      <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.muted }}>
                        {Math.round((r.amount / totalAssets) * 100)}%
                      </Text>
                    </View>
                  </View>
                ))}
              </Card>
            );
          })()}

          {/* ── Unified review modal ── */}
          <Modal visible={reviewModalVisible} transparent animationType="none" onRequestClose={dismissReviewModal}>
            <Animated.View style={[s.catReviewOverlay, { opacity: reviewModalFade }]}>
              <Pressable style={s.catReviewOverlayInner} onPress={dismissReviewModal}>
              <Animated.View style={[s.catReviewContainer, { transform: [{ translateY: reviewModalSlide }] }]} onStartShouldSetResponder={() => true}>
                {/* Header */}
                <View style={s.catReviewHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.modalTitle}>Review items</Text>
                    <Text style={s.catReviewSubtitle}>
                      {aiSuggesting
                        ? 'Bocy is reviewing your transactions...'
                        : aiSuggestedGroups.length > 0
                          ? "Bocy's best guesses \u2014 tap to confirm"
                          : 'Confirm a few items to sharpen your plan'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={dismissReviewModal}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                    accessibilityRole="button"
                    accessibilityLabel="Close review modal"
                    style={s.catReviewCloseBtn}
                  >
                    <Text style={s.catReviewClose}>{'\u2715'}</Text>
                  </TouchableOpacity>
                </View>

                {/* Progress indicator */}
                {(() => {
                  const aiDone = aiConfirmed.size + Object.keys(aiOverrides).length;
                  const manualDone = Object.keys(catAssignments).length;
                  const totalItems = aiSuggestedGroups.length + unresolvedGroups.length;
                  const reviewedItems = aiDone + manualDone;
                  const progress = totalItems > 0 ? reviewedItems / totalItems : 0;
                  return totalItems > 0 ? (
                    <View style={s.reviewProgressBar}>
                      <Text style={s.reviewProgressText}>
                        {reviewedItems} of {totalItems} reviewed
                      </Text>
                      <View style={s.reviewProgressTrack}>
                        <View style={[s.reviewProgressFill, { width: `${Math.round(progress * 100)}%` }]} />
                      </View>
                    </View>
                  ) : null;
                })()}

                {/* AI suggesting bar */}
                {aiSuggesting && (
                  <View style={s.aiSuggestBar}>
                    <ActivityIndicator color={colors.accent} size="small" />
                    <Text style={s.aiSuggestText}>Matching merchants...</Text>
                  </View>
                )}


                <ScrollView style={s.catReviewList} showsVerticalScrollIndicator={false}>

                  {/* ── Single unified review list, sorted by confidence: suggested first, then unresolved ── */}
                  {(() => {
                    const totalItems = aiSuggestedGroups.length + unresolvedGroups.length;
                    if (totalItems === 0) return null;

                    // "Confirm all" button for all items with AI suggestions
                    const unreviewed = aiSuggestedGroups.filter(
                      (g) => !aiConfirmed.has(g.key) && !aiOverrides[g.key],
                    );

                    return (
                      <>
                        <Text style={s.reviewSectionHeader}>
                          {totalItems} ITEM{totalItems !== 1 ? 'S' : ''} TO REVIEW
                        </Text>

                        {unreviewed.length > 0 && (
                          <TouchableOpacity
                            style={s.acceptAllBtn}
                            onPress={() => {
                              hapticSuccess();
                              setAiConfirmed((prev) => {
                                const next = new Set(prev);
                                for (const g of unreviewed) next.add(g.key);
                                return next;
                              });
                              setAiExpandedKey(null);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Confirm all ${unreviewed.length} suggestions`}
                          >
                            <Text style={s.acceptAllText}>
                              Confirm all ({unreviewed.length}) {'\u2713'}
                            </Text>
                          </TouchableOpacity>
                        )}

                        {/* AI-suggested items (high confidence) — badge + confirm button */}
                        {aiSuggestedGroups.map((group) => {
                          const isConfirmed = aiConfirmed.has(group.key);
                          const override = aiOverrides[group.key];
                          const isExpanded = aiExpandedKey === group.key;
                          const displayCat = override?.category || group.aiCategory;
                          const isDone = isConfirmed || !!override;

                          return (
                            <View
                              key={`ai-${group.key}`}
                              style={[s.catReviewRow, isDone && s.catReviewRowDone]}
                              accessibilityLabel={`${group.label}, ${displayCat}, ${isDone ? 'confirmed' : 'pending'}`}
                            >
                              <View style={s.catReviewRowHeader}>
                                <View style={{ flex: 1 }}>
                                  <Text style={s.catReviewMerchant} numberOfLines={1}>
                                    {group.label}
                                  </Text>
                                  <Text style={s.catReviewAmount}>
                                    {group.txs.length} txn{group.txs.length !== 1 ? 's' : ''} {'\u00b7'} {'\u00a3'}{group.total.toFixed(2)}
                                  </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                  {/* Category badge — tap to expand picker */}
                                  <TouchableOpacity
                                    onPress={() => {
                                      hapticLight();
                                      setAiExpandedKey(isExpanded ? null : group.key);
                                    }}
                                    style={[s.aiCatBadge, isDone && s.aiCatBadgeDone]}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${displayCat}, tap to change`}
                                  >
                                    <Text style={[s.aiCatBadgeText, isDone && s.aiCatBadgeTextDone]} numberOfLines={1}>
                                      {displayCat}
                                    </Text>
                                  </TouchableOpacity>
                                  {/* Confirm button */}
                                  <TouchableOpacity
                                    onPress={() => {
                                      hapticLight();
                                      if (isConfirmed) {
                                        setAiConfirmed((prev) => { const next = new Set(prev); next.delete(group.key); return next; });
                                      } else {
                                        setAiConfirmed((prev) => new Set(prev).add(group.key));
                                        setAiExpandedKey(null);
                                      }
                                    }}
                                    style={[s.aiConfirmBtn, isDone && s.aiConfirmBtnDone]}
                                    accessibilityRole="button"
                                    accessibilityLabel={isDone ? 'Undo confirm' : 'Confirm'}
                                  >
                                    <Text style={[s.aiConfirmBtnText, isDone && s.aiConfirmBtnTextDone]}>
                                      {isDone ? '\u2713' : '\u2713'}
                                    </Text>
                                  </TouchableOpacity>
                                </View>
                              </View>

                              {/* Expanded category picker for overriding */}
                              {isExpanded && (
                                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                                  {BUDGET_CATEGORIES.filter(c => c !== 'Other').map((cat) => (
                                    <TouchableOpacity
                                      key={cat}
                                      style={[s.categoryChip, displayCat === cat && s.categoryChipActive]}
                                      onPress={() => {
                                        hapticLight();
                                        if (cat === group.aiCategory) {
                                          setAiOverrides((prev) => { const next = { ...prev }; delete next[group.key]; return next; });
                                          setAiConfirmed((prev) => new Set(prev).add(group.key));
                                        } else {
                                          setAiOverrides((prev) => ({
                                            ...prev,
                                            [group.key]: { category: cat, isEssential: ESSENTIAL_CATS.has(cat) },
                                          }));
                                          setAiConfirmed((prev) => { const next = new Set(prev); next.delete(group.key); return next; });
                                        }
                                        setAiExpandedKey(null);
                                      }}
                                      accessibilityRole="button"
                                      accessibilityLabel={cat}
                                    >
                                      <Text style={[s.categoryChipText, displayCat === cat && s.categoryChipTextActive]}>{cat}</Text>
                                    </TouchableOpacity>
                                  ))}
                                </ScrollView>
                              )}
                            </View>
                          );
                        })}

                        {/* Unresolved items (low confidence) — chip picker */}
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
                              accessibilityLabel={`${group.label}, ${group.txs.length} transactions, ${assigned ? `categorised as ${assigned.category}` : 'not yet categorised'}${isAiSuggested ? ', suggested' : ''}`}
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
                                      hapticLight();
                                      setCatAssignments((prev) => ({
                                        ...prev,
                                        [group.key]: { category: cat, isEssential: ESSENTIAL_CATS.has(cat), aiSuggested: false },
                                      }));
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${cat}${assigned?.category === cat ? ', selected' : ''}`}
                                    accessibilityState={{ selected: assigned?.category === cat }}
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
                      </>
                    );
                  })()}

                </ScrollView>

                {/* Done button */}
                {(() => {
                  const aiDone = aiConfirmed.size + Object.keys(aiOverrides).length;
                  const manualDone = Object.keys(catAssignments).length;
                  const totalReviewed = aiDone + manualDone;
                  return (
                    <TouchableOpacity
                      style={[s.catReviewDone]}
                      onPress={totalReviewed === 0 ? () => setShowReviewModal(false) : saveReview}
                      disabled={savingReview}
                      accessibilityRole="button"
                      accessibilityLabel={totalReviewed > 0 ? `Save ${totalReviewed} reviewed items` : 'Close review'}
                      accessibilityState={{ disabled: savingReview }}
                    >
                      {savingReview ? (
                        saveSuccess ? (
                          <Text style={s.catReviewDoneText}>{'\u2713'} Saved!</Text>
                        ) : (
                          <ActivityIndicator color={colors.bg} size="small" />
                        )
                      ) : (
                        <Text style={s.catReviewDoneText}>
                          Save{totalReviewed > 0 ? ` (${totalReviewed} confirmed)` : ''}
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })()}
              </Animated.View>
              </Pressable>
            </Animated.View>
          </Modal>

        </>
      )}

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

      {/* ── Reactive engine insight modal (debt payments, achievements, plan verification) ── */}
      {reactiveEvents.length > 0 && reactiveEventIndex < reactiveEvents.length && (
        <InsightModal
          visible={showReactiveModal && !showInsightModal}
          onDismiss={() => {
            if (reactiveEventIndex < reactiveEvents.length - 1) {
              setReactiveEventIndex((i) => i + 1);
            } else {
              setShowReactiveModal(false);
            }
          }}
          onAction={(prefill) => {
            setShowReactiveModal(false);
            router.push({ pathname: '/(main)/(tabs)/chat', params: { prefill: prefill || 'What should I focus on next?' } });
          }}
          type={reactiveEvents[reactiveEventIndex].insightType}
          tag={reactiveEvents[reactiveEventIndex].tag}
          title={reactiveEvents[reactiveEventIndex].title}
          body={reactiveEvents[reactiveEventIndex].body}
          actionLabel={reactiveEvents[reactiveEventIndex].actionLabel || 'Ask Bocy'}
          actionPrefill={reactiveEvents[reactiveEventIndex].actionPrefill}
          fingerprint={reactiveEvents[reactiveEventIndex].fingerprint}
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

    {/* ── Install App Modal (post-onboarding) ── */}
    <Modal visible={showInstallModal} transparent animationType="fade" onRequestClose={() => { setShowInstallModal(false); AsyncStorage.setItem('install_modal_shown', '1').catch(() => {}); }}>
      <Pressable style={s.modalOverlay} onPress={() => { setShowInstallModal(false); AsyncStorage.setItem('install_modal_shown', '1').catch(() => {}); }}>
        <Pressable style={[s.modalContent, { maxWidth: 380 }]} onPress={(e) => e.stopPropagation()}>
          <Text style={[s.modalTitle, { textAlign: 'center' }]}>Add Bocy to your phone</Text>
          <Text style={[s.modalBody, { textAlign: 'center', marginTop: 8 }]}>
            Install on your home screen for instant access — no app store needed.
          </Text>
          {typeof window !== 'undefined' && /iP(hone|od|ad)/.test(navigator?.userAgent || '') && /WebKit/.test(navigator?.userAgent || '') && !/CriOS|FxiOS/.test(navigator?.userAgent || '') ? (
            <View style={{ marginTop: 16, gap: 12 }}>
              <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 }}>
                1. Tap the <Text style={{ fontFamily: fonts.semibold, color: colors.text }}>Share</Text> button in Safari's toolbar
              </Text>
              <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 }}>
                2. Scroll down and tap <Text style={{ fontFamily: fonts.semibold, color: colors.text }}>Add to Home Screen</Text>
              </Text>
              <Text style={{ fontFamily: fonts.regular, fontSize: 14, color: colors.text2, lineHeight: 22 }}>
                3. Tap <Text style={{ fontFamily: fonts.semibold, color: colors.text }}>Add</Text>
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={{ backgroundColor: colors.accent, paddingVertical: 14, borderRadius: radius.md, alignItems: 'center', marginTop: 20 }}
              onPress={async () => {
                // Try the native install prompt (Chrome/Edge)
                if (typeof window !== 'undefined' && (window as any).__pwaInstallPrompt) {
                  try {
                    (window as any).__pwaInstallPrompt.prompt();
                    const result = await (window as any).__pwaInstallPrompt.userChoice;
                    if (result.outcome === 'accepted') {
                      trackEvent('App Installed', { source: 'modal' });
                    }
                  } catch {}
                  (window as any).__pwaInstallPrompt = null;
                }
                setShowInstallModal(false);
                AsyncStorage.setItem('install_modal_shown', '1').catch(() => {});
              }}
              activeOpacity={0.8}
            >
              <Text style={{ fontFamily: fonts.semibold, fontSize: 15, color: colors.bg }}>Install app</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={{ alignItems: 'center', paddingVertical: 12, marginTop: 8 }}
            onPress={() => { setShowInstallModal(false); AsyncStorage.setItem('install_modal_shown', '1').catch(() => {}); }}
          >
            <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: colors.dim }}>Maybe later</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>

    {analysis && <Walkthrough visible={showWalkthrough} onDismiss={dismissWalkthrough} scrollRef={dashScrollRef} cardPositions={cardPositions} router={router} />}
    </View>
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
    marginTop: 32,
    alignItems: 'center',
  },
  emptyNatureBg: {
    width: '100%',
    borderRadius: radius.lg,
    overflow: 'hidden',
    minHeight: 360,
    position: 'relative',
    backgroundColor: '#2D5A1E',
  },
  emptyNatureLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  emptyGlassCard: {
    margin: spacing.lg,
    marginTop: 40,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyBocyWrap: {
    marginBottom: 24,
  },
  emptyTitle: {
    fontFamily: fonts.medium,
    fontSize: 20,
    color: '#fff',
    textAlign: 'center',
    marginBottom: spacing.sm,
    letterSpacing: -0.3,
  },
  emptyDesc: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: 'rgba(255,255,255,0.75)',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
    paddingHorizontal: spacing.sm,
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
    backgroundColor: c.accent,
    paddingVertical: 15,
    paddingHorizontal: spacing.xl,
    borderRadius: 100,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  heroCtaText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
    letterSpacing: 0.2,
    textAlign: 'center',
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
    paddingHorizontal: 10,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center' as const,
  },
  periodBtnText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    textAlign: 'center' as const,
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
  },
  catReviewOverlayInner: {
    flex: 1,
    justifyContent: 'center' as const,
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
  acceptAllBtn: {
    backgroundColor: c.accent,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center' as const,
  },
  acceptAllText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },
  aiCatBadge: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  aiCatBadgeDone: {
    borderColor: c.accent,
    backgroundColor: c.accentDim,
  },
  aiCatBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.text2,
  },
  aiCatBadgeTextDone: {
    color: c.accent,
  },
  aiConfirmBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  aiConfirmBtnDone: {
    borderColor: c.accent,
    backgroundColor: c.accent,
  },
  aiConfirmBtnText: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.dim,
  },
  aiConfirmBtnTextDone: {
    color: c.bg,
  },
  reviewSectionHeader: {
    fontFamily: fonts.mono,
    fontSize: 9,
    letterSpacing: 2,
    color: c.dim,
    textTransform: 'uppercase' as const,
    marginBottom: spacing.sm,
  },
  reviewProgressBar: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  reviewProgressText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.dim,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  reviewProgressTrack: {
    height: 3,
    backgroundColor: c.border,
    borderRadius: 2,
    overflow: 'hidden' as const,
  },
  reviewProgressFill: {
    height: '100%' as const,
    backgroundColor: c.accent,
    borderRadius: 2,
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
