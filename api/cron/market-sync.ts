// ── Market Price Sync Cron ──
// Runs weekdays at 18:00 UTC (after London market close).
// Fetches latest prices from Yahoo Finance for all investments with tickers,
// then updates current_value in the investments table.

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = { maxDuration: 30 };

const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (compatible; BOCY/1.0)';
const BATCH_SIZE = 20; // Yahoo supports ~20 symbols per request

const supabaseUrl = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

interface InvestmentRow {
  id: string;
  user_id: string;
  ticker: string;
  quantity: number | null;
  current_value: number;
}

interface YahooQuoteResult {
  symbol: string;
  regularMarketPrice: number;
  currency: string;
}

async function fetchYahooBatch(symbols: string[]): Promise<YahooQuoteResult[]> {
  const url = `${YAHOO_BASE}/v7/finance/quote?symbols=${symbols.join(',')}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.error(`[market-sync] Yahoo returned ${res.status} for batch: ${symbols.join(',')}`);
    return [];
  }

  const json = await res.json() as {
    quoteResponse?: { result?: YahooQuoteResult[] };
  };

  return json.quoteResponse?.result || [];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = (req.headers.authorization as string) || '';
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!serviceKey) {
    return res.json({ success: false, error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  const admin = createClient(supabaseUrl!, serviceKey);

  try {
    // Fetch all investments that have a ticker
    const { data: investments, error: fetchErr } = await admin
      .from('investments')
      .select('id, user_id, ticker, quantity, current_value')
      .not('ticker', 'is', null)
      .neq('ticker', '');

    if (fetchErr) {
      console.error('[market-sync] DB fetch error:', fetchErr.message);
      return res.json({ success: false, error: fetchErr.message });
    }

    if (!investments || investments.length === 0) {
      return res.json({ success: true, message: 'No investments with tickers', updated: 0 });
    }

    // Build unique ticker list
    const tickerMap = new Map<string, InvestmentRow[]>();
    for (const inv of investments as InvestmentRow[]) {
      const ticker = inv.ticker.toUpperCase();
      const list = tickerMap.get(ticker) || [];
      list.push(inv);
      tickerMap.set(ticker, list);
    }

    const allTickers = Array.from(tickerMap.keys());
    const priceMap = new Map<string, number>();

    // Fetch in batches of BATCH_SIZE
    for (let i = 0; i < allTickers.length; i += BATCH_SIZE) {
      const batch = allTickers.slice(i, i + BATCH_SIZE);
      const quotes = await fetchYahooBatch(batch);
      for (const q of quotes) {
        if (q.regularMarketPrice > 0) {
          priceMap.set(q.symbol, q.regularMarketPrice);
        }
      }
    }

    // Update investments with new prices
    let updated = 0;
    let skipped = 0;

    for (const [ticker, rows] of tickerMap) {
      const price = priceMap.get(ticker);
      if (!price) {
        skipped += rows.length;
        continue;
      }

      for (const inv of rows) {
        // If quantity is set, current_value = quantity × price
        // Otherwise just update the value directly (single-holding)
        const newValue = inv.quantity && inv.quantity > 0
          ? Math.round(inv.quantity * price * 100) / 100
          : price;

        const { error: updateErr } = await admin
          .from('investments')
          .update({ current_value: newValue, updated_at: new Date().toISOString() })
          .eq('id', inv.id);

        if (updateErr) {
          console.error(`[market-sync] Update failed for ${inv.id}:`, updateErr.message);
          skipped++;
        } else {
          updated++;
        }
      }
    }

    console.warn(`[market-sync] Done: ${updated} updated, ${skipped} skipped, ${allTickers.length} tickers`);
    return res.json({
      success: true,
      updated,
      skipped,
      tickers: allTickers.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[market-sync] Fatal error:', message);
    return res.status(500).json({ success: false, error: message });
  }
}
