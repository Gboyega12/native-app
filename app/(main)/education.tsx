import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { hapticTick } from '@/lib/haptics';
import { colors, fonts, spacing, radius } from '@/theme';
import { MockupDashboard, MockupMoves, MockupChat } from '@/components/Bocy';

const SLIDES = [
  {
    mockup: 'dashboard' as const,
    title: "This isn't a\nbudgeting app",
    body: "Your whole picture.\nOne smart move.",
    accent: colors.accent,
  },
  {
    mockup: 'moves' as const,
    title: 'One step at\na time',
    body: "Biggest wins first.\nStep by step.",
    accent: colors.text2,
  },
  {
    mockup: 'chat' as const,
    title: 'Built around\nyour life',
    body: "Adapts to your life.\nAlways learning.",
    cta: "Let's get to know you",
    accent: colors.green,
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
      // Update page state directly — onMomentumScrollEnd doesn't fire
      // for programmatic scrollTo() on web and some native platforms,
      // which caused the button to get stuck on the Methods slide.
      setCurrentPage(nextPage);
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
                {/* Title — top, establishes context */}
                <Text style={styles.title}>{slide.title}</Text>

                {/* Mockup hero with scroll parallax */}
                <Animated.View style={[
                  styles.mockupWrap,
                  containerWidth > 0 ? {
                    opacity: scrollX.interpolate({
                      inputRange: [(idx - 1) * containerWidth, idx * containerWidth, (idx + 1) * containerWidth],
                      outputRange: [0.4, 1, 0.4],
                      extrapolate: 'clamp',
                    }),
                    transform: [{
                      scale: scrollX.interpolate({
                        inputRange: [(idx - 1) * containerWidth, idx * containerWidth, (idx + 1) * containerWidth],
                        outputRange: [0.88, 1, 0.88],
                        extrapolate: 'clamp',
                      }),
                    }],
                  } : {},
                ]}>
                  {slide.mockup === 'dashboard' && <MockupDashboard />}
                  {slide.mockup === 'moves' && <MockupMoves />}
                  {slide.mockup === 'chat' && <MockupChat />}
                </Animated.View>

                {/* Subtitle — punchy one-liner */}
                {slide.body && <Text style={styles.body}>{slide.body}</Text>}
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
    paddingTop: spacing.xxl,
  },
  mockupWrap: {
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 30,
    color: colors.text,
    textAlign: 'center',
    lineHeight: 38,
    letterSpacing: -0.3,
  },
  body: {
    fontFamily: fonts.medium,
    fontSize: 17,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 28,
    maxWidth: 480,
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
