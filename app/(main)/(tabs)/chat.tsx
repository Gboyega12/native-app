import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, StyleSheet, ScrollView,
  KeyboardAvoidingView, Animated, Easing, ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import { requestSync, onSyncComplete, invalidateSyncCache } from '@/lib/sync-coordinator';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { useResponsive } from '@/lib/responsive';
import Markdown from '@/lib/markdown';
import { BocyFace, getBocyMood, type BocyMood } from '@/components/Bocy';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import Card from '@/components/Card';
import type { ChatMessage, ChatContext, ChatAction, Analysis, Goals, FinancialProfile, UserIdentity } from '@/lib/types';
import { solveBudgetAllocation } from '@/lib/budget-solver';
import { simulateHouseholdCashflow, estimateVolatility } from '@/lib/monte-carlo';
import { useVoiceConversation, type VoiceState } from '@/lib/use-voice-conversation';
import { trackEvent, trackScreen } from '@/lib/mixpanel';

/** Strip markdown bold/italic markers from text that will be rendered with plain <Text> */
const stripMd = (s?: string | null) => (s || '').replace(/\*\*/g, '');

/** Fingerprint for a payday context — changes each pay event so dismissal resets next payday */
const paydayFingerprint = (pc: any): string => {
  const events = (pc?.incomeEvents || []).map((e: any) => `${e.source}:${e.amount}:${e.date}`).join('|');
  return events || 'payday';
};


/** Word-count threshold — messages longer than this get split into chunks */
const CHUNK_WORD_THRESHOLD = 12;
/** Hard cap on chat bubbles per assistant message — keeps replies conversational */
const MAX_BUBBLES = 2;

/** Determine Bocy's mood from the latest chat message content */
function getChatMood(lastMsg: string | undefined, baseMood: BocyMood, isLoading: boolean): BocyMood {
  if (isLoading) return 'thinking';
  if (!lastMsg) return baseMood;
  const lower = lastMsg.toLowerCase();
  if (/payday|well done|great|nice|saved|congrat|milestone|achieved/.test(lower)) return 'celebrating';
  if (/overspend|debt|behind|warning|careful|risk|problem/.test(lower)) return 'alert';
  if (/plan|let me|here's|break|walk you|split/.test(lower)) return 'happy';
  return baseMood;
}

/**
 * Split a long assistant message into multiple chat-sized chunks.
 * Splits on paragraph breaks first, then on sentences for any chunk
 * still over the threshold. This makes AI responses feel like real texts.
 */
function splitIntoBubbles(text: string): string[] {
  if (!text || !text.trim()) return [];

  // GIF markdown pattern — must be kept as its own bubble
  const GIF_RX = /^!\[.*?\]\(https?:\/\/[^\s)]+\)\s*$/;

  // Split by double newlines (paragraphs) first
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const chunks: string[] = [];
  for (const para of paragraphs) {
    // If a paragraph contains a GIF line, split it so the GIF is its own bubble
    const lines = para.split('\n');
    const hasGif = lines.some((l) => GIF_RX.test(l.trim()));
    if (hasGif) {
      let textBuffer: string[] = [];
      for (const line of lines) {
        if (GIF_RX.test(line.trim())) {
          if (textBuffer.length > 0) {
            chunks.push(textBuffer.join('\n'));
            textBuffer = [];
          }
          chunks.push(line.trim());
        } else {
          textBuffer.push(line);
        }
      }
      if (textBuffer.length > 0) chunks.push(textBuffer.join('\n'));
      continue;
    }

    const wordCount = para.split(/\s+/).length;
    if (wordCount <= CHUNK_WORD_THRESHOLD) {
      chunks.push(para);
    } else {
      // Split long paragraphs on sentence boundaries
      const sentences = para.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [para];
      let current = '';
      for (const sentence of sentences) {
        const combined = current ? current + ' ' + sentence.trim() : sentence.trim();
        if (combined.split(/\s+/).length > CHUNK_WORD_THRESHOLD && current) {
          chunks.push(current.trim());
          current = sentence.trim();
        } else {
          current = combined;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
  }

  // Hard cap: never more than MAX_BUBBLES to keep replies conversational
  const result = chunks.length > 0 ? chunks : [text];
  return result.slice(0, MAX_BUBBLES);
}

/**
 * Speak text aloud using ElevenLabs TTS (via /api/tts proxy).
 * Falls back to Web Speech Synthesis if ElevenLabs is unavailable.
 * Returns a cancel function. Only works on web.
 */
function speakText(text: string, onEnd?: () => void, authToken?: string | null): (() => void) {
  if (typeof window === 'undefined') {
    onEnd?.();
    return () => {};
  }

  let cancelled = false;
  let audio: HTMLAudioElement | null = null;

  // Try ElevenLabs first, fall back to Web Speech API
  if (authToken) {
    const clean = text.replace(/[*_~`#>\[\]()]/g, '').replace(/\n+/g, '. ');

    fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ text: clean }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`TTS ${res.status}: ${body}`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          onEnd?.();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          onEnd?.();
        };
        audio.play();
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[TTS] ElevenLabs unavailable, falling back to Web Speech API:', err?.message);
        speakWithWebSpeech(text, onEnd);
      });
  } else {
    console.warn('[TTS] No auth token — using Web Speech API fallback');
    speakWithWebSpeech(text, onEnd);
  }

  return () => {
    cancelled = true;
    if (audio) {
      audio.pause();
      audio.src = '';
    }
    window.speechSynthesis?.cancel();
    onEnd?.();
  };
}

/** Fallback: Web Speech Synthesis API (robotic but works without API key) */
function speakWithWebSpeech(text: string, onEnd?: () => void) {
  if (!window.speechSynthesis) {
    onEnd?.();
    return;
  }
  const clean = text.replace(/[*_~`#>\[\]()]/g, '').replace(/\n+/g, '. ');
  const utterance = new SpeechSynthesisUtterance(clean);
  utterance.lang = 'en-GB';
  utterance.rate = 1.0;
  utterance.pitch = 1.0;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// ── Dot-matrix ring (Nothing Phone glyph aesthetic) ──
// Renders dots positioned in a circle. Used for the voice orb outer ring
// and the expanding animated rings when listening.

function DotRing({
  size,
  count = 20,
  dotSize = 2.5,
  color,
  animated,
  animValue,
}: {
  size: number;
  count?: number;
  dotSize?: number;
  color: string;
  animated?: boolean;
  animValue?: Animated.Value;
}) {
  const r = size / 2;
  const dots = useMemo(
    () =>
      Array.from({ length: count }).map((_, i) => {
        const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
        return {
          x: r + Math.cos(angle) * (r - dotSize) - dotSize / 2,
          y: r + Math.sin(angle) * (r - dotSize) - dotSize / 2,
        };
      }),
    [size, count, dotSize],
  );

  const containerStyle: any = {
    width: size,
    height: size,
    position: 'absolute' as const,
    left: '50%',
    top: '50%',
    marginLeft: -size / 2,
    marginTop: -size / 2,
  };
  if (animated && animValue) {
    containerStyle.opacity = animValue.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] });
    containerStyle.transform = [{ scale: animValue.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }];
  }

  const Container = animated ? Animated.View : View;
  return (
    <Container style={containerStyle}>
      {dots.map((d, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: d.x,
            top: d.y,
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: color,
          }}
        />
      ))}
    </Container>
  );
}

// ── Dot-matrix microphone glyph ──
// A tiny mic icon built from dots — Nothing Phone LED dot style.

const MIC_GLYPH: number[][] = [
  [0, 1, 0],
  [1, 1, 1],
  [1, 1, 1],
  [0, 1, 0],
  [0, 1, 0],
  [1, 1, 1],
];

function DotMic({ dotSize = 3.5, gap = 2, color }: { dotSize?: number; gap?: number; color: string }) {
  return (
    <View style={{ alignItems: 'center' }}>
      {MIC_GLYPH.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', gap }}>
          {row.map((v, c) => (
            <View
              key={c}
              style={{
                width: dotSize,
                height: dotSize,
                borderRadius: dotSize / 2,
                backgroundColor: v ? color : 'transparent',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

// ── Suggested questions (contextual) ──

function getContextualQuestions(analysis: Analysis | null, goals: Goals | null, paydayActive?: boolean, paydayContext?: any): string[] {
  if (!analysis) {
    return [
      'What can Bocy help me with?',
      'How does the financial analysis work?',
    ];
  }

  const moves = analysis.all_moves || [];
  const income = analysis.monthly_income ?? 0;
  const spending = analysis.monthly_spending ?? 0;
  const surplus = analysis.surplus ?? 0;
  const topMove = moves[0];

  // Payday mode: hyper-specific allocation questions
  if (paydayActive) {
    const incomeEvents = paydayContext?.incomeEvents || [];
    const questions: string[] = [];

    if (incomeEvents.length > 0) {
      const payAmount = incomeEvents.reduce((s: number, e: any) => s + (e?.amount ?? 0), 0);
      const paySource = incomeEvents[0]?.source || 'your employer';
      questions.push(`Split my \u00a3${Math.round(payAmount).toLocaleString()} from ${paySource} for me.`);

      const committed = paydayContext?.committedThisWeek ?? 0;
      if (committed > 0) {
        questions.push(`\u00a3${Math.round(committed).toLocaleString()} is committed to bills \u2014 what's left?`);
      } else {
        questions.push('How much should I set aside for bills this week?');
      }
    } else {
      questions.push('I just got paid. Walk me through what to do.');
      questions.push('How much can I safely spend this week?');
    }

    if (topMove) {
      const action = (topMove.action || '').replace(/\*\*/g, '');
      questions.push(`Can I put more towards "${action.length > 40 ? action.slice(0, 37) + '...' : action}"?`);
    }

    if (goals?.one_year_goal) {
      const goalName = goals.one_year_goal.replace(/_/g, ' ');
      questions.push(`How does this pay move me closer to ${goalName}?`);
    } else {
      questions.push('What should I do with the leftover?');
    }

    return questions;
  }

  // Default mode: specific, data-driven starters
  const questions: string[] = [];

  // #1: Top move — specific action with real amount
  if (topMove) {
    const action = (topMove.action || '').replace(/\*\*/g, '');
    const impact = topMove.annualImpact || (topMove.monthlyImpact || 0) * 12;
    if (impact > 0) {
      questions.push(`How do I save \u00a3${Math.round(impact).toLocaleString()}/yr by "${action.length > 30 ? action.slice(0, 27) + '...' : action}"?`);
    } else {
      questions.push(`Walk me through: ${action.length > 45 ? action.slice(0, 42) + '...' : action}`);
    }
  }

  // #2: Spending insight — specific category or subscription
  const subMove = moves.find((m: any) => m.action?.toLowerCase().includes('subscription'));
  if (subMove?.merchants?.length) {
    const count = subMove.merchants.length;
    const names = subMove.merchants.slice(0, 2).join(' and ');
    questions.push(`Do I actually need ${names}${count > 2 ? ` and ${count - 2} more` : ''}?`);
  } else if (surplus < 0) {
    questions.push(`I'm \u00a3${Math.round(Math.abs(surplus)).toLocaleString()}/mo over budget \u2014 where do I cut?`);
  } else if (spending > 0) {
    questions.push(`I spend \u00a3${Math.round(spending).toLocaleString()}/mo \u2014 is that reasonable?`);
  } else {
    questions.push('Where are my biggest spending leaks?');
  }

  // #3: Goal-specific or debt-specific
  const patterns = analysis.behavioral_patterns || [];
  if (patterns.some((p: string) => p.toLowerCase().includes('debt'))) {
    questions.push('Should I clear debt or build savings first?');
  } else if (goals?.one_year_goal) {
    const goalName = goals.one_year_goal.replace(/_/g, ' ');
    const target = goals.target_amount;
    if (target) {
      questions.push(`How fast can I hit \u00a3${Math.round(target).toLocaleString()} for ${goalName}?`);
    } else {
      questions.push(`Am I on track for ${goalName}?`);
    }
  } else {
    questions.push('What should my first financial goal be?');
  }

  // #4: Actionable nudge
  if (moves.length > 1) {
    questions.push(`If I follow all ${moves.length} moves, what happens?`);
  } else if (surplus > 100) {
    questions.push(`I have \u00a3${Math.round(surplus).toLocaleString()}/mo spare \u2014 invest or save?`);
  } else {
    questions.push('How can I make my money work harder?');
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

// ── Typewriter text reveal ──
// Progressively reveals text character-by-character for AI messages.
// Falls back to instant display once the animation completes.

function TypewriterText({ text, style, delay = 0, charsPerTick = 2, onComplete }: {
  text: string;
  style?: any;
  delay?: number;
  charsPerTick?: number;
  onComplete?: () => void;
}) {
  const [visibleLen, setVisibleLen] = useState(0);
  const [done, setDone] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // If the chunk is a GIF image, render it immediately (no typewriter for images)
  const isGif = /^!\[.*?\]\(https?:\/\/[^\s)]+\)\s*$/.test(text.trim());

  useEffect(() => {
    if (isGif) { setDone(true); onComplete?.(); return; }
    const timer = setTimeout(() => {
      tickRef.current = setInterval(() => {
        setVisibleLen((prev) => {
          const next = prev + charsPerTick;
          if (next >= text.length) {
            if (tickRef.current) clearInterval(tickRef.current);
            setDone(true);
            onComplete?.();
            return text.length;
          }
          return next;
        });
      }, 16); // ~60fps
    }, delay);

    return () => {
      clearTimeout(timer);
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [text]);

  if (done) return <Markdown>{text}</Markdown>;

  // During reveal, show plain text (Markdown parsing mid-stream is unreliable)
  return (
    <Text style={style}>
      {text.slice(0, visibleLen)}
      <Text style={{ opacity: 0.4 }}>|</Text>
    </Text>
  );
}

// ── Fade-in wrapper for new messages ──

function FadeInView({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(6)).current;

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 250, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
    }, delay);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }] }}>
      {children}
    </Animated.View>
  );
}

// ── Pulse animation for button mode transitions ──

function PulseButton({ children, trigger }: { children: React.ReactNode; trigger: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  const prevTrigger = useRef(trigger);

  useEffect(() => {
    if (prevTrigger.current !== trigger) {
      prevTrigger.current = trigger;
      Animated.sequence([
        Animated.timing(scale, { toValue: 0.85, duration: 80, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.05, duration: 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 100, useNativeDriver: true }),
      ]).start();
    }
  }, [trigger]);

  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

// ── Voice Orb (hero mic button with dot-matrix ring animation) ──
// Nothing Phone glyph aesthetic: dots arranged in circles, breathing, geometric.

function VoiceOrb({
  listening,
  onPress,
  disabled,
}: {
  listening: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const scale = useRef(new Animated.Value(1)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const dotPulse = useRef(new Animated.Value(0)).current;
  const idlePulse = useRef(new Animated.Value(0)).current;

  // Slow stoic idle pulse — draws the eye without being aggressive
  useEffect(() => {
    if (listening) {
      idlePulse.stopAnimation();
      idlePulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(idlePulse, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(idlePulse, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [listening]);

  useEffect(() => {
    if (listening) {
      // Breathing scale
      Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.04, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ).start();
      // Inner dot pulse
      Animated.loop(
        Animated.sequence([
          Animated.timing(dotPulse, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(dotPulse, { toValue: 0, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ).start();
      // Expanding dot ring 1
      Animated.loop(
        Animated.sequence([
          Animated.timing(ring1, { toValue: 1, duration: 2000, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
          Animated.timing(ring1, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ).start();
      // Expanding dot ring 2 (offset)
      setTimeout(() => {
        Animated.loop(
          Animated.sequence([
            Animated.timing(ring2, { toValue: 1, duration: 2000, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            Animated.timing(ring2, { toValue: 0, duration: 0, useNativeDriver: true }),
          ]),
        ).start();
      }, 1000);
    } else {
      [scale, ring1, ring2, dotPulse].forEach((a) => a.stopAnimation());
      scale.setValue(1);
      ring1.setValue(0);
      ring2.setValue(0);
      dotPulse.setValue(0);
    }
  }, [listening]);

  const handlePressIn = () => {
    Animated.timing(scale, { toValue: 0.92, duration: 100, useNativeDriver: true }).start();
  };
  const handlePressOut = () => {
    Animated.timing(scale, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  };

  const activeColor = listening ? colors.green : colors.accent;

  const idleScale = listening ? 1 : idlePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const idleGlow = listening ? 1 : idlePulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });

  return (
    <View style={s.voiceOrbContainer}>
      {/* Expanding dot-matrix rings (visible when listening) */}
      {listening && (
        <>
          <DotRing size={100} count={20} dotSize={2.5} color={colors.green} animated animValue={ring1} />
          <DotRing size={90} count={18} dotSize={2} color={colors.green} animated animValue={ring2} />
        </>
      )}
      {/* Static outer dot ring — breathes when idle, sits tight against orb */}
      <Animated.View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, transform: [{ scale: idleScale as any }], opacity: idleGlow as any }}>
        <DotRing size={82} count={24} dotSize={listening ? 3 : 2.5} color={activeColor} />
      </Animated.View>
      <Animated.View style={{ transform: [{ scale }, ...(listening ? [] : [{ scale: idleScale as any }])] }}>
        <Pressable
          style={[s.voiceOrb, listening && s.voiceOrbListening]}
          onPress={disabled ? undefined : onPress}
          onPressIn={disabled ? undefined : handlePressIn}
          onPressOut={disabled ? undefined : handlePressOut}
          accessibilityRole="button"
          accessibilityLabel={listening ? 'Stop listening' : 'Start voice input'}
        >
          {listening ? (
            <Animated.View style={{ opacity: dotPulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }}>
              <View style={s.voiceOrbStop} />
            </Animated.View>
          ) : (
            <DotMic dotSize={4} gap={2.5} color={colors.bg} />
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ── Voice Waveform Visualiser ──
// Pulsing dots that breathe during active listening. Nothing Phone dot-matrix feel.

const WAVE_DOT_COUNT = 7;

function VoiceWaveform({ active }: { active: boolean }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const dots = useRef(
    Array.from({ length: WAVE_DOT_COUNT }, () => new Animated.Value(0.4)),
  ).current;

  useEffect(() => {
    if (active) {
      const animations = dots.map((dot, i) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(i * 80),
            Animated.timing(dot, { toValue: 1, duration: 250 + Math.random() * 200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(dot, { toValue: 0.4, duration: 250 + Math.random() * 200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          ]),
        ),
      );
      animations.forEach((a) => a.start());
      return () => animations.forEach((a) => a.stop());
    } else {
      dots.forEach((dot) => {
        dot.stopAnimation();
        dot.setValue(0.4);
      });
    }
  }, [active]);

  if (!active) return null;

  return (
    <View style={s.waveformRow}>
      {dots.map((dot, i) => (
        <Animated.View
          key={i}
          style={[
            s.waveformDot,
            {
              transform: [{ scale: dot.interpolate({ inputRange: [0.4, 1], outputRange: [0.5, 1.4] }) }],
              opacity: dot,
            },
          ]}
        />
      ))}
    </View>
  );
}

// ── Inline action cards ──

function PlanCard({
  action,
  onApprove,
  onDismiss,
  onDelete,
  saving,
}: {
  action: ChatAction;
  onApprove: () => void;
  onDismiss: () => void;
  onDelete: () => void;
  saving?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  const isApproved = action.status === 'approved';
  const isDismissed = action.status === 'dismissed';
  const isDeleted = action.status === 'deleted';

  return (
    <Card
      variant="action"
      borderColor={isApproved ? colors.accent : undefined}
      noShadow
      style={{ borderRadius: radius.lg, padding: spacing.md, marginBottom: 0 }}
    >
      <Text style={s.actionCardLabel}>{isApproved ? 'PLAN ADDED' : isDeleted ? 'PLAN REMOVED' : 'PLAN SUGGESTED'}</Text>
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
        <>
          <View style={s.approvedBanner}>
            <Text style={s.approvedBannerText}>{'\u2713'} Added to your plan</Text>
          </View>
          <TouchableOpacity style={s.removeLink} onPress={onDelete} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Remove this plan">
            <Text style={s.removeLinkText}>Remove</Text>
          </TouchableOpacity>
        </>
      ) : isDismissed ? (
        <View style={s.dismissedBanner} accessibilityLabel="Plan removed">
          <Text style={s.dismissedBannerText}>Removed from plan</Text>
        </View>
      ) : isDeleted ? (
        <View style={s.dismissedBanner} accessibilityLabel="Plan removed">
          <Text style={s.dismissedBannerText}>Removed from plan</Text>
        </View>
      ) : (
        <View style={s.actionCardButtons}>
          <TouchableOpacity
            style={[s.approveBtn, saving && s.approveBtnSaving]}
            onPress={onApprove}
            activeOpacity={0.8}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Add this plan to your active plans"
            accessibilityState={{ disabled: saving }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.bg} />
            ) : (
              <Text style={s.approveBtnText}>Add to plan</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={s.dismissBtn} onPress={onDismiss} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="Dismiss this plan suggestion">
            <Text style={s.dismissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}
    </Card>
  );
}

function BudgetItemCard({ action, onDelete }: { action: ChatAction; onDelete: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  const isDeleted = action.status === 'deleted';
  return (
    <Card
      variant="action"
      borderColor={isDeleted ? undefined : colors.accent}
      noShadow
      style={{ borderRadius: radius.lg, padding: spacing.md, marginBottom: 0 }}
    >
      <Text style={s.actionCardLabel}>{isDeleted ? 'BUDGET ITEM REMOVED' : 'BUDGET UPDATED'}</Text>
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
      {isDeleted ? (
        <View style={s.dismissedBanner}>
          <Text style={s.dismissedBannerText}>Removed from budget</Text>
        </View>
      ) : (
        <>
          <View style={s.approvedBanner}>
            <Text style={s.approvedBannerText}>{'\u2713'} Added to your budget</Text>
          </View>
          <TouchableOpacity style={s.removeLink} onPress={onDelete} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Remove this budget item">
            <Text style={s.removeLinkText}>Remove</Text>
          </TouchableOpacity>
        </>
      )}
    </Card>
  );
}

function OverrideCard({ action }: { action: ChatAction }) {
  const { colors } = useTheme();
  const s = useMemo(() => createStyles(colors), [colors]);
  const d = action.data;
  return (
    <Card
      variant="action"
      noShadow
      style={{ borderRadius: radius.lg, padding: spacing.md, marginBottom: 0 }}
    >
      <Text style={s.actionCardLabel}>TRANSACTION UPDATED</Text>
      <Text style={s.overrideDescription}>
        {'\u201C'}{d.match_description}{'\u201D'} {'\u2192'} {d.category}
        {d.is_essential ? ' (essential)' : ' (discretionary)'}
      </Text>
      <Text style={s.overrideNote}>Will apply on your next analysis.</Text>
    </Card>
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
    <Card
      variant="action"
      borderColor={isAccepted ? colors.accent : colors.skyDim}
      noShadow
      style={{ borderRadius: radius.lg, padding: spacing.md, marginBottom: 0 }}
    >
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
    </Card>
  );
}

// ── Main Chat Component ──

export default function Chat() {
  const router = useRouter();
  const { prefill } = useLocalSearchParams<{ prefill?: string }>();
  const { colors } = useTheme();
  const { maxContentWidth, isTablet } = useResponsive();
  const s = useMemo(() => createStyles(colors), [colors]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [inputHeight, setInputHeight] = useState(40);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ChatContext>({});
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [goals, setGoals] = useState<Goals | null>(null);
  const [paydayDismissed, setPaydayDismissed] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState<string | null>(null); // "msgIdx-actionIdx"
  const scrollRef = useRef<ScrollView>(null);
  const inputRef = useRef<TextInput>(null);
  const [listening, setListening] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const recognitionRef = useRef<any>(null);
  const autoSendRef = useRef(false);
  const [speakingMsgIdx, setSpeakingMsgIdx] = useState<number | null>(null);
  const stopSpeechRef = useRef<(() => void) | null>(null);
  // Set when voice input triggers a message; cleared after TTS speaks the response
  const pendingVoiceResponseRef = useRef(false);

  // ── Full speech-to-speech conversation hook ──
  const {
    voiceState,
    toggleListening: toggleVoiceConversation,
    speak: speakResponse,
    stopSpeaking,
    isSupported: voiceConversationSupported,
    errorMessage: voiceError,
    amplitude: voiceAmplitude,
    conversationActive,
  } = useVoiceConversation({
    onTranscript: (text) => {
      // Voice mode: transcribed text goes straight to chat
      pendingVoiceResponseRef.current = true;
      // Flash the transcribed text briefly so user sees they were heard
      setInput(text);
      sendMessage(text, 'voice');
    },
    onStateChange: (state) => {
      // Sync listening state with existing UI
      setListening(state === 'listening');
    },
    autoPlayResponse: true,
  });

  // speakResponse ref — so sendMessage can call it without stale closures
  const speakResponseRef = useRef(speakResponse);
  speakResponseRef.current = speakResponse;

  // ── TTS support check (ElevenLabs uses Audio API; Web Speech API is fallback) ──
  const ttsSupported = typeof window !== 'undefined' &&
    (typeof Audio !== 'undefined' || !!window.speechSynthesis);

  const handleSpeak = async (msgIndex: number, text: string) => {
    trackEvent('TTS Played');
    // If already speaking this message, stop
    if (speakingMsgIdx === msgIndex) {
      stopSpeechRef.current?.();
      stopSpeechRef.current = null;
      setSpeakingMsgIdx(null);
      stopSpeaking();
      return;
    }
    // Stop any current speech
    stopSpeechRef.current?.();
    stopSpeaking();

    // Get auth token for ElevenLabs TTS proxy
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token || null;

    setSpeakingMsgIdx(msgIndex);
    const cancel = speakText(text, () => setSpeakingMsgIdx(null), token);
    stopSpeechRef.current = cancel;
  };

  // ── Pre-fill input from plan page navigation ──
  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [prefill]);

  // ── Voice input — uses full speech-to-speech hook (cross-platform) ──
  // Falls back to Web Speech API on browsers where expo-av isn't available.
  const webSpeechAvailable = typeof window !== 'undefined' &&
    (!!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition);
  const voiceSupported = voiceConversationSupported || webSpeechAvailable;

  const toggleVoice = () => {
    trackEvent('Voice Toggled');
    // Prefer cross-platform speech-to-speech hook
    if (voiceConversationSupported) {
      toggleVoiceConversation();
      return;
    }

    // Fallback: Web Speech API (browser only, for quick text dictation)
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

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
      setInput((prev) => {
        const cleaned = prev.replace(/\u200B/g, '').trim();
        if (cleaned) {
          autoSendRef.current = true;
        }
        return cleaned;
      });
    };

    recognition.onerror = () => {
      setListening(false);
    };

    setListening(true);
    recognition.start();
  };

  // ── Auto-send after Web Speech API recognition completes (fallback path) ──
  useEffect(() => {
    if (autoSendRef.current && input.trim() && !listening) {
      autoSendRef.current = false;
      sendMessage(input, 'voice');
    }
  }, [input, listening]);

  /** Human-readable voice state label for UI */
  const voiceStateLabel: string | null =
    voiceState === 'processing' ? 'Transcribing\u2026'
    : voiceState === 'thinking' ? 'Thinking\u2026'
    : voiceState === 'speaking' ? 'Speaking\u2026'
    : voiceState === 'listening' && conversationActive ? 'Listening\u2026'
    : voiceError ? voiceError
    : null;

  // ── Load context + persisted messages on focus ──
  // Also subscribe to sync completions from other screens so chat stays fresh.

  useFocusEffect(
    useCallback(() => {
      trackScreen('Chat');
      loadContext();
      const unsub = onSyncComplete((result) => {
        if (!result?.analysis) return;
        setAnalysis(result.analysis);
      });
      return () => unsub();
    }, []),
  );

  const loadContext = async () => {
    let user: any = null;
    try {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    } catch (e) {
      console.warn('[chat] auth.getUser failed:', e);
    }
    if (!user) return;
    setUserId(user.id);

    const [analysisRes, goalsRes] = await Promise.all([
      supabase
        .from('analyses')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('goals')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);

    const a: Analysis | null = analysisRes.data ?? null;
    const g: Goals | null = goalsRes.data ?? null;
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
      income_sources: a?.income_sources?.map((s: any) => ({
        source: s.source,
        frequency: s.frequency,
        avgAmount: s.avgAmount,
        monthly: s.monthly,
        isSalary: s.isSalary,
      })),
      essential_gaps: a?.essential_gaps,
      verified_bills: a?.verified_bills?.map((b: any) => ({
        category: b.category,
        merchant: b.merchant,
        monthlyAmount: b.monthlyAmount,
        frequency: b.frequency,
        lastPayment: b.lastPayment,
        lastPaymentDate: b.lastPaymentDate,
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

    // Fetch previous month snapshot for budget line month-over-month comparison
    let prevSnapshot: { monthly_spending: number; monthly_income: number } | null = null;
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
      prevSnapshot = prevData ?? null;
    } catch {}

    // Add budget line data (real income, trade-offs, month-over-month)
    ctx.budget_line = buildBudgetLine(a, prevSnapshot);

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
        .maybeSingle();
      if (identityData) {
        (ctx as any).identity = identityData;
      }
    } catch {}

    // Build payday context from sync coordinator's weeklyContext
    // This uses the same data as the home screen instead of duplicating the calculation
    try {
      // Force-sync to ensure chat always has the freshest transaction data
      const syncResult = await requestSync(user.id, true);
      if (syncResult?.analysis) {
        // Update analysis with fresh sync data
        const freshA = syncResult.analysis;
        setAnalysis(freshA);

        // Tell the AI model how fresh the data is
        if (syncResult.latestTransactionDate) {
          (ctx as any).data_freshness = {
            latest_transaction_date: syncResult.latestTransactionDate,
            data_source: syncResult.dataSource,
            connection_issues: syncResult.connectionIssues.length > 0
              ? syncResult.connectionIssues
              : undefined,
          };
        }

        // Rebuild context fields that depend on analysis
        ctx.monthly_income = freshA.monthly_income;
        ctx.monthly_spending = freshA.monthly_spending;
        ctx.surplus = freshA.surplus;
        ctx.is_variable_income = freshA.is_variable_income;
        ctx.income_floor = freshA.income_floor;
        ctx.income_cv = freshA.income_cv;
        ctx.archetype = freshA.archetype;
        ctx.decision_score = freshA.decision_score;
        ctx.all_moves = freshA.all_moves?.map((m: { action: string; monthlyImpact: number; effort: string; category?: string; strategy?: string; proof?: string; effect?: string }) => ({
          action: m.action,
          monthlyImpact: m.monthlyImpact,
          effort: m.effort,
          category: m.category,
          strategy: m.strategy,
          proof: m.proof,
          effect: m.effect,
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

        // Rebuild budget line from fresh sync data (identity not yet available here, enriched later)
        ctx.budget_line = buildBudgetLine(freshA, prevSnapshot);

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

    // ── Enrich budget line with solver output + add household cashflow ──
    // Now that identity is available, re-run with optimisation and scenario analysis
    const identityForSolver = (ctx as any).identity as UserIdentity | null;
    const latestAnalysis = analysis || a;
    if (identityForSolver && latestAnalysis) {
      ctx.budget_line = buildBudgetLine(latestAnalysis, prevSnapshot, identityForSolver);
      ctx.household_cashflow = buildHouseholdCashflow(latestAnalysis, identityForSolver);
    }

    setContext(ctx);

    // ── Check if payday check-in was already dismissed ──
    let isPaydayDismissed = false;
    if (ctx.payday_context?.incomeArrivedThisWeek) {
      const fp = paydayFingerprint(ctx.payday_context);
      const dismissed = await AsyncStorage.getItem('dismiss:chat:payday').catch(() => null);
      if (dismissed === fp) {
        isPaydayDismissed = true;
        setPaydayDismissed(true);
      }
    }

    // ── Load persisted messages ──
    let chatData: { messages: any[] } | null = null;
    try {
      const { data } = await supabase
        .from('chat_messages')
        .select('messages')
        .eq('user_id', user.id)
        .maybeSingle();
      chatData = data;
    } catch {}

    if (chatData?.messages?.length) {
      setMessages(chatData.messages);
    } else if (ctx.payday_context?.incomeArrivedThisWeek && ctx.payday_context.incomeEvents.length > 0 && !isPaydayDismissed) {
      // No existing messages + income arrived + not dismissed = auto-send a payday nudge
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
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      // Keep last 50 messages to avoid bloating the row
      const toStore = msgs.slice(-50);
      await supabase
        .from('chat_messages')
        .upsert({ user_id: user.id, messages: toStore }, { onConflict: 'user_id' });
    } catch (e) {
      console.warn('[chat] persistMessages error:', e);
    }
  };

  // ── Handle plan approval (via server API) ──

  const handleApprovePlan = async (msgIndex: number, actionIndex: number) => {
    trackEvent('Plan Approved From Chat');
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action || action.type !== 'plan_proposed') return;

    // Get fresh user ID in case state hasn't settled
    let uid = userId;
    if (!uid) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          window.alert('Please sign in to save plans.');
          return;
        }
        uid = user.id;
        setUserId(uid);
      } catch {
        window.alert('Could not verify sign-in. Please try again.');
        return;
      }
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
            window.alert(`Could not save plan: ${insertErr.message}`);
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
          window.alert(`Could not save plan: ${insertErr.message}`);
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
      window.alert(err?.message || 'Something went wrong.');
    }

    setSavingPlan(null);
  };

  // ── Handle plan dismissal (via server API) ──

  const handleDismissPlan = async (msgIndex: number, actionIndex: number) => {
    trackEvent('Plan Dismissed From Chat');
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action) return;

    const planId = action.data.id;
    let uid = userId;
    if (!uid) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        uid = user?.id || null;
      } catch {
        uid = null;
      }
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

  // ── Handle plan deletion (remove an already-approved plan) ──

  const handleDeletePlan = (msgIndex: number, actionIndex: number) => {
    trackEvent('Plan Deleted From Chat');
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action || action.type !== 'plan_proposed' || action.status !== 'approved') return;

    const doDelete = async () => {
      const planId = action.data.id;
      let uid = userId;
      if (!uid) {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          uid = user?.id || null;
        } catch {
          uid = null;
        }
      }

      if (planId && uid) {
        try {
          const res = await fetch('/api/plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', plan_id: planId, user_id: uid }),
          });
          if (!res.ok) throw new Error('API delete failed');
        } catch {
          // Fallback: delete directly via Supabase client (works on native)
          try {
            await supabase.from('user_plans').delete().eq('id', planId).eq('user_id', uid);
          } catch {
            // Non-critical — still update UI
          }
        }
      }

      const updated = [...messages];
      const updatedActions = [...(updated[msgIndex].actions || [])];
      updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'deleted' };
      updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
      setMessages(updated);
      persistMessages(updated);
    };

    const ok = window.confirm('Remove this plan?\n\nIt will be removed from your active plans.');
    if (ok) doDelete();
  };

  // ── Handle budget item deletion ──

  const handleDeleteBudgetItem = (msgIndex: number, actionIndex: number) => {
    trackEvent('Budget Item Deleted From Chat');
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action || action.type !== 'budget_item_saved') return;

    const doDelete = async () => {
      const itemId = action.data.id;
      let uid = userId;
      if (!uid) {
        try {
          const { data: { user } } = await supabase.auth.getUser();
          uid = user?.id || null;
        } catch {
          uid = null;
        }
      }

      if (itemId && uid) {
        try {
          await fetch('/api/plans', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_budget_item', budget_item_id: itemId, user_id: uid }),
          });
        } catch {
          // Non-critical — still update UI
        }

        // Invalidate sync cache and re-sync so the budget reflects the deletion
        invalidateSyncCache();
        requestSync(uid, true).then((syncResult) => {
          if (syncResult?.analysis) setAnalysis(syncResult.analysis);
        }).catch(() => {});
      }

      const updated = [...messages];
      const updatedActions = [...(updated[msgIndex].actions || [])];
      updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'deleted' };
      updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
      setMessages(updated);
      persistMessages(updated);
    };

    const ok = window.confirm('Remove this budget item?\n\nIt will be removed from your budget.');
    if (ok) doDelete();
  };

  // ── Handle goal update acceptance ──

  const handleAcceptGoalUpdate = async (msgIndex: number, actionIndex: number) => {
    trackEvent('Goals Updated From Chat');
    const msg = messages[msgIndex];
    const action = msg?.actions?.[actionIndex];
    if (!action || action.type !== 'goal_update_proposed') return;

    let uid = userId;
    if (!uid) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          window.alert('Please sign in to update goals.');
          return;
        }
        uid = user.id;
        setUserId(uid);
      } catch {
        window.alert('Could not verify sign-in. Please try again.');
        return;
      }
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
        window.alert(data.error || 'Could not update goals.');
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
      window.alert(err?.message || 'Something went wrong.');
    }

    setSavingPlan(null);
  };

  const handleKeepGoals = (msgIndex: number, actionIndex: number) => {
    trackEvent('Goals Kept From Chat');
    const updated = [...messages];
    const updatedActions = [...(updated[msgIndex].actions || [])];
    updatedActions[actionIndex] = { ...updatedActions[actionIndex], status: 'dismissed' };
    updated[msgIndex] = { ...updated[msgIndex], actions: updatedActions };
    setMessages(updated);
    persistMessages(updated);
  };

  // ── Send message (with streaming + fallback) ──

  const sendMessage = async (text: string, _source: 'text' | 'voice' | 'suggestion' = 'text') => {
    if (!text.trim() || loading) return;
    hapticLight();
    trackEvent('Chat Message Sent', { source: _source });

    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setInputHeight(40);
    setLoading(true);
    setError(null);

    // Dismiss the payday banner permanently for this pay event
    if (hasPaydayContext && !paydayDismissed) {
      setPaydayDismissed(true);
      const fp = paydayFingerprint(context.payday_context);
      AsyncStorage.setItem('dismiss:chat:payday', fp).catch(() => {});
    }

    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    let responseText = '';
    let hadError = false;
    try {
      // ── Try streaming first ──
      responseText = await tryStream(newMessages);
      if (!responseText) {
        // ── Fall back to standard request ──
        responseText = await standardRequest(newMessages);
      }
    } catch {
      hadError = true;
      setError('Connection error. Please check your internet and try again.');
    }

    // If both paths failed to produce a response, show an error message
    if (!responseText && !hadError) {
      const fallbackMsg: ChatMessage = { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' };
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        // Replace empty assistant bubble if one exists
        if (last?.role === 'assistant' && !last.content?.trim()) {
          return [...prev.slice(0, -1), fallbackMsg];
        }
        if (last?.role === 'user') {
          return [...prev, fallbackMsg];
        }
        return prev;
      });
    }

    setLoading(false);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

    // ── Voice response: speak the AI's reply if triggered by voice input ──
    if (pendingVoiceResponseRef.current && responseText) {
      pendingVoiceResponseRef.current = false;
      speakResponseRef.current(responseText);
    }
  };

  const tryStream = async (newMessages: ChatMessage[]): Promise<string> => {
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, context, stream: true, user_id: userId }),
      });

      if (!res.ok || !res.body) return '';

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
              // If we already have partial text, keep it rather than discarding
              if (fullText) break;
              return '';
            }
            if (event.t) {
              fullText += event.t;
              const streamContent = fullText;
              setMessages((prev) => {
                // Replace the last assistant message if streaming, otherwise append
                const last = prev[prev.length - 1];
                if (last?.role === 'assistant' && prev.length === newMessages.length + 1) {
                  return [...prev.slice(0, -1), { ...last, content: streamContent }];
                }
                return [...prev, { role: 'assistant', content: streamContent }];
              });
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

      // Process remaining buffer (stream may not end with newline)
      if (buffer.startsWith('data: ')) {
        const raw = buffer.slice(6).trim();
        if (raw && raw !== '[DONE]') {
          try {
            const event = JSON.parse(raw);
            if (event.t) fullText += event.t;
            if (event.action) {
              collectedActions.push({
                type: event.action.type,
                data: event.action.data,
                status: (event.action.type === 'goal_update_proposed' || event.action.type === 'plan_proposed') ? 'pending' : undefined,
              });
            }
          } catch {}
        }
      }

      if (fullText || collectedActions.length > 0) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: fullText || (collectedActions.length > 0 ? 'Done.' : ''),
          actions: collectedActions.length > 0 ? collectedActions : undefined,
        };
        const final: ChatMessage[] = [...newMessages, assistantMsg];
        setMessages(final);
        persistMessages(final);
        return fullText || assistantMsg.content;
      }

      return '';
    } catch {
      // Streaming not supported (e.g. React Native on device) — fall back
      return '';
    }
  };

  const standardRequest = async (newMessages: ChatMessage[]): Promise<string> => {
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
      return data.text;
    } else {
      setError(data.error || 'Failed to get response');
      const errorMsg: ChatMessage = { role: 'assistant', content: 'Sorry, I couldn\'t process that. Please try again.' };
      setMessages([...newMessages, errorMsg]);
      return '';
    }
  };

  // ── Retry last failed message ──

  const retryLastMessage = () => {
    trackEvent('Chat Message Retried');
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
    trackEvent('Chat Cleared');
    stopSpeechRef.current?.();
    stopSpeaking();
    setSpeakingMsgIdx(null);
    pendingVoiceResponseRef.current = false;
    setMessages([]);
    setError(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('chat_messages').delete().eq('user_id', user.id);
      }
    } catch (e) {
      console.warn('[chat] clearChat error:', e);
    }
  };

  const hasPaydayContext = !!context.payday_context?.incomeArrivedThisWeek;
  // Only show the payday banner when the user hasn't engaged yet and hasn't dismissed it
  const hasUserMessage = messages.some((m) => m.role === 'user');
  const paydayActive = hasPaydayContext && !hasUserMessage && !paydayDismissed;
  const suggestedQuestions = getContextualQuestions(analysis, goals, paydayActive, context.payday_context);

  const isEmptyState = messages.length === 0 || (messages.length === 1 && messages[0].role === 'assistant' && paydayActive);

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={undefined}
      keyboardVerticalOffset={90}
    >
      {/* ── Header (always visible to prevent layout shift) ── */}
      <View style={[s.header, isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%' }]}>
        <View style={s.headerLeftChat}>
          <View style={s.chatBocyWrap}>
            <BocyFace mood={getChatMood(messages[messages.length - 1]?.role === 'assistant' ? messages[messages.length - 1]?.content : undefined, getBocyMood(analysis), loading)} size="sm" breathing />
          </View>
          <Text style={s.headerTitle}>Bocy</Text>
          {loading && <ActivityIndicator size="small" color={colors.dim} style={{ marginLeft: 6 }} />}
        </View>
        {messages.length > 0 ? (
          <TouchableOpacity onPress={clearChat} style={s.clearButton} activeOpacity={0.7}>
            <Text style={s.clearText}>New chat</Text>
          </TouchableOpacity>
        ) : (
          <View />
        )}
      </View>

      {/* ── Messages ── */}
      <ScrollView
        ref={scrollRef}
        style={s.messages}
        contentContainerStyle={[
          s.messagesContent,
          isEmptyState && s.messagesContentEmpty,
          isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%' },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Voice-first empty state ── */}
        {isEmptyState && (
          <View style={s.voiceHeroContainer}>
            {/* Payday auto-nudge message if present */}
            {messages.length === 1 && messages[0].role === 'assistant' && (
              <FadeInView>
                <View style={[s.bubble, s.assistantBubble, { marginBottom: spacing.lg, alignSelf: 'center', maxWidth: '90%' }]}>
                  <Markdown>{messages[0].content}</Markdown>
                </View>
              </FadeInView>
            )}

            {/* Center content: orb + hint */}
            <View style={s.voiceHeroCenter}>
              <View style={s.voiceHeroTop}>
                {(paydayActive || listening || voiceState !== 'idle') && (
                  <Text style={s.voiceHeroTitle}>
                    {paydayActive ? 'Payday check-in'
                      : voiceState === 'processing' ? 'Processing\u2026'
                      : voiceState === 'thinking' ? 'Thinking\u2026'
                      : voiceState === 'speaking' ? 'Bocy is speaking'
                      : 'Listening\u2026'}
                  </Text>
                )}
                <Text style={s.voiceHeroSubtitle}>
                  {voiceStateLabel
                    ? voiceStateLabel
                    : listening
                      ? 'Speak naturally. I\u2019ll send when you\u2019re done.'
                      : paydayActive
                        ? 'Tap to speak, or pick a question below'
                        : 'Tap the mic \u2022 ask anything'}
                </Text>
              </View>

              {/* Voice Orb — the hero CTA */}
              <VoiceOrb
                listening={listening || voiceState === 'processing' || voiceState === 'thinking' || voiceState === 'speaking'}
                onPress={voiceSupported ? toggleVoice : () => { trackEvent('Text Input Toggled'); setShowTextInput(true); setTimeout(() => inputRef.current?.focus(), 100); }}
                disabled={loading && voiceState === 'idle'}
              />

              {/* Waveform visualiser + live transcript */}
              <VoiceWaveform active={listening} />
              {listening && input.trim() !== '' && (
                <FadeInView>
                  <Text style={s.liveTranscript}>{input.replace(/\u200B/g, '')}</Text>
                </FadeInView>
              )}

              {/* Type-instead toggle */}
              {!listening && (
                <TouchableOpacity
                  style={s.typeToggle}
                  onPress={() => { trackEvent('Text Input Toggled'); setShowTextInput(!showTextInput); if (!showTextInput) setTimeout(() => inputRef.current?.focus(), 100); }}
                  activeOpacity={0.7}
                >
                  <Text style={s.typeToggleText}>{showTextInput ? 'Hide keyboard' : 'Type instead'}</Text>
                </TouchableOpacity>
              )}

              {/* Inline text input (secondary, shown on demand) */}
              {showTextInput && !listening && (
                <FadeInView>
                  <View style={s.inlineInputRow}>
                    <TextInput
                      ref={inputRef}
                      style={[s.inlineInput, { height: Math.max(40, Math.min(inputHeight, 100)) }]}
                      placeholder="Type your question..."
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
                    {input.trim() ? (
                      <TouchableOpacity
                        style={[s.inlineSendBtn, loading && { opacity: 0.3 }]}
                        onPress={() => sendMessage(input)}
                        disabled={loading}
                        activeOpacity={0.7}
                      >
                        <Text style={s.inlineSendIcon}>{'\u2191'}</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </FadeInView>
              )}
            </View>

            {/* ── Horizontal suggestion pills (pinned at bottom) ── */}
            {!listening && (
              <View style={s.suggestedContainer}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={s.suggestedScroll}
                >
                  {suggestedQuestions.map((q, i) => (
                    <TouchableOpacity
                      key={i}
                      style={s.suggestedChip}
                      onPress={() => { trackEvent('Suggested Question Tapped', { question: q }); sendMessage(q, 'suggestion'); }}
                      activeOpacity={0.7}
                    >
                      <Text style={s.suggestedChipText}>{q}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>
        )}

        {/* ── Conversation messages ── */}
        {!isEmptyState && messages.map((msg, i) => {
          const isAssistant = msg.role === 'assistant';
          const isLast = i === messages.length - 1;
          const showLabel = isAssistant && (i === 0 || messages[i - 1]?.role !== 'assistant');

          // Split long assistant messages into multiple bubbles (like real texts)
          const bubbleChunks = isAssistant && !loading
            ? splitIntoBubbles(msg.content)
            : (msg.content ? [msg.content] : []);

          const bubble = (
            <View key={i}>
              {showLabel && (
                <View style={s.bocyLabelRow}>
                  <View style={s.bocyLabelDot} />
                  <Text style={s.bocyLabel}>bocy</Text>
                </View>
              )}

              {msg.role === 'user' ? (
                <View style={[s.bubble, s.userBubble]}>
                  <Text style={[s.bubbleText, s.userText]}>{msg.content}</Text>
                </View>
              ) : (
                <>
                  {bubbleChunks.map((chunk, ci) => {
                    const useTypewriter = isLast && !loading;
                    const isGifChunk = /^!\[.*?\]\(https?:\/\/[^\s)]+\)\s*$/.test(chunk.trim());
                    return (
                      <FadeInView key={`${i}-chunk-${ci}`} delay={ci * 300}>
                        <View style={[s.bubble, s.assistantBubble, ci > 0 && { marginTop: 4 }, isGifChunk && s.gifBubble]}>
                          {useTypewriter
                            ? <TypewriterText text={chunk} style={s.bubbleText} delay={ci * 300} />
                            : <Markdown>{chunk}</Markdown>
                          }
                        </View>
                      </FadeInView>
                    );
                  })}
                  {/* Voice response button */}
                  {ttsSupported && msg.content && !loading && (
                    <TouchableOpacity
                      style={s.ttsButton}
                      onPress={() => handleSpeak(i, msg.content)}
                      activeOpacity={0.7}
                    >
                      <Text style={[s.ttsButtonText, speakingMsgIdx === i && s.ttsButtonActive]}>
                        {speakingMsgIdx === i ? '\u25A0 Stop' : '\u266A Listen'}
                      </Text>
                    </TouchableOpacity>
                  )}
                </>
              )}

              {/* Render action cards below assistant messages */}
              {msg.actions?.map((action, j) => (
                <View key={`action-${i}-${j}`} style={s.actionCardWrapper}>
                  {action.type === 'plan_proposed' ? (
                    <PlanCard
                      action={action}
                      onApprove={() => handleApprovePlan(i, j)}
                      onDismiss={() => handleDismissPlan(i, j)}
                      onDelete={() => handleDeletePlan(i, j)}
                      saving={savingPlan === `${i}-${j}`}
                    />
                  ) : action.type === 'plan_error' ? (
                    <Card
                      variant="error"
                      noShadow
                      style={{ borderRadius: radius.md, padding: spacing.md, marginBottom: 0 }}
                    >
                      <Text style={s.errorCardText}>{action.data.error || 'Plan could not be saved.'}</Text>
                    </Card>
                  ) : action.type === 'override_saved' ? (
                    <OverrideCard action={action} />
                  ) : action.type === 'budget_item_saved' ? (
                    <BudgetItemCard action={action} onDelete={() => handleDeleteBudgetItem(i, j)} />
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
          );

          // Animate assistant messages sliding in
          if (isAssistant && isLast) {
            return <FadeInView key={i}>{bubble}</FadeInView>;
          }
          return bubble;
        })}

        {loading && <TypingIndicator />}

        {error && (
          <TouchableOpacity style={s.retryBanner} onPress={retryLastMessage}>
            <Text style={s.retryText}>{error}</Text>
            <Text style={s.retryAction}>Tap to retry</Text>
          </TouchableOpacity>
        )}

        {/* Follow-up suggestion chips after last assistant response */}
        {!isEmptyState && !loading && !error && messages.length > 0 && messages[messages.length - 1]?.role === 'assistant' && (
          <View style={s.followUpContainer}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.followUpScroll}>
              {suggestedQuestions.slice(0, 3).map((q, qi) => (
                <TouchableOpacity
                  key={qi}
                  style={s.followUpChip}
                  onPress={() => { trackEvent('Suggested Question Tapped', { question: q }); sendMessage(q, 'suggestion'); }}
                  activeOpacity={0.7}
                >
                  <Text style={s.followUpChipText}>{q}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* ── Input (only shown in conversation mode, not empty state) ── */}
      {!isEmptyState && (
        <>
              {/* Voice-first input bar: mic button prominent, text secondary */}
              <View style={[s.voiceInputRow, isTablet && { maxWidth: maxContentWidth, alignSelf: 'center' as const, width: '100%' }]}>
                <TextInput
                  ref={inputRef}
                  style={[s.input, { height: Math.max(40, Math.min(inputHeight, 160)) }]}
                  placeholder={
                    listening ? 'Listening...'
                    : voiceState === 'processing' ? 'Transcribing...'
                    : voiceState === 'thinking' ? 'Thinking...'
                    : voiceState === 'speaking' ? 'Speaking...'
                    : 'Type or tap mic...'
                  }
                  placeholderTextColor={
                    listening || voiceState === 'speaking' ? colors.green
                    : voiceState === 'processing' || voiceState === 'thinking' ? colors.accent
                    : colors.muted
                  }
                  value={input}
                  onChangeText={setInput}
                  onContentSizeChange={(e) => setInputHeight(e.nativeEvent.contentSize.height)}
                  onSubmitEditing={() => sendMessage(input)}
                  returnKeyType="send"
                  multiline
                  maxLength={1000}
                  blurOnSubmit
                />
                {/* Waveform in input bar when listening */}
                {listening && <VoiceWaveform active={listening} />}
                <PulseButton trigger={input.trim() ? 'send' : listening ? 'listening' : voiceState === 'speaking' ? 'listening' : 'voice'}>
                  {input.trim() ? (
                    <TouchableOpacity
                      style={[s.actionButton, loading && s.actionButtonDisabled]}
                      onPress={() => sendMessage(input)}
                      disabled={loading}
                      activeOpacity={0.7}
                    >
                      <Text style={s.actionButtonIcon}>{'\u2191'}</Text>
                    </TouchableOpacity>
                  ) : voiceState === 'speaking' ? (
                    <TouchableOpacity
                      style={[s.voiceInputOrb, s.voiceInputOrbListening]}
                      onPress={stopSpeaking}
                      activeOpacity={0.7}
                    >
                      <View style={s.glyphStop} />
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[s.voiceInputOrb, listening && s.voiceInputOrbListening]}
                      onPress={voiceSupported ? toggleVoice : undefined}
                      activeOpacity={0.7}
                      disabled={!voiceSupported || voiceState === 'processing' || voiceState === 'thinking'}
                    >
                      {listening ? (
                        <View style={s.glyphStop} />
                      ) : voiceState === 'processing' || voiceState === 'thinking' ? (
                        <ActivityIndicator size="small" color={colors.bg} />
                      ) : (
                        <DotMic dotSize={2.5} gap={1.5} color={colors.bg} />
                      )}
                    </TouchableOpacity>
                  )}
                </PulseButton>
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

function buildBudgetLine(
  a: Analysis | null,
  prevSnapshot: { monthly_spending: number; monthly_income: number } | null,
  identity?: UserIdentity | null,
): ChatContext['budget_line'] {
  if (!a || !a.monthly_income) return undefined;
  const income = a.monthly_income;
  const essentials = a.non_discretionary?.total ?? 0;
  const lifestyle = a.discretionary?.total ?? 0;
  const totalSpend = essentials + lifestyle;
  const leftToDecide = Math.max(0, income - totalSpend);
  const essentialsPct = income > 0 ? Math.round((essentials / income) * 100) : 0;
  const overBudget = totalSpend > income;
  const overAmount = Math.round(Math.max(0, totalSpend - income));

  const prevSpending = prevSnapshot?.monthly_spending ?? null;
  const essentialsChangePct = prevSpending !== null && prevSpending > 0
    ? Math.round(((essentials - prevSpending) / prevSpending) * 100)
    : null;

  const discItems = a.discretionary?.items ?? [];
  const topLifestyle = discItems.length > 0
    ? discItems.reduce((a, b) => a.monthly > b.monthly ? a : b)
    : null;

  // ── Budget solver: constrained optimisation ──
  // Reconstruct a minimal FinancialProfile from the stored Analysis to
  // run the solver. This finds the optimal reallocation of every pound.
  let allocationEfficiency: number | undefined;
  let topReallocation: { from: string; to: string; amount: number; utility_gain: string } | null | undefined = null;
  try {
    const profile = analysisToProfile(a);
    if (profile) {
      const allocation = solveBudgetAllocation(profile, identity);
      allocationEfficiency = allocation.efficiency;
      if (allocation.topReallocation) {
        topReallocation = {
          from: allocation.topReallocation.from,
          to: allocation.topReallocation.to,
          amount: allocation.topReallocation.amount,
          utility_gain: allocation.topReallocation.utilityGain,
        };
      }
    }
  } catch {}

  return {
    real_spending_power: Math.round(income - essentials),
    essentials_total: Math.round(essentials),
    lifestyle_total: Math.round(lifestyle),
    left_to_decide: Math.round(leftToDecide),
    essentials_pct: essentialsPct,
    over_budget: overBudget,
    over_amount: overAmount,
    essentials_change_pct: essentialsChangePct,
    top_lifestyle_category: topLifestyle?.category ?? null,
    top_lifestyle_amount: topLifestyle ? Math.round(topLifestyle.monthly) : null,
    allocation_efficiency: allocationEfficiency,
    top_reallocation: topReallocation,
  };
}

/** Reconstruct a minimal FinancialProfile from a stored Analysis for solver/MC use. */
function analysisToProfile(a: Analysis): FinancialProfile | null {
  if (!a.monthly_income) return null;
  const spending = a.monthly_spending || 0;
  return {
    monthly: {
      income: a.monthly_income,
      spending,
      surplus: a.surplus ?? (a.monthly_income - spending),
      subscriptions: 0,
      foodDelivery: 0,
      transport: 0,
      groceries: 0,
      shopping: 0,
      eatingOut: 0,
      entertainment: 0,
      debtPayments: 0,
    },
    budgetReality: {
      nonDiscretionary: a.non_discretionary ?? { total: 0, items: [] },
      discretionary: a.discretionary ?? { total: 0, items: [] },
    },
    incomeSources: a.income_sources ?? [],
    transfers: [],
    subscriptions: [],
    metrics: {
      savingsRate: a.monthly_income > 0 ? ((a.surplus ?? 0) / a.monthly_income) * 100 : 0,
      creditCardCount: 0,
      bnplCount: 0,
      debtAccountCount: 0,
      subscriptionCount: 0,
      streamingCount: 0,
      foodDelivery: 0,
      transport: 0,
      groceries: 0,
      shopping: 0,
      eatingOut: 0,
      coffeeAndCafes: 0,
      entertainment: 0,
      debtPayments: 0,
    },
  };
}

/** Build household cashflow scenario analysis for the chat context. */
function buildHouseholdCashflow(
  a: Analysis | null,
  identity: UserIdentity | null,
): ChatContext['household_cashflow'] {
  if (!a || !identity || !a.monthly_income) return null;
  // Only add household cashflow for non-single households or users with upcoming events
  const household = identity.household || 'single';
  const hasEvents = identity.upcoming_events?.some((e: any) => {
    const evtType = typeof e === 'string' ? e : e?.type || '';
    return evtType !== 'none';
  });
  const hasDeps = identity.dependents?.some((d: string) => d !== 'none');
  if (household === 'single' && !hasEvents && !hasDeps) return null;

  try {
    const profile = analysisToProfile(a);
    if (!profile) return null;
    const vol = estimateVolatility(profile, identity);
    const result = simulateHouseholdCashflow(profile, identity, vol);
    return {
      joint_surplus: result.jointSurplus,
      buffer_adequacy: result.bufferAdequacy,
      shared_expense_ratio: result.sharedExpenseRatio,
      scenarios: result.scenarios.map((s) => ({
        label: s.label,
        probability: s.probability,
        monthly_impact: s.monthlyImpact,
        description: s.description,
      })),
    };
  } catch {
    return null;
  }
}

// ── Styles ──
// Nothing Phone OS aesthetic: dot-matrix glyphs, monochrome, geometric minimalism.

const createStyles = (c: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.bg,
  },
  // ── Header — clean, borderless, floating ──
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl + spacing.sm,
    paddingBottom: 12,
    borderBottomWidth: 0,
  },
  headerLeftChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  chatBocyWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBocyHero: {
    marginBottom: spacing.md,
  },
  headerTitle: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: c.dim,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  clearButton: {
    paddingVertical: 5,
    paddingHorizontal: 14,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: 'transparent',
  },
  clearText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: c.dim,
    letterSpacing: 0.5,
  },
  messages: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  messagesContentEmpty: {
    flexGrow: 1,
  },
  // ── Voice-first hero (empty state) — flex layout for bottom pinning ──
  voiceHeroContainer: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    justifyContent: 'flex-end',
  },
  voiceHeroCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  voiceHeroTop: {
    alignItems: 'center',
    marginBottom: spacing.xl + spacing.sm,
  },
  voiceHeroTitle: {
    fontFamily: fonts.mono,
    fontSize: 22,
    color: c.text,
    textAlign: 'center',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  voiceHeroSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.muted,
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 260,
    letterSpacing: 0.3,
  },
  // ── Voice Orb — dot-matrix ring with inner glyph ──
  voiceOrbContainer: {
    width: 120,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  voiceOrb: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceOrbListening: {
    backgroundColor: c.green,
  },
  voiceOrbStop: {
    width: 18,
    height: 18,
    borderRadius: 3,
    backgroundColor: c.bg,
  },
  // ── Waveform visualiser — pulsing dots ──
  waveformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 28,
    marginBottom: spacing.sm,
  },
  waveformDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.green,
  },
  // ── Live transcript ──
  liveTranscript: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: c.text2,
    textAlign: 'center',
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
    lineHeight: 22,
  },
  // ── Type-instead toggle ──
  typeToggle: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  typeToggleText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  // ── Inline text input (empty state) ──
  inlineInputRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 10,
    alignItems: 'flex-end',
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
  },
  inlineInput: {
    flex: 1,
    fontFamily: fonts.regular,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: c.text,
  },
  inlineSendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inlineSendIcon: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: c.bg,
    marginTop: -1,
  },
  // ── Horizontal suggestion pills (pinned at bottom of empty state) ──
  suggestedContainer: {
    width: '100%',
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  suggestedScroll: {
    gap: 10,
    paddingHorizontal: spacing.sm,
  },
  suggestedChip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 100,
    paddingVertical: 10,
    paddingHorizontal: 18,
    backgroundColor: 'transparent',
  },
  suggestedChipText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
    letterSpacing: 0.3,
  },
  // ── Chat bubbles — sleek, minimal ──
  bubble: {
    maxWidth: '80%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginBottom: 12,
  },
  userBubble: {
    backgroundColor: c.accent,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
  },
  gifBubble: {
    width: '80%',
    maxWidth: '80%',
    paddingHorizontal: 4,
    paddingVertical: 4,
    overflow: 'hidden' as const,
  },
  bubbleText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 23,
  },
  userText: {
    color: c.bg,
  },
  // ── Animated typing dots ──
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.green,
  },
  // ── Action cards ──
  actionCardWrapper: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
    marginBottom: 12,
  },
  errorCardText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.coral,
    lineHeight: 20,
  },
  actionCardLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    color: c.dim,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
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
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    marginTop: 2,
    letterSpacing: 0.5,
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
  removeLink: {
    paddingTop: 8,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  removeLinkText: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.coral,
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
  goalUpdateLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1.5,
    color: c.sky,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
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
  // ── Voice-first input bar (conversation mode) — sleek, borderless ──
  voiceInputRow: {
    flexDirection: 'row',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    backgroundColor: c.bg,
    gap: 10,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    fontFamily: fonts.regular,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    fontSize: 15,
    color: c.text,
  },
  // ── Unified action button (glyph style) ──
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionButtonDisabled: {
    opacity: 0.3,
  },
  actionButtonListening: {
    backgroundColor: c.green,
  },
  actionButtonIcon: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    color: c.bg,
    marginTop: -1,
  },
  // ── Voice input orb (conversation-mode mic button — dot glyph) ──
  voiceInputOrb: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceInputOrbListening: {
    backgroundColor: c.green,
  },
  // ── Glyph stop icon ──
  glyphStop: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: c.bg,
  },

  // ── Free tier gate ──
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

  // ── Bocy label on assistant messages ──
  bocyLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    marginTop: 16,
  },
  bocyLabelDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: c.green,
  },
  bocyLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },

  // ── TTS (voice response) button ──
  ttsButton: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginTop: 4,
    marginBottom: 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: 'transparent',
  },
  ttsButtonText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: c.muted,
    letterSpacing: 0.5,
  },
  ttsButtonActive: {
    color: c.green,
  },

  // ── Follow-up suggestion chips (horizontal, inline after messages) ──
  followUpContainer: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  followUpScroll: {
    gap: 8,
    paddingVertical: 4,
  },
  followUpChip: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 100,
    paddingVertical: 10,
    paddingHorizontal: 16,
    backgroundColor: 'transparent',
  },
  followUpChipText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: c.text2,
    letterSpacing: 0.2,
  },
});
