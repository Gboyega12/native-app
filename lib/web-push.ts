// ── Web Push Subscription ──
// Client-side hook for subscribing to web push notifications via the
// Push API.
//
// Flow:
//   1. Register service worker
//   2. Request notification permission
//   3. Subscribe via PushManager with VAPID public key
//   4. POST subscription to /api/notifications/subscribe
//   5. Store subscription state in Supabase notification_preferences

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';

const VAPID_PUBLIC_KEY = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY || '';

/** Convert a URL-safe base64 VAPID key to a Uint8Array for PushManager. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export type WebPushState = {
  /** Whether the browser supports web push. */
  supported: boolean;
  /** Current permission: 'default' | 'granted' | 'denied'. */
  permission: NotificationPermission | 'unsupported';
  /** Whether the user is subscribed to web push. */
  subscribed: boolean;
  /** Loading state while subscribing/unsubscribing. */
  loading: boolean;
  /** Subscribe to web push notifications. Prompts for permission if needed. */
  subscribe: () => Promise<boolean>;
  /** Unsubscribe from web push notifications. */
  unsubscribe: () => Promise<void>;
};

const NOOP_STATE: WebPushState = {
  supported: false,
  permission: 'unsupported',
  subscribed: false,
  loading: false,
  subscribe: async () => false,
  unsubscribe: async () => {},
};

export function useWebPush(userId?: string): WebPushState {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const swReg = useRef<ServiceWorkerRegistration | null>(null);

  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  // Check existing subscription on mount
  useEffect(() => {
    if (!supported) return;

    setPermission(Notification.permission);

    navigator.serviceWorker.ready.then((reg) => {
      swReg.current = reg;
      return reg.pushManager.getSubscription();
    }).then((sub) => {
      setSubscribed(!!sub);
    }).catch(() => {});
  }, [supported]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!supported || !userId || !VAPID_PUBLIC_KEY) return false;

    setLoading(true);
    try {
      // Request permission
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setLoading(false);
        return false;
      }

      // Get or wait for SW registration
      const reg = swReg.current || await navigator.serviceWorker.ready;
      swReg.current = reg;

      // Subscribe via PushManager
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });

      // Send subscription to server
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
        }),
      });

      if (!res.ok) throw new Error('Failed to save subscription');

      setSubscribed(true);
      return true;
    } catch (err) {
      console.warn('[web-push] Subscribe failed:', err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [supported, userId]);

  const unsubscribe = useCallback(async () => {
    if (!supported || !userId) return;

    setLoading(true);
    try {
      const reg = swReg.current || await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();

      if (subscription) {
        await subscription.unsubscribe();

        // Remove from server
        const { data: { session } } = await supabase.auth.getSession();
        await fetch('/api/notifications/subscribe', {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({}),
        });
      }

      setSubscribed(false);
    } catch (err) {
      console.warn('[web-push] Unsubscribe failed:', err);
    } finally {
      setLoading(false);
    }
  }, [supported, userId]);

  if (!supported) return NOOP_STATE;

  return { supported, permission, subscribed, loading, subscribe, unsubscribe };
}
