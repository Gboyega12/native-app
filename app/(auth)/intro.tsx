import { useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts, spacing } from '@/theme';
import { BocyHero } from '@/components/Bocy';

export default function Intro() {
  const router = useRouter();

  // Staggered entrance animations
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroScale = useRef(new Animated.Value(0.9)).current;
  const headlineOpacity = useRef(new Animated.Value(0)).current;
  const headlineY = useRef(new Animated.Value(12)).current;
  const sublineOpacity = useRef(new Animated.Value(0)).current;
  const benefitsOpacity = useRef(new Animated.Value(0)).current;
  const benefitsY = useRef(new Animated.Value(16)).current;
  const ctaOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const stagger = 150;
    const dur = 520;
    const ease = Easing.out(Easing.cubic);

    Animated.parallel([
      Animated.timing(heroOpacity, { toValue: 1, duration: dur, delay: 100, easing: ease, useNativeDriver: true }),
      Animated.timing(heroScale, { toValue: 1, duration: dur, delay: 100, easing: ease, useNativeDriver: true }),
    ]).start();

    Animated.parallel([
      Animated.timing(headlineOpacity, { toValue: 1, duration: dur, delay: 100 + stagger, easing: ease, useNativeDriver: true }),
      Animated.timing(headlineY, { toValue: 0, duration: dur, delay: 100 + stagger, easing: ease, useNativeDriver: true }),
    ]).start();

    Animated.timing(sublineOpacity, { toValue: 1, duration: dur, delay: 100 + stagger * 2, easing: ease, useNativeDriver: true }).start();

    Animated.parallel([
      Animated.timing(benefitsOpacity, { toValue: 1, duration: dur, delay: 100 + stagger * 3, easing: ease, useNativeDriver: true }),
      Animated.timing(benefitsY, { toValue: 0, duration: dur, delay: 100 + stagger * 3, easing: ease, useNativeDriver: true }),
    ]).start();

    Animated.timing(ctaOpacity, { toValue: 1, duration: dur, delay: 100 + stagger * 4, easing: ease, useNativeDriver: true }).start();
  }, []);

  return (
    <View style={s.container} testID="intro-screen">
      <View style={s.content}>
        {/* Hero character */}
        <Animated.View style={[s.heroWrap, { opacity: heroOpacity, transform: [{ scale: heroScale }] }]}>
          <BocyHero mood="happy" animate />
        </Animated.View>

        {/* Headline block */}
        <Animated.View style={{ opacity: headlineOpacity, transform: [{ translateY: headlineY }] }}>
          <Text style={s.tagline}>MEET BOCY</Text>
          <Text style={s.headline}>Your money,{'\n'}working harder</Text>
        </Animated.View>

        {/* Subline */}
        <Animated.Text style={[s.subline, { opacity: sublineOpacity }]}>
          Bocy connects to your bank, spots what's costing{'\n'}you, and shows you exactly how to fix it.
        </Animated.Text>

        {/* Dot-matrix separator */}
        <View style={s.dotSeparator}>
          {Array.from({ length: 5 }).map((_, i) => (
            <View key={i} style={s.dot} />
          ))}
        </View>

        {/* Benefit pills — progressive disclosure */}
        <Animated.View style={[s.benefits, { opacity: benefitsOpacity, transform: [{ translateY: benefitsY }] }]}>
          <BenefitItem
            num="01"
            text="Spots hidden costs"
            detail="Overpaying on debt, unnecessary fees, savings sitting idle"
          />
          <BenefitItem
            num="02"
            text="Ranks every fix by how much it saves you"
          />
          <BenefitItem
            num="03"
            text="Walks you through each one, step by step"
          />
        </Animated.View>

        {/* CTAs */}
        <Animated.View style={{ opacity: ctaOpacity }}>
          <TouchableOpacity
            style={s.primaryButton}
            onPress={() => router.push('/(auth)/sign-up')}
            activeOpacity={0.8}
            testID="intro-get-started"
            accessibilityRole="button"
            accessibilityLabel="Get started"
          >
            <Text style={s.primaryButtonText}>Get started</Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => router.push('/(auth)/sign-in')}
            activeOpacity={0.7}
            testID="intro-sign-in-link"
            accessibilityRole="button"
            accessibilityLabel="Go to sign in"
          >
            <Text style={s.signInLink}>
              Already have an account? <Text style={s.signInLinkAccent}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </View>
  );
}

function BenefitItem({ num, text, detail }: { num: string; text: string; detail?: string }) {
  return (
    <View style={s.benefitRow}>
      <Text style={s.benefitNum}>{num}</Text>
      <View style={s.benefitContent}>
        <Text style={s.benefitText}>{text}</Text>
        {detail && <Text style={s.benefitDetail}>{detail}</Text>}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl + 4,
    paddingBottom: spacing.xxl + spacing.lg,
    maxWidth: 560,
    alignSelf: 'center' as const,
    width: '100%',
  },
  heroWrap: {
    alignItems: 'center',
    marginBottom: spacing.xl + spacing.sm,
  },
  tagline: {
    fontFamily: fonts.mono,
    fontSize: 10,
    color: colors.muted,
    letterSpacing: 3,
    textTransform: 'uppercase',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  headline: {
    fontFamily: fonts.heading,
    fontSize: 28,
    color: colors.text,
    textAlign: 'center',
    lineHeight: 36,
    marginBottom: spacing.md,
    letterSpacing: -0.3,
    // Letterpress: subtle inset shadow effect
    textShadowColor: 'rgba(255,255,255,0.06)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 0,
  },
  subline: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.dim,
    textAlign: 'center',
    lineHeight: 22,
  },
  dotSeparator: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingVertical: spacing.lg,
  },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.border,
  },
  benefits: {
    marginBottom: spacing.xxl,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
    paddingLeft: spacing.xs,
  },
  benefitNum: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.green,
    letterSpacing: 1,
    width: 32,
    marginTop: 3,
  },
  benefitContent: {
    flex: 1,
  },
  benefitText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    lineHeight: 22,
  },
  benefitDetail: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.muted,
    lineHeight: 19,
    marginTop: 2,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: 100,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  primaryButtonText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
    letterSpacing: 0.2,
  },
  signInLink: {
    fontFamily: fonts.regular,
    textAlign: 'center',
    color: colors.dim,
    fontSize: 14,
  },
  signInLinkAccent: {
    color: colors.accent,
  },
});
