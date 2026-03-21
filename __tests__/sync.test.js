/**
 * Tests for api/truelayer/sync.js
 *
 * Verifies that the TrueLayer sync endpoint:
 * 1. Rejects unauthenticated requests
 * 2. Does not overwrite CSV data when TrueLayer returns errors
 * 3. Persists rotated refresh tokens immediately (even on data fetch failure)
 * 4. Gracefully handles individual transaction fetch failures
 * 5. Writes transactions correctly on a successful sync
 */

// ── Supabase mock ──
const mockUpdate = jest.fn().mockReturnThis();
const mockEq = jest.fn().mockReturnThis();
const mockNot = jest.fn().mockReturnThis();
const mockOrder = jest.fn();
const mockSelect = jest.fn(() => ({
  eq: jest.fn(() => ({
    eq: jest.fn(() => ({
      not: jest.fn(() => ({
        order: mockOrder,
      })),
    })),
  })),
}));

const mockFrom = jest.fn((table) => ({
  select: mockSelect,
  update: (...args) => {
    mockUpdate(...args);
    return { eq: mockEq };
  },
}));

const mockGetUser = jest.fn();
const mockCreateClient = jest.fn(() => ({
  from: mockFrom,
  auth: { getUser: mockGetUser },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

// ── Env setup ──
process.env.TRUELAYER_CLIENT_ID = 'test-client-id';
process.env.TRUELAYER_CLIENT_SECRET = 'test-client-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key';

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
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', ...overrides.headers },
    body: { user_id: 'user-123', ...overrides.body },
    ...overrides,
  };
}

// ── Fetch mock builder ──
// Uses a function-based URL matcher: each response has a `match` function or string.
// If string, the URL pathname (without query) must end with it, or the full URL includes it.
function mockFetchResponses(responses) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url, opts });
    const pathname = url.split('?')[0];
    for (const r of responses) {
      const m = r.match;
      if (typeof m === 'function' ? m(url) : pathname.endsWith(m) || url.includes(m)) {
        if (r.throw) throw new Error(r.throw);
        return {
          ok: r.ok !== undefined ? r.ok : true,
          status: r.status || (r.ok === false ? 403 : 200),
          json: async () => r.json,
        };
      }
    }
    // Default: return empty success
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  });
  return calls;
}

// ── Import handler (after mocks) ──
let handler;
beforeAll(async () => {
  const mod = require('../api/truelayer/sync.js');
  handler = mod.default;
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: auth succeeds
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
});

// ════════════════════════════════════════════════════════════════
// 1. AUTH
// ════════════════════════════════════════════════════════════════

describe('Auth', () => {
  test('rejects requests with no Authorization header', async () => {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: { user_id: 'user-123' } }, res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe('Unauthorized');
  });

  test('rejects invalid JWT tokens', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status).toBe(401);
    expect(res._json.error).toBe('Invalid token');
  });

  test('rejects user_id mismatch (IDOR protection)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-123' } }, error: null });
    const res = makeRes();
    await handler(makeReq({ body: { user_id: 'user-456' } }), res);
    expect(res._status).toBe(403);
    expect(res._json.error).toBe('Forbidden');
  });
});

// ════════════════════════════════════════════════════════════════
// 2. EMPTY CSV GUARD
// ════════════════════════════════════════════════════════════════

describe('Empty CSV guard', () => {
  test('does NOT write csv_data when TrueLayer returns 0 transactions', async () => {
    // Bank row exists
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Monzo' }],
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

    // The update call should NOT contain csv_data
    const updateCalls = mockUpdate.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    // First update is refresh_token, second is the data update
    const dataUpdateCall = updateCalls.find(
      (call) => call[0] && call[0].updated_at !== undefined && call[0].csv_data === undefined
    );
    // Verify no csv_data was written
    for (const call of updateCalls) {
      if (call[0]?.updated_at) {
        expect(call[0].csv_data).toBeUndefined();
      }
    }
  });

  test('does NOT write csv_data when TrueLayer returns 403 on accounts/cards', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Barclays' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at-new', refresh_token: 'rt-new' } },
      { match: (u) => u.endsWith('data/v1/accounts'), ok: false, status: 403, json: { error: 'forbidden' } },
      { match: (u) => u.endsWith('data/v1/cards'), ok: false, status: 403, json: { error: 'forbidden' } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    // syncConnection returns null on 403 → no csv_data update
    expect(res._json.success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// 3. REFRESH TOKEN PERSISTENCE
// ════════════════════════════════════════════════════════════════

describe('Refresh token persistence', () => {
  test('persists new refresh token even when data fetch throws', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'HSBC' }],
      error: null,
    });

    let fetchCount = 0;
    global.fetch = jest.fn(async (url) => {
      fetchCount++;
      if (url.includes('connect/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at-new', refresh_token: 'rt-new' }) };
      }
      if (url.includes('data/v1/accounts')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ account_id: 'acc-1' }] }) };
      }
      if (url.includes('data/v1/cards')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      // Transaction fetch throws network error
      if (url.includes('transactions')) {
        throw new Error('Network timeout');
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    // The handler should still have persisted the new refresh token
    const tokenUpdateCall = mockUpdate.mock.calls.find(
      (call) => call[0]?.refresh_token === 'rt-new'
    );
    expect(tokenUpdateCall).toBeTruthy();
  });

  test('persists refresh token on successful sync', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Monzo' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at-new', refresh_token: 'rt-new' } },
      { match: (u) => u.includes('/transactions'), json: { results: [
        { timestamp: '2025-03-01T00:00:00Z', description: 'Tesco', amount: 45.00, transaction_type: 'DEBIT' },
      ] } },
      { match: (u) => u.includes('/balance'), json: { results: [{ current: 1200, available: 1200 }] } },
      { match: 'data/v1/accounts', json: { results: [{ account_id: 'acc-1' }] } },
      { match: 'data/v1/cards', json: { results: [] } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    const tokenUpdate = mockUpdate.mock.calls.find((c) => c[0]?.refresh_token === 'rt-new');
    expect(tokenUpdate).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════
// 4. SUCCESSFUL SYNC
// ════════════════════════════════════════════════════════════════

describe('Successful sync', () => {
  test('returns merged CSV with transactions and correct structure', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Monzo' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at-new', refresh_token: 'rt-new' } },
      { match: (u) => u.includes('/transactions'), json: { results: [
        { timestamp: '2025-03-01T00:00:00Z', description: 'Tesco', amount: 45.00, transaction_type: 'DEBIT' },
        { timestamp: '2025-03-02T00:00:00Z', merchant_name: 'Amazon', description: 'AMZN', amount: 12.99, transaction_type: 'DEBIT' },
        { timestamp: '2025-03-03T00:00:00Z', description: 'Salary', amount: 2500, transaction_type: 'CREDIT' },
      ] } },
      { match: (u) => u.includes('/balance'), json: { results: [{ current: 1200, available: 1200 }] } },
      { match: 'data/v1/accounts', json: { results: [{ account_id: 'acc-1' }] } },
      { match: 'data/v1/cards', json: { results: [] } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.success).toBe(true);
    expect(res._json.transactions_found).toBe(3);
    expect(res._json.csv_data).toContain('Date,Description,Amount');
    expect(res._json.csv_data).toContain('Tesco,-45');
    expect(res._json.csv_data).toContain('Amazon,-12.99');
    expect(res._json.csv_data).toContain('Salary,2500');
  });

  test('writes csv_data to bank_data row when transactions exist', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Monzo' }],
      error: null,
    });

    mockFetchResponses([
      { match: 'connect/token', json: { access_token: 'at-new', refresh_token: 'rt-new' } },
      { match: (u) => u.includes('/transactions'), json: { results: [
        { timestamp: '2025-03-01T00:00:00Z', description: 'Tesco', amount: 45.00, transaction_type: 'DEBIT' },
      ] } },
      { match: (u) => u.includes('/balance'), json: { results: [{ current: 500, available: 500 }] } },
      { match: 'data/v1/accounts', json: { results: [{ account_id: 'acc-1' }] } },
      { match: 'data/v1/cards', json: { results: [] } },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    // Find the data update call (not the refresh_token update)
    const csvUpdateCall = mockUpdate.mock.calls.find((c) => c[0]?.csv_data);
    expect(csvUpdateCall).toBeTruthy();
    expect(csvUpdateCall[0].csv_data).toContain('Date,Description,Amount');
    expect(csvUpdateCall[0].csv_data).toContain('Tesco,-45');
  });
});

// ════════════════════════════════════════════════════════════════
// 5. PARTIAL FAILURE (one tx fetch fails, others succeed)
// ════════════════════════════════════════════════════════════════

describe('Partial transaction fetch failure', () => {
  test('still returns data from successful accounts when one fails', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Monzo' }],
      error: null,
    });

    global.fetch = jest.fn(async (url) => {
      if (url.includes('connect/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt-new' }) };
      }
      // More specific matches first (transactions/balance before bare accounts/cards)
      if (url.includes('acc-1/transactions')) {
        return { ok: true, status: 200, json: async () => ({ results: [
          { timestamp: '2025-03-01T00:00:00Z', description: 'Tesco', amount: 45.00, transaction_type: 'DEBIT' },
        ] }) };
      }
      if (url.includes('acc-2/transactions')) {
        throw new Error('Network error');
      }
      if (url.includes('/balance')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ current: 500, available: 500 }] }) };
      }
      if (url.endsWith('data/v1/accounts')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ account_id: 'acc-1' }, { account_id: 'acc-2' }] }) };
      }
      if (url.endsWith('data/v1/cards')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.success).toBe(true);
    expect(res._json.transactions_found).toBe(1);
    expect(res._json.csv_data).toContain('Tesco');
  });
});

// ════════════════════════════════════════════════════════════════
// 6. EXPIRED TOKEN
// ════════════════════════════════════════════════════════════════

describe('Expired token handling', () => {
  test('returns token_expired when TrueLayer returns invalid_grant even within 90-day window', async () => {
    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: new Date().toISOString(), provider_name: 'Monzo' }],
      error: null,
    });

    global.fetch = jest.fn(async () => {
      return { ok: true, status: 200, json: async () => ({ error: 'invalid_grant' }) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.success).toBe(false);
    // TrueLayer's response determines expiry, not the 90-day window
    expect(res._json.reason).toBe('token_expired');
  });

  test('returns token_expired when token fails and consent window lapsed', async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 91); // Past 90-day window

    mockOrder.mockResolvedValue({
      data: [{ id: 'row-1', connection_id: 'conn-1', refresh_token: 'rt-old', created_at: oldDate.toISOString(), provider_name: 'Monzo' }],
      error: null,
    });

    global.fetch = jest.fn(async () => {
      return { ok: true, status: 200, json: async () => ({ error: 'invalid_grant' }) };
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res._json.success).toBe(false);
    expect(res._json.reason).toBe('token_expired');
    expect(res._json.expired_connections).toHaveLength(1);
    expect(res._json.expired_connections[0].provider_name).toBe('Monzo');
  });
});

// ════════════════════════════════════════════════════════════════
// 7. maxDuration config
// ════════════════════════════════════════════════════════════════

describe('Config', () => {
  test('exports maxDuration of 60', () => {
    const { config } = require('../api/truelayer/sync.js');
    expect(config.maxDuration).toBe(60);
  });
});
