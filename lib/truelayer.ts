const AUTH_URL = 'https://auth.truelayer.com';
const CLIENT_ID = 'bocymoneypersonality-a01ae4';
const REDIRECT_URI = 'https://native-app-blush.vercel.app/api/truelayer/callback';
const SCOPES = ['accounts', 'balance', 'transactions', 'cards'];
const PROVIDERS = ['uk-ob-all', 'uk-cs-mock'];

/**
 * Build TrueLayer auth URL with a connection_id in the state param.
 * The connection_id is used to retrieve the CSV after callback.
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
