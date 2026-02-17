// TrueLayer sandbox vs live – default to sandbox for development
const IS_SANDBOX = (process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX ?? 'false') === 'true';
const AUTH_URL = IS_SANDBOX
  ? 'https://auth.truelayer-sandbox.com'
  : 'https://auth.truelayer.com';
const CLIENT_ID = process.env.EXPO_PUBLIC_TRUELAYER_CLIENT_ID || 'native-971b11';
const REDIRECT_URI =
  process.env.EXPO_PUBLIC_TRUELAYER_REDIRECT_URI ||
  'https://native-app-ashy.vercel.app/api/truelayer/callback';
const SCOPES = ['accounts', 'balance', 'transactions', 'cards'];
const PROVIDERS = IS_SANDBOX ? ['uk-ob-all', 'uk-mock-payments-sandbox'] : ['uk-ob-all'];

/**
 * Build TrueLayer auth URL.
 * After auth, TrueLayer redirects to /api/truelayer/callback with ?code=...&state=...
 * The server exchanges the code, fetches data, saves to Supabase, then redirects
 * the user back to /connect?connection_id=...&status=success.
 */
export function getTrueLayerAuthUrl(connectionId: string): string {
  // Encode web origin in state so the server can redirect back to the app
  const state = typeof window !== 'undefined'
    ? `${connectionId}|${window.location.origin}`
    : connectionId;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    redirect_uri: REDIRECT_URI,
    providers: PROVIDERS.join(' '),
    state,
  });
  return `${AUTH_URL}/?${params.toString()}`;
}
