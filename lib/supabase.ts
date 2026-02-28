import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

// Lazy-load expo-secure-store to avoid triggering native Keychain access
// before the RN bridge is fully initialized. Eagerly requiring the module
// at import time caused a SIGABRT on iOS launch (SecureStoreModule.searchKeyChain
// → SecItemCopyMatching crashed before promise-rejection tracking was active).
let _secureStore: typeof import('expo-secure-store') | null = null;
function getSecureStore() {
  if (_secureStore) return _secureStore;
  if (Platform.OS === 'web') return null;
  try {
    _secureStore = require('expo-secure-store');
  } catch (e) {
    console.warn('[SecureStore] Failed to load module:', e);
  }
  return _secureStore;
}

// Suspend native storage access until the RN bridge is ready.
//
// During createClient() (module-load time), Supabase calls storage.getItem()
// to restore the persisted session via _initialize(). On native, we make
// getItem() await a promise that only resolves once markStorageReady() is
// called from a useEffect (= after the React tree mounts and the bridge is
// fully initialized). This *suspends* Supabase's initialization rather than
// skipping it, so the session is correctly restored once the bridge is ready.
// Using a boolean flag + returning null would silently discard the stored
// session and force re-login on every cold start.
let _resolveReady: (() => void) | null = null;
const _readyPromise =
  Platform.OS === 'web'
    ? Promise.resolve()
    : Promise.race([
        new Promise<void>((resolve) => {
          _resolveReady = resolve;
        }),
        new Promise<void>((resolve) => {
          // Safety timeout: if markStorageReady() is never called (e.g. bridge
          // init crash), unblock after 10 s so the app doesn't hang forever.
          setTimeout(() => {
            console.warn('[Supabase] _readyPromise timed out after 10 s — unblocking storage');
            resolve();
          }, 10_000);
        }),
      ]);

export function markStorageReady() {
  _resolveReady?.();
  _resolveReady = null;
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[Supabase] Missing env vars — EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is empty. Auth will not work.',
  );
}

const storage = {
  getItem: async (key: string): Promise<string | null> => {
    if (Platform.OS === 'web') return localStorage.getItem(key);
    await _readyPromise;
    try {
      return (await getSecureStore()?.getItemAsync(key)) ?? null;
    } catch (e) {
      console.warn('[SecureStore] getItem failed for key', key, e);
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (Platform.OS === 'web') {
      localStorage.setItem(key, value);
    } else {
      try {
        await getSecureStore()?.setItemAsync(key, value);
      } catch (e) {
        console.warn('[SecureStore] setItem failed for key', key, e);
      }
    }
  },
  removeItem: async (key: string): Promise<void> => {
    if (Platform.OS === 'web') {
      localStorage.removeItem(key);
    } else {
      try {
        await getSecureStore()?.deleteItemAsync(key);
      } catch (e) {
        console.warn('[SecureStore] removeItem failed for key', key, e);
      }
    }
  },
};

// Use a placeholder URL when env vars are missing so the module still loads
// (auth calls will fail gracefully instead of crashing on import).
export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-key',
  {
    auth: {
      storage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  },
);
