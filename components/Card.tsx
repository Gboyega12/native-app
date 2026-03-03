// ── Card component system ──
// Reusable card primitives with variants, press feedback, and entrance animations.
// Nothing OS design language: border-defined, minimal shadows, monochrome-first.

import { useRef, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, Easing,
  Platform, LayoutAnimation, type ViewStyle, type TextStyle,
} from 'react-native';
import { fonts, spacing, radius, cardShadow, animation, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';

// ── Smooth layout animation config ──
export const SMOOTH_ANIM = {
  duration: animation.expand.duration,
  create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
};

// ── Card variants ──
export type CardVariant = 'default' | 'hero' | 'active' | 'highlight' | 'error' | 'upgrade' | 'action' | 'compact';

type CardProps = {
  children: React.ReactNode;
  variant?: CardVariant;
  /** Override border color (e.g. for hero cards with green accent) */
  borderColor?: string;
  /** Make the card pressable with scale feedback */
  onPress?: () => void;
  /** Accessibility label */
  accessibilityLabel?: string;
  /** Additional style */
  style?: ViewStyle | ViewStyle[];
  /** Disable shadow elevation */
  noShadow?: boolean;
  /** Test ID for testing */
  testID?: string;
};

export default function Card({
  children,
  variant = 'default',
  borderColor,
  onPress,
  accessibilityLabel,
  style,
  noShadow,
  testID,
}: CardProps) {
  const { colors, isDark } = useTheme();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const shadow = noShadow ? {} : isDark ? cardShadow.dark : cardShadow.light;

  const variantStyles = getVariantStyles(colors, variant, borderColor);

  const handlePressIn = useCallback(() => {
    Animated.timing(scaleAnim, {
      toValue: animation.press.scale,
      duration: animation.press.duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  const handlePressOut = useCallback(() => {
    Animated.timing(scaleAnim, {
      toValue: 1,
      duration: animation.press.duration * 1.5,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  const cardStyle: ViewStyle[] = [
    styles.base,
    shadow,
    variantStyles,
    ...(Array.isArray(style) ? style : style ? [style] : []),
  ];

  if (onPress) {
    return (
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          style={cardStyle}
        >
          {children}
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={cardStyle}
    >
      {children}
    </View>
  );
}

// ── CardTitle ──
// Mono uppercase section title within a card.
export function CardTitle({ children, color, style }: { children: React.ReactNode; color?: string; style?: TextStyle }) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.title, { color: color || colors.text2 }, style]}>
      {children}
    </Text>
  );
}

// ── CardTitleRow ──
// Card title with an optional info/action element on the right.
export function CardTitleRow({
  title,
  titleColor,
  right,
  style,
}: {
  title: string;
  titleColor?: string;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.titleRow, style]}>
      <Text style={[styles.title, titleColor ? { color: titleColor } : { color: colors.text2 }]}>
        {title}
      </Text>
      {right}
    </View>
  );
}

// ── AnimatedCard ──
// Card with staggered entrance animation (fade + scale).
export function AnimatedCard({
  children,
  delay = 0,
  variant = 'default',
  borderColor,
  onPress,
  accessibilityLabel,
  style,
  noShadow,
}: CardProps & { delay?: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: animation.entrance.duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [{
          scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }),
        }, {
          translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
        }],
      }}
    >
      <Card
        variant={variant}
        borderColor={borderColor}
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        style={style}
        noShadow={noShadow}
      >
        {children}
      </Card>
    </Animated.View>
  );
}

// ── AnimGlyph ──
// Lightweight fade + scale entrance for any content (not just cards).
export function AnimGlyph({ children, delay = 0, style }: { children: React.ReactNode; delay?: number; style?: any }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: animation.entrance.duration,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: anim,
          transform: [{
            scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
          }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

// ── BreathingBar ──
// Subtle pulse animation for progress indicators.
export function BreathingBar({ color, width: barWidth, style }: { color: string; width: string; style?: any }) {
  const breathAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, { toValue: 1, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(breathAnim, { toValue: 0, duration: 2000, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ]),
    ).start();
  }, []);

  const opacity = breathAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0.95] });

  return (
    <Animated.View style={[style, { width: barWidth, backgroundColor: color, opacity }]} />
  );
}

// ── InfoBox ──
// Expandable info tooltip within cards.
export function InfoBox({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.infoBox, { backgroundColor: colors.mintDim, borderColor: colors.mintDim }, style]}>
      {children}
    </View>
  );
}

// ── InfoIcon ──
// Small circular info/close toggle.
export function InfoIcon({ expanded, onPress }: { expanded: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      onPress={() => {
        LayoutAnimation.configureNext(SMOOTH_ANIM);
        onPress();
      }}
    >
      <Text style={[styles.infoIconText, { color: colors.dim, borderColor: colors.border }]}>
        {expanded ? '\u2715' : 'i'}
      </Text>
    </Pressable>
  );
}

// ── Variant style resolver ──
function getVariantStyles(c: ThemeColors, variant: CardVariant, borderColor?: string): ViewStyle {
  const base: ViewStyle = {
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: borderColor || c.border,
  };

  switch (variant) {
    case 'hero':
      // Monochrome hero — elevated by accent border, no green tint
      return { ...base, borderColor: borderColor || c.accent, borderWidth: 1.5 };
    case 'active':
      return { ...base, borderColor: borderColor || c.accentDim };
    case 'highlight':
      return { ...base, borderColor: borderColor || c.accent, borderWidth: 1.5 };
    case 'error':
      return { ...base, backgroundColor: c.coralDim, borderColor: borderColor || c.coral };
    case 'upgrade':
      return { ...base, borderColor: borderColor || c.accentDim };
    case 'action':
      return { ...base, backgroundColor: c.surface, borderColor: borderColor || c.accentDim };
    case 'compact':
      return { ...base, padding: spacing.md, borderRadius: radius.md };
    default:
      return base;
  }
}

// ── Shared styles ──
const styles = StyleSheet.create({
  base: {
    borderRadius: 20,
    padding: 24,
    paddingTop: 28,
    paddingBottom: 28,
    marginBottom: 14,
    overflow: 'hidden' as const,
  },
  title: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoBox: {
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    marginBottom: 10,
    borderWidth: 1,
  },
  infoIconText: {
    fontFamily: fonts.mono,
    fontSize: 11,
    width: 22,
    height: 22,
    lineHeight: 22,
    textAlign: 'center',
    borderWidth: 1,
    borderRadius: 11,
    overflow: 'hidden',
  },
});
