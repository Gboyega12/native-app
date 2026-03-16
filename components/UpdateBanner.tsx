// ── PWA Update Banner ──
// Listens for service worker updates and shows a dismissible banner
// prompting the user to reload for the latest version.
import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { fonts, spacing, radius, type ThemeColors } from '@/theme';
import { useTheme } from '@/lib/theme-context';

export default function UpdateBanner() {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [slideAnim] = useState(() => new Animated.Value(-80));
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SW_UPDATED') {
        setVisible(true);
      }
    };

    // Listen for SW_UPDATED message from service worker
    navigator.serviceWorker.addEventListener('message', onMessage);

    // Register the service worker from React (the +html.tsx template
    // isn't used in static exports, so we register here instead).
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Poll for updates every 60 seconds
      const interval = setInterval(() => { reg.update(); }, 60000);

      // Check if a new SW is already waiting
      if (reg.waiting) setVisible(true);

      // Detect when a new SW is found and track its state
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            setVisible(true);
          }
        });
      });

      // Cleanup interval on unmount
      cleanupRef.current = () => clearInterval(interval);
    });

    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      cleanupRef.current?.();
    };
  }, []);

  // Animate in when visible
  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 80,
        friction: 12,
      }).start();
    }
  }, [visible]);

  if (!visible) return null;

  const reload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  const dismiss = () => {
    Animated.timing(slideAnim, {
      toValue: -80,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setVisible(false));
  };

  return (
    <Animated.View
      style={[
        styles.container,
        { backgroundColor: colors.green, transform: [{ translateY: slideAnim }] },
      ]}
    >
      <View style={styles.content}>
        <Text style={[styles.text, { color: '#000' }]}>
          New version available
        </Text>
        <View style={styles.actions}>
          <TouchableOpacity onPress={reload} style={styles.reloadBtn} activeOpacity={0.7}>
            <Text style={styles.reloadText}>Refresh</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={dismiss} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={[styles.dismiss, { color: 'rgba(0,0,0,0.5)' }]}>{'\u2715'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    paddingTop: 50, // safe area for notch / status bar
    paddingBottom: 12,
    paddingHorizontal: spacing.lg,
  },
  content: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  text: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    letterSpacing: -0.2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  reloadBtn: {
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
  },
  reloadText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: '#000',
  },
  dismiss: {
    fontSize: 16,
    fontFamily: fonts.regular,
  },
});
