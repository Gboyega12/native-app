// ── Market Data Client ──
// Client-side service for fetching market data via our /api/market-data proxy.
// Includes in-memory cache with 5-min TTL to avoid excessive requests.

import type { MarketQuote, ChartData } from './types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, { data: unknown; expiry: number }>();

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

// Deduplicate concurrent requests for the same key
const inflight = new Map<string, Promise<unknown>>();

async function deduped<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * Fetch quotes for one or more ticker symbols.
 * Returns a map keyed by symbol for easy lookup.
 */
export async function fetchQuotes(
  symbols: string[],
): Promise<Record<string, MarketQuote>> {
  if (symbols.length === 0) return {};

  const cleaned = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const cacheKey = `quotes:${cleaned.join(',')}`;

  const cached = getCached<Record<string, MarketQuote>>(cacheKey);
  if (cached) return cached;

  return deduped(cacheKey, async () => {
    const res = await fetch(
      `/api/market-data?symbols=${encodeURIComponent(cleaned.join(','))}&mode=quote`,
    );

    if (!res.ok) {
      throw new Error(`Market data request failed: ${res.status}`);
    }

    const json = (await res.json()) as { success: boolean; quotes?: MarketQuote[] };
    if (!json.success || !json.quotes) {
      throw new Error('Invalid market data response');
    }

    const map: Record<string, MarketQuote> = {};
    for (const q of json.quotes) {
      map[q.symbol] = q;
    }

    setCache(cacheKey, map);
    return map;
  });
}

/**
 * Fetch chart data for a single symbol.
 */
export async function fetchChart(
  symbol: string,
  range: '1d' | '5d' | '1m' | '3m' | '6m' | '1y' = '1m',
): Promise<ChartData> {
  const clean = symbol.trim().toUpperCase();
  const cacheKey = `chart:${clean}:${range}`;

  const cached = getCached<ChartData>(cacheKey);
  if (cached) return cached;

  return deduped(cacheKey, async () => {
    const res = await fetch(
      `/api/market-data?symbols=${encodeURIComponent(clean)}&mode=chart&range=${range}`,
    );

    if (!res.ok) {
      throw new Error(`Chart data request failed: ${res.status}`);
    }

    const json = (await res.json()) as { success: boolean; chart?: ChartData };
    if (!json.success || !json.chart) {
      throw new Error('Invalid chart data response');
    }

    setCache(cacheKey, json.chart);
    return json.chart;
  });
}

/** Clear all cached market data (useful after manual refresh) */
export function clearMarketCache(): void {
  cache.clear();
}
