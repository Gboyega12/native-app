import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Easing,
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

// Staggered entrance for each slide's content elements
function SlideContent({ slide, idx, containerWidth, scrollX }: {
  slide: typeof SLIDES[number]; idx: number; containerWidth: number; scrollX: Animated.Value;
}) {
  const titleAnim = useRef(new Animated.Value(0)).current;
  const mockupAnim = useRef(new Animated.Value(0)).current;
  const bodyAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.stagger(140, [
      Animated.timing(titleAnim, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(mockupAnim, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(bodyAnim, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <View style={styles.content}>
      {/* Title */}
      <Animated.Text style={[styles.title, {
        opacity: titleAnim,
        transform: [{ translateY: titleAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }],
      }]}>
        {slide.title}
      </Animated.Text>

      {/* Mockup hero with scroll parallax */}
      <Animated.View style={[
        styles.mockupWrap,
        {
          opacity: Animated.multiply(
            mockupAnim,
            containerWidth > 0 ? scrollX.interpolate({
              inputRange: [(idx - 1) * containerWidth, idx * containerWidth, (idx + 1) * containerWidth],
              outputRange: [0.4, 1, 0.4],
              extrapolate: 'clamp',
            }) : new Animated.Value(1),
          ),
          transform: [
            { translateY: mockupAnim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) },
            ...(containerWidth > 0 ? [{
              scale: scrollX.interpolate({
                inputRange: [(idx - 1) * containerWidth, idx * containerWidth, (idx + 1) * containerWidth],
                outputRange: [0.88, 1, 0.88],
                extrapolate: 'clamp',
              }),
            }] : []),
          ],
        },
      ]}>
        {slide.mockup === 'dashboard' && <MockupDashboard />}
        {slide.mockup === 'moves' && <MockupMoves />}
        {slide.mockup === 'chat' && <MockupChat />}
      </Animated.View>

      {/* Body text */}
      {slide.body && (
        <Animated.Text style={[styles.body, {
          opacity: bodyAnim,
          transform: [{ translateY: bodyAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        }]}>
          {slide.body}
        </Animated.Text>
      )}
    </View>
  );
}

export default function Education() {
  const router = useRouter();
  const scrollX = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef<any>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const bottomEnter = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    trackScreen('Education');
    Animated.timing(bottomEnter, { toValue: 1, duration: 700, delay: 400, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []);

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
              <SlideContent slide={slide} idx={idx} containerWidth={containerWidth} scrollX={scrollX} />
            </View>
          ))}
        </Animated.ScrollView>
      )}

      {/* Bottom area: animated dots + button */}
      <Animated.View style={[styles.bottomArea, {
        opacity: bottomEnter,
        transform: [{ translateY: bottomEnter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }]}>
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
      </Animated.View>
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
    top: spacing.xxl + spacing.md,
    right: spacing.xl,
    zIndex: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 44,
    justifyContent: 'center',
  },
  skipText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.dim,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  carousel: {
    flex: 1,
  },
  slideWrap: {
    flex: 1,
    paddingHorizontal: spacing.xl + spacing.sm,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: spacing.xxl + spacing.md,
  },
  mockupWrap: {
    alignItems: 'center',
    marginTop: spacing.xxl,
    marginBottom: spacing.xxl,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 32,
    color: colors.text,
    textAlign: 'center',
    lineHeight: 42,
    letterSpacing: -0.5,
  },
  body: {
    fontFamily: fonts.medium,
    fontSize: 17,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 28,
    maxWidth: 480,
    letterSpacing: 0.1,
  },
  bottomArea: {
    paddingBottom: spacing.xxl + spacing.md,
    paddingHorizontal: spacing.xl + spacing.sm,
    alignItems: 'center',
  },
  dots: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: spacing.xl,
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
    paddingVertical: 18,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
    letterSpacing: 0.3,
  },
});
