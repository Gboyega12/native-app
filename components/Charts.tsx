/**
 * Pure RN Animated chart components — no SVG or external deps.
 * Nothing Phone OS design language: monochrome-first, dot-matrix accents.
 */
import { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { fonts, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';

// ────────────────────────────────────────────────────────────
// SpendingRing — semicircular gauge for budget progress
// ────────────────────────────────────────────────────────────

interface SpendingRingProps {
  /** 0-1 fraction of budget spent */
  progress: number;
  /** Amount remaining to display in center */
  remaining: number;
  /** Total budget */
  budget: number;
  /** Color for the fill arc */
  color: string;
  /** Overspend color */
  overColor?: string;
  /** Size of the ring (diameter) */
  size?: number;
}

/**
 * Semicircular progress ring using CSS border tricks.
 * Two half-circles rotate to reveal the arc fill.
 */
export function SpendingRing({
  progress,
  remaining,
  budget,
  color,
  overColor,
  size = 160,
}: SpendingRingProps) {
  const { colors } = useTheme();
  const animProgress = useRef(new Animated.Value(0)).current;
  const clamped = Math.min(progress, 1);
  const isOver = progress > 1;
  const fillColor = isOver ? (overColor || colors.coral) : color;

  useEffect(() => {
    Animated.timing(animProgress, {
      toValue: clamped,
      duration: 1000,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [clamped]);

  const half = size / 2;
  const thickness = size * 0.08;
  const innerSize = size - thickness * 2;

  // First half (0-50%): rotate the right mask
  const rightRotate = animProgress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['0deg', '180deg', '180deg'],
    extrapolate: 'clamp',
  });

  // Second half (50-100%): rotate the left mask
  const leftRotate = animProgress.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['0deg', '0deg', '180deg'],
    extrapolate: 'clamp',
  });

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* Background ring */}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: half,
          borderWidth: thickness,
          borderColor: colors.border,
          position: 'absolute',
        }}
      />

      {/* Right half fill */}
      <View style={{ position: 'absolute', width: half, height: size, right: 0, overflow: 'hidden' }}>
        <Animated.View
          style={{
            width: size,
            height: size,
            borderRadius: half,
            borderWidth: thickness,
            borderColor: fillColor,
            borderLeftColor: 'transparent',
            borderBottomColor: 'transparent',
            position: 'absolute',
            right: 0,
            transform: [{ rotate: rightRotate }],
          }}
        />
      </View>

      {/* Left half fill */}
      <View style={{ position: 'absolute', width: half, height: size, left: 0, overflow: 'hidden' }}>
        <Animated.View
          style={{
            width: size,
            height: size,
            borderRadius: half,
            borderWidth: thickness,
            borderColor: fillColor,
            borderRightColor: 'transparent',
            borderTopColor: 'transparent',
            position: 'absolute',
            left: 0,
            transform: [{ rotate: leftRotate }],
          }}
        />
      </View>

      {/* Center label */}
      <View style={{ alignItems: 'center' }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: size * 0.16, color: fillColor, letterSpacing: -0.5 }}>
          {'\u00a3'}{Math.round(remaining).toLocaleString()}
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: size * 0.06, color: colors.muted, letterSpacing: 1, marginTop: 2 }}>
          OF {'\u00a3'}{Math.round(budget).toLocaleString()}
        </Text>
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────
// CategoryBars — horizontal animated bars for budget categories
// ────────────────────────────────────────────────────────────

interface CategoryBarItem {
  label: string;
  spent: number;
  budget: number;
}

interface CategoryBarsProps {
  items: CategoryBarItem[];
  /** Max bar items to show */
  limit?: number;
}

export function CategoryBars({ items, limit = 5 }: CategoryBarsProps) {
  const { colors } = useTheme();
  const visible = items.slice(0, limit);

  return (
    <View style={{ gap: 12 }}>
      {visible.map((item, i) => (
        <CategoryBarRow key={item.label} item={item} index={i} colors={colors} />
      ))}
    </View>
  );
}

function CategoryBarRow({ item, index, colors }: { item: CategoryBarItem; index: number; colors: ThemeColors }) {
  const fillAnim = useRef(new Animated.Value(0)).current;
  const pct = item.budget > 0 ? Math.min(item.spent / item.budget, 1.5) : 0;
  const isOver = item.spent > item.budget && item.budget > 0;
  const barColor = isOver ? colors.coral : colors.accent;

  useEffect(() => {
    Animated.timing(fillAnim, {
      toValue: Math.min(pct, 1),
      duration: 800,
      delay: index * 80,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct]);

  const barWidth = fillAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.text2 }} numberOfLines={1}>
          {item.label}
        </Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: isOver ? colors.coral : colors.dim }}>
          {'\u00a3'}{Math.round(item.spent).toLocaleString()}
          {item.budget > 0 ? ` / \u00a3${Math.round(item.budget).toLocaleString()}` : ''}
        </Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.border, overflow: 'hidden' }}>
        <Animated.View
          style={{
            height: '100%',
            width: barWidth,
            borderRadius: 2,
            backgroundColor: barColor,
          }}
        />
      </View>
    </View>
  );
}

// ────────────────────────────────────────────────────────────
// WeeklySparkline — 7-day vertical bar mini-chart
// ────────────────────────────────────────────────────────────

interface DaySpend {
  label: string; // e.g. "Mon"
  amount: number;
}

interface WeeklySparklineProps {
  days: DaySpend[];
  height?: number;
}

export function WeeklySparkline({ days, height = 48 }: WeeklySparklineProps) {
  const { colors } = useTheme();
  const maxAmount = Math.max(...days.map((d) => d.amount), 1);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, height }}>
      {days.map((day, i) => (
        <SparkBar
          key={day.label}
          day={day}
          maxAmount={maxAmount}
          height={height}
          index={i}
          isLast={i === days.length - 1}
          colors={colors}
        />
      ))}
    </View>
  );
}

function SparkBar({
  day,
  maxAmount,
  height,
  index,
  isLast,
  colors,
}: {
  day: DaySpend;
  maxAmount: number;
  height: number;
  index: number;
  isLast: boolean;
  colors: ThemeColors;
}) {
  const barAnim = useRef(new Animated.Value(0)).current;
  const barHeight = (day.amount / maxAmount) * height;

  useEffect(() => {
    Animated.timing(barAnim, {
      toValue: barHeight,
      duration: 600,
      delay: index * 60,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [barHeight]);

  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Animated.View
        style={{
          width: '100%',
          height: barAnim,
          borderRadius: 2,
          backgroundColor: day.amount > 0 ? colors.accent : colors.border,
          minHeight: day.amount > 0 ? 2 : 1,
        }}
      />
      <Text style={{ fontFamily: fonts.mono, fontSize: 7, color: colors.muted, marginTop: 3, letterSpacing: 0.5 }}>
        {day.label}
      </Text>
    </View>
  );
}
