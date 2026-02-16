const AUTH_URL = 'https://auth.truelayer.com';
const CLIENT_ID = 'bocymoneypersonality-a01ae4';
const REDIRECT_URI =
  process.env.EXPO_PUBLIC_TRUELAYER_REDIRECT_URI ||
  'https://native-app-ashy.vercel.app/api/truelayer/callback';
const SCOPES = ['accounts', 'balance', 'transactions', 'cards'];
const PROVIDERS = ['uk-ob-all', 'uk-cs-mock'];

/**
 * Build TrueLayer auth URL with a connection_id in the state param.
 * On web, webOrigin is included in state so the callback can redirect back.
 */
export function getTrueLayerAuthUrl(connectionId: string, webOrigin?: string): string {
  // Encode web origin in state so the callback knows where to redirect
  const state = webOrigin ? `${connectionId}|${webOrigin}` : connectionId;

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
