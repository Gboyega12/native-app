# Yahoo Finance Integration — Implementation Plan

## Context
BOCY already has an `investments` table with a `ticker` column. Users can manually add investments with tickers in account-setup. We need a Yahoo Finance integration to:
1. Fetch live/recent prices for tickers
2. Auto-update investment values
3. Provide market data for the decision engine

## Architecture

### 1. Serverless API Route: `api/market-data/index.ts`
**Vercel serverless function** that proxies Yahoo Finance requests server-side.

Why server-side:
- No CORS issues (Yahoo Finance blocks browser requests)
- Rate-limit control — single server IP, cacheable
- No API key exposed to client (Yahoo Finance v8 API is free, no key needed)
- Can add caching layer (in-memory + Supabase if needed)

**Endpoints:**
- `GET /api/market-data?symbols=VUSA.L,AAPL,TSLA` — batch quote lookup
- `GET /api/market-data?symbols=VUSA.L&range=1m` — historical data (for sparklines)

**Yahoo Finance API (v8 — free, no key):**
- Quote: `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=1d&range=5d`
- Batch: `https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL,TSLA`

### 2. Library: `lib/market-data.ts`
Client-side service that:
- Calls our `/api/market-data` proxy
- Provides `fetchQuotes(symbols: string[])` → `{ [symbol]: QuoteData }`
- Provides `fetchChart(symbol: string, range: '1d'|'5d'|'1m'|'3m')` → `ChartData`
- Handles errors gracefully (market closed, invalid ticker, rate limited)
- In-memory cache with 5-min TTL to avoid excessive API calls

### 3. Hook: `hooks/useMarketData.ts`
React hook for components:
- `useMarketData(symbols: string[])` → `{ quotes, loading, error, refresh }`
- Auto-refreshes every 5 minutes during market hours
- Deduplicates concurrent requests
- Handles empty symbols array gracefully

### 4. Migration: `supabase-migration-ticker.sql`
Add `ticker` column to investments table if not already present:
```sql
ALTER TABLE investments ADD COLUMN IF NOT EXISTS ticker TEXT;
```

### 5. Cron: `api/cron/market-sync.ts`
Daily cron job (runs at 18:00 UTC, after London close):
- Fetches all distinct tickers from `investments` table
- Batch-fetches latest prices from Yahoo Finance
- Updates `current_value` for investments with tickers
- Logs sync results

Add to `vercel.json`:
```json
{ "path": "/api/cron/market-sync", "schedule": "0 18 * * 1-5" }
```

### 6. Types: Update `lib/types.ts`
```typescript
export interface MarketQuote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  currency: string;
  marketState: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';
  lastUpdated: string;
}

export interface ChartPoint {
  timestamp: number;
  close: number;
}
```

## Implementation Order

1. **Types** — Add `MarketQuote` and `ChartPoint` to `lib/types.ts`
2. **API route** — `api/market-data/index.ts` (Yahoo Finance proxy with caching)
3. **Client lib** — `lib/market-data.ts` (fetch + cache layer)
4. **Hook** — `hooks/useMarketData.ts` (React hook with auto-refresh)
5. **Cron** — `api/cron/market-sync.ts` (daily price sync)
6. **Migration** — `supabase-migration-ticker.sql` (ensure ticker column exists)
7. **Update vercel.json** — Add cron schedule and CSP for Yahoo Finance

## Key Design Decisions

- **No npm dependency** — Use native `fetch` to call Yahoo Finance API directly. Avoids the bloated `yahoo-finance2` package (~2MB) and keeps the bundle lean.
- **Server-side proxy** — All Yahoo requests go through our Vercel function. Client never talks to Yahoo directly.
- **5-min client cache** — Prevents excessive API calls. Market data doesn't need sub-minute freshness for a personal finance app.
- **Batch requests** — Single API call for multiple symbols. Yahoo supports comma-separated symbols.
- **UK-aware** — Auto-append `.L` suffix for LSE-listed tickers when no exchange suffix present.
- **Graceful degradation** — If Yahoo is down or rate-limited, investments fall back to their last known `current_value`. No crashes, no stale indicators.
- **CRON_SECRET protected** — Market sync cron uses the existing `CRON_SECRET` auth pattern.
