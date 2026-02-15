import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, state: connectionId } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });
  if (!connectionId) return res.status(400).json({ error: 'Missing connection_id (state)' });

  const redirectUri = 'https://native-app-blush.vercel.app/api/truelayer/callback';

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://auth.truelayer.com/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.TRUELAYER_CLIENT_ID,
        client_secret: process.env.TRUELAYER_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).json({ error: 'Token exchange failed', details: tokenData });
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
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

    // Redirect back to app via deep link
    const redirectTo = `bocy://callback?connection_id=${connectionId}&status=success`;
    return res.redirect(302, redirectTo);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
