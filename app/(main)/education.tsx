import { useState, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions, Animated,
  LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts, spacing, radius } from '@/theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const { width } = Dimensions.get('window');

const SLIDES = [
  {
    icon: '{ B }',
    iconColor: colors.accent,
    title: 'Not a budgeting app',
    subtitle: 'Your financial decisions assistant',
    body: "We don't track what you spend. We analyse your complete financial picture and tell you exactly what to do next — ranked by real impact on your life.",
    accent: colors.accent,
  },
  {
    icon: '>>>',
    iconColor: colors.sky,
    title: 'Map. Detect. Execute.',
    subtitle: 'Three layers of intelligence',
    bullets: [
      { label: 'Map', detail: 'income stability and spending identity' },
      { label: 'Detect', detail: 'optimisation opportunities others miss' },
      { label: 'Execute', detail: 'highest-impact actions first' },
    ],
    accent: colors.sky,
  },
  {
    icon: '//',
    iconColor: colors.lavender,
    title: 'Personalised to your life',
    subtitle: 'Your situation shapes every decision',
    body: "A hybrid worker gets different advice than a commuter. A single parent gets different advice than a couple. We need to understand who you are — not just what you spend.",
    cta: "Let's get to know you",
    accent: colors.lavender,
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
        {/* Icon */}
        <View style={[styles.iconCircle, { borderColor: slide.accent + '30' }]}>
          <Text style={[styles.iconText, { color: slide.accent }]}>{slide.icon}</Text>
        </View>

        {/* Title */}
        <Text style={styles.title}>{slide.title}</Text>
        <Text style={[styles.subtitle, { color: slide.accent }]}>{slide.subtitle}</Text>

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
          style={[styles.button, { backgroundColor: slide.accent }]}
          onPress={handleNext}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>
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
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  iconText: {
    fontFamily: fonts.heading,
    fontSize: 22,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 24,
    maxWidth: width * 0.85,
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
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },
});
