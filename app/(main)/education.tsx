import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { hapticTick } from '@/lib/haptics';
import { colors, fonts, spacing } from '@/theme';
import { GlassMockupSpending, GlassMockupChat, GlassMockupNetWorth } from '@/components/Bocy';

// Per-slide gradient stops: [top, mid, bottom]
const SLIDE_GRADIENTS = [
  // Warm amber / sand dune
  ['#C4854C', '#A06E3F', '#8B5E34'],
  // Deep night sky
  ['#0A1628', '#122040', '#1B2D4A'],
  // Rich green leaf
  ['#2D5A1E', '#3B7324', '#4A8C2A'],
] as const;

const SLIDES = [
  {
    mockup: 'spending' as const,
    title: 'Optimise\nyour money',
    body: 'Net worth, spending, and investments.',
  },
  {
    mockup: 'chat' as const,
    title: 'Ask\nanything',
    body: 'Summaries, insights, and advice.',
  },
  {
    mockup: 'networth' as const,
    title: 'Grow your\nwealth',
    body: 'Forecasting, investing and more.',
    cta: "Let's get started",
  },
];

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
      {/* Title — large, white, serif-weight */}
      <Animated.Text style={[styles.title, {
        opacity: titleAnim,
        transform: [{ translateY: titleAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }]}>
        {slide.title}
      </Animated.Text>

      {/* Glass mockup card with parallax */}
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
        {slide.mockup === 'spending' && <GlassMockupSpending />}
        {slide.mockup === 'chat' && <GlassMockupChat />}
        {slide.mockup === 'networth' && <GlassMockupNetWorth />}
      </Animated.View>

      {/* Subtitle text */}
      <Animated.Text style={[styles.body, {
        opacity: bodyAnim,
        transform: [{ translateY: bodyAnim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
      }]}>
        {slide.body}
      </Animated.Text>
    </View>
  );
}

/** Interpolate a hex color channel between two values based on an Animated.Value */
function interpolateColor(scrollX: Animated.Value, width: number, slideIdx: number, colorA: string, colorB: string): Animated.AnimatedInterpolation<string> {
  return scrollX.interpolate({
    inputRange: [slideIdx * width, (slideIdx + 1) * width],
    outputRange: [colorA, colorB],
    extrapolate: 'clamp',
  });
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
      setCurrentPage(nextPage);
      (scrollRef.current as any)?.scrollTo({ x: nextPage * containerWidth, animated: true });
    }
  };

  const handleSkip = () => {
    trackEvent('Education Skipped', { skipped_at_slide: currentPage });
    router.push('/(main)/identity');
  };

  // Scroll-driven gradient color interpolation
  const gradientColors = containerWidth > 0
    ? [0, 1, 2].map((stop) => {
        // For each gradient stop (top/mid/bottom), interpolate across all slides
        if (SLIDE_GRADIENTS.length <= 1) return SLIDE_GRADIENTS[0][stop];
        // Build a full input/output range across all slides
        const inputRange = SLIDE_GRADIENTS.map((_, i) => i * containerWidth);
        const outputRange = SLIDE_GRADIENTS.map((g) => g[stop]);
        return scrollX.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
      })
    : SLIDE_GRADIENTS[0];

  return (
    <View
      style={styles.container}
      onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
    >
      {/* Animated gradient background */}
      <Animated.View style={StyleSheet.absoluteFill}>
        <LinearGradient
          colors={gradientColors as any}
          locations={[0, 0.5, 1]}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>

      {/* Vignette overlay for premium depth */}
      <LinearGradient
        colors={['rgba(0,0,0,0.3)', 'transparent', 'rgba(0,0,0,0.25)']}
        locations={[0, 0.4, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* Skip button */}
      {!isLast && (
        <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      )}

      {/* Horizontal snap carousel */}
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

      {/* Bottom area: dots + button */}
      <Animated.View style={[styles.bottomArea, {
        opacity: bottomEnter,
        transform: [{ translateY: bottomEnter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
      }]}>
        {/* Progress dots */}
        <View style={styles.dots}>
          {SLIDES.map((_, i) => {
            if (containerWidth <= 0) {
              return (
                <View
                  key={i}
                  style={[styles.progressDot, i === 0 && styles.dotActive]}
                />
              );
            }
            const dotWidth = scrollX.interpolate({
              inputRange: [(i - 1) * containerWidth, i * containerWidth, (i + 1) * containerWidth],
              outputRange: [8, 28, 8],
              extrapolate: 'clamp',
            });
            const dotOpacity = scrollX.interpolate({
              inputRange: [(i - 1) * containerWidth, i * containerWidth, (i + 1) * containerWidth],
              outputRange: [0.3, 1, 0.3],
              extrapolate: 'clamp',
            });
            return (
              <Animated.View
                key={i}
                style={[styles.progressDot, { width: dotWidth, opacity: dotOpacity, backgroundColor: '#FFFFFF' }]}
              />
            );
          })}
        </View>

        <TouchableOpacity
          style={styles.button}
          onPress={handleNext}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>
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
    backgroundColor: SLIDE_GRADIENTS[0][2], // fallback
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
    color: 'rgba(255,255,255,0.6)',
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
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 48,
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 56,
    letterSpacing: -1,
  },
  body: {
    fontFamily: fonts.medium,
    fontSize: 17,
    color: 'rgba(255,255,255,0.7)',
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
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  dotActive: {
    width: 28,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  button: {
    width: '100%',
    paddingVertical: 18,
    borderRadius: 100,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    shadowColor: '#fff',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});
