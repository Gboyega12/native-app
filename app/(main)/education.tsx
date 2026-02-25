import { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
  Platform, UIManager,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyFace, IllustrationScan, IllustrationPlan, IllustrationPersonal } from '@/components/Bocy';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SLIDES = [
  {
    illustration: 'scan' as const,
    title: "This isn't a budgeting app",
    body: "Bocy looks at your whole financial picture, not just what you spend. It finds the one move that'll make the biggest difference right now.",
    accent: colors.accent,
  },
  {
    illustration: 'plan' as const,
    title: 'See it. Rank it. Do it.',
    bullets: [
      { label: 'See', detail: 'your income, spending, and patterns in one place' },
      { label: 'Rank', detail: 'every opportunity by how much it actually helps' },
      { label: 'Do', detail: 'the highest impact action first, step by step' },
    ],
    accent: colors.text2,
  },
  {
    illustration: 'personal' as const,
    title: 'Built around your life',
    body: "Everyone's situation is different. Whether you're a freelancer, a parent, or just starting out, Bocy adapts to what matters to you.",
    cta: "Let's get to know you",
    accent: colors.green,
  },
];

export default function Education() {
  const router = useRouter();
  const [current, setCurrent] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  const slide = SLIDES[current];
  const isLast = current === SLIDES.length - 1;

  const animateTransition = (next: number) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      setCurrent(next);
      Animated.timing(fadeAnim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    });
  };

  const handleNext = () => {
    if (isLast) {
      router.push('/(main)/identity');
    } else {
      animateTransition(current + 1);
    }
  };

  const handleSkip = () => {
    router.push('/(main)/identity');
  };

  return (
    <View style={styles.container}>
      {/* Skip button */}
      {!isLast && (
        <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      )}

      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        {/* Illustration */}
        <View style={styles.illustrationWrap}>
          {slide.illustration === 'scan' && <IllustrationScan />}
          {slide.illustration === 'plan' && <IllustrationPlan />}
          {slide.illustration === 'personal' && <IllustrationPersonal />}
        </View>

        {/* Bocy face as companion indicator */}
        <View style={styles.bocyIndicator}>
          <BocyFace
            mood={current === 0 ? 'neutral' : current === 1 ? 'thinking' : 'happy'}
            size="sm"
            breathing
          />
        </View>

        {/* Title */}
        <Text style={styles.title}>{slide.title}</Text>

        {/* Body or bullets */}
        {slide.body && <Text style={styles.body}>{slide.body}</Text>}
        {slide.bullets && (
          <View style={styles.bullets}>
            {slide.bullets.map((b, i) => (
              <View key={i} style={styles.bulletRow}>
                <View style={[styles.bulletDot, { backgroundColor: slide.accent }]}>
                  <Text style={styles.bulletNum}>{i + 1}</Text>
                </View>
                <View style={styles.bulletContent}>
                  <Text style={[styles.bulletLabel, { color: slide.accent }]}>{b.label}</Text>
                  <Text style={styles.bulletDetail}>{b.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </Animated.View>

      {/* Bottom area: dots + button */}
      <View style={styles.bottomArea}>
        {/* Progress dots */}
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i === current && [styles.dotActive, { backgroundColor: slide.accent }],
              ]}
            />
          ))}
        </View>

        <TouchableOpacity
          style={[styles.button, isLast && { backgroundColor: colors.green }]}
          onPress={handleNext}
          activeOpacity={0.8}
        >
          <Text style={[styles.buttonText, isLast && { color: '#000000' }]}>
            {isLast ? (slide.cta || 'Continue') : 'Next'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
    maxWidth: 640,
    alignSelf: 'center' as const,
    width: '100%',
  },
  skipBtn: {
    position: 'absolute',
    top: spacing.xxl + spacing.sm,
    right: spacing.xl,
    zIndex: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  skipText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.dim,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  illustrationWrap: {
    marginBottom: spacing.lg,
    alignItems: 'center',
  },
  bocyIndicator: {
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: 480,
  },
  bullets: {
    width: '100%',
    paddingHorizontal: spacing.sm,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
  },
  bulletDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
    marginTop: 2,
  },
  bulletNum: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.bg,
  },
  bulletContent: {
    flex: 1,
  },
  bulletLabel: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    marginBottom: 2,
  },
  bulletDetail: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    lineHeight: 20,
  },
  bottomArea: {
    paddingBottom: spacing.xxl,
    alignItems: 'center',
  },
  dots: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: spacing.lg,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.muted,
  },
  dotActive: {
    width: 24,
    borderRadius: 4,
  },
  button: {
    width: '100%',
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },
});
