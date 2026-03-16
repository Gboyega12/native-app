import { useEffect, useRef } from 'react';
import { Animated, Easing, View, StyleSheet, type ViewStyle } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { radius } from '@/theme';

interface SkeletonLineProps {
  width?: number | string;
  height?: number;
  style?: ViewStyle;
  /** Stagger delay in ms */
  delay?: number;
}

/** A single shimmering placeholder line */
function SkeletonLine({ width = '100%', height = 14, style, delay = 0 }: SkeletonLineProps) {
  const { colors } = useTheme();
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(shimmer, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        }),
        Animated.timing(shimmer, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const bg = shimmer.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.border, colors.surface],
  });

  return (
    <Animated.View
      style={[
        { width: width as any, height, borderRadius: 4, backgroundColor: bg },
        style,
      ]}
    />
  );
}

/** Skeleton placeholder matching the hero card layout */
export function HeroCardSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <SkeletonLine width={90} height={10} delay={0} />
      <SkeletonLine width={160} height={36} delay={100} style={{ marginTop: 16 }} />
      <SkeletonLine width={110} height={12} delay={200} style={{ marginTop: 10 }} />
      <SkeletonLine width="100%" height={6} delay={300} style={{ marginTop: 20, borderRadius: 3 }} />
      <SkeletonLine width={140} height={10} delay={400} style={{ marginTop: 14 }} />
    </View>
  );
}

/** Skeleton placeholder matching a move/insight card */
export function MoveCardSkeleton() {
  const { colors } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <SkeletonLine width={28} height={28} style={{ borderRadius: 14 }} delay={0} />
        <View style={{ flex: 1 }}>
          <SkeletonLine width="85%" height={14} delay={100} />
          <SkeletonLine width={80} height={11} delay={200} style={{ marginTop: 8 }} />
        </View>
      </View>
    </View>
  );
}

/** Full dashboard skeleton with hero + 3 move cards */
export function DashboardSkeleton() {
  return (
    <View style={{ gap: 16 }} testID="dashboard-skeleton" accessibilityLabel="Loading dashboard">
      <HeroCardSkeleton />
      <MoveCardSkeleton />
      <MoveCardSkeleton />
      <MoveCardSkeleton />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 24,
    marginBottom: 0,
  },
});

export default SkeletonLine;
