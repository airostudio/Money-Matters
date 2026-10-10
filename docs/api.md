# Public API (v1) — developer guide

Phase 10 Slice 1 (master spec §54). A versioned, server-to-server REST API for approved integrations. The machine-readable
reference is the OpenAPI 3.1 document at **`GET /api/v1/openapi.json`** (public, unauthenticated, nothing
tenant-specific); this page is the human guide and the design record. Security design: `docs/security.md` §15.

**What it is for.** Read an organization's customers, suppliers, chart of accounts, invoices, bills, payments, journal
entries and three financial reports, and **create drafts**: invoices, bills, customers and suppliers. **What it can
never do:** post, approve, void, pay, reverse, delete or edit anything; close or reopen periods; manage people, roles,
seats, AI settings or API keys; touch payroll, employees, practices, consolidation or platform admin. Those stay with
people in the app. This mirrors the AI rule "prepare, a human confirms": an integration prepares a draft, a person posts it.

## 1. Authentication

Create a key in the app: **Settings → API access** (Owner or Administrator only). Choose a name, the scopes, an
optional expiry and an optional rate limit. The full key is shown **once**:

```
mm_live_<8-char prefix>_<43-char secret>        e.g. mm_live_k3x9p2ab_<256 bits of randomness, base64url>
```

Send it **only** in a header:

```
Authorization: Bearer mm_live_k3x9p2ab_…
```

- Never in a URL/query string and never in a cookie — those are ignored. The session cookie of a logged-in browser
  user has no effect on the API at all, and the API sets no cookies.
- **Server-to-server only.** No CORS headers are ever sent and `OPTIONS` is refused, so a browser page cannot call the API
  with a key (and must not hold one). Keep keys on a server.
- We store only a SHA-256 hash of the key. We cannot show it again; if it is lost, create a new key and revoke the old one.
- Revocation is immediate. Expiry (optional, at most two years) is enforced on every request.

**Third-party apps use OAuth 2.0 instead of a key** - see §1a. Authentication resolves either credential (a key or an OAuth
access token) to the same `ApiPrincipal` (organization + scopes + the acting user's current role); everything after that -
scopes, effective permissions, rate limiting, idempotency, errors - is credential-agnostic.

### Scopes

| Scope | Grants |
|---|---|
| `contacts:read` | list/get customers and suppliers |
| `contacts:write` | create customers and suppliers |
| `accounts:read` | list/get accounts |
| `invoices:read` | list/get invoices |
| `invoices:write` | create **draft** invoices |
| `bills:read` | list/get bills |
| `bills:write` | create **draft** bills |
| `payments:read` | list/get customer payments and supplier payments |
| `journals:read` | list/get journal entries |
| `reports:read` | profit and loss, balance sheet, trial balance |

Unknown scopes are rejected at creation. There is no `journals:write`: drafting a journal entry is gated on the
ledger's *posting* permission, which no scope may carry.

### Effective permissions

A key can do **what its scopes allow and what the person who created it can currently do** — the intersection,
re-evaluated on every request. If that person is demoted, the key shrinks on the next request; if they are removed from the
organization or suspended, the key stops working (`401 api_key_owner_inactive`). A key never exceeds its creator, and
never exceeds its scopes. `GET /api/v1/me` shows the result for the calling key.

## 1a. OAuth 2.0 for third-party apps

Phase 10 Slice 4. Use OAuth when **your app acts for somebody else's company** and you do not want them to hand you an API key: a person approves your app on a consent screen, you receive tokens, and you call the same `/api/v1` endpoints with them. API keys remain the right choice for your own server integration. Design and threat model: `docs/security.md` §20. Machine-readable discovery: **`GET /.well-known/oauth-authorization-server`** (RFC 8414); the OpenAPI document declares an `oauth2` security scheme with the `authorizationCode` flow and the same ten scopes.

**What it is.** The authorization-code grant (RFC 6749) with **PKCE (S256, required for every client)**, rotating refresh tokens with reuse detection, and token revocation (RFC 7009). There is **no** implicit grant, **no** password grant and **no** client-credentials grant, and no token introspection endpoint. **What a token can do** is exactly what an API key with the same scopes can do (read, and create **drafts**) *and* no more than the approving person's **current** role allows; it can never post, approve, void, pay or delete, and never reach anything administrative.

### Register an app (an Owner or Administrator)

**Settings → Connected apps** in the organization the app will work in. Give it a name, a description and homepage (shown on the consent screen), one or more **redirect URIs**, the **most** scopes it may ever request, and a type:

| Type | For | Secret |
|---|---|---|
| **Confidential** | an app with a server that can keep a secret | a client secret, shown **once** (only its SHA-256 is stored); rotatable |
| **Public** | a native or single-page app | none; PKCE alone protects the code |

You get a **client id** (`mmo_c_...`, not secret). Redirect URIs must be exact: `https://...` or `http://localhost` / `127.0.0.1` / `[::1]` (any port, for local and native apps). No wildcards, no fragments, no other schemes. **An app belongs to the organization that registered it and can only be authorised into that organization** (a person who belongs to several companies must be a member of this one). At most 10 apps per organization.

### The flow

```
# 0. your app creates a PKCE pair and a random state, once per attempt
code_verifier  = 43-128 random URL-safe characters            (kept secret, on your side)
code_challenge = BASE64URL(SHA256(code_verifier))              (S256 only; "plain" is refused)

# 1. send the person's browser here (they sign in to Money Matters if needed, then see a consent screen)
GET https://YOUR-DOMAIN/oauth/authorize
      ?response_type=code
      &client_id=mmo_c_EXAMPLE
      &redirect_uri=https%3A%2F%2Fapp.example.com%2Foauth%2Fcallback
      &scope=invoices%3Aread%20contacts%3Aread%20invoices%3Awrite
      &state=RANDOM_PER_ATTEMPT
      &code_challenge=CHALLENGE
      &code_challenge_method=S256

# 2. the person clicks Allow; their browser returns to your redirect_uri
https://app.example.com/oauth/callback?code=mmo_ac_EXAMPLE&state=RANDOM_PER_ATTEMPT&iss=https%3A%2F%2FYOUR-DOMAIN
#    check state == yours, and iss == the issuer. On refusal you get ?error=access_denied&state=...
```

Every parameter is required (`state` and PKCE included). If the `client_id` or `redirect_uri` is not recognised the person sees an **error page and is not redirected** - nothing is ever sent to an address that is not registered. Other problems (`invalid_scope`, `invalid_request`, `unsupported_response_type`, `access_denied`) come back to your redirect URI as `error=...&error_description=...&state=...&iss=...`. A person's role must itself allow every scope you ask for, otherwise they get `access_denied`.

```bash
# 3. exchange the code (valid 60 seconds, single use) - from your server
curl -sS https://YOUR-DOMAIN/api/oauth/token \
  -u 'mmo_c_EXAMPLE:mmo_cs_EXAMPLE_SECRET' \
  -d grant_type=authorization_code \
  -d code=mmo_ac_EXAMPLE \
  -d redirect_uri=https://app.example.com/oauth/callback \
  -d code_verifier=YOUR_CODE_VERIFIER
# public client: no -u, add  -d client_id=mmo_c_EXAMPLE

# 200 OK  (Cache-Control: no-store)
# { "access_token": "mmo_at_abcd1234_EXAMPLE", "token_type": "Bearer", "expires_in": 3600,
#   "refresh_token": "mmo_rt_EXAMPLE", "scope": "contacts:read invoices:read invoices:write" }

# 4. call the API exactly as with a key
curl https://YOUR-DOMAIN/api/v1/me -H 'Authorization: Bearer mmo_at_abcd1234_EXAMPLE'
curl https://YOUR-DOMAIN/api/v1/invoices -X POST \
  -H 'Authorization: Bearer mmo_at_abcd1234_EXAMPLE' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1001' -d '{ ...a draft invoice... }'

# 5. when it expires (401 token_expired), refresh. The refresh token ROTATES: store the new one before using the new access token
curl -sS https://YOUR-DOMAIN/api/oauth/token -u 'mmo_c_EXAMPLE:mmo_cs_EXAMPLE_SECRET' \
  -d grant_type=refresh_token -d refresh_token=mmo_rt_EXAMPLE
#    optional -d scope='contacts:read' narrows the new access token (it can never widen)

# 6. sign out / disconnect (RFC 7009). Either token revokes the whole authorisation; unknown tokens still answer 200
curl -sS https://YOUR-DOMAIN/api/oauth/revoke -u 'mmo_c_EXAMPLE:mmo_cs_EXAMPLE_SECRET' -d token=mmo_rt_EXAMPLE
```

### Rules worth knowing

- **Token endpoint.** `POST`, `Content-Type: application/x-www-form-urlencoded`, parameters in the **body only** (a query string is refused), each at most once, body under 8 KiB. Authenticate with HTTP Basic (`client_secret_basic`) or `client_id` + `client_secret` in the body (`client_secret_post`) - not both. No CORS: call it from a server or native code, never from a browser page. Rate limited (60 requests/minute per address, 300 per client); `429` carries `Retry-After`. Errors are RFC 6749 §5.2 JSON (`invalid_request`, `invalid_client`, `invalid_grant`, `unsupported_grant_type`, `invalid_scope`).
- **Lifetimes.** Authorization code 60 s, once. Access token 1 hour. Refresh token 30 days from issue, rotated on every use.
- **Reuse is treated as theft.** Presenting a refresh token that was already exchanged revokes the **whole authorisation** (every access and refresh token) and your app must send the person through consent again. So: refresh **sequentially**, save the new refresh token durably before using the new access token, and never retry a refresh whose response you lost without expecting that outcome. Replaying an authorization code does the same to the tokens it produced.
- **Power is recomputed on every API request.** Effective permissions = granted scopes ∩ the approving person's *current* role. If they are demoted the token loses those powers on the very next call (`403 permission_denied`); if they are removed from the company, suspended, or the company is archived, the token stops working at once (`401 authorization_owner_inactive`, `403 organization_archived`). Revocation by the person (**Authorised apps**), an Owner/Administrator, or disabling/deleting the app also takes effect on the next request (`401 token_revoked`). `GET /api/v1/me` shows `auth_type: "oauth"`, the client and grant, the granted scopes and the permissions in force right now.
- **Same API, same limits.** Pagination, `Idempotency-Key` (required to create invoices and bills; scoped to the authorisation), RFC 7807 errors and `X-RateLimit-*` headers behave exactly as for keys; the budget is 60 requests/minute per authorisation. A `401` from a token carries `WWW-Authenticate: Bearer error="invalid_token"`.
- **Nothing human-only.** Tokens cannot manage members, API keys, webhooks, integrations, automations or OAuth apps, cannot touch billing, payroll, period close or locks, and cannot post, approve, void, pay or delete anything. Writes create drafts a person reviews in the app.
- **Where people manage it.** **Authorised apps** (`/app/authorised-apps`) lists what *they* have authorised across their companies, with a *Remove access* button each; Owners and Administrators also see and can revoke everyone's authorisations of an app under **Settings → Connected apps**.
- **Secrets.** Treat the client secret, access token and refresh token like passwords. They are shown once, stored by us only as hashes, and recognisable by their `mmo_cs_` / `mmo_at_` / `mmo_rt_` prefixes in secret scanners.

## 2. Conventions

- **JSON only.** Bodies must be `Content-Type: application/json`, at most 256 KB. Unknown fields are rejected (`422`), not ignored.
- **Methods:** `GET`, `HEAD`, `POST`. There is no `PUT`, `PATCH` or `DELETE` in v1 (`405`).
- **Money** is an object with a decimal **string** and a currency: `{"amount": "1234.50", "currency": "AUD"}`. Never a number.
  Inputs accept money as decimal strings only (`"150.00"`); a JSON number is rejected. You never send totals or tax — they are
  calculated on the server from the tax codes, by the same code the app uses.
- **Dates** are `YYYY-MM-DD` (calendar dates: `issue_date`, `due_date`, `payment_date`, `posting_date`). **Timestamps** are
  RFC 3339 UTC with milliseconds (`created_at`, `posted_at`). They are never interchanged.
- **IDs** are UUIDs. An id that does not exist **in your organization** — including one that exists in someone else's — is `404`,
  never `403`.
- **Names** are `snake_case`. Responses are explicit shapes; internal columns are never exposed.
- Every response carries `X-Request-Id`; quote it to support. Every response is `Cache-Control: no-store`.

### Pagination

List endpoints take `?limit=` (1–100, default 25) and `?cursor=` and return

```json
{ "data": [ … ], "next_cursor": "c1.…" }     // next_cursor is null on the last page
```

ordered **newest created first** (ties broken by id), so a walk never repeats or skips a row that existed when you started,
even while new rows are being created. Cursors are opaque, versioned and signed; they are valid only for the organization,
endpoint and filters that produced them (`400 invalid_cursor` otherwise). Filters: `status`, `customer_id` / `supplier_id`, issue
date ranges (`issue_date_from`, `issue_date_to`), payment/journal date ranges (`date_from`, `date_to`), account `type`,
`include_inactive`.

### Idempotency

Every `POST` accepts an `Idempotency-Key` header (1–255 printable ASCII characters). It is **required for invoice and bill
creation** (`400 idempotency_key_required`) and optional for customers/suppliers.

- Same key + same request → the original response is replayed (`Idempotent-Replayed: true`); nothing is created again.
  Key order and whitespace of the JSON do not matter.
- Same key + a different request (body, path or method) → `422 idempotency_key_reuse`.
- Same key while the first request is still running → the second waits briefly for it and then replays its result; if the first
  is still running after about 5 s you get `409 idempotency_in_progress` with `Retry-After`.
- Keys are scoped to the API key and kept for 24 hours. A failed request (validation, locked period, permission) stores nothing:
  fix it and retry with the same key.
- Two simultaneous identical requests create exactly one invoice. (Different keys, different invoices.)

Generate the key once per intended creation (e.g. `order-1001`), reuse it for every retry of that creation.

### Rate limits

60 requests/minute per key by default, configurable per key from 10 to 600. Every response has `X-RateLimit-Limit`,
`X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds). Over the limit: `429 rate_limited` with `Retry-After`. The
window is fixed (a burst up to 2× straddling a boundary is possible). Repeated requests with an *invalid* key from one address
are also cut off (`429 too_many_failed_attempts`) — best effort, per server instance. An OAuth access token shares one budget of
60 requests/minute per **authorisation** (all of a grant's tokens together), with the same headers; the token and revocation
endpoints have their own limits (§1a).

### Errors

RFC 7807 problem details, `Content-Type: application/problem+json`:

```json
{ "type": "urn:moneymatters:problem:validation_failed", "title": "Validation failed", "status": 422,
  "code": "validation_failed", "detail": "The request body failed validation.", "requestId": "…",
  "errors": [ { "field": "lines[0].quantity", "message": "Must be a non-negative decimal string …" } ] }
```

Switch on `code`, never on `detail`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `invalid_json`, `body_required`, `invalid_query`, `invalid_cursor`, `idempotency_key_required`, `idempotency_key_invalid` | malformed request |
| 401 | `invalid_api_key`, `api_key_revoked`, `api_key_expired`, `api_key_owner_inactive` | authentication failed |
| 403 | `insufficient_scope`, `permission_denied` | the key's scopes, or its creator's current permissions, don't allow it |
| 403 | `organization_archived` | the key's organization is archived (see below); nothing is deleted and the key works again after an owner restores it |
| 404 | `not_found`, `route_not_found` | no such resource in your organization / no such endpoint |
| 405 | `method_not_allowed` | v1 is GET/HEAD/POST only |
| 409 | `period_locked` (carries `lockLevel`), `idempotency_in_progress`, `conflict` | locked period, in-flight duplicate, concurrent change (retry) |
| 413 / 415 | `body_too_large`, `unsupported_media_type` | |
| 422 | `validation_failed` (with `errors[]`), `idempotency_key_reuse` | |
| 429 | `rate_limited`, `too_many_failed_attempts` | see `Retry-After` |
| 500 / 503 | `internal_error`, `service_unavailable` | quote `requestId`; 503 is retryable |

**Archived organizations.** When an owner (or the platform administrator) archives a company, every API key of that company answers `403 organization_archived` (problem JSON, no
data) from then on - on every endpoint - until an owner restores it; then the same keys work again unchanged, nothing having been deleted. The check happens after the key's secret verified
(a wrong secret still gets `401 invalid_api_key`) and costs no additional database statement. **Webhooks** for an archived company are paused the same way: no delivery is attempted and its
events wait in the outbox, then flow in order after a restore. Managing invites, archiving and restoring are human-only and are not part of the public API.

A document dated in a locked period is refused with `409 period_locked` for **any** lock level (even a soft lock, which a person may
override with a reason in the app — an integration has no override). Nothing is saved.

## 3. Endpoints

| Method & path | Scope | Notes |
|---|---|---|
| `GET /me` | any | organization, scopes, **effective permissions**, rate-limit window. Never the secret. |
| `GET /openapi.json` | none | the OpenAPI 3.1 document |
| `GET /customers`, `GET /customers/{id}`, `POST /customers` | `contacts:read` / `contacts:write` | create needs `display_name`, `currency`; optional `legal_name`, `email`, `phone`, `tax_number`, `billing_address` |
| `GET /suppliers`, `GET /suppliers/{id}`, `POST /suppliers` | same | |
| `GET /accounts`, `GET /accounts/{id}` | `accounts:read` | read-only |
| `GET /invoices`, `GET /invoices/{id}`, `POST /invoices` | `invoices:read` / `invoices:write` | POST creates a **DRAFT**; `Idempotency-Key` required |
| `GET /bills`, `GET /bills/{id}`, `POST /bills` | `bills:read` / `bills:write` | POST creates a **DRAFT**; `Idempotency-Key` required |
| `GET /payments`, `GET /payments/{id}` | `payments:read` | customer receipts; read-only |
| `GET /supplier-payments`, `GET /supplier-payments/{id}` | `payments:read` | read-only |
| `GET /journals`, `GET /journals/{id}` | `journals:read` | read-only |
| `GET /reports/profit-and-loss?from&to`, `/reports/balance-sheet?as_of`, `/reports/trial-balance?as_of` | `reports:read` | posted activity only; amounts in the base currency |

### Create a draft invoice

```bash
curl -X POST https://YOUR-DOMAIN/api/v1/invoices \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1001" \
  -d '{
    "customer_id": "…", "issue_date": "2026-03-10", "due_date": "2026-04-10", "currency": "AUD",
    "ar_account_id": "…", "memo": "March retainer",
    "lines": [ { "description": "Consulting", "quantity": "3", "unit_price": "100.00",
                 "account_id": "…", "tax_code_id": "…" } ]
  }'
```

`201 Created`, `Location: /api/v1/invoices/{id}`, body `{ "data": { "status": "DRAFT", "number": "INV-000042", "subtotal": {…}, "tax_total": {…}, "total": {…}, "lines": […], … } }`.
Customer, accounts and tax code must belong to your organization (a foreign id is `422`, with no hint whether it exists elsewhere).
The draft appears in the app under Sales as a normal draft; a person reviews and posts it. The audit trail records the API key
(`viaApiKey`, key id and prefix, the user who created the key) on every row the request wrote.

Bills are the mirror image (`supplier_id`, `ap_account_id`, optional `supplier_reference`).

## 4. Operating notes

- **Query budget.** An API request costs a fixed, small number of sequential statements and never more than one pooled
  connection at a time — see `docs/architecture.md` §8.
- **Lists are not the UI's lists.** The in-app list services return everything; the API has its own bounded, keyset-paginated reads
  with the same permission checks.
- **Drafts in locked periods** are refused (stricter than the UI, deliberately).
- **Document numbers** are assigned at creation (`INV-000042`); two concurrent creations that collide on a number are retried
  server-side, so you do not see a spurious conflict.

## 5. Webhooks

Phase 10 Slice 2 (master spec §55, §65). Money Matters POSTs a signed JSON event to a URL you register whenever something
happens in your organization. Manage subscriptions in **Settings → Webhooks** (Owner or Administrator, humans only — an API key
or the AI can never create, change or read a webhook). Security design: `docs/security.md` §16; the outbox and dispatch design:
`docs/architecture.md` §11.

**Enabling.** The platform operator must set `WEBHOOK_SECRET_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`).
Without it webhooks are disabled with a clear message in Settings and nothing else in the app is affected.

### Event catalogue

| Event | Fired when | `data.object` |
|---|---|---|
| `customer.created` | a customer (or a contact that is both) is added | Contact |
| `supplier.created` | a supplier (or a contact that is both) is added | Contact |
| `invoice.created` | a **draft** invoice is created (in the app, by recurrence or via the API) | Invoice, with `lines` |
| `invoice.sent` | an approved invoice is marked as sent (the `APPROVED → SENT` transition; repeating it does nothing) | Invoice |
| `invoice.paid` | allocations bring an invoice to fully paid (the transition into `PAID`) | Invoice |
| `payment.received` | a customer payment is recorded and allocated | Payment, with `allocations` |
| `bill.created` | a **draft** bill is created | Bill, with `lines` |
| `bill.approved` | a bill is approved and posted | Bill |
| `automation.triggered` | an automation rule you configured fired and has the **Emit a webhook event** action (Phase 10 Slice 3, below) | an automation envelope object, not a resource |

A subscription lists concrete event types; there is no wildcard in v1. **Not available:** `payroll.completed` (payroll is outside
the public API) and `bank.transaction.created` (bank transactions have no API representation) — they will be offered when their
data can be exposed under the same permission rules. There is also no `invoice.approved`/`bill.paid`/supplier-payment event yet.
`ping` is sent only by the **Send test event** button.

#### `automation.triggered` (Phase 10 Slice 3)

Emitted only by the Automation Centre's `EMIT_WEBHOOK_EVENT` action (**Settings → Automation**), never by a business change, and
delivered through your existing subscriptions like any other event (subscribe to `automation.triggered`). Its `data.object` is:

```json
{
  "rule": { "id": "…", "name": "Large invoice" },
  "trigger": "invoice.created",
  "subject": { "type": "Invoice", "id": "…" },
  "object": { "id": "…", "number": "INV-000042", "total": { "amount": "1100.00", "currency": "AUD" }, "…": "…" }
}
```

`object` is the **public-API representation** of the triggering resource (for event triggers: exactly the object the original
event carried; for the overdue / due-soon scans: a small subset of the invoice or bill fields the API already returns) and is
`null` for a product (stock is not part of the public API), where only `subject.id` identifies it. Nothing beyond what
`GET /api/v1/…` returns is ever included. **Loop protection:** an `automation.triggered` event carries an `origin = automation`
marker and can never itself trigger an automation rule, so a rule cannot cause a cycle. The same `Mm-Event-Id` dedupe rule applies.

### Envelope

```json
{
  "id": "0b8f6c0e-6d3c-4a3e-9d64-3f1c4f1f2a11",
  "type": "invoice.paid",
  "api_version": "v1",
  "created_at": "2026-03-10T09:30:00.123Z",
  "data": { "object": { "id": "…", "number": "INV-000042", "status": "PAID", "total": { "amount": "1100.00", "currency": "AUD" }, "…": "…" } }
}
```

`data.object` is **exactly the object the public API returns** for that resource (same field names, money as decimal strings with a
currency, dates as `YYYY-MM-DD`, timestamps in RFC 3339 UTC): a webhook never discloses more than `GET /api/v1/…` would. It is a
**snapshot taken when the event was recorded** — fetch the resource if you need its current state. `id` is unique per event and is
what you dedupe on. If an object is too large (over 256 KB, e.g. an invoice with thousands of lines) its `lines`/`allocations` are
left out and `data.truncated` is `true`; fetch the object by id. The envelope carries no organization id: the subscription's
`Mm-Subscription-Id` header tells you which registration (and so which secret) the delivery belongs to.

### Request headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `MoneyMatters-Webhooks/1` |
| `Mm-Event-Id` | the envelope `id` (dedupe on this) |
| `Mm-Event-Type` | e.g. `invoice.paid` |
| `Mm-Delivery-Id` | unique per event × subscription (stable across retries and replays) |
| `Mm-Delivery-Attempt` | 1, 2, 3 … |
| `Mm-Subscription-Id` | which of your subscriptions this is |
| `Mm-Signature` | `t=<unix seconds>,v1=<hex>[,v1=<hex>]` |

### Verifying the signature

`v1 = hex( HMAC-SHA256( key = the whole secret string including its "whsec_" prefix, message = "<t>.<raw body>" ) )`. Use the
**raw bytes** of the body as received, not re-serialised JSON. Compare in constant time. **Reject** a delivery whose `t` is more than
**5 minutes** from your clock (replay protection) and reject if no `v1` matches a secret you hold. Respond `2xx` quickly (we wait at
most 10 s) and process asynchronously.

Node.js:

```js
const crypto = require("crypto");

// rawBody: the request body EXACTLY as received (a string/Buffer) - never JSON.stringify(parsedBody).
// header:  the value of the Mm-Signature header.
// secrets: every signing secret you currently accept (two during a rotation).
function verifyMoneyMattersSignature(rawBody, header, secrets, toleranceSeconds = 300) {
  const parts = String(header).split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false; // replay protection
  for (const secret of secrets) {
    const expected = crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest();
    for (const sig of signatures) {
      const given = Buffer.from(sig, "hex");
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
    }
  }
  return false;
}

module.exports = { verifyMoneyMattersSignature };
```

Python:

```python
import hashlib
import hmac
import time


def verify_money_matters_signature(raw_body: bytes, header: str, secrets, tolerance_seconds: int = 300) -> bool:
    # raw_body: the request body EXACTLY as received (bytes). header: the Mm-Signature header value.
    parts = [p.strip().split("=", 1) for p in header.split(",") if "=" in p]
    t = next((v for k, v in parts if k == "t"), None)
    signatures = [v for k, v in parts if k == "v1"]
    if t is None or not t.isdigit() or not signatures:
        return False
    if abs(time.time() - int(t)) > tolerance_seconds:  # replay protection
        return False
    for secret in secrets:
        expected = hmac.new(secret.encode(), t.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
        if any(hmac.compare_digest(expected, s) for s in signatures):
            return True
    return False
```

Both snippets are executed against the real signer in the test suite.

### Secrets and rotation

The secret (`whsec_…`) is shown **once**, when the subscription is created or rotated. We store it encrypted and can never show it
again; if you lose it, rotate. **Rotate** issues a new secret and, for **24 hours**, signs every delivery with **both** (`v1=<new>,v1=<old>`),
so you can deploy the new secret and verify with either without downtime; afterwards only the new one is used. Rotating again inside
the window replaces the old secret immediately.

### Delivery semantics

- **At least once.** The same event can arrive more than once (a retry after a timeout whose first attempt actually succeeded, a
  replay, a dispatcher crash). **Dedupe on the event `id`.**
- **No ordering guarantee.** `invoice.paid` can arrive before `invoice.created`. Use the object's own fields, not arrival order.
- **Snapshot.** The payload is the state when the event was recorded.
- **Success is any `2xx`** within 10 seconds. Anything else — other status, timeout, TLS error, DNS failure — is a failure.
  **Redirects are never followed**: a `3xx` is a failure (register the final URL). Only `https` on port 443 to a public address is allowed;
  URLs that resolve to private, loopback, link-local or otherwise internal addresses are refused when you save them **and on every delivery**.
- **Retries** with exponential backoff and ±20% jitter: **1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h** after consecutive failures, **8 attempts
  in all**; then the delivery is dead-lettered (**Failed**) but stays replayable. **There is no background scheduler**: retries run when
  someone presses **Send pending now** in Settings → Webhooks (or when the next best-effort dispatch runs after a request in the app/API
  that creates events). The page shows "N deliveries are waiting" whenever work is due. This is deliberate and documented in
  `docs/architecture.md` §11.
- **Circuit breaker.** After **20 consecutive failed attempts** the subscription is automatically **disabled** (visible reason, audit entry).
  Fix the endpoint and re-enable it; the counter resets.
- **Replay.** Any delivery (delivered or failed) can be replayed from its page; it is sent again immediately as a fresh attempt and
  logged as a replay by the person who pressed the button. A replay never consumes the retry schedule.
- **Test event.** *Send test event* posts a signed `ping` so you can check your endpoint and your signature code.
- **Retention.** Events and their delivery logs are kept 30 days.
- Each delivery's attempts (time, duration, HTTP status or error class, a short sanitised response excerpt) are in the delivery log.
  The log is append-only.

## 6. Deferred (and why)

| Item | Why |
|---|---|
| Token introspection (RFC 7662), dynamic client registration (RFC 7591), the device-code grant, `prompt=none` | apps never need to introspect their own opaque tokens; registering an app is a human decision; see `docs/security.md` §20.7 |
| A platform-level OAuth app usable across organizations ("published apps"), and custom-scheme native redirects | an app is registered by, and authorised into, ONE organization (`docs/security.md` §20.2); a cross-organization app needs a review/marketplace workflow |
| Scope step-up on an existing authorisation, per-app rate limits, per-token last-used timestamps | a new consent produces a new authorisation; limits are per authorisation; stamping every request would turn reads into writes |
| Integration framework and automation centre | Phase 10 Slice 3 |
| A scheduler / global dispatcher (Vercel Cron) for webhook retries | owner decision: no job queue in this slice. Retries are on demand plus best-effort after a request. A global dispatcher needs a cross-tenant "which organizations have pending work" index that the row-level-security model deliberately does not give the application role; `WebhookDispatchService.dispatch(orgId)` is the function a scheduler would call once per organization |
| `payroll.completed`, `bank.transaction.created` events | their data has no public API representation yet (see Webhooks) |
| `GET /events` polling catch-up endpoint | not needed while deliveries are replayable from the log |
| Per-event payload customisation, wildcard subscriptions | v1 payloads are exactly the API objects; subscriptions list concrete types |
| Managing webhooks through the public API | webhooks aim the platform at a URL: a human-only decision |
| Sender IP allow-listing / mTLS | requests originate from the serverless platform (no stable egress IPs); signatures are the authenticity control |
| Dead-letter email notifications | the Settings page banner is the visible signal for now |
| `PUT`/`PATCH`/`DELETE`; posting, approving, voiding, paying via API | integrations prepare drafts, people decide |
| Draft journal entries via API | drafting is gated on the posting permission; would put a posting permission into a key's effective set |
| Payroll, employees, practice, consolidation, admin endpoints | out of scope for v1 and excluded structurally |
| Per-key IP allow-lists | not needed for the first server integrations |
| Key rotation workflow beyond create-new + revoke-old | |
| Usage analytics dashboard, SDKs | |
