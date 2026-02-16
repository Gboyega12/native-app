import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Accept both GET (legacy server redirect) and POST (new client-initiated flow)
  let code, connectionId;

  if (req.method === 'POST') {
    code = req.body?.code;
    const state = req.body?.state;
    connectionId = state;
  } else if (req.method === 'GET') {
    code = req.query.code;
    const state = req.query.state || '';
    // Legacy: state may contain "connectionId|webOrigin"
    const pipeIdx = state.indexOf('|');
    connectionId = pipeIdx === -1 ? state : state.slice(0, pipeIdx);
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
  if (!connectionId) return res.status(400).json({ error: 'Missing connection_id (state)' });

  const redirectUri =
    process.env.TRUELAYER_REDIRECT_URI ||
    process.env.EXPO_PUBLIC_TRUELAYER_REDIRECT_URI ||
    'https://native-app-ashy.vercel.app/';

  const clientId = process.env.TRUELAYER_CLIENT_ID;
  const clientSecret = process.env.TRUELAYER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      error: 'Server misconfigured',
      details: 'TRUELAYER_CLIENT_ID or TRUELAYER_CLIENT_SECRET not set',
    });
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://auth.truelayer.com/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Token exchange failed:', JSON.stringify({
        status: tokenRes.status,
        redirect_uri_used: redirectUri,
        response: tokenData,
      }));
      return res.status(400).json({
        error: 'Token exchange failed',
        details: tokenData.error || tokenData,
        hint: `redirect_uri sent: ${redirectUri}`,
      });
    }

    const token = tokenData.access_token;
    const headers = { Authorization: `Bearer ${token}` };

    // Fetch accounts and cards
    const [accountsRes, cardsRes] = await Promise.all([
      fetch('https://api.truelayer.com/data/v1/accounts', { headers }),
      fetch('https://api.truelayer.com/data/v1/cards', { headers }),
    ]);
    const accountsData = await accountsRes.json();
    const cardsData = await cardsRes.json();

    const accounts = accountsData.results || [];
    const cards = cardsData.results || [];

    // Date range: last 12 months
    const to = new Date().toISOString().split('T')[0];
    const fromDate = new Date();
    fromDate.setFullYear(fromDate.getFullYear() - 1);
    const from = fromDate.toISOString().split('T')[0];

    // Fetch all transactions
    const txPromises = [
      ...accounts.map((a) =>
        fetch(`https://api.truelayer.com/data/v1/accounts/${a.account_id}/transactions?from=${from}&to=${to}`, { headers }).then((r) => r.json())
      ),
      ...cards.map((c) =>
        fetch(`https://api.truelayer.com/data/v1/cards/${c.account_id}/transactions?from=${from}&to=${to}`, { headers }).then((r) => r.json())
      ),
    ];

    const txResults = await Promise.all(txPromises);
    const allTx = txResults.flatMap((r) => r.results || []);

    // Convert to CSV
    const csvLines = ['Date,Description,Amount'];
    for (const tx of allTx) {
      const date = tx.timestamp ? tx.timestamp.split('T')[0] : '';
      const desc = (tx.merchant_name || tx.description || '').replace(/,/g, ' ');
      const amount = tx.transaction_type === 'CREDIT' ? Math.abs(tx.amount) : -Math.abs(tx.amount);
      csvLines.push(`${date},${desc},${amount}`);
    }
    const csv = csvLines.join('\n');

    // Save CSV to Supabase bank_data table (using service role)
    const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      console.error('Missing Supabase config:', { supabaseUrl: !!supabaseUrl, serviceKey: !!serviceKey });
      return res.status(500).json({
        error: 'Server misconfigured',
        details: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set',
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { error: dbError } = await admin.from('bank_data').insert({
      connection_id: connectionId,
      csv_data: csv,
      source: 'truelayer',
    });

    if (dbError) {
      console.error('Failed to save bank data:', dbError);
      return res.status(500).json({ error: 'Failed to save bank data' });
    }

    // POST → return JSON to the client
    if (req.method === 'POST') {
      return res.json({ success: true, connection_id: connectionId });
    }

    // GET → redirect back to app (legacy flow)
    const webOrigin = req.query.state?.includes('|')
      ? req.query.state.slice(req.query.state.indexOf('|') + 1)
      : null;

    if (webOrigin) {
      return res.redirect(302, `${webOrigin}/connect?connection_id=${encodeURIComponent(connectionId)}&status=success`);
    }
    return res.redirect(302, `bocy://callback?connection_id=${connectionId}&status=success`);
  } catch (err) {
    console.error('Callback error:', err);
    return res.status(500).json({ error: err.message });
  }
}
