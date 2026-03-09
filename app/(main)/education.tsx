import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { hapticTick } from '@/lib/haptics';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyFace } from '@/components/Bocy';

const SLIDES = [
  {
    illustration: 'scan' as const,
    tag: 'PHILOSOPHY',
    title: "This isn't a\nbudgeting app",
    body: "Bocy looks at your whole financial picture, not just what you spend. It finds the one move that'll make the biggest difference right now.",
    accent: colors.accent,
    mood: 'neutral' as const,
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
    mood: 'thinking' as const,
  },
  {
    illustration: 'personal' as const,
    tag: 'PERSONALISED',
    title: 'Built around\nyour life',
    body: "Everyone's situation is different. Whether you're a freelancer, a parent, or just starting out, Bocy adapts to what matters to you.",
    cta: "Let's get to know you",
    accent: colors.green,
    mood: 'happy' as const,
  },
];

export default function Education() {
  const router = useRouter();
  const scrollX = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<any>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => { trackScreen('Education'); }, []);

  const isLast = currentPage === SLIDES.length - 1;

  const handleNext = () => {
    if (isLast) {
      trackEvent('Education Completed', { slides_viewed: currentPage + 1 });
      router.push('/(main)/identity');
    } else {
      trackEvent('Education Slide Viewed', { slide: currentPage + 1 });
      const nextPage = currentPage + 1;
      (scrollRef.current as any)?.scrollTo({ x: nextPage * containerWidth, animated: true });
    }
  };

  const handleSkip = () => {
    trackEvent('Education Skipped', { skipped_at_slide: currentPage });
    router.push('/(main)/identity');
  };

  return (
    <View
      style={styles.container}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
    >
      {/* Skip button */}
      {!isLast && (
        <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      )}

      {/* ── Horizontal snap carousel ── */}
      {containerWidth > 0 && (
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          decelerationRate="fast"
          snapToInterval={containerWidth}
          snapToAlignment="start"
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { x: scrollX } } }],
            { useNativeDriver: false },
          )}
          onMomentumScrollEnd={(e) => {
            const page = Math.round(e.nativeEvent.contentOffset.x / containerWidth);
            if (page !== currentPage) hapticTick();
            setCurrentPage(page);
          }}
          style={styles.carousel}
          contentContainerStyle={{ alignItems: 'center' }}
        >
          {SLIDES.map((slide, idx) => (
            <View key={idx} style={[styles.slideWrap, { width: containerWidth }]}>
              <View style={styles.content}>
                {/* Bocy character */}
                <View style={styles.bocyHero}>
                  <BocyFace mood={slide.mood} size="lg" breathing />
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
              </View>
            </View>
          ))}
        </Animated.ScrollView>
      )}

      {/* Bottom area: animated dots + button */}
      <View style={styles.bottomArea}>
        {/* Animated progress dots */}
        <View style={styles.dots}>
          {SLIDES.map((slide, i) => {
            if (containerWidth <= 0) {
              return (
                <View
                  key={i}
                  style={[styles.progressDot, i === 0 && [styles.dotActive, { backgroundColor: slide.accent }]]}
                />
              );
            }
            const dotWidth = scrollX.interpolate({
              inputRange: [(i - 1) * containerWidth, i * containerWidth, (i + 1) * containerWidth],
              outputRange: [8, 28, 8],
              extrapolate: 'clamp',
            });
            const dotBg = scrollX.interpolate({
              inputRange: [(i - 1) * containerWidth, i * containerWidth, (i + 1) * containerWidth],
              outputRange: [colors.muted, slide.accent, colors.muted],
              extrapolate: 'clamp',
            });
            return (
              <Animated.View
                key={i}
                style={[styles.progressDot, { width: dotWidth, backgroundColor: dotBg }]}
              />
            );
          })}
        </View>

        <TouchableOpacity
          style={[styles.button, isLast && { backgroundColor: colors.green }]}
          onPress={handleNext}
          activeOpacity={0.8}
        >
          <Text style={[styles.buttonText, isLast && { color: '#000000' }]}>
            {isLast ? (SLIDES[currentPage].cta || 'Continue') : 'Next'}
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
  carousel: {
    flex: 1,
  },
  slideWrap: {
    flex: 1,
    paddingHorizontal: spacing.xl + 4,
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
    paddingHorizontal: spacing.xl + 4,
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
