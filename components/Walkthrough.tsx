// ── Walkthrough component ──
// Interactive walkthrough that scrolls to actual cards/sections and
// shows a tooltip near each card. Uses a light scrim so the underlying
// card remains visible (no opaque modal blocking the view).
// Persists "seen" state in AsyncStorage so it only shows once.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, Easing, Dimensions,
  type ScrollView, type LayoutChangeEvent,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Router } from 'expo-router';
import { fonts, spacing, radius } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { BocyFace } from '@/components/Bocy';

const WALKTHROUGH_KEY = '@bocy_walkthrough_seen';

type WalkthroughStep = {
  title: string;
  body: string;
  /** Which key in cardPositions to spotlight */
  scrollTo?: string;
  /** Where the tooltip appears relative to the card */
  tooltipPosition: 'below' | 'above';
  /** Emoji-style label shown above the title */
  tag?: string;
};

const STEPS: WalkthroughStep[] = [
  {
    title: 'Your #1 Move',
    body: 'Your highest-impact action right now. Bocy ranks every opportunity by how much it saves you.',
    scrollTo: 'hero',
    tooltipPosition: 'below',
    tag: 'TOP PICK',
  },
  {
    title: 'Safe to Spend',
    body: 'How much you can freely spend this week without touching your goals. Updates automatically.',
    scrollTo: 'hero',
    tooltipPosition: 'below',
    tag: 'WEEKLY',
  },
  {
    title: 'Your Budget',
    body: 'Where every pound goes: essentials, lifestyle, and what\u2019s left. Tap any category for the breakdown.',
    scrollTo: 'budget',
    tooltipPosition: 'above',
    tag: 'SPENDING',
  },
  {
    title: 'Your Moves',
    body: 'Personalised actions ranked by impact. Start a move, tick off steps, and watch your progress grow.',
    scrollTo: 'moves',
    tooltipPosition: 'above',
    tag: 'ACTION',
  },
  {
    title: 'Chat with Bocy',
    body: '\u201CCan I afford this?\u201D \u201CWhat\u2019s my biggest expense?\u201D Ask anything \u2014 Bocy knows your numbers.',
    tooltipPosition: 'below',
    tag: 'ASK ME',
  },
];

type Props = {
  visible: boolean;
  onDismiss: () => void;
  /** Ref to the dashboard ScrollView for scrolling to cards */
  scrollRef?: React.RefObject<ScrollView>;
  /** Y positions of key cards on the dashboard, keyed by name */
  cardPositions?: React.MutableRefObject<Record<string, number>>;
  /** Router for tab navigation */
  router?: Router;
};

export default function Walkthrough({ visible, onDismiss, scrollRef, cardPositions, router }: Props) {
  const { colors } = useTheme();
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;

  const animateIn = useCallback(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(16);
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // Navigate / scroll to the correct position for a step
  const navigateToStep = useCallback((stepIndex: number) => {
    const s = STEPS[stepIndex];

    // Last step → navigate to chat tab
    if (stepIndex === STEPS.length - 1 && router) {
      router.navigate('/(main)/(tabs)/chat');
      return;
    }

    // All other steps are on the home tab
    if (router) {
      router.navigate('/(main)/(tabs)');
    }

    if (s.scrollTo && scrollRef?.current && cardPositions?.current) {
      const y = cardPositions.current[s.scrollTo];
      if (y != null) {
        setTimeout(() => {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 120), animated: true });
        }, 100);
      }
    }
  }, [scrollRef, cardPositions, router]);

  useEffect(() => {
    if (visible) {
      setStep(0);
      animateIn();
      setTimeout(() => navigateToStep(0), 200);
    }
  }, [visible]);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      const next = step + 1;
      setStep(next);
      navigateToStep(next);
      animateIn();
    } else {
      handleDone();
    }
  };

  const handleDone = async () => {
    if (router) {
      router.navigate('/(main)/(tabs)');
    }
    if (scrollRef?.current) {
      scrollRef.current.scrollTo({ y: 0, animated: true });
    }
    try { await AsyncStorage.setItem(WALKTHROUGH_KEY, 'true'); } catch {}
    onDismiss();
  };

  if (!visible) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  const tooltip = (
    <Animated.View
      style={[
        styles.tooltip,
        {
          backgroundColor: colors.surface,
          borderColor: colors.accentDim,
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }],
        },
      ]}
    >
      {/* Progress bar */}
      <View style={[styles.progressTrack, { backgroundColor: colors.mintDim }]}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              backgroundColor: colors.green,
              width: `${((step + 1) / STEPS.length) * 100}%`,
            },
          ]}
        />
      </View>

      {/* Tag + Bocy face */}
      <View style={styles.tagRow}>
        {current.tag && (
          <View style={[styles.tag, { backgroundColor: colors.greenDim }]}>
            <Text style={[styles.tagText, { color: colors.green }]}>{current.tag}</Text>
          </View>
        )}
        <View style={styles.tagBocyWrap}>
          <BocyFace mood="happy" size="sm" breathing />
        </View>
      </View>

      {/* Content */}
      <Text style={[styles.title, { color: colors.text }]}>
        {current.title}
      </Text>
      <Text style={[styles.body, { color: colors.text2 }]}>
        {current.body}
      </Text>

      {/* Actions */}
      <View style={styles.actions}>
        <Pressable onPress={handleDone} hitSlop={10}>
          <Text style={[styles.skipText, { color: colors.muted }]}>
            Skip
          </Text>
        </Pressable>

        <View style={styles.actionsRight}>
          <Text style={[styles.stepCounter, { color: colors.dim }]}>
            {step + 1}/{STEPS.length}
          </Text>
          <Pressable
            style={[styles.nextBtn, { backgroundColor: colors.accent }]}
            onPress={handleNext}
          >
            <Text style={[styles.nextBtnText, { color: colors.bg }]}>
              {isLast ? 'Let\u2019s go' : 'Next'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );

  return (
    <Pressable style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.4)' }]} onPress={handleNext}>
      <View style={[
        styles.tooltipContainer,
        current.tooltipPosition === 'below' && styles.tooltipNearTop,
        current.tooltipPosition === 'above' && styles.tooltipNearBottom,
      ]}>
        {/* Arrow pointing up (tooltip is below the card) */}
        {current.tooltipPosition === 'below' && (
          <View style={[styles.arrowUp, { borderBottomColor: colors.surface }]} />
        )}

        {tooltip}

        {/* Arrow pointing down (tooltip is above the card) */}
        {current.tooltipPosition === 'above' && (
          <View style={[styles.arrowDown, { borderTopColor: colors.surface }]} />
        )}
      </View>
    </Pressable>
  );
}

// ── Hook to check if walkthrough should show ──
export function useWalkthrough() {
  const [showWalkthrough, setShowWalkthrough] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(WALKTHROUGH_KEY).then((val) => {
      if (val !== 'true') {
        // Small delay so the dashboard has time to render first
        setTimeout(() => setShowWalkthrough(true), 800);
      }
    }).catch(() => {});
  }, []);

  const dismiss = useCallback(() => {
    setShowWalkthrough(false);
  }, []);

  return { showWalkthrough, dismissWalkthrough: dismiss };
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
  },
  tooltipContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  tooltipNearTop: {
    top: 130,
  },
  tooltipNearBottom: {
    bottom: 100,
  },
  tooltip: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 24,
    paddingTop: 16,
    maxWidth: 400,
    width: '100%',
  },
  // ── Progress bar ──
  progressTrack: {
    height: 3,
    borderRadius: 2,
    marginBottom: spacing.md,
  },
  progressFill: {
    height: 3,
    borderRadius: 2,
  },
  // ── Tag + Bocy ──
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  tag: {
    borderRadius: 100,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  tagText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
  },
  tagBocyWrap: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 22,
    marginBottom: 6,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepCounter: {
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  skipText: {
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  nextBtn: {
    borderRadius: 100,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  nextBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  // ── Pointer arrows ──
  arrowUp: {
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderBottomWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: -1,
    alignSelf: 'center',
  },
  arrowDown: {
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: -1,
    alignSelf: 'center',
  },
});
