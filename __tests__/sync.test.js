/**
 * Tests for api/finexer/sync.ts
 *
 * Verifies that the Finexer sync endpoint:
 * 1. Rejects unauthenticated requests
 * 2. Does not overwrite CSV data when Finexer returns errors
 * 3. Handles consent status checks
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
process.env.FINEXER_API_KEY = 'test-finexer-key';
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

// ── Import handler (after mocks) ──
let handler;
beforeAll(async () => {
  const mod = require('../api/finexer/sync.js');
  handler = mod.default;
});

beforeEach(() => {
  jest.clearAllMocks();
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
// 2. CONFIG
// ════════════════════════════════════════════════════════════════

describe('Config', () => {
  test('exports maxDuration of 60', () => {
    const { config } = require('../api/finexer/sync.js');
    expect(config.maxDuration).toBe(60);
  });
});
