import { useEffect, useRef } from 'react';
import { Text, StyleSheet, Animated, Easing } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '@/theme';

export default function Splash() {
  const router = useRouter();

  const wordOpacity = useRef(new Animated.Value(0)).current;
  const lineWidth   = useRef(new Animated.Value(0)).current;
  const exitOpacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Phase 1: "BOCY" fades in
    Animated.timing(wordOpacity, {
      toValue: 1,
      duration: 800,
      delay: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

    // Phase 2: Thin line expands beneath
    const lineTimer = setTimeout(() => {
      Animated.timing(lineWidth, {
        toValue: 1,
        duration: 600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false, // width can't use native driver
      }).start();
    }, 700);

    // Exit + navigate
    const exitTimer = setTimeout(() => {
      Animated.timing(exitOpacity, {
        toValue: 0,
        duration: 400,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        router.replace('/(auth)/sign-in');
      });
    }, 2800);

    return () => {
      clearTimeout(lineTimer);
      clearTimeout(exitTimer);
    };
  }, []);

  const animatedLineWidth = lineWidth.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 48],
  });

  return (
    <Animated.View style={[s.container, { opacity: exitOpacity }]}>
      <Animated.Text style={[s.brand, { opacity: wordOpacity }]}>
        BOCY
      </Animated.Text>
      <Animated.View style={[s.line, { width: animatedLineWidth }]} />
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
  brand: {
    fontFamily: fonts.heading,
    fontSize: 32,
    letterSpacing: 12,
    color: '#FFFFFF',
  },
  line: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.20)',
    marginTop: 16,
  },
});
