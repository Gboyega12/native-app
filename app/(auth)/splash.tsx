import { useEffect, useRef, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, Animated, Easing, Dimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '@/theme';

const { width: SW } = Dimensions.get('window');

// ── Bocy face — 7×7 pixel art (brand identity) ──
const FACE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [0, 0, 1, 0, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 0],
  [0, 0, 1, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0],
];
const FACE_PX = 12;
const FACE_GAP = 5;
const FACE_SIZE = 7 * FACE_PX + 6 * FACE_GAP; // total face width/height

// Ring dimensions — elegant containment
const RING_RADIUS = Math.max(72, FACE_SIZE / 2 + 24);
const RING_SIZE = RING_RADIUS * 2;

export default function Splash() {
  const router = useRouter();

  // ── Animation values ──
  const ringOpacity   = useRef(new Animated.Value(0)).current;
  const glowOpacity   = useRef(new Animated.Value(0)).current;
  const faceOpacity   = useRef(new Animated.Value(0)).current;
  const textOpacity   = useRef(new Animated.Value(0)).current;
  const textTranslate = useRef(new Animated.Value(12)).current;
  const breathAnim    = useRef(new Animated.Value(0)).current;
  const exitOpacity   = useRef(new Animated.Value(1)).current;

  const [isBlinking, setIsBlinking] = useState(false);

  const face = useMemo(() => {
    if (!isBlinking) return FACE;
    return FACE.map((row, r) =>
      (r === 1 || r === 2) ? row.map(() => 0) : row,
    );
  }, [isBlinking]);

  useEffect(() => {
    // ── Phase 1: Ring + glow fade in (0-800ms) ──
    Animated.parallel([
      Animated.timing(ringOpacity, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(glowOpacity, {
        toValue: 1,
        duration: 1000,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    // ── Phase 2: Bocy face materialises (600ms) ──
    const faceTimer = setTimeout(() => {
      Animated.timing(faceOpacity, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }, 600);

    // ── Phase 3: "BOCY" text slides up (1100ms) ──
    const textTimer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(textTranslate, {
          toValue: 0,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }, 1100);

    // ── Breathing glow (1500ms) ──
    const breathTimer = setTimeout(() => {
      Animated.loop(
        Animated.sequence([
          Animated.timing(breathAnim, {
            toValue: 1,
            duration: 3000,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(breathAnim, {
            toValue: 0,
            duration: 3000,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ).start();
    }, 1500);

    // ── Blink cycle ──
    let blinkTimer: ReturnType<typeof setTimeout>;
    const scheduleBlink = () => {
      blinkTimer = setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => {
          setIsBlinking(false);
          scheduleBlink();
        }, 130);
      }, 2500 + Math.random() * 2500);
    };
    const blinkStart = setTimeout(scheduleBlink, 1800);

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
      clearTimeout(faceTimer);
      clearTimeout(textTimer);
      clearTimeout(breathTimer);
      clearTimeout(blinkStart);
      clearTimeout(blinkTimer);
      clearTimeout(exitTimer);
    };
  }, []);

  // Breathing interpolation — very subtle
  const glowScale = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });
  const glowBreathOpacity = breathAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.06, 0.10],
  });

  return (
    <Animated.View style={[s.container, { opacity: exitOpacity }]}>
      {/* ── Ambient radial glow ── */}
      <Animated.View
        style={[
          s.glow,
          {
            opacity: Animated.multiply(glowOpacity, glowBreathOpacity),
            transform: [{ scale: glowScale }],
          },
        ]}
      />

      {/* ── Centre composition ── */}
      <View style={s.centre}>
        {/* Thin circular ring */}
        <Animated.View
          style={[
            s.ring,
            {
              opacity: ringOpacity.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 0.18],
              }),
            },
          ]}
        />

        {/* Bocy face — refined pixel art */}
        <Animated.View style={[s.faceWrap, { opacity: faceOpacity }]}>
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
                      : 'rgba(255,255,255,0.03)',
                  }}
                />
              ))}
            </View>
          ))}
        </Animated.View>

        {/* Brand name — clean typography */}
        <Animated.View
          style={{
            opacity: textOpacity,
            transform: [{ translateY: textTranslate }],
            marginTop: 32,
          }}
        >
          <Text style={s.brandName}>BOCY</Text>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Soft ambient glow — barely visible
  glow: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#FFFFFF',
  },

  // Centre layout
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Geometric containment ring
  ring: {
    position: 'absolute',
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_RADIUS,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },

  // Bocy face
  faceWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  // Typography
  brandName: {
    fontFamily: fonts.heading,
    fontSize: 26,
    letterSpacing: 10,
    color: '#FFFFFF',
  },
});
