import { useEffect, useRef, useState, useMemo } from 'react';
import {
  View, StyleSheet, Animated, Easing, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '@/theme';

const { width: SW, height: SH } = Dimensions.get('window');

// ── Full-screen tamagotchi pixel grid ──
const PX = 6;
const GAP = 6;
const CELL = PX + GAP;
const COLS = Math.floor(SW / CELL);
const ROWS = Math.floor(SH / CELL);
const CX = COLS / 2;
const CY = ROWS / 2;
const MAX_D = Math.sqrt(CX ** 2 + CY ** 2);

// ── Bocy face — 7×7 pixel art ──
const FACE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 0],
  [0, 0, 1, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0],
];
const FACE_PX = 10;
const FACE_GAP = 5;

// ── "BOCY" in 5×7 pixel font ──
const LB = [[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,1,1,1,0]];
const LO = [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]];
const LC = [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,0],[1,0,0,0,1],[0,1,1,1,0]];
const LY = [[1,0,0,0,1],[1,0,0,0,1],[0,1,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]];

const BOCY_TEXT: number[][] = [];
for (let r = 0; r < 7; r++) {
  BOCY_TEXT.push([...LB[r], 0, ...LO[r], 0, ...LC[r], 0, ...LY[r]]);
}
const TEXT_PX = 5;
const TEXT_GAP = 3;

// Pre-compute background pixel opacities (radial brightness gradient)
const GRID_OP: number[][] = [];
for (let r = 0; r < ROWS; r++) {
  const row: number[] = [];
  for (let c = 0; c < COLS; c++) {
    const d = Math.sqrt((r - CY) ** 2 + (c - CX) ** 2) / MAX_D;
    // Brighter near center (0.12), dimmer at edges (0.03)
    row.push(0.03 + 0.09 * Math.max(0, 1 - d));
  }
  GRID_OP.push(row);
}

export default function Splash() {
  const router = useRouter();

  // ── Animation values ──
  const gridOpacity = useRef(new Animated.Value(0)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const faceOpacity = useRef(new Animated.Value(0)).current;
  const faceScale = useRef(new Animated.Value(0.5)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textScale = useRef(new Animated.Value(0.3)).current;
  const breathAnim = useRef(new Animated.Value(0)).current;
  const exitOpacity = useRef(new Animated.Value(1)).current;

  const [isBlinking, setIsBlinking] = useState(false);

  // Face with blink applied (close eye rows)
  const face = useMemo(() => {
    if (!isBlinking) return FACE;
    return FACE.map((row, r) =>
      (r === 1 || r === 2) ? row.map(() => 0) : row,
    );
  }, [isBlinking]);

  useEffect(() => {
    // ── Phase 1: Pixel grid powers on (0-800ms) ──
    Animated.timing(gridOpacity, {
      toValue: 1,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // ── Phase 2: Centre glow (300ms) ──
    setTimeout(() => {
      Animated.timing(glowOpacity, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, 300);

    // ── Phase 3: Bocy face materialises (600ms) ──
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(faceOpacity, {
          toValue: 1,
          duration: 500,
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
    }, 600);

    // ── Phase 4: "BOCY" pixel text generates from centre (1200ms) ──
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(textScale, {
          toValue: 1,
          tension: 50,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    }, 1200);

    // ── Glow breathing loop (1500ms) ──
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
    }, 1500);

    // ── Blink cycle (starts after face visible) ──
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
    setTimeout(scheduleBlink, 1500);

    // ── Exit + navigate (3500ms) ──
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

  // Breathing interpolations
  const glowScale = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.08],
  });

  return (
    <Animated.View style={[s.container, { opacity: exitOpacity }]}>
      {/* ── Full-screen tamagotchi pixel grid ── */}
      <Animated.View style={[s.grid, { opacity: gridOpacity }]}>
        {Array.from({ length: ROWS }).map((_, r) => (
          <View key={r} style={s.gridRow}>
            {Array.from({ length: COLS }).map((_, c) => (
              <View
                key={c}
                style={[s.gridDot, { opacity: GRID_OP[r]?.[c] ?? 0.04 }]}
              />
            ))}
          </View>
        ))}
      </Animated.View>

      {/* ── Centre composition ── */}
      <View style={s.centre}>
        {/* Radial glow behind face */}
        <Animated.View
          style={[
            s.glow,
            {
              opacity: glowOpacity.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 0.10],
              }),
              transform: [{ scale: glowScale }],
            },
          ]}
        />

        {/* Bocy 7×7 face */}
        <Animated.View
          style={[
            s.faceWrap,
            {
              opacity: faceOpacity,
              transform: [{ scale: faceScale }],
            },
          ]}
        >
          {face.map((row, r) => (
            <View key={r} style={[s.faceRow, { gap: FACE_GAP }]}>
              {row.map((v, c) => (
                <View
                  key={c}
                  style={{
                    width: FACE_PX,
                    height: FACE_PX,
                    borderRadius: 2,
                    backgroundColor: v === 1
                      ? '#FFFFFF'
                      : 'rgba(255,255,255,0.05)',
                  }}
                />
              ))}
            </View>
          ))}
        </Animated.View>

        {/* "BOCY" pixel text */}
        <Animated.View
          style={[
            s.textWrap,
            {
              opacity: textOpacity,
              transform: [{ scale: textScale }],
            },
          ]}
        >
          {BOCY_TEXT.map((row, r) => (
            <View key={r} style={[s.textRow, { gap: TEXT_GAP }]}>
              {row.map((v, c) => (
                <View
                  key={c}
                  style={{
                    width: TEXT_PX,
                    height: TEXT_PX,
                    borderRadius: 1,
                    backgroundColor: v === 1
                      ? '#FFFFFF'
                      : 'transparent',
                  }}
                />
              ))}
            </View>
          ))}
        </Animated.View>
      </View>
    </Animated.View>
  );
}

// ── Styles ──

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Full-screen pixel grid
  grid: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: GAP,
  },
  gridRow: {
    flexDirection: 'row',
    gap: GAP,
  },
  gridDot: {
    width: PX,
    height: PX,
    borderRadius: 1,
    backgroundColor: '#FFFFFF',
  },

  // Centre composition
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: '#FFFFFF',
  },

  // Bocy face
  faceWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  faceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  // Pixel text
  textWrap: {
    alignItems: 'center',
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
