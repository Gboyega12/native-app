// ── Bocy Tamagotchi ──
// A dot-matrix character that lives within the app.
// Instead of users taking care of Bocy, Bocy takes care of users' finances.
// Rendered as a compact dot-matrix face that changes expression based on
// the user's financial state.

import { useEffect, useRef, useState, useMemo } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { useTheme } from '@/lib/theme-context';
import { fonts, radius } from '@/theme';

// ── Bocy mood states ──
export type BocyMood = 'neutral' | 'happy' | 'alert' | 'thinking' | 'celebrating' | 'sleepy';

// Determine Bocy's mood from financial data
export function getBocyMood(analysis: {
  decision_score?: number;
  surplus?: number;
  all_moves?: any[];
} | null): BocyMood {
  if (!analysis) return 'neutral';

  const score = analysis.decision_score ?? 50;
  const surplus = analysis.surplus ?? 0;

  if (score >= 75 && surplus > 200) return 'celebrating';
  if (score >= 60 && surplus > 0) return 'happy';
  if (surplus < 0) return 'alert';
  if (score < 40) return 'alert';
  return 'neutral';
}

// ── Face dot patterns ──
// 5x5 grid: 1 = lit, 0 = dim, 2 = accent (green)
const FACES: Record<BocyMood, number[][]> = {
  neutral: [
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0],
  ],
  happy: [
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  alert: [
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0],
  ],
  thinking: [
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 1, 1, 0],
    [0, 0, 0, 0, 0],
  ],
  celebrating: [
    [1, 0, 0, 0, 1],
    [0, 2, 0, 2, 0],
    [0, 0, 0, 0, 0],
    [2, 0, 0, 0, 2],
    [0, 2, 2, 2, 0],
  ],
  sleepy: [
    [0, 0, 0, 0, 0],
    [0, 1, 0, 1, 0],
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0],
  ],
};

// ── Animated Bocy Face Component ──
export function BocyFace({
  mood = 'neutral',
  size = 'md',
  breathing = true,
}: {
  mood?: BocyMood;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  breathing?: boolean;
}) {
  const { colors } = useTheme();
  const breathAnim = useRef(new Animated.Value(0)).current;
  const enterAnim = useRef(new Animated.Value(0)).current;
  const [isBlinking, setIsBlinking] = useState(false);

  const dotSize = size === 'sm' ? 4 : size === 'md' ? 6 : size === 'lg' ? 8 : 10;
  const gap = size === 'sm' ? 2 : size === 'md' ? 3 : size === 'lg' ? 4 : 5;

  useEffect(() => {
    Animated.timing(enterAnim, {
      toValue: 1,
      duration: 500,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  // Blink: eyes close briefly every 2-5 seconds
  useEffect(() => {
    if (!breathing) return;
    let timerId: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const delay = 2000 + Math.random() * 3000;
      timerId = setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => {
          setIsBlinking(false);
          scheduleNext();
        }, 150);
      }, delay);
    };
    scheduleNext();
    return () => clearTimeout(timerId);
  }, [breathing]);

  useEffect(() => {
    if (!breathing) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathAnim, {
          toValue: 0,
          duration: 2000,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathing]);

  // Apply blink: close eyes (row 1 all dim) when blinking
  const face = useMemo(() => {
    const base = FACES[mood] || FACES.neutral;
    if (!isBlinking) return base;
    return base.map((row, r) => (r === 1 ? [0, 0, 0, 0, 0] : row));
  }, [mood, isBlinking]);

  const breathScale = breathing
    ? breathAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] })
    : 1;

  return (
    <Animated.View
      style={[
        styles.faceContainer,
        {
          opacity: enterAnim,
          transform: [
            { scale: enterAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
            ...(breathing ? [{ scale: breathScale as any }] : []),
          ],
        },
      ]}
    >
      {face.map((row, r) => (
        <View key={r} style={[styles.faceRow, { gap }]}>
          {row.map((val, c) => (
            <View
              key={c}
              style={[
                {
                  width: dotSize,
                  height: dotSize,
                  borderRadius: dotSize / 2,
                },
                val === 0 && { backgroundColor: colors.accentDim },
                val === 1 && { backgroundColor: colors.accent },
                val === 2 && { backgroundColor: colors.green },
              ]}
            />
          ))}
        </View>
      ))}
    </Animated.View>
  );
}

// ── Large animated Bocy for welcome/onboarding ──
export function BocyHero({
  mood = 'neutral',
  animate = true,
}: {
  mood?: BocyMood;
  animate?: boolean;
}) {
  const { colors } = useTheme();
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const enterAnim = useRef(new Animated.Value(0)).current;
  const [isBlinking, setIsBlinking] = useState(false);

  useEffect(() => {
    Animated.timing(enterAnim, {
      toValue: 1,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    if (!animate) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 2500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 2500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animate]);

  // Blink for hero too
  useEffect(() => {
    if (!animate) return;
    let timerId: ReturnType<typeof setTimeout>;
    const scheduleNext = () => {
      const delay = 2500 + Math.random() * 3500;
      timerId = setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => {
          setIsBlinking(false);
          scheduleNext();
        }, 150);
      }, delay);
    };
    scheduleNext();
    return () => clearTimeout(timerId);
  }, [animate]);

  const face = useMemo(() => {
    const base = FACES[mood] || FACES.neutral;
    if (!isBlinking) return base;
    return base.map((row, r) => (r === 1 ? [0, 0, 0, 0, 0] : row));
  }, [mood, isBlinking]);
  const dotSize = 12;
  const gap = 6;

  const ringOpacity = animate
    ? pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.35] })
    : 0.15;
  const ringScale = animate
    ? pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] })
    : 1;

  return (
    <Animated.View
      style={[
        styles.heroContainer,
        {
          opacity: enterAnim,
          transform: [
            { scale: enterAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) },
          ],
        },
      ]}
    >
      {/* Outer glow ring */}
      <Animated.View
        style={[
          styles.heroRing,
          {
            borderColor: colors.accent,
            opacity: ringOpacity,
            transform: [{ scale: ringScale as any }],
          },
        ]}
      />
      {/* Inner ring */}
      <View style={[styles.heroInnerRing, { borderColor: colors.border }]}>
        {face.map((row, r) => (
          <View key={r} style={[styles.faceRow, { gap }]}>
            {row.map((val, c) => (
              <Animated.View
                key={c}
                style={[
                  {
                    width: dotSize,
                    height: dotSize,
                    borderRadius: dotSize / 2,
                  },
                  val === 0 && { backgroundColor: colors.accentDim },
                  val === 1 && { backgroundColor: colors.accent },
                  val === 2 && { backgroundColor: colors.green },
                ]}
              />
            ))}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

// ── Visual illustration components for education screens ──

export function IllustrationScan() {
  const { colors } = useTheme();
  const scanAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(scanAnim, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(scanAnim, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    ).start();
  }, []);

  // A visual representation of scanning: rows of dots that light up in sequence
  const rows = 5;
  const cols = 7;
  return (
    <View style={styles.illustrationContainer}>
      {Array.from({ length: rows }).map((_, r) => (
        <Animated.View
          key={r}
          style={[
            styles.scanRow,
            {
              opacity: scanAnim.interpolate({
                inputRange: [0, 1],
                outputRange: [r % 2 === 0 ? 0.3 : 0.6, r % 2 === 0 ? 0.8 : 1],
              }),
            },
          ]}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <View
              key={c}
              style={[
                styles.scanDot,
                (r === 1 && c >= 2 && c <= 4) && { backgroundColor: colors.green },
                (r === 3 && c >= 1 && c <= 5) && { backgroundColor: colors.green },
              ]}
            />
          ))}
        </Animated.View>
      ))}
    </View>
  );
}

export function IllustrationPlan() {
  const { colors } = useTheme();
  const anim1 = useRef(new Animated.Value(0)).current;
  const anim2 = useRef(new Animated.Value(0)).current;
  const anim3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.stagger(300, [
      Animated.timing(anim1, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(anim2, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(anim3, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);

  // Three action bars that slide in, representing a ranked plan
  const bars = [
    { anim: anim1, width: '85%', color: colors.accent },
    { anim: anim2, width: '65%', color: colors.text2 },
    { anim: anim3, width: '45%', color: colors.dim },
  ] as const;

  return (
    <View style={styles.illustrationContainer}>
      {bars.map((bar, i) => (
        <Animated.View
          key={i}
          style={[
            styles.planBar,
            {
              width: bar.width,
              backgroundColor: bar.color,
              opacity: bar.anim,
              transform: [
                { translateX: bar.anim.interpolate({ inputRange: [0, 1], outputRange: [-40, 0] }) },
              ],
            },
          ]}
        >
          <View style={[styles.planBarDot, { backgroundColor: i === 0 ? colors.green : 'rgba(0,0,0,0.3)' }]} />
        </Animated.View>
      ))}
    </View>
  );
}

export function IllustrationPersonal() {
  const { colors } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    ).start();
  }, []);

  // A constellation of dots that shift, representing personalisation
  const points = [
    { x: 20, y: 10 }, { x: 60, y: 5 }, { x: 90, y: 20 },
    { x: 15, y: 40 }, { x: 55, y: 35 }, { x: 85, y: 45 },
    { x: 30, y: 60 }, { x: 70, y: 55 }, { x: 50, y: 70 },
  ];

  return (
    <View style={[styles.illustrationContainer, { height: 80 }]}>
      {points.map((pt, i) => (
        <Animated.View
          key={i}
          style={[
            styles.constellationDot,
            {
              left: pt.x,
              top: pt.y,
              backgroundColor: i < 3 ? colors.accent : i < 6 ? colors.text2 : colors.green,
              opacity: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [i % 2 === 0 ? 0.4 : 0.8, i % 2 === 0 ? 1 : 0.5],
              }),
              transform: [
                {
                  translateY: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, i % 2 === 0 ? -4 : 4],
                  }),
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

// ── Mockup illustrations for education slides ──
// Miniature app-preview cards on surface. All content is mathematical:
// real £ values, percentages, multiplications — not generic advice.

export function MockupDashboard() {
  const { colors } = useTheme();
  const anims = useRef(Array.from({ length: 3 }, () => new Animated.Value(0))).current;

  useEffect(() => {
    Animated.stagger(150, anims.map(a =>
      Animated.timing(a, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true })
    )).start();
  }, []);

  return (
    <View style={[mockS.card, { backgroundColor: colors.surface }]}>
      <Animated.View style={[mockS.headline, {
        opacity: anims[0],
        transform: [{ scale: anims[0].interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
      }]}>
        <Text style={[mockS.bigNum, { color: colors.green }]}>+£491</Text>
        <Text style={[mockS.unit, { color: colors.muted }]}> /mo surplus</Text>
      </Animated.View>
      <Animated.View style={[mockS.insightRow, {
        opacity: anims[1],
        transform: [{ translateX: anims[1].interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
      }]}>
        <Text style={[mockS.insightLabel, { color: colors.text2 }]}>
          {'\u2192 Redirect £180 to notice account'}
        </Text>
      </Animated.View>
      <Animated.View style={[mockS.insightRow, {
        opacity: anims[2],
        transform: [{ translateX: anims[2].interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
      }]}>
        <Text style={[mockS.insightHighlight, { color: colors.green }]}>
          {'= £96/yr earned '}
          <Text style={{ color: colors.dim }}>{'vs £11 now'}</Text>
        </Text>
      </Animated.View>
    </View>
  );
}

export function MockupMoves() {
  const { colors } = useTheme();
  const anims = useRef(Array.from({ length: 3 }, () => new Animated.Value(0))).current;

  useEffect(() => {
    Animated.stagger(150, anims.map(a =>
      Animated.timing(a, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true })
    )).start();
  }, []);

  const moves = [
    { rank: '#1', action: 'Switch energy tariff', math: '£47/mo \u00D7 12 = £564/yr', hi: true },
    { rank: '#2', action: 'Move £2k to notice account', math: 'earns £96/yr vs £11 now' },
    { rank: '#3', action: 'Consolidate debt at 3.1%', math: 'saves £1,240 in interest' },
  ];

  return (
    <View style={[mockS.card, { backgroundColor: colors.surface }]}>
      {moves.map((m, i) => (
        <Animated.View key={i} style={[mockS.moveRow, {
          opacity: anims[i],
          transform: [{ translateX: anims[i].interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
          borderLeftColor: m.hi ? colors.green : colors.accentDim,
          marginTop: i > 0 ? 12 : 0,
        }]}>
          <View style={mockS.moveHeader}>
            <Text style={[mockS.moveRank, { color: m.hi ? colors.green : colors.dim }]}>{m.rank}</Text>
            <Text style={[mockS.moveAction, { color: m.hi ? colors.text : colors.text2 }]} numberOfLines={1}>{m.action}</Text>
          </View>
          <Text style={[mockS.moveMath, { color: m.hi ? colors.green : colors.dim }]}>{m.math}</Text>
        </Animated.View>
      ))}
    </View>
  );
}

export function MockupChat() {
  const { colors } = useTheme();
  const anims = useRef(Array.from({ length: 3 }, () => new Animated.Value(0))).current;

  useEffect(() => {
    Animated.stagger(200, anims.map(a =>
      Animated.timing(a, { toValue: 1, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true })
    )).start();
  }, []);

  return (
    <View style={[mockS.card, { backgroundColor: colors.surface }]}>
      {/* User message */}
      <Animated.View style={[mockS.chatRow, mockS.chatRowUser, {
        opacity: anims[0],
        transform: [{ translateY: anims[0].interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }]}>
        <View style={[mockS.chatBubbleUser, { backgroundColor: colors.accent }]}>
          <Text style={[mockS.bubbleLine, { color: colors.bg }]}>When will I be debt free?</Text>
        </View>
      </Animated.View>

      {/* Response bubble */}
      <Animated.View style={[mockS.chatRow, {
        opacity: anims[1],
        transform: [{ translateY: anims[1].interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }]}>
        <View style={[mockS.bubble, { borderColor: colors.green + '40' }]}>
          <Text style={[mockS.bubbleLine, { color: colors.text }]}>
            {'Debt free by '}
            <Text style={{ color: colors.green }}>Nov \u201927</Text>
          </Text>
          <Text style={[mockS.bubbleLine, { color: colors.text2, marginTop: 3 }]}>
            {'if you redirect '}
            <Text style={{ color: colors.green }}>£180/mo</Text>
          </Text>
        </View>
      </Animated.View>

      {/* Detail line */}
      <Animated.View style={[mockS.chatRow, {
        opacity: anims[2],
        transform: [{ translateY: anims[2].interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      }]}>
        <Text style={[mockS.bubbleLine, { color: colors.dim, fontSize: 10 }]}>
          {'Income varies \u00B123% \u2192 buffer built in'}
        </Text>
      </Animated.View>
    </View>
  );
}

const mockS = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: 20,
    width: '100%' as any,
    maxWidth: 340,
  },
  headline: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 10,
  },
  bigNum: {
    fontFamily: fonts.mono,
    fontSize: 26,
    letterSpacing: 0.5,
  },
  unit: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
  },
  barRow: {
    marginTop: 6,
  },
  barLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  barLabel: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  barValue: {
    fontFamily: fonts.mono,
    fontSize: 10,
  },
  barTrack: {
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden' as const,
  },
  barFill: {
    height: 3,
    borderRadius: 1.5,
  },
  insightRow: {
    marginTop: 8,
  },
  insightLabel: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  insightHighlight: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 0.3,
  },
  moveRow: {
    borderLeftWidth: 3,
    paddingLeft: 12,
  },
  moveHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  moveRank: {
    fontFamily: fonts.mono,
    fontSize: 12,
    letterSpacing: 1,
  },
  moveAction: {
    fontFamily: fonts.medium,
    fontSize: 13,
    flex: 1,
  },
  moveMath: {
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
    marginTop: 3,
  },
  chatRow: {
    marginTop: 10,
  },
  chatRowUser: {
    alignItems: 'flex-end',
    marginTop: 0,
  },
  chatBubbleUser: {
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  bubble: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  bubbleLine: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
});

const styles = StyleSheet.create({
  // ── Face ──
  faceContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // ── Hero ──
  heroContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 140,
    height: 140,
  },
  heroRing: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
  },
  heroInnerRing: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  // ── Illustrations ──
  illustrationContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 16,
    gap: 6,
  },
  scanRow: {
    flexDirection: 'row',
    gap: 6,
  },
  scanDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(128,128,128,0.25)',
  },
  planBar: {
    height: 14,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 5,
  },
  planBarDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  constellationDot: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
