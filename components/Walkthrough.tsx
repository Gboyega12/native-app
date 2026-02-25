// ── Walkthrough component ──
// Modal overlay that walks new users through the app after onboarding.
// Shows step-by-step tooltips explaining key features.
// Persists "seen" state in AsyncStorage so it only shows once.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Animated, Easing,
  Dimensions, Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fonts, spacing, radius, animation } from '@/theme';
import { useTheme } from '@/lib/theme-context';

const WALKTHROUGH_KEY = '@bocy_walkthrough_seen';

type WalkthroughStep = {
  title: string;
  body: string;
  /** Position of the highlight indicator: 'top' | 'center' | 'bottom' */
  position: 'top' | 'center' | 'bottom';
};

const STEPS: WalkthroughStep[] = [
  {
    title: 'Your #1 Move',
    body: 'This is the single most impactful financial action you can take right now. Bocy analyses your transactions and ranks every opportunity by potential savings.',
    position: 'top',
  },
  {
    title: 'Safe to Spend',
    body: 'Your weekly lifestyle allowance — how much you can spend freely without affecting your goals. It updates every time income arrives or bills go out.',
    position: 'center',
  },
  {
    title: 'Your Budget Line',
    body: 'See exactly where every pound goes: essentials, lifestyle, and what\'s left over. Tap the info icon on any card for a deeper breakdown.',
    position: 'center',
  },
  {
    title: 'Plan Tab',
    body: 'Your ranked action plan with step-by-step moves. Start with the highest impact, work down. Each move tracks your progress as you go.',
    position: 'bottom',
  },
  {
    title: 'Chat with Bocy',
    body: 'Ask Bocy anything about your finances — "Can I afford X?", "How do I save more?", or "What\'s my biggest expense?". Bocy knows your numbers.',
    position: 'bottom',
  },
  {
    title: 'Add More Accounts',
    body: 'For a fuller picture, connect credit cards and savings accounts from your profile. The more Bocy sees, the smarter your plan.',
    position: 'bottom',
  },
];

type Props = {
  /** If true, show the walkthrough (caller checks AsyncStorage) */
  visible: boolean;
  onDismiss: () => void;
};

export default function Walkthrough({ visible, onDismiss }: Props) {
  const { colors } = useTheme();
  const [step, setStep] = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;

  const animateIn = useCallback(() => {
    fadeAnim.setValue(0);
    slideAnim.setValue(20);
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  useEffect(() => {
    if (visible) {
      setStep(0);
      animateIn();
    }
  }, [visible]);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      animateIn();
    } else {
      handleDone();
    }
  };

  const handleDone = async () => {
    await AsyncStorage.setItem(WALKTHROUGH_KEY, 'true');
    onDismiss();
  };

  if (!visible) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const progress = (step + 1) / STEPS.length;

  return (
    <Modal transparent visible={visible} animationType="fade" statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={handleNext}>
        <View style={[
          styles.tooltipContainer,
          current.position === 'top' && styles.tooltipTop,
          current.position === 'center' && styles.tooltipCenter,
          current.position === 'bottom' && styles.tooltipBottom,
        ]}>
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
            {/* Step indicator dots */}
            <View style={styles.dotsRow}>
              {STEPS.map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    { backgroundColor: i <= step ? colors.accent : colors.mintDim },
                  ]}
                />
              ))}
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
                  Skip tour
                </Text>
              </Pressable>

              <Pressable
                style={[styles.nextBtn, { backgroundColor: colors.accent }]}
                onPress={handleNext}
              >
                <Text style={[styles.nextBtnText, { color: colors.bg }]}>
                  {isLast ? 'Get started' : `Next (${step + 1}/${STEPS.length})`}
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
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
    });
  }, []);

  const dismiss = useCallback(() => {
    setShowWalkthrough(false);
  }, []);

  return { showWalkthrough, dismissWalkthrough: dismiss };
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
  },
  tooltipContainer: {
    paddingHorizontal: spacing.lg,
  },
  tooltipTop: {
    justifyContent: 'flex-start',
    paddingTop: 120,
  },
  tooltipCenter: {
    justifyContent: 'center',
  },
  tooltipBottom: {
    justifyContent: 'flex-end',
    paddingBottom: 120,
  },
  tooltip: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 28,
    maxWidth: 420,
    alignSelf: 'center',
    width: '100%',
  },
  dotsRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: 20,
    marginBottom: spacing.sm,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 24,
    marginBottom: spacing.xl,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  skipText: {
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  nextBtn: {
    borderRadius: 100,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  nextBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
});
