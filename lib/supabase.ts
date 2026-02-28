import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

// Lazy-load expo-secure-store so the app can boot even if the native module
// fails to link. A top-level `import` would crash the JS bundle at load time.
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

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    '[Supabase] Missing env vars — EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is empty. Auth will not work.',
  );
}

const storage = {
  getItem: async (key: string): Promise<string | null> => {
    if (Platform.OS === 'web') return localStorage.getItem(key);
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
