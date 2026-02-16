import { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, Animated, Easing,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import Markdown from '@/lib/markdown';
import type { ChatMessage, ChatContext, Analysis, Goals } from '@/lib/types';

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

// ── Main Chat Component ──

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ChatContext>({});
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [goals, setGoals] = useState<Goals | null>(null);
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

    // Add subscriptions from discretionary budget if available
    if (a?.discretionary?.items) {
      const subItems = a.discretionary.items.filter(
        (item: { category: string }) => item.category === 'Subscriptions' || item.category === 'Streaming',
      );
      if (subItems.length) {
        ctx.subscriptions = [];
        for (const item of subItems) {
          for (const tx of (item.transactions || [])) {
            ctx.subscriptions.push({ merchant: tx.merchant, amount: tx.amount });
          }
        }
      }
    }

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

  // ── Send message (with streaming + fallback) ──

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
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
        body: JSON.stringify({ messages: newMessages, context, stream: true }),
      });

      if (!res.ok || !res.body) return false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

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
          } catch {
            // Skip malformed SSE
          }
        }
      }

      if (fullText) {
        const assistantMsg: ChatMessage = { role: 'assistant', content: fullText };
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
      body: JSON.stringify({ messages: newMessages, context }),
    });
    const data = await res.json();

    if (data.success && data.text) {
      const assistantMsg: ChatMessage = { role: 'assistant', content: data.text };
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
            <Text style={styles.suggestedSubtitle}>Your AI financial advisor</Text>
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
          <View
            key={i}
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
          style={styles.input}
          placeholder="Ask about your finances..."
          placeholderTextColor={colors.muted}
          value={input}
          onChangeText={setInput}
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
    maxHeight: 100,
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
