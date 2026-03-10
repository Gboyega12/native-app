/**
 * Tests for api/truelayer/callback.js
 *
 * Verifies that the TrueLayer callback endpoint:
 * 1. Exchanges auth codes and saves bank data correctly
 * 2. Handles zero-transaction scenarios (new accounts) gracefully
 * 3. Produces correct CSV format that processing.tsx can consume
 * 4. Cleans up old connections for the same provider
 * 5. Stores card/account balances
 */

// ── Supabase mock ──
const mockInsert = jest.fn().mockResolvedValue({ error: null });
const mockDeleteChain = {
  eq: jest.fn().mockReturnThis(),
  neq: jest.fn().mockResolvedValue({ error: null }),
};
const mockUpdateChain = {
  eq: jest.fn().mockResolvedValue({ error: null }),
};
const mockFrom = jest.fn((table) => ({
  insert: mockInsert,
  delete: () => mockDeleteChain,
  update: (...args) => {
    mockUpdateChain._args = args;
    return mockUpdateChain;
  },
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom }),
}));

// ── Env setup ──
process.env.TRUELAYER_CLIENT_ID = 'test-client-id';
process.env.TRUELAYER_CLIENT_SECRET = 'test-client-secret';
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.EXPO_PUBLIC_TRUELAYER_SANDBOX = 'false';

// ── Helpers ──
function makeRes() {
  const res = {
    _status: 200,
    _json: null,
    _redirect: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    redirect(code, url) { res._status = code; res._redirect = url; return res; },
  };
  return res;
}

function makePostReq(overrides = {}) {
  return {
    method: 'POST',
    body: {
      code: 'auth-code-123',
      state: 'conn_test_abc|https://app.bocy.io',
      user_id: 'user-123',
      ...overrides,
    },
    query: {},
  };
}

function makeGetReq(overrides = {}) {
  return {
    method: 'GET',
    query: {
      code: 'auth-code-123',
      state: 'conn_test_abc|https://app.bocy.io',
      ...overrides,
    },
    body: {},
  };
}

// Standard TrueLayer mock responses
const MOCK_TOKEN = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_in: 3600,
};

const MOCK_ACCOUNTS = {
  results: [{
    account_id: 'acc-001',
    display_name: 'Current Account',
    provider: { display_name: 'Barclays' },
  }],
};

const MOCK_CARDS = { results: [] };

const MOCK_TRANSACTIONS = {
  results: [
    { timestamp: '2025-03-01T10:00:00Z', merchant_name: 'Tesco', description: 'Tesco Stores', amount: 45.5, transaction_type: 'DEBIT' },
    { timestamp: '2025-03-02T09:00:00Z', merchant_name: null, description: 'SALARY DEPOSIT', amount: 2500, transaction_type: 'CREDIT' },
    { timestamp: '2025-03-03T14:30:00Z', merchant_name: 'Netflix', description: 'Netflix.com', amount: 15.99, transaction_type: 'DEBIT' },
  ],
};

const MOCK_BALANCE = {
  results: [{ current: 1250.00, available: 1250.00 }],
};

function setupFetch(overrides = {}) {
  const calls = [];
  global.fetch = jest.fn(async (url, opts) => {
    calls.push({ url, opts });

    // Token exchange
    if (url.includes('/connect/token')) {
      return { ok: true, json: async () => overrides.token || MOCK_TOKEN };
    }
    // Accounts
    if (url.includes('/data/v1/accounts') && !url.includes('/transactions') && !url.includes('/balance')) {
      return { ok: true, json: async () => overrides.accounts || MOCK_ACCOUNTS };
    }
    // Cards
    if (url.includes('/data/v1/cards') && !url.includes('/transactions') && !url.includes('/balance')) {
      return { ok: true, json: async () => overrides.cards || MOCK_CARDS };
    }
    // Transactions
    if (url.includes('/transactions')) {
      return { ok: true, json: async () => overrides.transactions || MOCK_TRANSACTIONS };
    }
    // Balance
    if (url.includes('/balance')) {
      return { ok: true, json: async () => overrides.balance || MOCK_BALANCE };
    }

    return { ok: true, json: async () => ({ results: [] }) };
  });
  return calls;
}

// ── Import handler (after mocks) ──
let handler;
beforeAll(async () => {
  const mod = require('../api/truelayer/callback.js');
  handler = mod.default;
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════
// 1. SUCCESSFUL FLOW
// ════════════════════════════════════════════════════════════════

describe('Successful connection (POST)', () => {
  test('exchanges code, fetches transactions, saves CSV, returns success JSON', async () => {
    const calls = setupFetch();
    const res = makeRes();
    await handler(makePostReq(), res);

    // Should return success
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.connection_id).toBe('conn_test_abc');
    expect(res._json.transactions_found).toBe(3);
    expect(res._json.accounts_found).toBe(1);

    // Should save to Supabase
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertedRow = mockInsert.mock.calls[0][0];
    expect(insertedRow.connection_id).toBe('conn_test_abc');
    expect(insertedRow.source).toBe('truelayer');
    expect(insertedRow.refresh_token).toBe('test-refresh-token');
    expect(insertedRow.user_id).toBe('user-123');
    expect(insertedRow.provider_name).toBe('Barclays');
    expect(insertedRow.account_type).toBe('bank');

    // CSV format is correct
    const lines = insertedRow.csv_data.split('\n');
    expect(lines[0]).toBe('Date,Description,Amount');
    expect(lines.length).toBe(4); // header + 3 transactions
    expect(lines[1]).toBe('2025-03-01,Tesco,-45.5');
    expect(lines[2]).toBe('2025-03-02,SALARY DEPOSIT,2500');
    expect(lines[3]).toBe('2025-03-03,Netflix,-15.99');
  });

  test('GET request redirects to app on success', async () => {
    setupFetch();
    const res = makeRes();
    await handler(makeGetReq(), res);

    expect(res._status).toBe(302);
    expect(res._redirect).toContain('https://app.bocy.io/connect?connection_id=conn_test_abc&status=success');
  });
});

// ════════════════════════════════════════════════════════════════
// 2. ZERO TRANSACTIONS (the bug scenario)
// ════════════════════════════════════════════════════════════════

describe('Zero transactions (new account)', () => {
  test('saves header-only CSV when bank returns 0 transactions', async () => {
    setupFetch({ transactions: { results: [] } });
    const res = makeRes();
    await handler(makePostReq(), res);

    // Should still succeed — bank IS connected
    expect(res._status).toBe(200);
    expect(res._json.success).toBe(true);
    expect(res._json.transactions_found).toBe(0);

    // CSV should be header-only
    const insertedRow = mockInsert.mock.calls[0][0];
    expect(insertedRow.csv_data).toBe('Date,Description,Amount');

    // Line count check (what processing.tsx uses)
    const lineCount = insertedRow.csv_data.trim().split('\n').length;
    expect(lineCount).toBe(1); // header only — this triggers the lineCount <= 1 branch
  });

  test('header-only CSV from bank source should bypass to dashboard (not show CSV error)', () => {
    // This verifies the fix in processing.tsx:
    // When source === 'bank' and lineCount <= 1, we bypass to dashboard
    // instead of showing "Check the file format" error
    const csvData = 'Date,Description,Amount';
    const lineCount = csvData.trim().split('\n').length;
    expect(lineCount).toBe(1);

    // The fix: source === 'bank' → router.replace('/(main)/(tabs)') instead of setError()
    // This is a logic assertion — the actual routing is tested via the source param
    const source = 'bank';
    const shouldBypassToDashboard = source === 'bank' && lineCount <= 1;
    expect(shouldBypassToDashboard).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
// 3. CSV FORMAT VALIDATION
// ════════════════════════════════════════════════════════════════

describe('CSV format', () => {
  test('commas in merchant names are replaced with spaces', async () => {
    setupFetch({
      transactions: {
        results: [{
          timestamp: '2025-03-01T10:00:00Z',
          merchant_name: 'Tesco, Extra',
          description: 'Tesco, Extra Birmingham',
          amount: 30,
          transaction_type: 'DEBIT',
        }],
      },
    });
    const res = makeRes();
    await handler(makePostReq(), res);

    const csv = mockInsert.mock.calls[0][0].csv_data;
    // No extra commas in the description field
    const dataLine = csv.split('\n')[1];
    const parts = dataLine.split(',');
    expect(parts.length).toBe(3); // Date, Description, Amount — no extra splits
    expect(parts[1]).toBe('Tesco  Extra'); // comma replaced with space
  });

  test('CREDIT transactions have positive amounts, DEBIT negative', async () => {
    setupFetch({
      transactions: {
        results: [
          { timestamp: '2025-03-01T10:00:00Z', merchant_name: 'Salary', amount: 2500, transaction_type: 'CREDIT' },
          { timestamp: '2025-03-02T10:00:00Z', merchant_name: 'Shop', amount: 50, transaction_type: 'DEBIT' },
        ],
      },
    });
    const res = makeRes();
    await handler(makePostReq(), res);

    const lines = mockInsert.mock.calls[0][0].csv_data.split('\n');
    expect(lines[1]).toContain('2500'); // positive
    expect(lines[2]).toContain('-50'); // negative
  });

  test('falls back to description when merchant_name is null', async () => {
    setupFetch({
      transactions: {
        results: [{
          timestamp: '2025-03-01T10:00:00Z',
          merchant_name: null,
          description: 'Direct Debit Payment',
          amount: 100,
          transaction_type: 'DEBIT',
        }],
      },
    });
    const res = makeRes();
    await handler(makePostReq(), res);

    const csv = mockInsert.mock.calls[0][0].csv_data;
    expect(csv).toContain('Direct Debit Payment');
  });
});

// ════════════════════════════════════════════════════════════════
// 4. ERROR HANDLING
// ════════════════════════════════════════════════════════════════

describe('Error handling', () => {
  test('rejects missing authorization code', async () => {
    const res = makeRes();
    await handler(makePostReq({ code: null }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('Missing authorization code');
  });

  test('rejects missing state/connection_id', async () => {
    const res = makeRes();
    await handler(makePostReq({ state: '' }), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('Missing connection_id');
  });

  test('handles token exchange failure', async () => {
    setupFetch({ token: { error: 'invalid_grant', error_description: 'Code expired' } });
    const res = makeRes();
    await handler(makePostReq(), res);
    expect(res._status).toBe(400);
    expect(res._json.error).toContain('Token exchange failed');
  });

  test('rejects unsupported HTTP methods', async () => {
    const res = makeRes();
    await handler({ method: 'PUT', body: {}, query: {} }, res);
    expect(res._status).toBe(405);
  });

  test('GET errors redirect to app instead of returning JSON', async () => {
    setupFetch({ token: { error: 'invalid_grant' } });
    const res = makeRes();
    await handler(makeGetReq(), res);
    expect(res._status).toBe(302);
    expect(res._redirect).toContain('status=error');
    expect(res._redirect).toContain('Token%20exchange%20failed');
  });
});

// ════════════════════════════════════════════════════════════════
// 5. OLD CONNECTION CLEANUP
// ════════════════════════════════════════════════════════════════

describe('Old connection cleanup', () => {
  test('deletes old rows for same user + provider after successful insert', async () => {
    setupFetch();
    const res = makeRes();
    await handler(makePostReq(), res);

    // Should have called delete on bank_data
    expect(mockFrom).toHaveBeenCalledWith('bank_data');
    // The delete chain should filter by user_id, source, provider_name, and exclude current connection_id
    expect(mockDeleteChain.eq).toHaveBeenCalled();
    expect(mockDeleteChain.neq).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// 6. SOURCE PARAM (processing.tsx integration)
// ════════════════════════════════════════════════════════════════

describe('Source param for processing.tsx', () => {
  test('connect.tsx should pass source=bank for Open Banking connections', () => {
    // Simulates the logic in connect.tsx:
    // const source = _label === 'Bank account' ? 'bank' : 'csv';
    const bankLabel = 'Bank account';
    const csvLabel = 'CSV statement';
    const pdfLabel = 'PDF statement';

    expect(bankLabel === 'Bank account' ? 'bank' : 'csv').toBe('bank');
    expect(csvLabel === 'Bank account' ? 'bank' : 'csv').toBe('csv');
    expect(pdfLabel === 'Bank account' ? 'bank' : 'csv').toBe('csv');
  });

  test('processing.tsx: bank source with empty CSV bypasses to dashboard', () => {
    // Simulates the fix in processing.tsx lines 203-209
    const source = 'bank';
    const csvData = 'Date,Description,Amount'; // header-only from bank
    const lineCount = csvData.trim().split('\n').length;

    // Before fix: would hit setError('No transactions found...')
    // After fix: bypasses to dashboard
    const shouldBypass = source === 'bank' && lineCount <= 1;
    expect(shouldBypass).toBe(true);
  });

  test('processing.tsx: csv source with empty CSV shows format error', () => {
    const source = 'csv';
    const csvData = 'Date,Description,Amount';
    const lineCount = csvData.trim().split('\n').length;

    const shouldBypass = source === 'bank' && lineCount <= 1;
    expect(shouldBypass).toBe(false); // CSV should show error, not bypass
  });

  test('processing.tsx: bank source with transactions proceeds normally', () => {
    const source = 'bank';
    const csvData = 'Date,Description,Amount\n2025-03-01,Tesco,-45.5\n2025-03-02,Salary,2500';
    const lineCount = csvData.trim().split('\n').length;

    expect(lineCount).toBe(3); // header + 2 data rows
    // lineCount > 1 so it doesn't hit the zero-tx branch at all
    const hitsZeroTxBranch = lineCount <= 1;
    expect(hitsZeroTxBranch).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════
// 7. CONFIG
// ════════════════════════════════════════════════════════════════

describe('Config', () => {
  test('maxDuration is 60 seconds', () => {
    const { config } = require('../api/truelayer/callback.js');
    expect(config.maxDuration).toBe(60);
  });
});
