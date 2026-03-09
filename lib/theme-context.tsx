import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { darkColors, lightColors, type ThemeColors } from '@/theme';

type ThemeMode = 'dark' | 'light';

type ThemeContextType = {
  mode: ThemeMode;
  colors: ThemeColors;
  isDark: boolean;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextType>({
  mode: 'dark',
  colors: darkColors,
  isDark: true,
  toggleTheme: () => {},
});

const STORAGE_KEY = '@bocy_theme_mode';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [overlayColor, setOverlayColor] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark') setMode(stored);
    }).catch(() => {});
  }, []);

  const toggleTheme = useCallback(() => {
    setMode((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      const nextColors = next === 'dark' ? darkColors : lightColors;

      // Flash a full-screen overlay that fades out to reveal the new theme
      setOverlayColor(nextColors.bg);
      fadeAnim.setValue(1);
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 400,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setOverlayColor(null));

      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const isDark = mode === 'dark';
  const colors = isDark ? darkColors : lightColors;

  return (
    <ThemeContext.Provider value={{ mode, colors, isDark, toggleTheme }}>
      <View style={{ flex: 1 }}>
        {children}
        {overlayColor && (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: overlayColor, opacity: fadeAnim, zIndex: 9999 },
            ]}
          />
        )}
      </View>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
