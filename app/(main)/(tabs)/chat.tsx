import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, Animated, Easing, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { requestSync, onSyncComplete, invalidateSyncCache } from '@/lib/sync-coordinator';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useSubscription } from '@/lib/subscription';
import Paywall from '@/components/Paywall';
import Markdown from '@/lib/markdown';
import { BocyFace, getBocyMood } from '@/components/Bocy';
import type { ChatMessage, ChatContext, ChatAction, Analysis, Goals } from '@/lib/types';

/** Strip markdown bold/italic markers from text that will be rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

/** Free users can send this many messages before the paywall gate kicks in */
const FREE_MESSAGE_LIMIT = 2;

// ── Suggested questions (contextual) ──

function getContextualQuestions(analysis: Analysis | null, goals: Goals | null, paydayActive?: boolean): string[] {
  if (!analysis) {
    return [
      'What can Bocy help me with?',
      'How does the financial analysis work?',
    ];
  }

  // Payday mode: prioritise allocation-focused questions
  if (paydayActive) {
    const questions: string[] = [];
    questions.push('I just got paid. Walk me through what to do first.');
    questions.push('How much can I safely spend this week?');

    const moves = analysis.all_moves || [];
    if (moves.length > 0) {
      questions.push('Am I on track with my plan?');
    } else {
      questions.push('Help me set up a budget for this pay period.');
    }

    if (goals?.one_year_goal) {
      const goalName = goals.one_year_goal.replace(/_/g, ' ');
      questions.push(`How does this pay cycle move me closer to ${goalName}?`);
    } else {
      questions.push('What should I do with any leftover money?');
    }

    return questions;
  }

  const questions: string[] = [];
  questions.push('What happens if I follow my full action plan?');

  const patterns = analysis.behavioral_patterns || [];
  if (patterns.some((p: string) => p.toLowerCase().includes('debt'))) {
    questions.push('Should I focus on debt or savings first?');
  } else {
    questions.push('How can I optimise my savings rate?');
  }

  const moves = analysis.all_moves || [];
  if (moves.some((m: { action?: string }) => m.action?.toLowerCase().includes('subscription'))) {
    questions.push('Which subscriptions should I cut first?');
  } else {
    questions.push('Where are my biggest spending leaks?');
  }

  if (goals?.one_year_goal) {
    const goalName = goals.one_year_goal.replace(/_/g, ' ');
    questions.push(`How fast can I reach my ${goalName} goal?`);
  } else {
    questions.push('What financial goal should I set first?');
  }

  return questions;
}

// ── Animated typing dots ──

function TypingIndicator() {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const dots = [useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current, useRef(new Animated.Value(0)).current];

  useEffect(() => {
    const animations = dots.map((dot, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 200),
          Animated.timing(dot, { toValue: 1, duration: 400, easing: Easing.ease, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 400, easing: Easing.ease, useNativeDriver: true }),
        ]),
      ),
    );
    animations.forEach((a) => a.start());
    return () => animations.forEach((a) => a.stop());
  }, []);

  return (
    <View style={[s.bubble, s.assistantBubble]}>
      <View style={s.dotsRow}>
        {dots.map((dot, i) => (
          <Animated.View
            key={i}
            style={[
              s.dot,
              { opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) },
              { transform: [{ translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }] },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

// ── Inline action cards ──

function PlanCard({
  action,
  onApprove,
  onDismiss,
  saving,
}: {
  action: ChatAction;
  onApprove: () => void;
  onDismiss: () => void;
  saving?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  const isApproved = action.status === 'approved';
  const isDismissed = action.status === 'dismissed';

  return (
    <View style={[s.actionCard, isApproved && s.actionCardApproved]}>
      <Text style={s.actionCardLabel}>{isApproved ? 'PLAN ADDED' : 'PLAN SUGGESTED'}</Text>
      <Text style={s.actionCardTitle}>{stripMd(d.action)}</Text>
      <View style={s.actionCardStats}>
        {d.target_amount != null && (
          <View style={s.actionStat}>
            <Text style={s.actionStatValue}>{'\u00a3'}{d.target_amount.toLocaleString()}</Text>
            <Text style={s.actionStatLabel}>target</Text>
          </View>
        )}
        {d.monthly_saving != null && (
          <View style={s.actionStat}>
            <Text style={s.actionStatValue}>{'\u00a3'}{d.monthly_saving.toLocaleString()}/mo</Text>
            <Text style={s.actionStatLabel}>saving</Text>
          </View>
        )}
        {d.timeline && (
          <View style={s.actionStat}>
            <Text style={s.actionStatValue}>{d.timeline}</Text>
            <Text style={s.actionStatLabel}>timeline</Text>
          </View>
        )}
      </View>
      {isApproved ? (
        <View style={s.approvedBanner}>
          <Text style={s.approvedBannerText}>{'\u2713'} Added to your plan</Text>
        </View>
      ) : isDismissed ? (
        <View style={s.dismissedBanner}>
          <Text style={s.dismissedBannerText}>Removed from plan</Text>
        </View>
      ) : (
        <View style={s.actionCardButtons}>
          <TouchableOpacity
            style={[s.approveBtn, saving && s.approveBtnSaving]}
            onPress={onApprove}
            activeOpacity={0.8}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.bg} />
            ) : (
              <Text style={s.approveBtnText}>Add to plan</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.dismissBtn} onPress={onDismiss} activeOpacity={0.8}>
            <Text style={s.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function BudgetItemCard({ action }: { action: ChatAction }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  return (
    <View style={[s.actionCard, s.actionCardApproved]}>
      <Text style={s.actionCardLabel}>BUDGET UPDATED</Text>
      <Text style={s.actionCardTitle}>{d.description}</Text>
      <View style={s.actionCardStats}>
        <View style={s.actionStat}>
          <Text style={s.actionStatValue}>{'\u00a3'}{(d.monthly_amount || 0).toLocaleString()}/mo</Text>
          <Text style={s.actionStatLabel}>amount</Text>
        </View>
        <View style={s.actionStat}>
          <Text style={s.actionStatValue}>{d.is_essential ? 'Essential' : 'Lifestyle'}</Text>
          <Text style={s.actionStatLabel}>type</Text>
        </View>
        {d.category && (
          <View style={s.actionStat}>
            <Text style={s.actionStatValue}>{d.category}</Text>
            <Text style={s.actionStatLabel}>category</Text>
          </View>
        )}
      </View>
      <View style={s.approvedBanner}>
        <Text style={s.approvedBannerText}>{'\u2713'} Added to your budget</Text>
      </View>
    </View>
  );
}

function OverrideCard({ action }: { action: ChatAction }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  return (
    <View style={s.actionCard}>
      <Text style={s.actionCardLabel}>TRANSACTION UPDATED</Text>
      <Text style={s.overrideDescription}>
        {'\u201C'}{d.match_description}{'\u201D'} {'\u2192'} {d.category}
        {d.is_essential ? ' (essential)' : ' (discretionary)'}
      </Text>
      <Text style={s.overrideNote}>Will apply on your next analysis.</Text>
    </View>
  );
}

const GOAL_LABELS: Record<string, string> = {
  in_debt: 'In debt', breaking_even: 'Breaking even', saving_slowly: 'Saving slowly',
  saving_well: 'Saving well', other: 'Other',
  clear_debt: 'Clear debt', emergency_fund: 'Emergency fund', save_target: 'Savings target',
  reduce_spending: 'Reduce spending', invest: 'Start investing',
  buy_home: 'Buy a home', go_freelance: 'Go freelance', financial_freedom: 'Financial freedom',
};

function GoalUpdateCard({
  action,
  onAccept,
  onKeep,
  saving,
}: {
  action: ChatAction;
  onAccept: () => void;
  onKeep: () => void;
  saving?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  const isAccepted = action.status === 'approved';
  const isDismissed = action.status === 'dismissed';

  return (
    <View style={[s.actionCard, s.goalUpdateCard, isAccepted && s.actionCardApproved]}>
      <Text style={s.goalUpdateLabel}>GOAL CHECK-IN</Text>
      <Text style={s.goalUpdateReason}>{stripMd(d.reason)}</Text>
      <View style={s.goalUpdateFields}>
        <View style={s.goalField}>
          <Text style={s.goalFieldLabel}>Situation</Text>
          <Text style={s.goalFieldValue}>{GOAL_LABELS[d.new_situation || ''] || d.new_situation}</Text>
        </View>
        <View style={s.goalField}>
          <Text style={s.goalFieldLabel}>1-year goal</Text>
          <Text style={s.goalFieldValue}>{GOAL_LABELS[d.new_one_year_goal || ''] || d.new_one_year_goal}</Text>
        </View>
        <View style={s.goalField}>
          <Text style={s.goalFieldLabel}>2-year goal</Text>
          <Text style={s.goalFieldValue}>{GOAL_LABELS[d.new_two_year_goal || ''] || d.new_two_year_goal}</Text>
        </View>
        {d.new_target_amount != null && (
          <View style={s.goalField}>
            <Text style={s.goalFieldLabel}>Target</Text>
            <Text style={s.goalFieldValue}>{'\u00a3'}{d.new_target_amount}</Text>
          </View>
        )}
      </View>
      {isAccepted ? (
        <View style={s.approvedBanner}>
          <Text style={s.approvedBannerText}>{'\u2713'} Goals updated</Text>
        </View>
      ) : isDismissed ? (
        <View style={s.dismissedBanner}>
          <Text style={s.dismissedBannerText}>Keeping current goals</Text>
        </View>
      ) : (
        <View style={s.actionCardButtons}>
          <TouchableOpacity
            style={[s.approveBtn, saving && s.approveBtnSaving]}
            onPress={onAccept}
            activeOpacity={0.8}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.bg} />
            ) : (
              <Text style={s.approveBtnText}>Update goals</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.dismissBtn} onPress={onKeep} activeOpacity={0.8} disabled={saving}>
            <Text style={s.dismissBtnText}>Keep current</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Main Chat Component ──

export default function Chat() {
  const router = useRouter();
  const { prefill } = useLocalSearchParams<{ prefill?: string }>();
  const { isPro } = useSubscription();
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [showPaywall, setShowPaywall] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(40);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ChatContext>({});
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [goals, setGoals] = useState<Goals | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState<string | null>(null); // "msgIdx-actionIdx"
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  // ── Pre-fill input from plan page navigation ──
  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [prefill]);

  // ── Voice input via Web Speech API ──
  const voiceSupported = Platform.OS === 'web' && typeof window !== 'undefined' &&
    !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition;

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    if (Platform.OS !== 'web') return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-GB';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognitionRef.current = recognition;

    let finalTranscript = '';

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interim = transcript;
        }
      }
      setInput((prev) => {
        const base = prev.replace(/\u200B.*$/, '').trimEnd();
        const prefix = base ? base + ' ' : '';
        if (finalTranscript) return prefix + finalTranscript;
        return prefix + (interim ? '\u200B' + interim : '');
      });
    };

    recognition.onend = () => {
      setListening(false);
      // Clean up any interim markers
      setInput((prev) => prev.replace(/\u200B/g, ''));
      setTimeout(() => inputRef.current?.focus(), 100);
    };

    recognition.onerror = () => {
      setListening(false);
    };

    setListening(true);
    recognition.start();
  };

  // ── Load context + persisted messages on focus ──
  // Also subscribe to sync completions from other screens so chat stays fresh.

  useFocusEffect(
    useCallback(() => {
      loadContext();
      const unsub = onSyncComplete((result) => {
        if (!result) return;
        setAnalysis(result.analysis);
      });
      return () => unsub();
    }, []),
  );

  const loadContext = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    setUserId(user.id);

    const [analysisRes, goalsRes] = await Promise.all([
      supabase
        .from('analyses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
      supabase
        .from('goals')
        .select('*')
        .eq('user_id', user.id)
        .single(),
    ]);

    const a: Analysis | null = analysisRes.data;
    const g: Goals | null = goalsRes.data;
    setAnalysis(a);
    setGoals(g);

    // ── Build richer context ──
    const ctx: ChatContext = {
      monthly_income: a?.monthly_income,
      monthly_spending: a?.monthly_spending,
      surplus: a?.surplus,
      archetype: a?.archetype,
      decision_score: a?.decision_score,
      goals: g ? {
        current_situation: g.current_situation,
        one_year_goal: g.one_year_goal,
        two_year_goal: g.two_year_goal,
        target_amount: g.target_amount,
      } : undefined,
      top_move: a?.top_move ? { action: a.top_move.action, monthlyImpact: a.top_move.monthlyImpact } : undefined,
      all_moves: a?.all_moves?.map((m: { action: string; monthlyImpact: number; effort: string }) => ({
        action: m.action,
        monthlyImpact: m.monthlyImpact,
        effort: m.effort,
      })),
      spending_by_category: buildSpendingBreakdown(a),
      behavioral_patterns: a?.behavioral_patterns,
      goal_trajectory: a?.goal_context ? {
        goalLabel: a.goal_context.goalLabel,
        currentMonths: a.goal_context.currentMonths,
        newMonths: a.goal_context.newMonths,
        insight: a.goal_context.insight,
        confidence: a.goal_context.confidence,
        bufferRecommendation: a.goal_context.bufferRecommendation,
      } : null,
    };

    // Add recent person-to-person transfers so Claude can spot miscategorised rent/bills
    const transferItems: { description: string; amount: number; date: string }[] = [];
    for (const section of [a?.non_discretionary, a?.discretionary]) {
      if (!section?.items) continue;
      for (const item of section.items) {
        if (item.category !== 'Transfers' && item.category !== 'Other') continue;
        for (const tx of (item.transactions || []).slice(0, 10)) {
          transferItems.push({ description: tx.merchant || tx.description, amount: tx.amount, date: tx.date });
        }
      }
    }
    if (transferItems.length > 0) {
      ctx.recent_transfers = transferItems.slice(0, 15);
    }

    // Add recent transactions (last 7 days) so Claude can answer "how much did I spend today/this week?"
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const recentTxs: { description: string; amount: number; date: string; category: string; essential: boolean }[] = [];
    for (const section of [
      { data: a?.non_discretionary, essential: true },
      { data: a?.discretionary, essential: false },
    ]) {
      if (!section.data?.items) continue;
      for (const item of section.data.items) {
        for (const tx of (item.transactions || [])) {
          if (!tx.date) continue;
          const txDate = new Date(tx.date);
          if (txDate >= sevenDaysAgo) {
            recentTxs.push({
              description: tx.merchant || tx.description,
              amount: tx.amount,
              date: tx.date,
              category: item.category,
              essential: section.essential,
            });
          }
        }
      }
    }
    if (recentTxs.length > 0) {
      // Sort by date descending (most recent first) and cap at 50
      recentTxs.sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime());
      ctx.recent_transactions = recentTxs.slice(0, 50);
    }

    // Add debt account balances if available
    try {
      const { data: debtData } = await supabase
        .from('debt_accounts')
        .select('account_name, account_type, outstanding_balance, credit_limit')
        .eq('user_id', user.id);
      if (debtData && debtData.length > 0) {
        ctx.debt_accounts = debtData.map((d: any) => ({
          name: d.account_name,
          type: d.account_type,
          balance: d.outstanding_balance,
          limit: d.credit_limit,
        }));
      }
    } catch {}

    // Add subscriptions from discretionary budget if available.
    // IMPORTANT: Deduplicate by merchant name to avoid counting recurring
    // payments (e.g. £10/month Netflix x 4 months) as separate subscriptions.
    // Show only the average monthly cost per merchant.
    if (a?.discretionary?.items) {
      const subItems = a.discretionary.items.filter(
        (item: { category: string }) => item.category === 'Subscriptions' || item.category === 'Streaming',
      );
      if (subItems.length) {
        const merchantMap: Record<string, { total: number; count: number }> = {};
        for (const item of subItems) {
          for (const tx of (item.transactions || [])) {
            const key = (tx.merchant || tx.description).toLowerCase();
            if (!merchantMap[key]) merchantMap[key] = { total: 0, count: 0 };
            merchantMap[key].total += Math.abs(tx.amount);
            merchantMap[key].count += 1;
          }
        }
        ctx.subscriptions = Object.entries(merchantMap).map(([merchant, data]) => ({
          merchant,
          amount: Math.round(data.total / data.count), // avg per occurrence, not total
        }));
      }
    }

    // Add existing manual budget items so Claude knows what's been added
    try {
      const { data: adjData } = await supabase
        .from('budget_adjustments')
        .select('description, category, monthly_amount, is_essential')
        .eq('user_id', user.id);
      if (adjData && adjData.length > 0) {
        ctx.budget_adjustments = adjData.map((a: any) => ({
          description: a.description,
          category: a.category,
          amount: a.monthly_amount,
          essential: a.is_essential,
        }));
      }
    } catch {}

    // Fetch user identity for personalised context
    try {
      const { data: identityData } = await supabase
        .from('user_identity')
        .select('work_setup, household, housing, financial_experience, risk_appetite, priorities, upcoming_events, dependents')
        .eq('user_id', user.id)
        .single();
      if (identityData) {
        (ctx as any).identity = identityData;
      }
    } catch {}

    // Build payday context from sync coordinator's weeklyContext
    // This uses the same data as the home screen instead of duplicating the calculation
    try {
      // Force-sync to ensure chat always has the freshest transaction data
      const syncResult = await requestSync(user.id, true);
      if (syncResult) {
        // Update analysis with fresh sync data
        const freshA = syncResult.analysis;
        setAnalysis(freshA);

        // Rebuild context fields that depend on analysis
        ctx.monthly_income = freshA.monthly_income;
        ctx.monthly_spending = freshA.monthly_spending;
        ctx.surplus = freshA.surplus;
        ctx.archetype = freshA.archetype;
        ctx.decision_score = freshA.decision_score;
        ctx.all_moves = freshA.all_moves?.map((m: { action: string; monthlyImpact: number; effort: string }) => ({
          action: m.action,
          monthlyImpact: m.monthlyImpact,
          effort: m.effort,
        }));
        ctx.top_move = freshA.top_move ? { action: freshA.top_move.action, monthlyImpact: freshA.top_move.monthlyImpact } : undefined;
        ctx.behavioral_patterns = freshA.behavioral_patterns;
        ctx.spending_by_category = buildSpendingBreakdown(freshA);
        ctx.goal_trajectory = freshA.goal_context ? {
          goalLabel: freshA.goal_context.goalLabel,
          currentMonths: freshA.goal_context.currentMonths,
          newMonths: freshA.goal_context.newMonths,
          insight: freshA.goal_context.insight,
          confidence: freshA.goal_context.confidence,
          bufferRecommendation: freshA.goal_context.bufferRecommendation,
        } : null;

        // Rebuild recent_transactions from fresh sync data (NOT the stale DB analysis)
        const freshSevenDaysAgo = new Date();
        freshSevenDaysAgo.setDate(freshSevenDaysAgo.getDate() - 7);
        freshSevenDaysAgo.setHours(0, 0, 0, 0);
        const freshRecentTxs: { description: string; amount: number; date: string; category: string; essential: boolean }[] = [];
        for (const section of [
          { data: freshA.non_discretionary, essential: true },
          { data: freshA.discretionary, essential: false },
        ]) {
          if (!section.data?.items) continue;
          for (const item of section.data.items) {
            for (const tx of (item.transactions || [])) {
              if (!tx.date) continue;
              const txDate = new Date(tx.date);
              if (txDate >= freshSevenDaysAgo) {
                freshRecentTxs.push({
                  description: tx.merchant || tx.description,
                  amount: tx.amount,
                  date: tx.date,
                  category: item.category,
                  essential: section.essential,
                });
              }
            }
          }
        }
        if (freshRecentTxs.length > 0) {
          freshRecentTxs.sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime());
          ctx.recent_transactions = freshRecentTxs.slice(0, 50);
        }

        // Rebuild recent_transfers from fresh sync data
        const freshTransfers: { description: string; amount: number; date: string }[] = [];
        for (const section of [freshA.non_discretionary, freshA.discretionary]) {
          if (!section?.items) continue;
          for (const item of section.items) {
            if (item.category !== 'Transfers' && item.category !== 'Other') continue;
            for (const tx of (item.transactions || []).slice(0, 10)) {
              freshTransfers.push({ description: tx.merchant || tx.description, amount: tx.amount, date: tx.date });
            }
          }
        }
        if (freshTransfers.length > 0) {
          ctx.recent_transfers = freshTransfers.slice(0, 15);
        }

        // Rebuild subscriptions from fresh sync data
        if (freshA.discretionary?.items) {
          const freshSubItems = freshA.discretionary.items.filter(
            (item: { category: string }) => item.category === 'Subscriptions' || item.category === 'Streaming',
          );
          if (freshSubItems.length) {
            const freshMerchantMap: Record<string, { total: number; count: number }> = {};
            for (const item of freshSubItems) {
              for (const tx of (item.transactions || [])) {
                const key = (tx.merchant || tx.description).toLowerCase();
                if (!freshMerchantMap[key]) freshMerchantMap[key] = { total: 0, count: 0 };
                freshMerchantMap[key].total += Math.abs(tx.amount);
                freshMerchantMap[key].count += 1;
              }
            }
            ctx.subscriptions = Object.entries(freshMerchantMap).map(([merchant, data]) => ({
              merchant,
              amount: Math.round(data.total / data.count),
            }));
          }
        }

        // Use weeklyContext from sync (same source of truth as home screen)
        const wc = syncResult.weeklyContext;
        if (wc.incomeArrivedThisWeek && wc.recentIncomeEvents.length > 0) {
          ctx.payday_context = {
            incomeArrivedThisWeek: true,
            incomeEvents: wc.recentIncomeEvents.map((e) => ({
              source: e.source,
              amount: e.amount,
              date: e.date,
              frequency: e.frequency,
            })),
            committedThisWeek: wc.committedThisWeek,
            discretionaryThisWeek: wc.discretionaryThisWeek,
            adaptiveBudget: wc.adaptiveBudget,
            staticBudget: wc.staticBudget,
          };
        }
      }
    } catch {}

    setContext(ctx);

    // ── Load persisted messages ──
    const { data: chatData } = await supabase
      .from('chat_messages')
      .select('messages')
      .eq('user_id', user.id)
      .single();

    if (chatData?.messages?.length) {
      setMessages(chatData.messages);
    } else if (ctx.payday_context?.incomeArrivedThisWeek && ctx.payday_context.incomeEvents.length > 0) {
      // No existing messages + income arrived = auto-send a payday nudge
      const pc = ctx.payday_context;
      const totalIncome = pc.incomeEvents.reduce((s: number, e: any) => s + e.amount, 0);
      const nudgeMsg: ChatMessage = {
        role: 'assistant',
        content: `Payday! **\u00a3${Math.round(totalIncome).toLocaleString()}** just landed. Before you spend, let me walk you through where this needs to go. Tap below or just ask.`,
      };
      setMessages([nudgeMsg]);
    }
  };

  // ── Persist messages to Supabase ──

  const persistMessages = async (msgs: ChatMessage[]) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Keep last 50 messages to avoid bloating the row
    const toStore = msgs.slice(-50);
    await supabase
      .from('chat_messages')
      .upsert({ user_id: user.id, messages: toStore }, { onConflict: 'user_id' })
      .then(() => {});
  };

  // ── Handle plan approval (via server API) ──

  const handleApprovePlan = async (msgIndex: number, actionIndex: number) => {
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action || action.type !== 'plan_proposed') return;

    // Get fresh user ID in case state hasn't settled
    let uid = userId;
    if (!uid) {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        Alert.alert('Not signed in', 'Please sign in to save plans.');
        return;
      }
      uid = user.id;
      setUserId(uid);
    }

    const key = `${msgIndex}-${actionIndex}`;
    setSavingPlan(key);

    try {
      const planId = action.data.id;

      if (planId) {
        // Server already created the plan as 'proposed' — approve it
        const res = await fetch('/api/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', plan_id: planId, user_id: uid }),
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          // Fallback: server approve failed, try direct client-side insert
          const { error: insertErr } = await supabase.from('user_plans').upsert({
            id: planId,
            user_id: uid,
            action: action.data.action || '',
            target_amount: action.data.target_amount || null,
            monthly_saving: action.data.monthly_saving || null,
            timeline: action.data.timeline || null,
            status: 'active',
          }, { onConflict: 'id' });

          if (insertErr) {
            Alert.alert('Could not save plan', insertErr.message);
            setSavingPlan(null);
            return;
          }
        }
      } else {
        // No server-side plan ID — insert directly from client
        const { error: insertErr } = await supabase.from('user_plans').insert({
          user_id: uid,
          action: action.data.action || '',
          target_amount: action.data.target_amount || null,
          monthly_saving: action.data.monthly_saving || null,
          timeline: action.data.timeline || null,
          status: 'active',
        });

        if (insertErr) {
          Alert.alert('Could not save plan', insertErr.message);
          setSavingPlan(null);
          return;
        }
      }

      // Update action status in chat messages
      const updated = [...messages];
      const updatedActions = [...(updated[msgIndex].actions || [])];
      updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'approved' };
      updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
      setMessages(updated);
      persistMessages(updated);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Something went wrong.');
    }

    setSavingPlan(null);
  };

  // ── Handle plan dismissal (via server API) ──

  const handleDismissPlan = async (msgIndex: number, actionIndex: number) => {
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action) return;

    const planId = action.data.id;
    let uid = userId;
    if (!uid) {
      const { data: { user } } = await supabase.auth.getUser();
      uid = user?.id || null;
    }

    // Dismiss server-side if we have a plan ID
    if (planId && uid) {
      try {
        await fetch('/api/plans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'dismiss', plan_id: planId, user_id: uid }),
        });
      } catch {
        // Non-critical — still update UI
      }
    }

    const updated = [...messages];
    const updatedActions = [...(updated[msgIndex].actions || [])];
    updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'dismissed' };
    updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
    setMessages(updated);
    persistMessages(updated);
  };

  // ── Handle goal update acceptance ──

  const handleAcceptGoalUpdate = async (msgIndex: number, actionIndex: number) => {
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action || action.type !== 'goal_update_proposed') return;

    let uid = userId;
    if (!uid) {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        Alert.alert('Not signed in', 'Please sign in to update goals.');
        return;
      }
      uid = user.id;
      setUserId(uid);
    }

    const key = `${msgIndex}-${actionIndex}`;
    setSavingPlan(key);

    try {
      const res = await fetch('/api/goals/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: uid,
          current_situation: action.data.new_situation,
          one_year_goal: action.data.new_one_year_goal,
          two_year_goal: action.data.new_two_year_goal,
          target_amount: action.data.new_target_amount || null,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        Alert.alert('Could not update goals', data.error || 'Unknown error');
        setSavingPlan(null);
        return;
      }

      // Update local goals state so chat context reflects the change
      setGoals({
        current_situation: action.data.new_situation || '',
        one_year_goal: action.data.new_one_year_goal || '',
        two_year_goal: action.data.new_two_year_goal || '',
        target_amount: action.data.new_target_amount || undefined,
      } as Goals);

      const updated = [...messages];
      const updatedActions = [...(updated[msgIndex].actions || [])];
      updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'approved' };
      updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
      setMessages(updated);
      persistMessages(updated);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Something went wrong.');
    }

    setSavingPlan(null);
  };

  const handleKeepGoals = (msgIndex: number, actionIndex: number) => {
    const updated = [...messages];
    const updatedActions = [...(updated[msgIndex].actions || [])];
    updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'dismissed' };
    updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
    setMessages(updated);
    persistMessages(updated);
  };

  // ── Send message (with streaming + fallback) ──

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;

    // Gate free users after they've used their teaser messages
    if (!isPro && messages.filter((m) => m.role === 'user').length >= FREE_MESSAGE_LIMIT) {
      setShowPaywall(true);
      return;
    }

    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setInputHeight(40);
    setLoading(true);
    setError(null);

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      // ── Try streaming first ──
      const streamSuccess = await tryStream(newMessages);
      if (!streamSuccess) {
        // ── Fall back to standard request ──
        await standardRequest(newMessages);
      }
    } catch {
      setError('Connection error. Please check your internet and try again.');
      const errorMsg: ChatMessage = { role: 'assistant', content: 'Sorry, something went wrong.' };
      setMessages([...newMessages, errorMsg]);
    }

    setLoading(false);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  };

  const tryStream = async (newMessages: ChatMessage[]): Promise<boolean> => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, context, stream: true, user_id: userId }),
      });

      if (!res.ok || !res.body) return false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      const collectedActions: ChatAction[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;

          try {
            const event = JSON.parse(raw);
            if (event.error) {
              setError(event.error);
              return false;
            }
            if (event.t) {
              fullText += event.t;
              const streamMsg: ChatMessage = { role: 'assistant', content: fullText };
              setMessages([...newMessages, streamMsg]);
              scrollRef.current?.scrollToEnd({ animated: false });
            }
            // Collect action events from tool execution
            if (event.action) {
              collectedActions.push({
                type: event.action.type,
                data: event.action.data,
                status: (event.action.type === 'goal_update_proposed' || event.action.type === 'plan_proposed') ? 'pending' : undefined,
              });
            }
          } catch {
            // Skip malformed SSE
          }
        }
      }

      if (fullText || collectedActions.length > 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: fullText || '',
          actions: collectedActions.length > 0 ? collectedActions : undefined,
        };
        const final: ChatMessage[] = [...newMessages, assistantMsg];
        setMessages(final);
        persistMessages(final);
        return true;
      }

      return false;
    } catch {
      // Streaming not supported (e.g. React Native on device) — fall back
      return false;
    }
  };

  const standardRequest = async (newMessages: ChatMessage[]) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: newMessages, context, user_id: userId }),
    });
    const data = await res.json();

    if (data.success && data.text) {
      // Convert API actions to ChatActions
      const chatActions: ChatAction[] | undefined = data.actions?.length
        ? data.actions.map((a: { type: string; data: ChatAction['data'] }) => ({
            type: a.type,
            data: a.data,
            status: (a.type === 'goal_update_proposed' || a.type === 'plan_proposed') ? 'pending' : undefined,
          }))
        : undefined;

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: data.text,
        actions: chatActions,
      };
      const final: ChatMessage[] = [...newMessages, assistantMsg];
      setMessages(final);
      persistMessages(final);
    } else {
      setError(data.error || 'Failed to get response');
      const errorMsg: ChatMessage = { role: 'assistant', content: 'Sorry, I couldn\'t process that. Please try again.' };
      setMessages([...newMessages, errorMsg]);
    }
  };

  // ── Retry last failed message ──

  const retryLastMessage = () => {
    setError(null);
    // Remove the failed assistant message, re-send the last user message
    const withoutLastAssistant = messages.slice(0, -1);
    const lastUserMsg = withoutLastAssistant[withoutLastAssistant.length - 1];
    if (lastUserMsg?.role === 'user') {
      setMessages(withoutLastAssistant.slice(0, -1));
      sendMessage(lastUserMsg.content);
    }
  };

  // ── Clear conversation ──

  const clearChat = async () => {
    setMessages([]);
    setError(null);
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from('chat_messages').delete().eq('user_id', user.id);
    }
  };

  const paydayActive = !!context.payday_context?.incomeArrivedThisWeek;
  const suggestedQuestions = getContextualQuestions(analysis, goals, paydayActive);

  // ── Free tier: count user messages for gate ──
  const userMessageCount = messages.filter((m) => m.role === 'user').length;
  const freeGateReached = !isPro && userMessageCount >= FREE_MESSAGE_LIMIT;
  const freeMessagesRemaining = isPro ? Infinity : Math.max(0, FREE_MESSAGE_LIMIT - userMessageCount);

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* ── Header ── */}
      {messages.length > 0 && (
        <View style={s.header}>
          <View style={s.headerLeftChat}>
            <View style={s.chatBocyWrap}>
              <BocyFace mood={getBocyMood(analysis)} size="sm" breathing />
            </View>
            <Text style={s.headerTitle}>Bocy</Text>
            {loading && <ActivityIndicator size="small" color={colors.dim} style={{ marginLeft: 6 }} />}
          </View>
          <TouchableOpacity onPress={clearChat} style={s.clearButton} activeOpacity={0.7}>
            <Text style={s.clearText}>New chat</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Messages ── */}
      <ScrollView
        ref={scrollRef}
        style={s.messages}
        contentContainerStyle={s.messagesContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Show suggestions when empty OR when only the payday auto-nudge is present */}
        {(messages.length === 0 || (messages.length === 1 && messages[0].role === 'assistant' && paydayActive)) && (
          <View style={s.suggestedContainer}>
            {messages.length === 0 && (
              <>
                <View style={s.chatBocyHero}>
                  <BocyFace mood={getBocyMood(analysis)} size="lg" breathing />
                </View>
                <Text style={s.suggestedTitle}>{paydayActive ? 'Payday check-in' : 'Ask Bocy'}</Text>
                <Text style={s.suggestedSubtitle}>{paydayActive ? 'Let\u2019s make your money work' : 'Your personal finance companion'}</Text>
              </>
            )}
            <View style={s.suggestedGrid}>
              {suggestedQuestions.map((q, i) => (
                <TouchableOpacity
                  key={i}
                  style={s.suggestedButton}
                  onPress={() => sendMessage(q)}
                  activeOpacity={0.7}
                >
                  <Text style={s.suggestedText}>{q}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {messages.map((msg, i) => (
          <View key={i}>
            <View
              style={[
                s.bubble,
                msg.role === 'user' ? s.userBubble : s.assistantBubble,
              ]}
            >
              {msg.role === 'user' ? (
                <Text style={[s.bubbleText, s.userText]}>{msg.content}</Text>
              ) : (
                <Markdown>{msg.content}</Markdown>
              )}
            </View>

            {/* Render action cards below assistant messages */}
            {msg.actions?.map((action, j) => (
              <View key={`action-${i}-${j}`} style={s.actionCardWrapper}>
                {action.type === 'plan_proposed' ? (
                  <PlanCard
                    action={action}
                    onApprove={() => handleApprovePlan(i, j)}
                    onDismiss={() => handleDismissPlan(i, j)}
                    saving={savingPlan === `${i}-${j}`}
                  />
                ) : action.type === 'plan_error' ? (
                  <View style={s.errorCard}>
                    <Text style={s.errorCardText}>{action.data.error || 'Plan could not be saved.'}</Text>
                  </View>
                ) : action.type === 'override_saved' ? (
                  <OverrideCard action={action} />
                ) : action.type === 'budget_item_saved' ? (
                  <BudgetItemCard action={action} />
                ) : action.type === 'goal_update_proposed' ? (
                  <GoalUpdateCard
                    action={action}
                    onAccept={() => handleAcceptGoalUpdate(i, j)}
                    onKeep={() => handleKeepGoals(i, j)}
                    saving={savingPlan === `${i}-${j}`}
                  />
                ) : null}
              </View>
            ))}
          </View>
        ))}

        {loading && <TypingIndicator />}

        {error && (
          <TouchableOpacity style={s.retryBanner} onPress={retryLastMessage}>
            <Text style={s.retryText}>{error}</Text>
            <Text style={s.retryAction}>Tap to retry</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* ── Input / Gate ── */}
      <Paywall visible={showPaywall} onClose={() => setShowPaywall(false)} feature="chat" />
      {freeGateReached ? (
        <View style={s.gateRow}>
          <Text style={s.gateText}>You've used your {FREE_MESSAGE_LIMIT} free messages</Text>
          <TouchableOpacity
            style={s.gateBtn}
            onPress={() => setShowPaywall(true)}
            activeOpacity={0.8}
          >
            <Text style={s.gateBtnText}>Unlock unlimited chat</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {!isPro && userMessageCount > 0 && (
            <View style={s.freeBadgeRow}>
              <Text style={s.freeBadgeText}>
                {freeMessagesRemaining} of {FREE_MESSAGE_LIMIT} free {freeMessagesRemaining === 1 ? 'message' : 'messages'} left
              </Text>
            </View>
          )}
          <View style={[s.inputRow, !isPro && userMessageCount > 0 && { borderTopWidth: 0 }]}>
            <TextInput
              ref={inputRef}
              style={[s.input, { height: Math.max(40, Math.min(inputHeight, 160)) }]}
              placeholder={listening ? 'Listening...' : 'Ask about your finances...'}
              placeholderTextColor={listening ? colors.green : colors.muted}
              value={input}
              onChangeText={setInput}
              onContentSizeChange={(e) => setInputHeight(e.nativeEvent.contentSize.height)}
              onSubmitEditing={() => sendMessage(input)}
              returnKeyType="send"
              multiline
              maxLength={1000}
              blurOnSubmit
            />
            {voiceSupported && (
              <TouchableOpacity
                style={[s.voiceButton, listening && s.voiceButtonActive]}
                onPress={toggleVoice}
                activeOpacity={0.7}
              >
                <Text style={[s.voiceIcon, listening && s.voiceIconActive]}>
                  {listening ? '\u23F9' : '\u{1F3A4}'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[s.sendButton, (!input.trim() || loading) && s.sendDisabled]}
              onPress={() => sendMessage(input)}
              disabled={!input.trim() || loading}
            >
              <Text style={s.sendText}>{'\u2191'}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

// ── Helpers ──

function buildSpendingBreakdown(a: Analysis | null): { category: string; monthly: number }[] | undefined {
  if (!a) return undefined;
  const items: { category: string; monthly: number }[] = [];

  const sections = [a.non_discretionary, a.discretionary];
  for (const section of sections) {
    if (!section?.items) continue;
    for (const item of section.items) {
      items.push({ category: item.category, monthly: item.monthly });
    }
  }

  if (!items.length) return undefined;
  // Sort by spend descending
  items.sort((a, b) => b.monthly - a.monthly);
  return items;
}

// ── Styles ──

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xxl + spacing.sm,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  headerLeftChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chatBocyWrap: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBocyHero: {
    marginBottom: spacing.md,
  },
  headerTitle: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: c.text,
  },
  clearButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 100,
    backgroundColor: c.accentDim,
  },
  clearText: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: c.text2,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    padding: spacing.md,
    paddingTop: spacing.xxl + spacing.md,
    paddingBottom: spacing.sm,
  },
  suggestedContainer: {
    marginTop: spacing.xl,
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
  },
  suggestedTitle: {
    fontFamily: fonts.heading,
    fontSize: 22,
    color: c.text,
  },
  suggestedSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
    marginBottom: spacing.lg,
    marginTop: 6,
  },
  suggestedGrid: {
    width: '100%',
    gap: spacing.sm,
  },
  suggestedButton: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
  },
  suggestedText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.text2,
    textAlign: 'center',
  },
  bubble: {
    maxWidth: '82%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    marginBottom: 6,
  },
  userBubble: {
    backgroundColor: c.accent,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: c.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 21,
  },
  userText: {
    color: c.bg,
  },
  // ── Animated typing dots ──
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: c.dim,
  },
  // ── Action cards ──
  actionCardWrapper: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
    marginBottom: 6,
  },
  errorCard: {
    backgroundColor: c.coralDim,
    borderWidth: 1,
    borderColor: c.coral,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorCardText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.coral,
    lineHeight: 20,
  },
  actionCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.accentDim,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  actionCardApproved: {
    borderColor: c.accent,
  },
  actionCardLabel: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1,
    color: c.accent,
    marginBottom: spacing.xs,
  },
  actionCardTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.text,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  actionCardStats: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  actionStat: {
    alignItems: 'center',
  },
  actionStatValue: {
    fontFamily: fonts.mono,
    fontSize: 14,
    color: c.accent,
  },
  actionStatLabel: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.dim,
    marginTop: 2,
  },
  actionCardButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  approveBtn: {
    flex: 1,
    backgroundColor: c.accent,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  approveBtnSaving: {
    opacity: 0.7,
  },
  approveBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.bg,
  },
  dismissBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  dismissBtnText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.dim,
  },
  approvedBanner: {
    backgroundColor: c.accentDim,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  approvedBannerText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.accent,
  },
  dismissedBanner: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  dismissedBannerText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.muted,
  },
  viewPlanBanner: {
    backgroundColor: c.accentDim,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  viewPlanBannerText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.accent,
  },
  dismissLink: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  dismissLinkText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.muted,
  },
  overrideDescription: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.text2,
    lineHeight: 22,
  },
  overrideNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
    marginTop: spacing.xs,
  },
  // ── Goal update card ──
  goalUpdateCard: {
    borderColor: c.skyDim,
  },
  goalUpdateLabel: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1,
    color: c.sky,
    marginBottom: spacing.xs,
  },
  goalUpdateReason: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.text,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  goalUpdateFields: {
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  goalField: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  goalFieldLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.dim,
  },
  goalFieldValue: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.sky,
  },
  // ── Retry banner ──
  retryBanner: {
    backgroundColor: c.coralDim,
    borderRadius: radius.md,
    padding: 12,
    marginTop: 4,
    alignItems: 'center',
  },
  retryText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.coral,
    textAlign: 'center',
  },
  retryAction: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.coral,
    marginTop: spacing.xs,
  },
  // ── Input row ──
  inputRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    backgroundColor: c.bg,
    gap: 8,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 22,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    color: c.text,
  },
  voiceButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceButtonActive: {
    borderColor: c.green,
    backgroundColor: c.greenDim,
  },
  voiceIcon: {
    fontSize: 16,
  },
  voiceIconActive: {
    color: c.green,
  },
  sendButton: {
    backgroundColor: c.accent,
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendDisabled: {
    opacity: 0.3,
  },
  sendText: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: c.bg,
  },

  // ── Free tier gate (replaces input after limit reached) ──
  gateRow: {
    padding: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    backgroundColor: c.bg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  gateText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.dim,
  },
  gateBtn: {
    backgroundColor: c.accent,
    borderRadius: 100,
    paddingVertical: 14,
    paddingHorizontal: spacing.xl + spacing.md,
  },
  gateBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.bg,
  },
  // ── Free message counter badge ──
  freeBadgeRow: {
    alignItems: 'center',
    paddingTop: spacing.xs,
    paddingBottom: 2,
    backgroundColor: c.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  freeBadgeText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.muted,
    letterSpacing: 0.3,
  },
});
