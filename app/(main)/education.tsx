import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyFace } from '@/components/Bocy';

const SLIDES = [
  {
    illustration: 'scan' as const,
    tag: 'PHILOSOPHY',
    title: "This isn't a\nbudgeting app",
    body: "Bocy looks at your whole financial picture, not just what you spend. It finds the one move that'll make the biggest difference right now.",
    accent: colors.accent,
  },
  {
    illustration: 'plan' as const,
    tag: 'METHOD',
    title: 'See it. Rank it.\nDo it.',
    bullets: [
      { label: 'See', detail: 'your income, spending, and patterns in one place' },
      { label: 'Rank', detail: 'every opportunity by how much it actually helps' },
      { label: 'Do', detail: 'the highest impact action first, step by step' },
    ],
    accent: colors.text2,
  },
  {
    illustration: 'personal' as const,
    tag: 'PERSONALISED',
    title: 'Built around\nyour life',
    body: "Everyone's situation is different. Whether you're a freelancer, a parent, or just starting out, Bocy adapts to what matters to you.",
    cta: "Let's get to know you",
    accent: colors.green,
  },
];

export default function Education() {
  const router = useRouter();
  const [current, setCurrent] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;

  // Track page view on mount
  useEffect(() => { trackScreen('Education'); }, []);

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
      trackEvent('Education Completed', { slides_viewed: current + 1 });
      router.push('/(main)/identity');
    } else {
      trackEvent('Education Slide Viewed', { slide: current + 1 });
      animateTransition(current + 1);
    }
  };

  const handleSkip = () => {
    trackEvent('Education Skipped', { skipped_at_slide: current });
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
        {/* Bocy character */}
        <View style={styles.bocyHero}>
          <BocyFace
            mood={current === 0 ? 'neutral' : current === 1 ? 'thinking' : 'happy'}
            size="lg"
            breathing
          />
        </View>

        {/* Tag */}
        <Text style={[styles.tag, { color: slide.accent }]}>{slide.tag}</Text>

        {/* Title */}
        <Text style={styles.title}>{slide.title}</Text>

        {/* Dot separator */}
        <View style={styles.dotSeparator}>
          {Array.from({ length: 3 }).map((_, i) => (
            <View key={i} style={[styles.dot, { backgroundColor: slide.accent + '40' }]} />
          ))}
        </View>

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
                styles.progressDot,
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
    paddingHorizontal: spacing.xl + 4,
    maxWidth: 640,
    alignSelf: 'center' as const,
    width: '100%',
  },
  skipBtn: {
    position: 'absolute',
    top: spacing.xxl + spacing.sm,
    right: spacing.xl,
    zIndex: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 44,
    justifyContent: 'center',
  },
  skipText: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.dim,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bocyHero: {
    marginBottom: spacing.xl + spacing.sm,
    alignItems: 'center',
  },
  tag: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 30,
    color: colors.text,
    textAlign: 'center',
    lineHeight: 38,
    letterSpacing: -0.3,
  },
  dotSeparator: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginVertical: spacing.lg,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 26,
    maxWidth: 480,
    paddingHorizontal: spacing.sm,
  },
  bullets: {
    width: '100%',
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.xl + spacing.xs,
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
    marginBottom: 4,
  },
  bulletDetail: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text2,
    lineHeight: 22,
  },
  bottomArea: {
    paddingBottom: spacing.xxl + spacing.sm,
    alignItems: 'center',
  },
  dots: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: spacing.lg + spacing.xs,
  },
  progressDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.muted,
  },
  dotActive: {
    width: 28,
    borderRadius: 4,
  },
  button: {
    width: '100%',
    paddingVertical: 16,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
    letterSpacing: 0.2,
  },
});
