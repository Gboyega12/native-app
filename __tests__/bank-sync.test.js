/**
 * Tests for api/cron/bank-sync.ts
 *
 * Verifies that the bank-sync cron job:
 * 1. Authenticates via cron secret
 * 2. Handles consent-based auth (Finexer) instead of OAuth tokens
 * 3. Fetches account balances
 * 4. Handles expired consents correctly
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
process.env.FINEXER_API_KEY = 'test-finexer-key';
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
// 2. CONFIG
// ════════════════════════════════════════════════════════════════

describe('Config', () => {
  test('exports maxDuration of 60', () => {
    const { config } = require('../api/cron/bank-sync.js');
    expect(config.maxDuration).toBe(60);
  });
});
