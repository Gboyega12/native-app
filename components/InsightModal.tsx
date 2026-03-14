// ── Cancellable Insight Modal ──
// Nothing Phone OS-inspired dismissable modal for app-open prompts.
// Used for: payday nudges, spending alerts, weekly check-ins, goal milestones.
// Shows once per trigger, dismissable via X button, swipe, or backdrop tap.
// Persists dismissal per-fingerprint in AsyncStorage to avoid re-showing.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Animated, Easing,
  TouchableOpacity, type ViewStyle,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fonts, spacing, radius } from '@/theme';
import { useTheme } from '@/lib/theme-context';
import { BocyFace } from '@/components/Bocy';

export type InsightType = 'payday' | 'spending_alert' | 'weekly_checkin' | 'goal_milestone' | 'general';

type InsightModalProps = {
  visible: boolean;
  onDismiss: () => void;
  /** Navigate to chat with a pre-filled message */
  onAction?: (prefill?: string) => void;
  /** Insight type controls icon/accent */
  type?: InsightType;
  /** Tag label above title */
  tag?: string;
  title: string;
  body: string;
  /** Primary action button label */
  actionLabel?: string;
  /** Pre-fill text for chat when action is pressed */
  actionPrefill?: string;
  /** Unique fingerprint to prevent re-showing (stored in AsyncStorage) */
  fingerprint?: string;
};

const DISMISS_PREFIX = '@bocy_insight_dismiss:';

export default function InsightModal({
  visible,
  onDismiss,
  onAction,
  type = 'general',
  tag,
  title,
  body,
  actionLabel = 'Ask Bocy',
  actionPrefill,
  fingerprint,
}: InsightModalProps) {
  const { colors } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(40)).current;
  const [dismissed, setDismissed] = useState(false);

  // Check if this insight was already dismissed
  useEffect(() => {
    if (!fingerprint || !visible) return;
    AsyncStorage.getItem(DISMISS_PREFIX + fingerprint).then((val) => {
      if (val === 'true') {
        setDismissed(true);
        onDismiss();
      }
    }).catch(() => {});
  }, [fingerprint, visible]);

  // Animate in
  useEffect(() => {
    if (visible && !dismissed) {
      fadeAnim.setValue(0);
      slideAnim.setValue(40);
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 320,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 320,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, dismissed]);

  const handleDismiss = useCallback(async () => {
    // Animate out
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 40,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      if (fingerprint) {
        AsyncStorage.setItem(DISMISS_PREFIX + fingerprint, 'true').catch(() => {});
      }
      onDismiss();
    });
  }, [fingerprint, onDismiss]);

  const handleAction = useCallback(() => {
    if (fingerprint) {
      AsyncStorage.setItem(DISMISS_PREFIX + fingerprint, 'true').catch(() => {});
    }
    onDismiss();
    onAction?.(actionPrefill);
  }, [fingerprint, onDismiss, onAction, actionPrefill]);

  if (!visible || dismissed) return null;

  const accentColor = getTypeAccent(type, colors);
  const bocyMood = getTypeMood(type);

  return (
    <Modal transparent visible={visible} animationType="none" statusBarTranslucent testID="insight-modal">
      <Pressable style={styles.overlay} onPress={handleDismiss}>
        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
              opacity: fadeAnim,
              transform: [{ translateY: slideAnim }],
            },
          ]}
        >
          <Pressable onPress={() => {}} /* prevent dismiss on card tap */>
            {/* Close button */}
            <TouchableOpacity
              style={[styles.closeBtn, { backgroundColor: colors.mintDim }]}
              onPress={handleDismiss}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              activeOpacity={0.7}
              testID="insight-modal-close-button"
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Text style={[styles.closeIcon, { color: colors.dim }]}>{'\u2715'}</Text>
            </TouchableOpacity>

            {/* Tag + Bocy */}
            <View style={styles.topRow}>
              {tag && (
                <View style={[styles.tag, { backgroundColor: accentColor + '18' }]}>
                  <Text style={[styles.tagText, { color: accentColor }]}>{tag}</Text>
                </View>
              )}
              <View style={styles.bocyWrap}>
                <BocyFace mood={bocyMood} size="sm" breathing />
              </View>
            </View>

            {/* Content */}
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            <Text style={[styles.body, { color: colors.text2 }]}>{body}</Text>

            {/* Action button */}
            {onAction && (
              <TouchableOpacity
                style={[styles.actionBtn, { backgroundColor: colors.accent }]}
                onPress={handleAction}
                activeOpacity={0.8}
                testID="insight-modal-action-button"
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
              >
                <Text style={[styles.actionBtnText, { color: colors.bg }]}>{actionLabel}</Text>
              </TouchableOpacity>
            )}

            {/* Dismiss link */}
            <TouchableOpacity style={styles.dismissLink} onPress={handleDismiss} activeOpacity={0.7} testID="insight-modal-dismiss-button" accessibilityRole="button" accessibilityLabel="Dismiss">
              <Text style={[styles.dismissLinkText, { color: colors.muted }]}>Not now</Text>
            </TouchableOpacity>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Helper: clear a specific insight dismissal (e.g. when new data arrives) ──
export async function clearInsightDismissal(fingerprint: string) {
  try {
    await AsyncStorage.removeItem(DISMISS_PREFIX + fingerprint);
  } catch {}
}

// ── Helper: clear all insight dismissals ──
export async function clearAllInsightDismissals() {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const insightKeys = keys.filter((k) => k.startsWith(DISMISS_PREFIX));
    if (insightKeys.length > 0) {
      await AsyncStorage.multiRemove(insightKeys);
    }
  } catch {}
}

function getTypeAccent(type: InsightType, colors: any): string {
  switch (type) {
    case 'payday': return colors.green;
    case 'spending_alert': return colors.coral;
    case 'weekly_checkin': return colors.accent;
    case 'goal_milestone': return colors.green;
    default: return colors.accent;
  }
}

function getTypeMood(type: InsightType): 'happy' | 'alert' | 'neutral' | 'celebrating' {
  switch (type) {
    case 'payday': return 'happy';
    case 'spending_alert': return 'alert';
    case 'weekly_checkin': return 'neutral';
    case 'goal_milestone': return 'celebrating';
    default: return 'neutral';
  }
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 28,
    paddingTop: 24,
    maxWidth: 400,
    width: '100%',
    alignSelf: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  closeIcon: {
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
    paddingRight: 36,
  },
  tag: {
    borderRadius: 100,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  tagText: {
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  bocyWrap: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 22,
    marginBottom: 6,
    lineHeight: 28,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  actionBtn: {
    borderRadius: 100,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  actionBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
  },
  dismissLink: {
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  dismissLinkText: {
    fontFamily: fonts.regular,
    fontSize: 13,
  },
});
