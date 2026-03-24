// Finexer Open Banking API client
// Docs: https://finexer.com/api
//
// Auth: Basic auth with API key as username (no password).
// Flow: Create customer → Create consent → User authorizes at bank →
//       Bank accounts auto-created → Sync → Fetch transactions/balances.

const FINEXER_API = 'https://api.finexer.com';

// ── Auth header helper ──
// Finexer uses HTTP Basic Auth: API key as username, empty password.
function authHeader(apiKey: string): string {
  const encoded = typeof btoa !== 'undefined'
    ? btoa(`${apiKey}:`)
    : Buffer.from(`${apiKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

// ── Shared fetch wrapper ──
async function finexerFetch(
  path: string,
  apiKey: string,
  options: { method?: string; body?: Record<string, string | string[]> } = {},
): Promise<Response> {
  const { method = 'GET', body } = options;
  const headers: Record<string, string> = {
    Authorization: authHeader(apiKey),
  };

  let fetchBody: string | undefined;
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        for (const v of value) params.append(`${key}[]`, v);
      } else {
        params.append(key, value);
      }
    }
    fetchBody = params.toString();
  }

  return fetch(`${FINEXER_API}${path}`, {
    method,
    headers,
    body: fetchBody,
  });
}

// ── Customer management ──
// Each Bocy user maps to a Finexer customer. We store the customer ID
// in bank_data metadata so we can create consents for them.

export interface FinexerCustomer {
  id: string;
  object: 'customer';
  name: string;
  email: string | null;
}

export async function createCustomer(
  apiKey: string,
  name: string,
  email: string,
): Promise<FinexerCustomer> {
  const res = await finexerFetch('/customers', apiKey, {
    method: 'POST',
    body: { name, email },
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Finexer create customer failed: ${err.error?.message || res.statusText}`);
  }
  return res.json();
}

export async function getCustomer(apiKey: string, customerId: string): Promise<FinexerCustomer> {
  const res = await finexerFetch(`/customers/${customerId}`, apiKey);
  if (!res.ok) throw new Error(`Finexer get customer failed: ${res.statusText}`);
  return res.json();
}

// ── Consent management ──
// A consent represents user authorization to access their bank data.
// After creating a consent, redirect the user to `redirect.consent_url`.
// When they authorize, consent status becomes "authorized" and bank
// accounts are auto-created under the consent.

export type ConsentStatus = 'new' | 'pending' | 'authorized' | 'failed' | 'expired' | 'canceled';

export interface FinexerConsent {
  id: string;
  object: 'consent';
  created_at: string;
  updated_at: string | null;
  renewed_at: string | null;
  provider: string | null;
  customer: string | null;
  consent_link: string | null;
  failure_code: string | null;
  failure_message: string | null;
  expiry_date: string | null;
  retro_date: string | null;
  scopes: string[];
  authed_at: string | null;
  status: ConsentStatus;
  redirect?: {
    return_url: string;
    consent_url: string;
  } | null;
  metadata: Record<string, string>;
}

export async function createConsent(
  apiKey: string,
  opts: {
    customer: string;
    return_url?: string;
    provider?: string;
    scopes?: string[];
    retro_date?: string;
    expiry_date?: string;
    metadata?: Record<string, string>;
  },
): Promise<FinexerConsent> {
  const body: Record<string, string | string[]> = {
    customer: opts.customer,
  };
  if (opts.return_url) body.return_url = opts.return_url;
  if (opts.provider) body.provider = opts.provider;
  if (opts.scopes) body.scopes = opts.scopes;
  if (opts.retro_date) body.retro_date = opts.retro_date;
  if (opts.expiry_date) body.expiry_date = opts.expiry_date;
  if (opts.metadata) {
    for (const [k, v] of Object.entries(opts.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }

  const res = await finexerFetch('/consents', apiKey, { method: 'POST', body });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Finexer create consent failed: ${err.error?.message || res.statusText}`);
  }
  return res.json();
}

export async function getConsent(apiKey: string, consentId: string): Promise<FinexerConsent> {
  const res = await finexerFetch(`/consents/${consentId}`, apiKey);
  if (!res.ok) throw new Error(`Finexer get consent failed: ${res.statusText}`);
  return res.json();
}

export async function renewConsent(
  apiKey: string,
  consentId: string,
  renewedAt: string,
): Promise<FinexerConsent> {
  const res = await finexerFetch(`/consents/${consentId}`, apiKey, {
    method: 'POST',
    body: { renewed_at: renewedAt },
  });
  if (!res.ok) throw new Error(`Finexer renew consent failed: ${res.statusText}`);
  return res.json();
}

export async function listConsents(
  apiKey: string,
  opts?: { customer?: string; status?: string },
): Promise<{ data: FinexerConsent[]; count: number }> {
  const params = new URLSearchParams();
  if (opts?.customer) params.set('customer', opts.customer);
  if (opts?.status) params.set('status', opts.status);
  const qs = params.toString();
  const res = await finexerFetch(`/consents${qs ? `?${qs}` : ''}`, apiKey);
  if (!res.ok) throw new Error(`Finexer list consents failed: ${res.statusText}`);
  return res.json();
}

// ── Bank Accounts ──

export interface FinexerBankAccount {
  id: string;
  object: 'bank_account';
  created_at: string;
  holder_name: string | null;
  nickname: string | null;
  currency: string;
  identification: {
    sort_code?: string;
    account_number?: string;
    iban?: string;
    pan?: string;
  };
  type: string; // personal, business, unknown
  class: string | null; // current, savings, emoney, etc.
  provider: string | null;
  consent: string | null;
  customer: string | null;
  fingerprint: string;
  metadata: Record<string, string>;
}

export async function listBankAccounts(
  apiKey: string,
  opts: { customer?: string; consent?: string },
): Promise<{ data: FinexerBankAccount[]; count: number }> {
  const params = new URLSearchParams();
  if (opts.customer) params.set('customer', opts.customer);
  if (opts.consent) params.set('consent', opts.consent);
  const res = await finexerFetch(`/bank_accounts?${params.toString()}`, apiKey);
  if (!res.ok) throw new Error(`Finexer list bank accounts failed: ${res.statusText}`);
  return res.json();
}

export async function getBankAccount(
  apiKey: string,
  bankAccountId: string,
): Promise<FinexerBankAccount> {
  const res = await finexerFetch(`/bank_accounts/${bankAccountId}`, apiKey);
  if (!res.ok) throw new Error(`Finexer get bank account failed: ${res.statusText}`);
  return res.json();
}

// ── Bank Account Balance ──

export interface FinexerBalance {
  current: number;
  available: number;
  currency: string;
  synced_at: string;
  overdraft: { limit: number; type: string } | null;
  type: string; // actual, interim
}

export async function getBalance(
  apiKey: string,
  bankAccountId: string,
): Promise<{ data: FinexerBalance[] }> {
  const res = await finexerFetch(`/bank_accounts/${bankAccountId}/balance`, apiKey);
  if (!res.ok) throw new Error(`Finexer get balance failed: ${res.statusText}`);
  return res.json();
}

// ── Bank Account Sync ──

export interface FinexerSyncStatus {
  synced_from: string | null;
  synced_to: string | null;
  status: 'idle' | 'running';
  auto_sync_interval: string | null;
}

export async function syncBankAccount(
  apiKey: string,
  bankAccountId: string,
): Promise<FinexerSyncStatus> {
  const res = await finexerFetch(`/bank_accounts/${bankAccountId}/sync`, apiKey, { method: 'POST' });
  if (!res.ok) {
    if (res.status === 429) {
      // Rate limited (1/hour) — check current status instead
      return getSyncStatus(apiKey, bankAccountId);
    }
    throw new Error(`Finexer sync failed: ${res.statusText}`);
  }
  return res.json();
}

export async function getSyncStatus(
  apiKey: string,
  bankAccountId: string,
): Promise<FinexerSyncStatus> {
  const res = await finexerFetch(`/bank_accounts/${bankAccountId}/sync`, apiKey);
  if (!res.ok) throw new Error(`Finexer get sync status failed: ${res.statusText}`);
  return res.json();
}

// ── Transactions ──

export interface FinexerTransaction {
  id: string;
  object: 'transaction';
  timestamp: string;
  amount: number; // Already signed: negative = debit, positive = credit
  currency: string;
  type: 'debit' | 'credit';
  reference: string | null;
  description: string;
  category: string | null;
  balance: number | null;
  merchant: string | null;
  status: 'pending' | 'booked';
  metadata: Record<string, string>;
}

export async function listTransactions(
  apiKey: string,
  bankAccountId: string,
  opts?: {
    limit?: number;
    offset?: number;
    status?: string;
    timestamp_gte?: string;
    timestamp_lte?: string;
  },
): Promise<{ data: FinexerTransaction[]; count: number; paging: { total: number; next: string | null; prev: string | null } }> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set('limit', String(opts.limit));
  if (opts?.offset) params.set('offset', String(opts.offset));
  if (opts?.status) params.set('status', opts.status);
  if (opts?.timestamp_gte) params.set('timestamp.gte', opts.timestamp_gte);
  if (opts?.timestamp_lte) params.set('timestamp.lte', opts.timestamp_lte);
  const res = await finexerFetch(`/bank_accounts/${bankAccountId}/transactions?${params.toString()}`, apiKey);
  if (!res.ok) throw new Error(`Finexer list transactions failed: ${res.statusText}`);
  return res.json();
}

/**
 * Fetch ALL transactions for a bank account, paginating through results.
 * Finexer returns max 100 per page.
 */
export async function fetchAllTransactions(
  apiKey: string,
  bankAccountId: string,
  opts?: { since?: string; until?: string },
): Promise<FinexerTransaction[]> {
  const all: FinexerTransaction[] = [];
  const pageSize = 100;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const page = await listTransactions(apiKey, bankAccountId, {
      limit: pageSize,
      offset,
      status: 'booked',
      timestamp_gte: opts?.since,
      timestamp_lte: opts?.until,
    });
    if (page.data) {
      // Handle nested array structure from Finexer (data may be [[...]])
      const txs = Array.isArray(page.data[0]) ? (page.data as unknown as FinexerTransaction[][]).flat() : page.data;
      all.push(...txs);
    }
    total = page.paging?.total ?? page.count ?? 0;
    offset += pageSize;
    // Safety: break if we got fewer than requested (last page)
    if (!page.data || page.data.length < pageSize) break;
  }

  return all;
}

// ── Providers ──

export interface FinexerProvider {
  id: string;
  object: 'provider';
  name: string;
  roles: string[];
  logo_url: string;
  bg_colors: string[];
  health_status: string;
}

export async function listProviders(
  apiKey: string,
  opts?: { roles?: string[] },
): Promise<{ data: FinexerProvider[] }> {
  const params = new URLSearchParams();
  if (opts?.roles) {
    for (const r of opts.roles) params.append('roles[]', r);
  }
  params.set('limit', '100');
  const res = await finexerFetch(`/providers?${params.toString()}`, apiKey);
  if (!res.ok) throw new Error(`Finexer list providers failed: ${res.statusText}`);
  return res.json();
}

// ── Client-side: Build consent URL ──
// This is the only function used on the frontend. It calls our own
// server endpoint which creates the Finexer customer + consent and
// returns the consent_url for redirect.

/**
 * Get a Finexer consent URL by calling our server endpoint.
 * The server creates the customer + consent and returns the URL.
 */
export async function getFinexerConsentUrl(
  connectionId: string,
  userId: string,
  userEmail: string,
  userName: string,
): Promise<{ consent_url: string; consent_id: string }> {
  const res = await fetch('/api/finexer/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      connection_id: connectionId,
      user_id: userId,
      email: userEmail,
      name: userName,
    }),
  });
  const data = await res.json();
  if (!data.success || !data.consent_url) {
    throw new Error(data.error || 'Failed to create bank connection');
  }
  return { consent_url: data.consent_url, consent_id: data.consent_id };
}
