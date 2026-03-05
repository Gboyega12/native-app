/**
 * Tests for api/cron/bank-sync.js
 *
 * Verifies that the bank-sync cron job:
 * 1. Does not overwrite CSV data when TrueLayer returns errors
 * 2. Persists rotated refresh tokens immediately (even on failure)
 * 3. Fetches account balances (not just card balances)
 * 4. Handles expired connections correctly
 * 5. Writes transactions correctly on a successful refresh
 */

// ── Supabase mock ──
const updateCalls = [];
const mockEq = jest.fn().mockReturnThis();
const mockUpdate = jest.fn((...args) => {
  updateCalls.push(args);
  return { eq: mockEq };
});
const mockNot = jest.fn().mockReturnThis();
const mockOrder = jest.fn();
const mockSelectFn = jest.fn();
const mockUpsert = jest.fn().mockResolvedValue({ error: null });

const mockFrom = jest.fn((table) => ({
  select: (...selArgs) => {
    mockSelectFn(table, ...selArgs);
    return {
      eq: jest.fn(() => ({
        eq: jest.fn(() => ({
          not: jest.fn(() => ({
            order: mockOrder,
          })),
        })),
        not: jest.fn(() => ({
          order: mockOrder,
        })),
        gte: jest.fn(() => ({ limit: jest.fn().mockResolvedValue({ data: [] }) })),
        single: jest.fn().mockResolvedValue({ data: null }),
      })),
    };
  },
  update: (...args) => {
    mockUpdate(...args);
    return { eq: mockEq };
  },
  upsert: mockUpsert,
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: mockFrom,
  })),
}));

// ── Env setup ──
process.env.TRUELAYER_CLIENT_ID = 'test-client-id';
process.env.TRUELAYER_CLIENT_SECRET = 'test-client-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.CRON_SECRET = 'test-cron-secret';

// ── Helpers ──
function makeRes() {
  const res = {
    _status: 200,
    _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

function makeReq(overrides = {}) {
  return {
    method: 'GET',
    headers: { authorization: 'Bearer test-cron-secret' },
    ...overrides,
  };
}

function mockFetchResponses(responses) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url, opts });
    for (const r of responses) {
      const m = r.match;
      const matched = typeof m === 'function' ? m(url) : url.includes(m);
      if (matched) {
        if (r.throw) throw new Error(r.throw);
        return {
          ok: r.ok !== undefined ? r.ok : true,
          status: r.status || (r.ok === false ? 403 : 200),
          json: async () => r.json,
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  });
  return calls;
}

let handler;
beforeAll(async () => {
  const mod = require('../api/cron/bank-sync.js');
  handler = mod.default;
});

beforeEach(() => {
  jest.clearAllMocks();
  updateCalls.length = 0;
});

// ════════════════════════════════════════════════════════════════
// 1. AUTH
// ════════════════════════════════════════════════════════════════

describe('Cron auth', () => {
  test('rejects requests without valid cron secret', async () => {
    const res = makeRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    expect(res._status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. EMPTY CSV GUARD
// ════════════════════════════════════════════════════════════════

describe('Empty CSV guard', () => {
  test('does NOT write csv_data when transactions are empty', async () => {
    const now = new Date().toISOString();
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', user_id: 'u1', created_at: now, updated_at: now, provider_name: 'Monzo' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at-new', refresh_token: 'rt-new' } },
      { match: (u) => u.includes('/transactions'), json: { results: [] } },
      { match: (u) => u.includes('/balance'), json: { results: [{ current: 500, available: 500 }] } },
      { match: 'data/v1/accounts', json: { results: [{ account_id: 'acc-1' }] } },
      { match: 'data/v1/cards', json: { results: [] } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.success).toBe(true);
    expect(res._json.refreshed).toBe(1);

    // Check that no csv_data was written in any update call
    for (const call of updateCalls) {
      if (call[0]?.updated_at) {
        expect(call[0].csv_data).toBeUndefined();
      }
    }
  });

  test('does NOT write csv_data when TrueLayer returns 403', async () => {
    const now = new Date().toISOString();
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', user_id: 'u1', created_at: now, updated_at: now, provider_name: 'Barclays' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at-new', refresh_token: 'rt-new' } },
      { match: (u) => u.endsWith('data/v1/accounts'), ok: false, status: 403, json: { error: 'forbidden' } },
      { match: (u) => u.endsWith('data/v1/cards'), ok: false, status: 403, json: { error: 'forbidden' } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    // refreshConnection returns { success: false } → no data update
    expect(res._json.refreshed).toBe(0);
    expect(res._json.failed).toBe(1);

    // No csv_data should have been written
    const csvWrites = updateCalls.filter((c) => c[0]?.csv_data);
    expect(csvWrites).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// 3. REFRESH TOKEN PERSISTENCE
// ════════════════════════════════════════════════════════════════

describe('Refresh token persistence', () => {
  test('persists new refresh token even when refreshConnection fails partially', async () => {
    const now = new Date().toISOString();
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', user_id: 'u1', created_at: now, updated_at: now, provider_name: 'HSBC' }],
      error: null,
    });

    // Token exchange succeeds, but transaction fetch throws
    global.fetch = jest.fn(async (url) => {
      if (url.includes('connect/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new' }) };
      }
      if (url.includes('data/v1/accounts')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ account_id: 'acc-1' }] }) };
      }
      if (url.includes('data/v1/cards')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (url.includes('transactions')) {
        throw new Error('Network timeout');
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    // The new refresh token should have been persisted
    const tokenWrite = updateCalls.find((c) => c[0]?.refresh_token === 'rt-new');
    expect(tokenWrite).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════
// 4. ACCOUNT BALANCES
// ════════════════════════════════════════════════════════════════

describe('Account balance fetches', () => {
  test('fetches account balances and includes overdraft data', async () => {
    const now = new Date().toISOString();
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', user_id: 'u1', created_at: now, updated_at: now, provider_name: 'Monzo' }],
      error: null,
    });

    const fetchCalls = [];
    global.fetch = jest.fn(async (url) => {
      fetchCalls.push(url);
      if (url.includes('connect/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt-new' }) };
      }
      if (url.includes('data/v1/accounts') && !url.includes('/balance') && !url.includes('/transactions')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ account_id: 'acc-1', display_name: 'Current' }] }) };
      }
      if (url.includes('data/v1/cards') && !url.includes('/balance') && !url.includes('/transactions')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      if (url.includes('acc-1/transactions')) {
        return { ok: true, status: 200, json: async () => ({ results: [
          { timestamp: '2025-03-01T00:00:00Z', description: 'Tesco', amount: 10, transaction_type: 'DEBIT' },
        ] }) };
      }
      if (url.includes('acc-1/balance')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ current: -150, available: 350, overdraft: 500 }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    // Verify that account balance endpoint was called
    const balanceFetches = fetchCalls.filter((u) => u.includes('acc-1/balance'));
    expect(balanceFetches.length).toBe(1);

    // card_balances should include the overdrawn account
    const balanceWrite = updateCalls.find((c) => c[0]?.card_balances);
    expect(balanceWrite).toBeTruthy();
    expect(balanceWrite[0].card_balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'overdraft', balance: 150 }),
      ])
    );
  });
});

// ════════════════════════════════════════════════════════════════
// 5. SUCCESSFUL SYNC
// ════════════════════════════════════════════════════════════════

describe('Successful refresh', () => {
  test('writes csv_data and returns correct counts', async () => {
    const now = new Date().toISOString();
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', user_id: 'u1', created_at: now, updated_at: now, provider_name: 'Monzo' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at', refresh_token: 'rt-new' } },
      { match: (u) => u.includes('/transactions'), json: { results: [
        { timestamp: '2025-03-01T00:00:00Z', description: 'Tesco', amount: 45.00, transaction_type: 'DEBIT' },
        { timestamp: '2025-03-02T00:00:00Z', description: 'Salary', amount: 2500, transaction_type: 'CREDIT' },
      ] } },
      { match: (u) => u.includes('/balance'), json: { results: [{ current: 1200, available: 1200 }] } },
      { match: 'data/v1/accounts', json: { results: [{ account_id: 'acc-1' }] } },
      { match: 'data/v1/cards', json: { results: [] } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.success).toBe(true);
    expect(res._json.refreshed).toBe(1);

    // Verify CSV was written
    const csvWrite = updateCalls.find((c) => c[0]?.csv_data);
    expect(csvWrite).toBeTruthy();
    expect(csvWrite[0].csv_data).toContain('Date,Description,Amount');
    expect(csvWrite[0].csv_data).toContain('Tesco,-45');
    expect(csvWrite[0].csv_data).toContain('Salary,2500');
  });
});

// ════════════════════════════════════════════════════════════════
// 6. EXPIRED CONNECTIONS
// ════════════════════════════════════════════════════════════════

describe('Expired connections', () => {
  test('skips connections past the 90-day consent window', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 91);

    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', user_id: 'u1', created_at: oldDate.toISOString(), updated_at: oldDate.toISOString(), provider_name: 'Old Bank' }],
      error: null,
    });

    const fetchCalls = [];
    global.fetch = jest.fn(async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.expired).toBe(1);
    expect(res._json.refreshed).toBe(0);
    // Should not have called TrueLayer token endpoint
    const tokenCalls = fetchCalls.filter((u) => u.includes('connect/token'));
    expect(tokenCalls).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// 7. CONFIG
// ════════════════════════════════════════════════════════════════

describe('Config', () => {
  test('exports maxDuration of 60', () => {
    const { config } = require('../api/cron/bank-sync.js');
    expect(config.maxDuration).toBe(60);
  });
});
