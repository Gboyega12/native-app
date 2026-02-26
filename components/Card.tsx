// ── Card component system ──
// Reusable card primitives with variants, press feedback, and entrance animations.
// Nothing OS design language: border-defined, minimal shadows, monochrome-first.
// Dot-matrix accents echo the app's grid identity.

import { useRef, useEffect, useCallback, useMemo } from 'react';
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
  /** Show a colored accent line at the top of the card */
  accentLine?: string;
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
  accentLine,
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

  // Resolve accent line color: explicit prop > variant default
  const resolvedAccent = accentLine || getVariantAccent(colors, variant);

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

  const inner = (
    <>
      {/* Accent line — subtle top-edge color strip */}
      {resolvedAccent && (
        <View style={[styles.accentLine, { backgroundColor: resolvedAccent }]} />
      )}
      {/* Dot-grid overlay for hero cards */}
      {variant === 'hero' && (
        <DotGrid color={colors.green} />
      )}
      {children}
    </>
  );

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
          {inner}
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
      {inner}
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
  accentLine,
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
        accentLine={accentLine}
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

  const opacity = breathAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] });

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

// ── DotGrid ──
// Subtle dot-matrix pattern in the top-right corner of hero cards.
// Evokes the app's dot-matrix "B" branding. Pure RN Views — no SVG dependency.
function DotGrid({ color, cols = 5, rows = 3 }: { color: string; cols?: number; rows?: number }) {
  const dots = useMemo(() => {
    const arr = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        arr.push({ key: `${r}-${c}`, top: r * 8, left: c * 8 });
      }
    }
    return arr;
  }, [cols, rows]);

  return (
    <View style={styles.dotGrid} pointerEvents="none">
      {dots.map((d) => (
        <View
          key={d.key}
          style={[styles.dot, { top: d.top, left: d.left, backgroundColor: color }]}
        />
      ))}
    </View>
  );
}

// ── DotMatrixBar ──
// A horizontal row of evenly spaced dots, inspired by the Nothing Phone glyph interface.
// Use at the top of special cards for visual emphasis.
export function DotMatrixBar({
  color,
  dotCount = 12,
  dotSize = 3,
  gap = 6,
  style,
}: {
  color?: string;
  dotCount?: number;
  dotSize?: number;
  gap?: number;
  style?: ViewStyle;
}) {
  const { colors } = useTheme();
  const dotColor = color || colors.dim;
  const dots = useMemo(() => Array.from({ length: dotCount }, (_, i) => i), [dotCount]);

  return (
    <View style={[styles.dotMatrixBar, style]}>
      {dots.map((i) => (
        <View
          key={i}
          style={{
            width: dotSize,
            height: dotSize,
            borderRadius: dotSize / 2,
            backgroundColor: dotColor,
            marginHorizontal: gap / 2,
          }}
        />
      ))}
    </View>
  );
}

// ── CardDivider ──
// Subtle horizontal separator for visual breaks within a card.
// Renders as a fine line or a dot-matrix row depending on the variant.
export function CardDivider({ dotted, color, style }: { dotted?: boolean; color?: string; style?: ViewStyle }) {
  const { colors } = useTheme();
  const lineColor = color || colors.border;

  if (dotted) {
    return (
      <View style={[styles.divider, style]}>
        <DotMatrixBar color={lineColor} dotCount={20} dotSize={2} gap={4} />
      </View>
    );
  }

  return (
    <View style={[styles.divider, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: lineColor }, style]} />
  );
}

// ── CardBadge ──
// Small pill badge for effort level, status, or category indicators within cards.
export function CardBadge({ label, color, textColor, style }: { label: string; color?: string; textColor?: string; style?: ViewStyle }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: color || colors.accentDim }, style]}>
      <Text style={[styles.badgeText, { color: textColor || colors.text2 }]}>
        {label}
      </Text>
    </View>
  );
}

// ── Accent line color resolver ──
// Returns the default accent line color for variants that should have one.
function getVariantAccent(c: ThemeColors, variant: CardVariant): string | undefined {
  switch (variant) {
    case 'hero': return c.green;
    case 'error': return c.coral;
    case 'highlight': return c.accent;
    default: return undefined;
  }
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
      return { ...base, borderColor: borderColor || (c.green + '40') };
    case 'active':
      return { ...base, borderColor: borderColor || c.accentDim };
    case 'highlight':
      return { ...base, borderColor: borderColor || c.accent, borderWidth: 2 };
    case 'error':
      return { ...base, backgroundColor: c.coralDim, borderColor: borderColor || c.coral };
    case 'upgrade':
      return { ...base, borderColor: borderColor || c.greenDim };
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
    borderRadius: 24,
    padding: 28,
    paddingTop: 32,
    paddingBottom: 32,
    marginBottom: 32,
    overflow: 'hidden' as const,
  },

  // Accent line — thin color strip at the top edge
  accentLine: {
    position: 'absolute',
    top: 0,
    left: 24,
    right: 24,
    height: 2,
    borderRadius: 1,
    opacity: 0.6,
  },

  // Dot-grid — decorative corner pattern
  dotGrid: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: 40,
    height: 24,
  },
  dot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    opacity: 0.18,
  },

  // Dot-matrix bar
  dotMatrixBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Card divider
  divider: {
    marginVertical: 16,
    alignItems: 'center',
  },

  // Card badge
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  badgeText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  title: {
    fontFamily: fonts.mono,
    fontSize: 13,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 10,
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
