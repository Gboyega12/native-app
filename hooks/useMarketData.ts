// ── useMarketData Hook ──
// Fetches live market quotes for a list of ticker symbols.
// Auto-refreshes every 5 minutes. Handles loading, error, and empty states.

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchQuotes, clearMarketCache } from '../lib/market-data';
import type { MarketQuote } from '../lib/types';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface UseMarketDataResult {
  quotes: Record<string, MarketQuote>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useMarketData(symbols: string[]): UseMarketDataResult {
  const [quotes, setQuotes] = useState<Record<string, MarketQuote>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable reference for the symbols array to avoid infinite re-renders
  const symbolsKey = symbols
    .filter(Boolean)
    .map((s) => s.trim().toUpperCase())
    .sort()
    .join(',');

  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const syms = symbolsKey.split(',').filter(Boolean);
    if (syms.length === 0) {
      setQuotes({});
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await fetchQuotes(syms);
      if (mountedRef.current) {
        setQuotes(result);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch market data');
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [symbolsKey]);

  // Initial fetch + auto-refresh
  useEffect(() => {
    mountedRef.current = true;
    load();

    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [load]);

  const refresh = useCallback(async () => {
    clearMarketCache();
    await load();
  }, [load]);

  return { quotes, loading, error, refresh };
}
