const AUTH_URL = 'https://auth.truelayer-sandbox.com';
const CLIENT_ID = 'bocymoneypersonality-a01ae4';
const REDIRECT_URI =
  process.env.EXPO_PUBLIC_TRUELAYER_REDIRECT_URI ||
  'https://native-app-ashy.vercel.app/';
const SCOPES = ['accounts', 'balance', 'transactions', 'cards'];
const PROVIDERS = ['uk-ob-all', 'uk-cs-mock'];

/**
 * Build TrueLayer auth URL.
 * After auth, TrueLayer redirects to the app root with ?code=...&state=connectionId.
 * The app then POSTs the code to /api/truelayer/callback for token exchange.
 */
export function getTrueLayerAuthUrl(connectionId: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    redirect_uri: REDIRECT_URI,
    providers: PROVIDERS.join(' '),
    state: connectionId,
  });
  return `${AUTH_URL}/?${params.toString()}`;
}
