// ── Online/offline detection hook ──
// Uses the browser's navigator.onLine + online/offline events on web,
// and AppState for detecting background/foreground transitions.

import { useState, useEffect, useCallback } from 'react';
import { AppState, Platform } from 'react-native';

export interface OnlineStatus {
  /** Whether the device appears to have network connectivity */
  isOnline: boolean;
  /** Whether the app is in the foreground (active) */
  isActive: boolean;
}

export function useOnlineStatus(): OnlineStatus {
  const [isOnline, setIsOnline] = useState(() => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined') {
      return navigator.onLine;
    }
    return true; // assume online on native until proven otherwise
  });
  const [isActive, setIsActive] = useState(true);

  // Web: listen for online/offline events
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // All platforms: listen for app state changes (active/background/inactive)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setIsActive(nextState === 'active');
    });
    return () => subscription.remove();
  }, []);

  return { isOnline, isActive };
}
