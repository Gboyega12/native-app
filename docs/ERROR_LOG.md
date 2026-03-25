# Error Log

A running record of production errors, their root causes, and the fixes applied.
Entries are ordered newest-first so the most recent issues are at the top.

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
