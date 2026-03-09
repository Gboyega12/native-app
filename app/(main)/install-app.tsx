// ── Add to Home Screen ──
// Onboarding step that prompts PWA users to install the app.
// Uses the beforeinstallprompt event (Chrome/Edge/Samsung) and provides
// manual instructions for Safari. Skips entirely on native platforms.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { trackEvent, trackScreen } from '@/lib/mixpanel';
import { colors, fonts, spacing, radius } from '@/theme';
import { BocyFace } from '@/components/Bocy';

// Cache the beforeinstallprompt event globally so it survives re-renders
let deferredPrompt: any = null;

if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredPrompt = e;
  });
}

/** Detect iOS Safari for manual A2HS instructions. */
function isIOSSafari(): boolean {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iP(hone|od|ad)/.test(ua) && /WebKit/.test(ua) && !/CriOS|FxiOS/.test(ua);
}

/** Check if already running as installed PWA. */
function isStandalone(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  return (
    (window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    (window.navigator as any)?.standalone === true
  );
}

export default function InstallApp() {
  const router = useRouter();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [installed, setInstalled] = useState(false);
  const [promptAvailable, setPromptAvailable] = useState(!!deferredPrompt);
  const [showHint, setShowHint] = useState(false);
  const iosSafari = isIOSSafari();
  const alreadyInstalled = isStandalone();

  // On native or already-installed PWA, skip straight to connect
  useEffect(() => {
    if (Platform.OS !== 'web' || alreadyInstalled) {
      router.replace('/(main)/connect');
      return;
    }
    trackScreen('Install App');
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  // Listen for late-arriving beforeinstallprompt
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt = e;
      setPromptAvailable(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result.outcome === 'accepted') {
        trackEvent('App Installed');
        setInstalled(true);
        // Brief pause to show success, then continue
        setTimeout(() => router.push('/(main)/connect'), 1200);
      }
    } catch (err) {
      console.warn('[install-app] Prompt error:', err);
    }
    deferredPrompt = null;
    setPromptAvailable(false);
  }, [router]);

  const handleOpenShareSheet = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ url: window.location.href });
      } catch {
        // User cancelled or share failed — show fallback hint
        setShowHint(true);
      }
    } else {
      setShowHint(true);
    }
  }, []);

  const handleSkip = () => {
    trackEvent('App Install Skipped');
    router.push('/(main)/connect');
  };

  // Already installed state (brief flash)
  if (installed) {
    return (
      <View style={styles.container}>
        <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
          <BocyFace mood="happy" size="lg" breathing />
          <Text style={styles.title}>You're all set</Text>
          <Text style={styles.body}>Bocy is now on your home screen.</Text>
        </Animated.View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        <BocyFace mood="happy" size="lg" breathing />

        <Text style={styles.title}>Add Bocy to your phone</Text>
        <Text style={styles.body}>
          Install Bocy on your home screen for instant access — no app store needed.
        </Text>

        {/* Chrome/Edge: native install prompt */}
        {promptAvailable && (
          <TouchableOpacity style={styles.installBtn} onPress={handleInstall} activeOpacity={0.8}>
            <Text style={styles.installBtnText}>Install app</Text>
          </TouchableOpacity>
        )}

        {/* iOS Safari: manual instructions */}
        {iosSafari && !promptAvailable && (
          <View style={styles.instructionsCard}>
            <TouchableOpacity style={styles.stepRow} onPress={handleOpenShareSheet} activeOpacity={0.6}>
              <View style={styles.stepNum}><Text style={styles.stepNumText}>1</Text></View>
              <Text style={styles.stepText}>
                Tap here to open the <Text style={styles.bold}>Share</Text> menu{' '}
                <Text style={styles.mono}>[{'\u2191'}]</Text>
              </Text>
            </TouchableOpacity>
            {showHint && (
              <View style={styles.hintRow}>
                <Text style={styles.hintText}>
                  Look for the <Text style={styles.bold}>Share</Text> button{' '}
                  <Text style={styles.mono}>[{'\u2191'}]</Text> in Safari's toolbar below {'\u2193'}
                </Text>
              </View>
            )}
            <View style={styles.stepRow}>
              <View style={styles.stepNum}><Text style={styles.stepNumText}>2</Text></View>
              <Text style={styles.stepText}>
                Scroll down and tap <Text style={styles.bold}>Add to Home Screen</Text>
              </Text>
            </View>
            <View style={styles.stepRow}>
              <View style={styles.stepNum}><Text style={styles.stepNumText}>3</Text></View>
              <Text style={styles.stepText}>
                Tap <Text style={styles.bold}>Add</Text> — Bocy will appear on your home screen
              </Text>
            </View>
          </View>
        )}

        {/* Generic fallback: no prompt + not iOS Safari */}
        {!promptAvailable && !iosSafari && (
          <View style={styles.instructionsCard}>
            <Text style={styles.fallbackText}>
              Use your browser's menu to "Add to Home Screen" or "Install app" for the best experience.
            </Text>
          </View>
        )}
      </Animated.View>

      <View style={styles.bottomArea}>
        <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
          <Text style={styles.skipText}>I'll do this later</Text>
        </TouchableOpacity>
        {(iosSafari || (!promptAvailable && !iosSafari)) && (
          <TouchableOpacity style={styles.continueBtn} onPress={handleSkip} activeOpacity={0.8}>
            <Text style={styles.continueBtnText}>Continue</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
    maxWidth: 640,
    alignSelf: 'center' as const,
    width: '100%',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 26,
    color: colors.text,
    textAlign: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text2,
    textAlign: 'center',
    lineHeight: 26,
    maxWidth: 400,
    marginBottom: spacing.xl,
  },

  // Install button (Chrome/Edge prompt)
  installBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.md,
    alignItems: 'center',
    width: '100%',
  },
  installBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },

  // iOS Safari instructions card
  instructionsCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    width: '100%',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.md,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: spacing.md,
    marginTop: 2,
  },
  stepNumText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.bg,
  },
  stepText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    lineHeight: 22,
    flex: 1,
  },
  bold: {
    fontFamily: fonts.semibold,
    color: colors.text,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: 16,
  },
  hintRow: {
    backgroundColor: colors.accent + '15',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  hintText: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.accent,
    lineHeight: 20,
    textAlign: 'center',
  },
  fallbackText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text2,
    lineHeight: 22,
    textAlign: 'center',
  },

  // Bottom
  bottomArea: {
    paddingBottom: spacing.xxl,
    alignItems: 'center',
  },
  skipBtn: {
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  skipText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.dim,
  },
  continueBtn: {
    backgroundColor: colors.accent,
    paddingVertical: 16,
    borderRadius: radius.md,
    alignItems: 'center',
    width: '100%',
  },
  continueBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
    color: colors.bg,
  },
});
