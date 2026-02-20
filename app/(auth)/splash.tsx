import { useEffect, useRef, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, Animated, Easing, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts, spacing } from '@/theme';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ── Nothing OS dot-matrix grid config ──
const GRID_COLS = 15;
const GRID_ROWS = 25;
const DOT_SIZE = 4;
const DOT_GAP = 2;

// ── Bocy face — 7x7 high-res dot-matrix ──
const BOCY_FACE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 0],
  [0, 0, 1, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0],
];
const FACE_DOT = 10;
const FACE_GAP = 5;

// ── Glyph-line data (Nothing OS scanline aesthetic) ──
const SCAN_LINES: { width: `${number}%`; delay: number }[] = [
  { width: '60%', delay: 0 },
  { width: '40%', delay: 80 },
  { width: '75%', delay: 160 },
  { width: '30%', delay: 240 },
  { width: '55%', delay: 320 },
];

// ── Animated dot in the background grid ──
function GridDot({ row, col, totalCols, staggerMs }: {
  row: number; col: number; totalCols: number; staggerMs: number;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const delay = staggerMs + (row * totalCols + col) * 8;
    Animated.timing(anim, {
      toValue: 1,
      duration: 600,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View
      style={[
        styles.gridDot,
        { opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.06] }) },
      ]}
    />
  );
}

// ── Animated scan line ──
function ScanLine({ width, delay, startDelay }: {
  width: `${number}%`; delay: number; startDelay: number;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 400,
      delay: startDelay + delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // Shimmer after reveal
    setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(shimmer, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(shimmer, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      ).start();
    }, startDelay + delay + 400);
  }, []);

  return (
    <Animated.View
      style={[
        styles.scanLine,
        {
          width,
          opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
          transform: [
            { scaleX: anim },
            { scaleY: shimmer.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] }) },
          ],
        },
      ]}
    />
  );
}

export default function Splash() {
  const router = useRouter();

  // ── Master animation values ──
  const gridFade = useRef(new Animated.Value(0)).current;
  const ringScale = useRef(new Animated.Value(0)).current;
  const ringOpacity = useRef(new Animated.Value(0)).current;
  const innerRingScale = useRef(new Animated.Value(0)).current;
  const faceOpacity = useRef(new Animated.Value(0)).current;
  const faceScale = useRef(new Animated.Value(0.3)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleTranslateY = useRef(new Animated.Value(20)).current;
  const subtitleOpacity = useRef(new Animated.Value(0)).current;
  const scanOpacity = useRef(new Animated.Value(0)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const exitOpacity = useRef(new Animated.Value(1)).current;

  // Bocy eye blink
  const [isBlinking, setIsBlinking] = useState(false);

  // Breathing pulse for outer ring
  const breathAnim = useRef(new Animated.Value(0)).current;

  // Face with blink applied
  const face = useMemo(() => {
    if (!isBlinking) return BOCY_FACE;
    return BOCY_FACE.map((row, r) =>
      (r === 1 || r === 2) ? [0, 0, 0, 0, 0, 0, 0] : row,
    );
  }, [isBlinking]);

  useEffect(() => {
    // ── Phase 1: Background grid fades in (0-600ms) ──
    Animated.timing(gridFade, {
      toValue: 1,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // ── Phase 2: Outer ring expands (400ms) ──
    setTimeout(() => {
      Animated.parallel([
        Animated.spring(ringScale, {
          toValue: 1,
          tension: 40,
          friction: 7,
          useNativeDriver: true,
        }),
        Animated.timing(ringOpacity, {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }, 400);

    // ── Phase 3: Inner ring + glow (700ms) ──
    setTimeout(() => {
      Animated.parallel([
        Animated.spring(innerRingScale, {
          toValue: 1,
          tension: 50,
          friction: 8,
          useNativeDriver: true,
        }),
        Animated.timing(glowOpacity, {
          toValue: 1,
          duration: 800,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }, 700);

    // ── Phase 4: Bocy face materialises (1000ms) ──
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(faceOpacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(faceScale, {
          toValue: 1,
          tension: 60,
          friction: 9,
          useNativeDriver: true,
        }),
      ]).start();
    }, 1000);

    // ── Phase 5: Title + subtitle reveal (1500ms) ──
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(titleOpacity, {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(titleTranslateY, {
          toValue: 0,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }, 1500);

    setTimeout(() => {
      Animated.timing(subtitleOpacity, {
        toValue: 1,
        duration: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, 1800);

    // ── Phase 6: Scan lines (1600ms) ──
    setTimeout(() => {
      Animated.timing(scanOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }, 1600);

    // ── Breathing loop starts after full reveal ──
    setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(breathAnim, {
            toValue: 1,
            duration: 2500,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(breathAnim, {
            toValue: 0,
            duration: 2500,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ).start();
    }, 1800);

    // ── Blink cycle ──
    let blinkTimer: ReturnType<typeof setTimeout>;
    const scheduleBlink = () => {
      blinkTimer = setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => {
          setIsBlinking(false);
          scheduleBlink();
        }, 150);
      }, 2000 + Math.random() * 3000);
    };
    setTimeout(scheduleBlink, 2000);

    // ── Phase 7: Exit + navigate (3500ms) ──
    const exitTimer = setTimeout(() => {
      Animated.timing(exitOpacity, {
        toValue: 0,
        duration: 500,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        router.replace('/(auth)/sign-in');
      });
    }, 3500);

    return () => {
      clearTimeout(exitTimer);
      clearTimeout(blinkTimer);
    };
  }, []);

  // Ring breathing interpolations
  const outerRingBreathScale = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });
  const outerRingBreathOpacity = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.2, 0.45],
  });

  return (
    <Animated.View style={[styles.container, { opacity: exitOpacity }]}>
      {/* ── Background dot-matrix grid ── */}
      <Animated.View style={[styles.gridContainer, { opacity: gridFade }]}>
        {Array.from({ length: GRID_ROWS }).map((_, r) => (
          <View key={r} style={styles.gridRow}>
            {Array.from({ length: GRID_COLS }).map((_, c) => (
              <GridDot key={c} row={r} col={c} totalCols={GRID_COLS} staggerMs={100} />
            ))}
          </View>
        ))}
      </Animated.View>

      {/* ── Centre composition ── */}
      <View style={styles.centreStack}>
        {/* Radial glow */}
        <Animated.View
          style={[
            styles.radialGlow,
            {
              opacity: glowOpacity.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 0.12],
              }),
              transform: [{ scale: outerRingBreathScale }],
            },
          ]}
        />

        {/* Outer ring */}
        <Animated.View
          style={[
            styles.outerRing,
            {
              opacity: Animated.multiply(ringOpacity, outerRingBreathOpacity.interpolate({
                inputRange: [0.2, 0.45],
                outputRange: [0.2, 0.45],
              })) as any,
              transform: [
                { scale: Animated.multiply(ringScale, outerRingBreathScale) as any },
              ],
            },
          ]}
        />

        {/* Inner ring */}
        <Animated.View
          style={[
            styles.innerRing,
            {
              opacity: innerRingScale.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 1],
              }),
              transform: [{ scale: innerRingScale }],
            },
          ]}
        />

        {/* Bocy face */}
        <Animated.View
          style={[
            styles.faceContainer,
            {
              opacity: faceOpacity,
              transform: [{ scale: faceScale }],
            },
          ]}
        >
          {face.map((row, r) => (
            <View key={r} style={[styles.faceRow, { gap: FACE_GAP }]}>
              {row.map((val, c) => (
                <View
                  key={c}
                  style={[
                    styles.faceDot,
                    {
                      width: FACE_DOT,
                      height: FACE_DOT,
                      borderRadius: FACE_DOT / 2,
                      backgroundColor: val === 1
                        ? colors.accent
                        : 'rgba(255,255,255,0.06)',
                    },
                  ]}
                />
              ))}
            </View>
          ))}
        </Animated.View>

        {/* Brand */}
        <Animated.Text
          style={[
            styles.title,
            {
              opacity: titleOpacity,
              transform: [{ translateY: titleTranslateY }],
            },
          ]}
        >
          Bocy
        </Animated.Text>

        <Animated.Text style={[styles.subtitle, { opacity: subtitleOpacity }]}>
          AI financial strategist
        </Animated.Text>

        {/* Scan lines */}
        <Animated.View style={[styles.scanContainer, { opacity: scanOpacity }]}>
          {SCAN_LINES.map((line, i) => (
            <ScanLine
              key={i}
              width={line.width}
              delay={line.delay}
              startDelay={1600}
            />
          ))}
        </Animated.View>
      </View>

      {/* ── Bottom system line ── */}
      <Animated.Text
        style={[
          styles.systemLine,
          { opacity: subtitleOpacity.interpolate({ inputRange: [0, 1], outputRange: [0, 0.25] }) },
        ]}
      >
        {'{ } system ready'}
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Background grid ──
  gridContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: DOT_GAP,
  },
  gridRow: {
    flexDirection: 'row',
    gap: DOT_GAP,
  },
  gridDot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: colors.accent,
  },

  // ── Centre composition ──
  centreStack: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  radialGlow: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: colors.accent,
  },
  outerRing: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius: 90,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  innerRing: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },

  // ── Bocy face ──
  faceContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  faceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  faceDot: {},

  // ── Brand text ──
  title: {
    fontFamily: fonts.heading,
    fontSize: 38,
    color: colors.accent,
    letterSpacing: 2,
  },
  subtitle: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.dim,
    marginTop: spacing.xs,
    letterSpacing: 1,
  },

  // ── Scan lines ──
  scanContainer: {
    marginTop: spacing.lg,
    gap: 4,
    alignItems: 'flex-start',
    width: 120,
  },
  scanLine: {
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 1,
  },

  // ── System line ──
  systemLine: {
    position: 'absolute',
    bottom: 48,
    fontFamily: fonts.mono,
    fontSize: 11,
    color: colors.accent,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
});
