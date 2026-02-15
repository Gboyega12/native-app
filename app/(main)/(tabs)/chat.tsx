import { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fonts, spacing, radius } from '@/theme';
import type { ChatMessage, ChatContext, Analysis, Goals } from '@/lib/types';

const SUGGESTED_QUESTIONS = [
  'How can I save more?',
  'Am I spending too much on food?',
  'What should I prioritise first?',
  'How do I build an emergency fund?',
];

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState<ChatContext>({});
  const scrollRef = useRef<ScrollView>(null);

  useFocusEffect(
    useCallback(() => {
      loadContext();
    }, [])
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

    setContext({
      monthly_income: a?.monthly_income,
      monthly_spending: a?.monthly_spending,
      surplus: a?.surplus,
      archetype: a?.archetype,
      goals: g ? {
        current_situation: g.current_situation,
        one_year_goal: g.one_year_goal,
        two_year_goal: g.two_year_goal,
      } : undefined,
      top_move: a?.top_move ? { action: a.top_move.action } : undefined,
    });
  };

  const sendMessage = async (text: string) => {
    if (!text.trim() || loading) return;

    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          context,
        }),
      });
      const data = await res.json();
      if (data.success && data.text) {
        setMessages([...newMessages, { role: 'assistant', content: data.text }]);
      } else {
        setMessages([...newMessages, { role: 'assistant', content: 'Sorry, I couldn\'t process that. Please try again.' }]);
      }
    } catch {
      setMessages([...newMessages, { role: 'assistant', content: 'Connection error. Please check your internet and try again.' }]);
    }

    setLoading(false);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.messages}
        contentContainerStyle={styles.messagesContent}
      >
        {messages.length === 0 && (
          <View style={styles.suggestedContainer}>
            <Text style={styles.suggestedTitle}>Ask Bocy anything</Text>
            {SUGGESTED_QUESTIONS.map((q, i) => (
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
            <Text
              style={[
                styles.bubbleText,
                msg.role === 'user' ? styles.userText : styles.assistantText,
              ]}
            >
              {msg.content}
            </Text>
          </View>
        ))}

        {loading && (
          <View style={[styles.bubble, styles.assistantBubble]}>
            <Text style={styles.thinkingText}>Thinking...</Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Ask about your finances..."
          placeholderTextColor={colors.muted}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => sendMessage(input)}
          returnKeyType="send"
          multiline={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || loading) && styles.sendDisabled]}
          onPress={() => sendMessage(input)}
          disabled={!input.trim() || loading}
        >
          <Text style={styles.sendText}>&gt;</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
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
    fontFamily: fonts.mono,
    fontSize: 16,
    color: colors.text,
    marginBottom: spacing.lg,
  },
  suggestedButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    width: '100%',
  },
  suggestedText: {
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
    fontSize: 14,
    lineHeight: 22,
  },
  userText: {
    color: colors.bg,
  },
  assistantText: {
    color: colors.text2,
  },
  thinkingText: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.dim,
    fontStyle: 'italic',
  },
  inputRow: {
    flexDirection: 'row',
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
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
    fontFamily: fonts.mono,
    fontSize: 18,
    color: colors.bg,
    fontWeight: '700',
  },
});
