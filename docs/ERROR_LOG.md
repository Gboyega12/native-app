# Error Log

A running record of production errors, their root causes, and the fixes applied.
Entries are ordered newest-first so the most recent issues are at the top.

---

## ERR-003 — Finexer `missing_identity` when listing bank accounts

| Field | Detail |
|-------|--------|
| **Date** | 2026-03-25 |
| **Severity** | Critical (all bank connection flows broken) |
| **Environment** | Vercel serverless — `api/finexer/callback.ts`, `api/finexer/sync.ts`, `api/cron/bank-sync.ts` |
| **Log** | `Finexer list bank accounts failed: Bad Request — {"error":{"type":"request_error","code":"missing_identity","message":"An associated identity is missing in the request. Please supply a valid vendor or customer identifier."}}` |

### Cause

The Finexer `/bank_accounts` endpoint requires **both** a `customer` and
`consent` query parameter. All call sites in the codebase were only passing
`{ consent: consentId }` — the `customer` identifier was never included.

This was discovered thanks to the `throwFinexerError` helper added in ERR-001,
which now includes the full API response body in error logs. Previously the
error only showed "Bad Request" with no actionable detail.

### Why it wasn't caught earlier

The Finexer API previously accepted consent-only queries and inferred the
customer. A recent change on Finexer's side made the `customer` parameter
mandatory, breaking all three call paths (callback, manual sync, cron sync).

### Fix Applied

**Files changed:** `api/finexer/callback.ts`, `api/finexer/sync.ts`,
`api/cron/bank-sync.ts`

All three files already call `getConsent()` before `listBankAccounts()`, and
the consent object contains `consent.customer` (the Finexer customer ID).
The fix extracts the customer ID from the consent and passes it through.

#### callback.ts

```typescript
// Resolve customer ID from consent (authoritative) or DB fallback
const customerId = consent.customer || bankRow?.finexer_customer_id || null;
if (!customerId) {
  return fail('Missing customer identity', 'No Finexer customer ID associated with this consent');
}

// Now pass both identifiers
const result = await listBankAccounts(apiKey, { customer: customerId, consent: consentId });
```

#### sync.ts and cron/bank-sync.ts

```typescript
const customerId = consent.customer || null;

// Both listBankAccounts calls updated:
await listBankAccounts(apiKey, { customer: customerId || undefined, consent: bankRow.consent_id });
```

### Affected call sites (5 total)

| File | Line | Purpose |
|------|------|---------|
| `api/finexer/callback.ts` | ~166 | Initial account discovery after bank authorization |
| `api/finexer/sync.ts` | ~61 | Account discovery during manual sync |
| `api/finexer/sync.ts` | ~131 | Account info for balance naming |
| `api/cron/bank-sync.ts` | ~61 | Account discovery during cron sync |
| `api/cron/bank-sync.ts` | ~123 | Account info for balance naming |

### How to verify

- Trigger a new bank connection flow — the callback should list accounts
  successfully on the first attempt.
- Check Vercel logs for `[finexer/callback] Found N bank accounts` instead of
  the `missing_identity` error.
- Run a manual sync and verify it completes without errors.

### Relationship to ERR-001

ERR-001 added the `throwFinexerError` helper and retry logic that made this
root cause visible. The retry logic remains useful for genuine transient
failures but the core fix is passing the `customer` parameter.

### Status: Fixed

---

## ERR-002 — `url.parse()` Deprecation Warning

| Field | Detail |
|-------|--------|
| **Date** | 2026-03-25 |
| **Severity** | Low (warning, no functional impact) |
| **Environment** | Vercel serverless runtime (Node) |
| **Log** | `[DEP0169] DeprecationWarning: url.parse() behavior is not standardized and prone to errors that have security implications. Use the WHATWG URL API instead.` |

### Cause

The warning does **not** originate from our code — our codebase uses the modern
`URL` / `URLSearchParams` APIs throughout. The deprecation is triggered by an
internal dependency (likely Vercel's Node runtime or one of its transitive
packages) that still calls the legacy `url.parse()`.

### Resolution

**No action required on our side.** The warning will disappear when the
upstream dependency updates to the WHATWG URL API. Monitor for updates to
`@vercel/node` or the Node runtime version used in our Vercel project.

### Status: Monitored (upstream dependency)

---

## ERR-001 — Finexer `listBankAccounts` Bad Request in Callback

| Field | Detail |
|-------|--------|
| **Date** | 2026-03-25 |
| **Severity** | High (blocks bank connection flow for users) |
| **Environment** | Vercel serverless — `api/finexer/callback.ts` |
| **Log** | `Error: Finexer list bank accounts failed: Bad Request` at `lib/finexer.ts:213` called from `api/finexer/callback.ts:159` |

### Cause

Two contributing factors were identified:

1. **Trailing `?` in URL construction** — `listBankAccounts` always appended a
   `?` to the path even when the query string was empty (e.g. `/bank_accounts?`
   instead of `/bank_accounts`). The Finexer API rejects URLs with empty query
   strings as malformed. The same bug existed in `listTransactions` and
   `listProviders`. Notably, `listConsents` already handled this correctly with
   a conditional check.

2. **Race condition after consent authorization** — When Finexer redirects the
   user back to our callback after bank authorization, the bank accounts may not
   be fully provisioned yet on Finexer's side. The immediate call to
   `listBankAccounts` can hit a 400 Bad Request because the accounts aren't
   ready.

3. **Poor error diagnostics** — All Finexer API error handlers only logged
   `res.statusText` (e.g. "Bad Request") without the response body, making it
   impossible to see the actual error detail from Finexer's API.

### Fix Applied (commit `ae60579`)

**Files changed:** `lib/finexer.ts`, `api/finexer/callback.ts`

#### 1. Fixed URL construction (`lib/finexer.ts`)

```typescript
// BEFORE — always appends `?` even when params are empty
const res = await finexerFetch(`/bank_accounts?${params.toString()}`, apiKey);

// AFTER — only appends `?` when there are actual query params
const qs = params.toString();
const res = await finexerFetch(`/bank_accounts${qs ? `?${qs}` : ''}`, apiKey);
```

Applied the same fix to `listTransactions` and `listProviders` to match the
pattern already used in `listConsents`.

#### 2. Added `throwFinexerError` helper (`lib/finexer.ts`)

```typescript
async function throwFinexerError(label: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  throw new Error(`${label}: ${res.statusText}${body ? ` — ${body}` : ''}`);
}
```

All Finexer API error throws now use this helper, so error logs include the
full response body from Finexer (e.g. `Bad Request — {"error":{"message":"..."}}`).

#### 3. Added retry with backoff (`api/finexer/callback.ts`)

```typescript
const retryDelays = [0, 2000, 4000];
for (let attempt = 0; attempt < retryDelays.length; attempt++) {
  if (retryDelays[attempt]) await new Promise((r) => setTimeout(r, retryDelays[attempt]));
  try {
    const result = await listBankAccounts(apiKey, { consent: consentId });
    bankAccounts = result.data || [];
    break;
  } catch (err) {
    console.warn(`[finexer/callback] listBankAccounts attempt ${attempt + 1} failed:`, err);
    if (attempt === retryDelays.length - 1) {
      return fail('Failed to list bank accounts', err instanceof Error ? err.message : String(err));
    }
  }
}
```

Retries up to 3 times (0 s, 2 s, 4 s) to give Finexer time to provision
accounts after consent authorization. Stays within the 60 s Vercel function
timeout.

### How to verify

- Deploy and trigger a new bank connection flow end-to-end.
- Check Vercel logs — if the first attempt still fails, you should now see the
  full Finexer error body in the warning, and a subsequent retry should succeed.
- The final redirect to the app should land on the success page with accounts
  listed.

### Status: Fixed
