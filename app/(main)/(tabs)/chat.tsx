import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, Animated, Easing, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import Markdown from '@/lib/markdown';
import type { ChatMessage, ChatContext, ChatAction, Analysis, Goals } from '@/lib/types';

/** Strip markdown bold/italic markers from text that will be rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

// ── Suggested questions (contextual) ──

function getContextualQuestions(analysis: Analysis | null, goals: Goals | null): string[] {
  if (!analysis) {
    return [
      'What can Bocy help me with?',
      'How does the financial analysis work?',
    ];
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
    <View style={[styles.bubble, styles.assistantBubble]}>
      <View style={styles.dotsRow}>
        {dots.map((dot, i) => (
          <Animated.View
            key={i}
            style={[
              styles.dot,
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
  onDismiss,
  onViewPlan,
}: {
  action: ChatAction;
  onDismiss: () => void;
  onViewPlan: () => void;
}) {
  const d = action.data;
  const isDismissed = action.status === 'dismissed';

  return (
    <View style={[styles.actionCard, styles.actionCardApproved]}>
      <Text style={styles.actionCardLabel}>PLAN CREATED</Text>
      <Text style={styles.actionCardTitle}>{stripMd(d.action)}</Text>
      <View style={styles.actionCardStats}>
        {d.target_amount != null && (
          <View style={styles.actionStat}>
            <Text style={styles.actionStatValue}>{'\u00a3'}{d.target_amount.toLocaleString()}</Text>
            <Text style={styles.actionStatLabel}>target</Text>
          </View>
        )}
        {d.monthly_saving != null && (
          <View style={styles.actionStat}>
            <Text style={styles.actionStatValue}>{'\u00a3'}{d.monthly_saving.toLocaleString()}/mo</Text>
            <Text style={styles.actionStatLabel}>saving</Text>
          </View>
        )}
        {d.timeline && (
          <View style={styles.actionStat}>
            <Text style={styles.actionStatValue}>{d.timeline}</Text>
            <Text style={styles.actionStatLabel}>timeline</Text>
          </View>
        )}
      </View>
      {isDismissed ? (
        <View style={styles.dismissedBanner}>
          <Text style={styles.dismissedBannerText}>Removed from plan</Text>
        </View>
      ) : (
        <>
          <TouchableOpacity style={styles.viewPlanBanner} onPress={onViewPlan} activeOpacity={0.7}>
            <Text style={styles.viewPlanBannerText}>{'\u2713'} Added to your plan — tap to view {'>'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.dismissLink} onPress={onDismiss} activeOpacity={0.7}>
            <Text style={styles.dismissLinkText}>Remove from plan</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

function BudgetItemCard({ action }: { action: ChatAction }) {
  const d = action.data;
  return (
    <View style={[styles.actionCard, styles.actionCardApproved]}>
      <Text style={styles.actionCardLabel}>BUDGET UPDATED</Text>
      <Text style={styles.actionCardTitle}>{d.description}</Text>
      <View style={styles.actionCardStats}>
        <View style={styles.actionStat}>
          <Text style={styles.actionStatValue}>{'\u00a3'}{(d.monthly_amount || 0).toLocaleString()}/mo</Text>
          <Text style={styles.actionStatLabel}>amount</Text>
        </View>
        <View style={styles.actionStat}>
          <Text style={styles.actionStatValue}>{d.is_essential ? 'Essential' : 'Lifestyle'}</Text>
          <Text style={styles.actionStatLabel}>type</Text>
        </View>
        {d.category && (
          <View style={styles.actionStat}>
            <Text style={styles.actionStatValue}>{d.category}</Text>
            <Text style={styles.actionStatLabel}>category</Text>
          </View>
        )}
      </View>
      <View style={styles.approvedBanner}>
        <Text style={styles.approvedBannerText}>{'\u2713'} Added to your budget</Text>
      </View>
    </View>
  );
}

function OverrideCard({ action }: { action: ChatAction }) {
  const d = action.data;
  return (
    <View style={styles.actionCard}>
      <Text style={styles.actionCardLabel}>TRANSACTION UPDATED</Text>
      <Text style={styles.overrideDescription}>
        {'\u201C'}{d.match_description}{'\u201D'} {'\u2192'} {d.category}
        {d.is_essential ? ' (essential)' : ' (discretionary)'}
      </Text>
      <Text style={styles.overrideNote}>Will apply on your next analysis.</Text>
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
  const d = action.data;
  const isAccepted = action.status === 'approved';
  const isDismissed = action.status === 'dismissed';

  return (
    <View style={[styles.actionCard, styles.goalUpdateCard, isAccepted && styles.actionCardApproved]}>
      <Text style={styles.goalUpdateLabel}>GOAL CHECK-IN</Text>
      <Text style={styles.goalUpdateReason}>{stripMd(d.reason)}</Text>
      <View style={styles.goalUpdateFields}>
        <View style={styles.goalField}>
          <Text style={styles.goalFieldLabel}>Situation</Text>
          <Text style={styles.goalFieldValue}>{GOAL_LABELS[d.new_situation || ''] || d.new_situation}</Text>
        </View>
        <View style={styles.goalField}>
          <Text style={styles.goalFieldLabel}>1-year goal</Text>
          <Text style={styles.goalFieldValue}>{GOAL_LABELS[d.new_one_year_goal || ''] || d.new_one_year_goal}</Text>
        </View>
        <View style={styles.goalField}>
          <Text style={styles.goalFieldLabel}>2-year goal</Text>
          <Text style={styles.goalFieldValue}>{GOAL_LABELS[d.new_two_year_goal || ''] || d.new_two_year_goal}</Text>
        </View>
        {d.new_target_amount != null && (
          <View style={styles.goalField}>
            <Text style={styles.goalFieldLabel}>Target</Text>
            <Text style={styles.goalFieldValue}>{'\u00a3'}{d.new_target_amount}</Text>
          </View>
        )}
      </View>
      {isAccepted ? (
        <View style={styles.approvedBanner}>
          <Text style={styles.approvedBannerText}>{'\u2713'} Goals updated</Text>
        </View>
      ) : isDismissed ? (
        <View style={styles.dismissedBanner}>
          <Text style={styles.dismissedBannerText}>Keeping current goals</Text>
        </View>
      ) : (
        <View style={styles.actionCardButtons}>
          <TouchableOpacity
            style={[styles.approveBtn, saving && styles.approveBtnSaving]}
            onPress={onAccept}
            activeOpacity={0.8}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.bg} />
            ) : (
              <Text style={styles.approveBtnText}>Update goals</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.dismissBtn} onPress={onKeep} activeOpacity={0.8} disabled={saving}>
            <Text style={styles.dismissBtnText}>Keep current</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Main Chat Component ──

export default function Chat() {
  const router = useRouter();
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

  // ── Load context + persisted messages on focus ──

  useFocusEffect(
    useCallback(() => {
      loadContext();
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

    // Fetch user identity for personalised advice
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

    setContext(ctx);

    // ── Load persisted messages ──
    const { data: chatData } = await supabase
      .from('chat_messages')
      .select('messages')
      .eq('user_id', user.id)
      .single();

    if (chatData?.messages?.length) {
      setMessages(chatData.messages);
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

    const planId = action.data.id;
    if (!planId) {
      Alert.alert('Error', 'No plan ID — this plan may have been created before the fix. Ask Bocy to suggest it again.');
      return;
    }

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
      const res = await fetch('/api/plans/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan_id: planId, user_id: uid }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        Alert.alert('Could not save plan', data.error || 'Unknown error');
        setSavingPlan(null);
        return;
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
        await fetch('/api/plans/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_id: planId, user_id: uid }),
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
                status: event.action.type === 'goal_update_proposed' ? 'pending' : undefined,
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
            status: a.type === 'goal_update_proposed' ? 'pending' : undefined,
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

  const suggestedQuestions = getContextualQuestions(analysis, goals);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      {/* ── Header ── */}
      {messages.length > 0 && (
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Bocy</Text>
          <TouchableOpacity onPress={clearChat} style={styles.clearButton}>
            <Text style={styles.clearText}>New chat</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Messages ── */}
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 && (
          <View style={styles.suggestedContainer}>
            <Text style={styles.suggestedTitle}>Ask Bocy</Text>
            <Text style={styles.suggestedSubtitle}>Your financial decisions platform</Text>
            {suggestedQuestions.map((q, i) => (
              <TouchableOpacity
                key={i}
                style={styles.suggestedButton}
                onPress={() => sendMessage(q)}
              >
                <Text style={styles.suggestedText}>{q}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {messages.map((msg, i) => (
          <View key={i}>
            <View
              style={[
                styles.bubble,
                msg.role === 'user' ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              {msg.role === 'user' ? (
                <Text style={[styles.bubbleText, styles.userText]}>{msg.content}</Text>
              ) : (
                <Markdown>{msg.content}</Markdown>
              )}
            </View>

            {/* Render action cards below assistant messages */}
            {msg.actions?.map((action, j) => (
              <View key={`action-${i}-${j}`} style={styles.actionCardWrapper}>
                {action.type === 'plan_proposed' ? (
                  <PlanCard
                    action={action}
                    onDismiss={() => handleDismissPlan(i, j)}
                    onViewPlan={() => router.push('/(main)/(tabs)/plan')}
                  />
                ) : action.type === 'plan_error' ? (
                  <View style={styles.errorCard}>
                    <Text style={styles.errorCardText}>{action.data.error || 'Plan could not be saved.'}</Text>
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
          <TouchableOpacity style={styles.retryBanner} onPress={retryLastMessage}>
            <Text style={styles.retryText}>{error}</Text>
            <Text style={styles.retryAction}>Tap to retry</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* ── Input ── */}
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          style={[styles.input, { height: Math.max(40, Math.min(inputHeight, 160)) }]}
          placeholder="Ask about your finances..."
          placeholderTextColor={colors.muted}
          value={input}
          onChangeText={setInput}
          onContentSizeChange={(e) => setInputHeight(e.nativeEvent.contentSize.height)}
          onSubmitEditing={() => sendMessage(input)}
          returnKeyType="send"
          multiline
          maxLength={1000}
          blurOnSubmit
        />
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || loading) && styles.sendDisabled]}
          onPress={() => sendMessage(input)}
          disabled={!input.trim() || loading}
        >
          <Text style={styles.sendText}>{'\u2191'}</Text>
        </TouchableOpacity>
      </View>
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xxl + spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.text,
  },
  clearButton: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  clearText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.accent,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    padding: spacing.md,
    paddingTop: spacing.xxl + spacing.lg,
    paddingBottom: spacing.md,
  },
  suggestedContainer: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
  suggestedTitle: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.text,
  },
  suggestedSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginBottom: spacing.lg,
    marginTop: spacing.xs,
  },
  suggestedButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    width: '100%',
  },
  suggestedText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text2,
    textAlign: 'center',
  },
  bubble: {
    maxWidth: '80%',
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
  },
  userBubble: {
    backgroundColor: colors.accent,
    alignSelf: 'flex-end',
    borderBottomRightRadius: radius.sm,
  },
  assistantBubble: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: radius.sm,
  },
  bubbleText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
  },
  userText: {
    color: colors.bg,
  },
  // ── Animated typing dots ──
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  // ── Action cards ──
  actionCardWrapper: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
    marginBottom: spacing.sm,
  },
  errorCard: {
    backgroundColor: 'rgba(255,100,100,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,100,100,0.2)',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorCardText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.coral,
    lineHeight: 20,
  },
  actionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.accentDim,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  actionCardApproved: {
    borderColor: colors.accent,
  },
  actionCardLabel: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1,
    color: colors.accent,
    marginBottom: spacing.xs,
  },
  actionCardTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
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
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.accent,
  },
  actionStatLabel: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.dim,
    marginTop: 2,
  },
  actionCardButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  approveBtn: {
    flex: 1,
    backgroundColor: colors.accent,
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
    color: colors.bg,
  },
  dismissBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  dismissBtnText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.dim,
  },
  approvedBanner: {
    backgroundColor: colors.accentDim,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  approvedBannerText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
  },
  dismissedBanner: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  dismissedBannerText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.muted,
  },
  viewPlanBanner: {
    backgroundColor: colors.accentDim,
    borderRadius: radius.sm,
    paddingVertical: 10,
    alignItems: 'center',
  },
  viewPlanBannerText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.accent,
  },
  dismissLink: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  dismissLinkText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.muted,
  },
  overrideDescription: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text2,
    lineHeight: 22,
  },
  overrideNote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
    marginTop: spacing.xs,
  },
  // ── Goal update card ──
  goalUpdateCard: {
    borderColor: colors.skyDim,
  },
  goalUpdateLabel: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 1,
    color: colors.sky,
    marginBottom: spacing.xs,
  },
  goalUpdateReason: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
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
    borderBottomColor: colors.border,
  },
  goalFieldLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.dim,
  },
  goalFieldValue: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.sky,
  },
  // ── Retry banner ──
  retryBanner: {
    backgroundColor: colors.coralDim,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.xs,
    alignItems: 'center',
  },
  retryText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.coral,
    textAlign: 'center',
  },
  retryAction: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.coral,
    marginTop: spacing.xs,
  },
  // ── Input row ──
  inputRow: {
    flexDirection: 'row',
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    color: colors.text,
  },
  sendButton: {
    backgroundColor: colors.accent,
    width: 44,
    height: 44,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendText: {
    fontFamily: fonts.semibold,
    fontSize: 20,
    color: colors.bg,
  },
});
