// ── Yahoo Finance Market Data Proxy ──
// Server-side proxy for Yahoo Finance API.
// Avoids CORS issues and centralises rate-limit control.
//
// GET /api/market-data?symbols=VUSA.L,AAPL&mode=quote   → batch quotes
// GET /api/market-data?symbols=VUSA.L&mode=chart&range=1m → chart data

import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { MarketQuote, ChartData, ChartPoint } from '../../lib/types.js';

export const config = { maxDuration: 15 };

// ── In-memory cache (per serverless instance) ──
const cache = new Map<string, { data: unknown; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiry) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

// ── Yahoo Finance v8 fetchers ──

const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const UA = 'Mozilla/5.0 (compatible; BOCY/1.0)';

async function fetchYahooQuotes(symbols: string[]): Promise<MarketQuote[]> {
  const url = `${YAHOO_BASE}/v7/finance/quote?symbols=${symbols.join(',')}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo quote API returned ${res.status}`);
  }

  const json = await res.json() as {
    quoteResponse?: {
      result?: Array<{
        symbol: string;
        regularMarketPrice: number;
        regularMarketPreviousClose: number;
        regularMarketChange: number;
        regularMarketChangePercent: number;
        currency: string;
        marketState: string;
        shortName?: string;
        longName?: string;
      }>;
    };
  };

  const results = json.quoteResponse?.result || [];

  return results.map((r) => ({
    symbol: r.symbol,
    price: r.regularMarketPrice ?? 0,
    previousClose: r.regularMarketPreviousClose ?? 0,
    change: r.regularMarketChange ?? 0,
    changePercent: r.regularMarketChangePercent ?? 0,
    currency: r.currency ?? 'GBP',
    marketState: normaliseMarketState(r.marketState),
    name: r.shortName || r.longName || r.symbol,
    lastUpdated: new Date().toISOString(),
  }));
}

async function fetchYahooChart(
  symbol: string,
  range: string,
): Promise<ChartData> {
  const interval = range === '1d' || range === '5d' ? '15m' : '1d';
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Yahoo chart API returned ${res.status}`);
  }

  const json = await res.json() as {
    chart?: {
      result?: Array<{
        meta?: { previousClose?: number };
        timestamp?: number[];
        indicators?: {
          quote?: Array<{ close?: (number | null)[] }>;
        };
      }>;
    };
  };

  const result = json.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const previousClose = result?.meta?.previousClose ?? 0;

  const points: ChartPoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close != null && !isNaN(close)) {
      points.push({ timestamp: timestamps[i], close });
    }
  }

  return { symbol, points, previousClose };
}

function normaliseMarketState(state: string | undefined): MarketQuote['marketState'] {
  switch (state) {
    case 'PRE': return 'PRE';
    case 'REGULAR': return 'REGULAR';
    case 'POST': case 'POSTPOST': return 'POST';
    default: return 'CLOSED';
  }
}

// ── Handler ──

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const symbolsParam = (req.query.symbols as string) || '';
  const mode = (req.query.mode as string) || 'quote';
  const range = (req.query.range as string) || '1m';

  const symbols = symbolsParam
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing symbols parameter' });
  }

  if (symbols.length > 20) {
    return res.status(400).json({ success: false, error: 'Maximum 20 symbols per request' });
  }

  const validRanges = ['1d', '5d', '1m', '3m', '6m', '1y'];
  if (mode === 'chart' && !validRanges.includes(range)) {
    return res.status(400).json({ success: false, error: `Invalid range. Use: ${validRanges.join(', ')}` });
  }

  try {
    if (mode === 'quote') {
      const cacheKey = `quote:${symbols.join(',')}`;
      const cached = getCached<MarketQuote[]>(cacheKey);
      if (cached) {
        return res.status(200).json({ success: true, quotes: cached, cached: true });
      }

      const quotes = await fetchYahooQuotes(symbols);
      setCache(cacheKey, quotes);

      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ success: true, quotes });

    } else if (mode === 'chart') {
      if (symbols.length > 1) {
        return res.status(400).json({ success: false, error: 'Chart mode supports one symbol at a time' });
      }

      const cacheKey = `chart:${symbols[0]}:${range}`;
      const cached = getCached<ChartData>(cacheKey);
      if (cached) {
        return res.status(200).json({ success: true, chart: cached, cached: true });
      }

      const chart = await fetchYahooChart(symbols[0], range);
      setCache(cacheKey, chart);

      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ success: true, chart });

    } else {
      return res.status(400).json({ success: false, error: 'Invalid mode. Use: quote, chart' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[market-data] Error:', message);
    return res.status(502).json({ success: false, error: 'Failed to fetch market data' });
  }
}
