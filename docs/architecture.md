# Architecture

Money Matters is a multi-tenant AI-assisted accounting platform. This document
describes the production architecture as implemented, starting from Phase 1
(Financial Foundation). Later phases extend this architecture; they do not
replace it.

## 1. High-level shape

A single Next.js application (App Router) hosts both the UI and the server
API surface for Phase 1. Business logic does not live in React components or
route handlers — it lives in a framework-agnostic **domain layer** that route
handlers and server actions call into. This keeps the door open to extracting
domain code into standalone services later (e.g. a payroll worker, a
reconciliation worker) without a rewrite.

```
Browser (Next.js UI)
      │
      ▼
Route Handlers / Server Actions   (src/app/**, "thin controllers")
      │  — auth check, input validation, tenant resolution —
      ▼
Domain Services                    (src/domain/**, framework-agnostic)
      │  — business rules, invariants, calculations —
      ▼
Tenant-scoped Repository Layer     (src/db/**)
      │
      ▼
PostgreSQL  (via Prisma)
```

Cross-cutting concerns (audit logging, permission checks) are enforced inside
the domain layer, not bolted onto the UI — so the same rule applies whether
the caller is a human clicking a button or (in later phases) an AI agent tool
call.

## 2. Directory structure

```
docs/                     architecture & domain documentation, ADRs
prisma/
  schema.prisma           canonical database schema (Phase 1 entities)
src/
  app/                     Next.js routes — UI + route handlers (thin)
    (auth)/                sign in / sign up
    (dashboard)/[orgSlug]/ authenticated app, org-scoped routes
    api/                   route handlers used by client components
  domain/                  business logic, pure of Next.js/Prisma types where possible
    money/                 Money value type (Decimal-backed)
    ledger/                LedgerService, PostingService, invariants
    accounts/              Chart of Accounts service
    contacts/              Customers/suppliers service
    tax/                   Tax code / jurisdiction service (Phase 1 architecture only)
    banking/               Bank import/reconciliation/rules (Phase 2 Slice 1)
    sales/                 InvoiceService, PaymentAllocationService, AgedReceivablesService (Phase 3 Slice 1)
    permissions/           Roles, permission checks
    audit/                 AuditService
    organizations/         Org + membership service
  db/
    client.ts              Prisma client singleton
    tenant.ts              tenant-scoped query helpers ("never forget organizationId")
  components/
    ui/                    shadcn/ui primitives
    shell/                 nav, dashboard shell, org switcher
    accounting/             Money, StatusBadge, AccountSelector, JournalEditor, etc.
  lib/                     auth config, session helpers, generic utils
  tests/
    unit/                  domain unit tests
    property/               property-based tests (fast-check) for the ledger
    integration/            DB-backed tests incl. tenant isolation
scripts/
  seed.ts                  Northstar Electrical Group demo data
```

Rationale: a single deployable app is the right size for Phase 1. A
turborepo/monorepo split into separate packages is deferred until there is a
second consumer of the domain layer (e.g. a background worker process) that
actually needs it — see `decisions/0005-single-app-not-monorepo.md`.

## 3. Multi-tenancy

Tenant = **Organization**. Every tenant-owned table carries `organizationId`.

Two layers of enforcement, not one:

1. **Application layer** — all reads/writes go through `src/db/tenant.ts`
   helpers that require an `organizationId` derived from the authenticated
   session's active membership, never from client-supplied input alone. A
   Prisma call that omits a tenant filter is a code review defect; the
   repository helpers make the tenant filter mandatory in the type signature.
2. **Database layer** — PostgreSQL Row-Level Security policies scope every
   tenant table to `current_setting('app.current_org_id')`, set per request.
   This is defense-in-depth: even a bug in application code cannot leak
   cross-tenant rows.

See `docs/security.md` §Tenant Isolation and the integration test in
`src/tests/integration/tenant-isolation.test.ts`.

## 4. Accounting engine

See `docs/accounting-engine.md`. Summary: all money is `Decimal`, never
`number`/float. Journal entries are immutable once posted; corrections are
reversals or new adjusting entries, never edits. `SUM(debit) = SUM(credit)`
is enforced in the domain layer and re-validated by a database CHECK-style
invariant test.

## 5. Permissions (RBAC)

Roles are attached to an `OrganizationMembership` (a user can hold different
roles in different organizations). Phase 1 roles: Owner, Administrator,
Accountant, Bookkeeper, Employee, ReadOnly (extensible list — see
`src/domain/permissions/roles.ts`). Every domain service method that mutates
or reads sensitive data takes the acting `Actor` (user + org + role) and
calls `assertPermission()` before touching the repository layer. This is the
same choke point later phases reuse for AI tool calls (§7 AI tool layer),
so "the AI can never see what the user role can't see" holds by construction
rather than by convention.

## 6. Audit trail

`AuditService.record()` is called by every domain service after a mutating
operation (post journal, reverse journal, create/edit account, create/edit
contact, membership/role changes). Audit rows are append-only — the
Prisma model exposes no update/delete, and RLS denies UPDATE/DELETE for the
application's runtime DB role on `audit_logs`.

## 7. AI tool layer (architecture now, implementation in Phase 6)

Not implemented in Phase 1 beyond the seam left for it: because domain
services already centralize permission checks, input validation and audit
logging, an AI tool layer only ever needs to call the same domain services a
human-triggered request calls — `Intent → Permission → Validation → Tool →
Result → Audit` (see `docs/ai-agents.md`). No separate "AI data path" is
introduced, which is what prevents an AI agent from ever having a wider view
of the data than the user driving it.

## 8. Events

Phase 1 did not need background workers, so no queue/outbox was stood up. **Phase 10 Slice 2 added the durable outbox**
(`domain_events`) and webhook delivery on top of it - see §12. There is still **no job queue or scheduler**: delivery runs
on demand and best-effort after the request that caused the event. The domain services keep returning their typed results
(e.g. `PostingService.postJournal()` returns `JournalPosted`) exactly as before; the outbox is written beside them, inside
the same transaction.

## 9. Deployment target (design, not yet wired in this session)

- Frontend/route handlers: Vercel (Next.js).
- Database: PostgreSQL (Supabase-hosted Postgres is the intended target;
  the schema and queries use nothing Supabase-proprietary — see
  `decisions/0004-multi-tenancy-and-supabase.md`).
- Auth: Phase 1 ships NextAuth (Credentials + Prisma adapter) so the app is
  runnable without external accounts in any environment, incl. this one.
  Supabase Auth is the intended production identity provider; see
  `decisions/0002-auth-strategy.md` for the swap plan.
- Object storage (receipts, documents): deferred to Phase 2 (Document AI).
- Background jobs/queue: deferred to Phase 2.

## 10. What Phase 1 deliberately does not include

Banking, invoicing, payroll, inventory, AI agents, reporting engine, and
everything else in the master spec's sections 10-87 are **out of scope for
this session** and tracked in `docs/roadmap.md`. Phase 1's job is to prove
the ledger, tenancy, permissions and audit trail are correct, because every
later feature posts through them.
## 11. Public API: the per-request database budget (Phase 10 Slice 1)

The Supabase session pooler caps the whole project at about 15 clients and `DATABASE_POOL_MAX` defaults to 3, so an API request must cost a
small, **fixed** number of **sequential** statements and hold **at most one pooled connection at a time** (no `Promise.all`, no nested
`withTenant`). The budget, measured at the driver (every statement, including `BEGIN`/`set_config`/`COMMIT`) by
`src/tests/integration/api/api-query-budget.test.ts` against the real database:

| Request | Statements | Notes |
|---|---|---|
| malformed / missing key | 0 | rejected on shape, before any query; repeat offenders from one address are cut off in memory |
| unknown prefix | 1 | the lookup |
| `GET /me`, 403 insufficient scope, 429 rate limited | 2 | (1) key lookup joined to the creator's membership and `users.disabled_at`; (2) one atomic rate-limit upsert (which also stamps `last_used_at` at most once a minute) |
| any read (`/customers`, `/accounts`, `/invoices`, `/journals`, reports) | 6 to 9 | the 2 above + ONE `withTenant` (`BEGIN`, `set_config`, 1-3 set-based queries, `COMMIT`); independent of the number of rows or lines |
| `POST /invoices` with `Idempotency-Key` | 20 | the 2 above + ONE `withTenant` containing the idempotency claim, the same creation code as the UI, the reload for the response and the idempotency completion; independent of the number of lines |
| replay of a completed POST | 9 | claim conflict + read + commit; nothing is created |
| validation failure | 2 | rejected before any tenant transaction |

Order: authenticate (cheap checks first) -> rate-limit **before** any expensive work -> permission/scope checks (no database) -> strict body
validation (no database) -> exactly one `withTenant`. Tests assert `withTenant` is entered at most once per request and never nested, and
a structural test forbids `Promise.all`/`allSettled`/`race` and any private `pg` connection in `src/domain/api` and `src/app/api/v1`.
Only `api-auth.ts` and `rate-limit.ts` use the non-tenant `db` handle, for the two authentication statements.

Phase 10 Slice 2 note: creating an invoice now also writes its `invoice.created` outbox row in that same transaction - one `INSERT` plus the
three snapshot reads described in §12 - so the `POST /invoices` figure above now measures **23** statements (re-measured at the driver after Slice 2; the
table's 20 predates the outbox), still independent of the number of lines and still one tenant transaction; `api-query-budget.test.ts` is unchanged and still passes.

Organisation lifecycle note (archive): **no budget above changed.** The archived flag rides inside statements that already existed - the API key lookup now joins `organizations` (still 2 statements per
authenticated request; an archived company's key costs 1 and never reaches the rate limiter or a tenant transaction), and webhook dispatch's phase A reads it in the same statement as its advisory try-lock
(still 10). `withTenant` is untouched. `OrganizationService.getMembership` / `listMembershipsForUser` became joins to `organizations` (one query each, as before), the chooser makes one membership query for its
active list, archived list and owned-company count, and the `[orgSlug]` layout is still at most three reads. The new flows are small and fixed: create-another-company is one transaction (user-row lock, owned count, slug check,
insert, membership) plus the audit row and two starter accounts exactly as registration; invite redemption is one non-tenant lookup (hash), one user read and one tenant transaction; none uses `Promise.all`. See `docs/security.md` section 17.

## 12. Transactional outbox and webhook dispatch (Phase 10 Slice 2)

Master spec §65: "important business events should generate domain events ... implement a durable outbox pattern"; §55: webhooks with
signatures, retries, exponential backoff, delivery logs, replay, idempotency. Developer view: `docs/api.md` "Webhooks". Security view:
`docs/security.md` §16.

```
business request                       later, after commit (a separate short unit of work)
-----------------                      -----------------------------------------------------------
withTenant tx:                         dispatch(orgId)            <- the ONE function a scheduler could call
  mutate rows                            phase A   tx: try-lock; fan out undispatched events into per-subscription
  audit row                                         deliveries; claim due deliveries FOR UPDATE SKIP LOCKED + lease; COMMIT
  INSERT domain_events  <- emit          send      for each claimed delivery, one at a time, NO tx held: decrypt secret,
COMMIT  -> events exist iff                          sign, POST through the SSRF-guarded client
        the change committed             phase B   per delivery, tx: append attempt row, move delivery state,
                                                    update the subscription's failure counter (circuit breaker); COMMIT
```

**Emit (write side).** `DomainEventService.emitIn(tx, organizationId, ...)` is called by the services themselves
(`ContactService`, `InvoiceService`, `PaymentAllocationService`, `BillService`) inside the business transaction, at the point the transition
really happens, so the API's `createIn(tx, ...)` entry points and the UI's `create(...)` both emit exactly once. The payload is built with the
public API's own DTO mappers and read loaders (`loadInvoice`, `loadBill`, `loadPayment`, `contactDto`...), so a webhook can never disclose more
than `GET /api/v1/...` would. Emit **does not** match subscriptions, read any webhook table or make any network call.
**Measured emit cost:** one `INSERT INTO domain_events`; plus, for an invoice or bill, the same three set-based reads the API's `GET` does
(document + customer, lines, allocated total); for a payment two reads (payment, allocations); for a contact none (the row is in hand).
So `invoice.created` adds 4 statements to the creating transaction (`outbox-emit.test.ts` asserts one insert and zero webhook-table statements).
Events are emitted exactly once per transition: `customer.created`/`supplier.created` (by contact kind), `invoice.created` (the draft, from the UI,
recurrence or the API), `invoice.sent` (only on a real `APPROVED -> SENT` via `InvoiceService.markSent`; repeating it emits nothing),
`invoice.paid` (the transition into `PAID`, from `refreshInvoiceStatus`), `payment.received`, `bill.created`, `bill.approved`. An oversize snapshot
(over 256 KB) drops `lines`/`allocations` and sets `data.truncated` instead of ever failing the business transaction.

**Why a snapshot at emit time and not at dispatch time.** The payload must describe the object *as it was when the event happened* (an `invoice.created`
must say DRAFT even if it is paid by the time it is delivered), and reading it later would also mean reading business tables from the dispatcher.

**Dispatch (read side).** Subscription matching happens here, not at emit: events with `dispatched_at IS NULL` are fanned out into `webhook_deliveries`
(unique `(event_id, subscription_id)`, so re-running is idempotent) for ACTIVE subscriptions whose type list contains the event type and which already
existed when the event occurred (5 s clock-skew tolerance). A `pg_try_advisory_xact_lock` keeps two dispatchers from fanning out together; claiming uses
`FOR UPDATE SKIP LOCKED` plus a **lease** (`lease_until`, sized batch x 10 s + 30 s) so a delivery that is claimed is invisible to every other dispatcher, and
one whose dispatcher died simply becomes due again when the lease expires (**at-least-once**). The attempt outcome is recorded with a compare-and-set on the
lease. Retry timing is the pure function in `backoff.ts` (1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, +/-20% jitter, 8 attempts, then FAILED = dead letter,
replayable). A **circuit breaker** disables a subscription after 20 consecutive failed automatic attempts (SYSTEM audit entry, visible reason); a manual
replay or test ping never feeds it, a success resets it.

**Why no connection is held across the HTTP call.** `DATABASE_POOL_MAX` is 3 and the Supabase session pooler allows about 15 clients for the whole project. A
transaction held while waiting up to 10 s on a customer's slow endpoint would exhaust the pool and take the rest of the app down with it. So the
dispatcher commits its claim, sends with **no transaction open**, and opens a second short transaction per delivery to record the result. It is sequential
(`for ... of`, no `Promise.all`), bounded (<= 10 deliveries per call), and a test asserts that at the instant the HTTP client runs no `withTenant`
transaction is open and that scoped transactions never overlap.
**Measured dispatch cost** (`dispatch.test.ts`, real database, every driver statement): phase A is **10 statements** in one transaction regardless of batch size
(`BEGIN`, `set_config`, try-lock, events, subscriptions, insert deliveries, mark events dispatched, claim, lease, `COMMIT`; the retention purge adds one `DELETE`
at most once an hour per organization per process); phase B is **6 statements** per delivery. One delivery = 16 statements in 2 transactions; five = 40 in 6.
The delivery log pages run one or two short transactions each (counts are SQL aggregates).

**Post-response dispatch.** After a creating request has committed and its response is built, `scheduleDispatchAfterResponse(orgId)` starts a dispatch for that
organization (API `POST`s that return 201, and the UI actions that create/mark-sent/record-payment). On Vercel an un-awaited promise is frozen when the
function returns, so the work is registered with **`waitUntil` from `@vercel/functions`** - the only mechanism used (Next 14.2 has no `after()`). Off Vercel
`waitUntil` is a no-op and the promise just runs. It yields one macrotask first (the request's own connection is long released), is skipped when this instance is
already dispatching for that organization, does nothing without the encryption key, can never throw into the request, and is disabled under test unless a test
enables it. It is best effort by design: if the platform kills the invocation the events stay in the outbox and go out on the next dispatch.

**No scheduler, and why there is no global dispatcher.** Owner decision: no job queue, no Vercel Cron. Retries are therefore on demand ("Send pending now",
per-delivery Replay) plus the best-effort run above; the Settings page shows a "N events pending delivery - Send now" banner whenever work is waiting, which is
the honest substitute. A global cross-tenant dispatcher is deliberately **not** built: it would need to discover *which organizations have pending work*, but
every tenant table is row-level-secured by the single `app.current_org_id`, so the application role cannot list work across organizations without either a
non-RLS work index (a new cross-tenant surface) or a bypass connection (forbidden). `WebhookDispatchService.dispatch(orgId, {limit})` is the unit a scheduler
would call per organization once such an index exists.

**Retention.** Events, deliveries and attempts older than 30 days are purged lazily inside the dispatch transaction (at most once an hour per organization per
process; events with a still-PENDING delivery are kept). The attempt log is append-only for `mm_app` (no UPDATE/DELETE grant); aged rows disappear only as the
foreign-key cascade of a purged event.


## 13. The Automation Centre and the integration framework (Phase 10 Slice 3)

Master spec §75 (automation rules) and §53 (integration platform). Threat model: `docs/security.md` §18-19. Owner decisions honoured: **no job queue, no scheduler, no Vercel Cron** - automations run on demand, best-effort after a response, and whenever the outbox is dispatched.

```
 triggers                          evaluation pass  AutomationEngine.runPass(orgId)         actions (own short tx each)
 --------                          ---------------------------------------------           ---------------------------
 "Run automations now"  --\        phase 1  ONE tx ("plan"):                                NOTIFY_IN_APP          1 tx
 post-response task     ---+--->      head statement: try-lock + archived? + paused?          EMIT_WEBHOOK_EVENT     1 tx
   (same waitUntil as              rules  -> re-validate + execution identity (1 query for the    CREATE_DRAFT_PO        1 tx (savepoint)
    webhook dispatch)             authorisers' CURRENT standing)                                SEND_TO_CHANNEL        read tx -> HTTP (no tx) -> record tx
 outbox "Send now"      --/        caps (1 query), events (1 query, oldest first, bounded),
                                   scans (1 bounded SELECT per scan rule), claim = INSERT ... ON CONFLICT DO NOTHING,
                                   retries / interrupted jobs; COMMIT
                                  phase 2  for each claimed job, SEQUENTIALLY: execute -> (run row + job state + rule counters + audit) in the SAME tx as the effect
```

**Rules** (`automation_rules`) are `{ trigger, trigger_params, conditions[], action }` JSON from closed vocabularies (`vocabulary.ts`, zod), validated at creation and **again on every pass**. `authorised_by_user_id` is the person whose **current** membership bounds the run (`identity.ts`): `required permissions ∩ role ∩ allow-list`, as an `AUTOMATION` actor with `grantedPermissions`; a removed / suspended / demoted authoriser switches the rule off at the next pass with a visible reason. `automation_settings.all_paused` is the emergency switch, read in the pass's first statement, uncached.

**Event-driven triggers** read the Slice 2 outbox but are *independent of webhook fan-out*: `domain_events.automation_processed_at` (a second flag next to `dispatched_at`) records that the evaluator has seen an event, so rules work with no webhook subscription and **without the encryption key**. The pass reads pending events once (`origin = 'user'`, newest rule floor, oldest first, `LIMIT 50`), builds a `JobContext` from the event's own payload (the public-API DTO; no extra reads), evaluates each rule's conditions in memory with exact decimals, and claims `event:<id>` jobs. The business transaction is unchanged: it still only inserts the outbox row.

**Condition scans** (`scans.ts`): `INVOICE_OVERDUE` (N calendar days past due, UTC, still has an amount due), `BILL_DUE_SOON` (due today through N days, still owed), `INVENTORY_BELOW_REORDER` (active tracked product at or below its reorder point - `<=`, matching the Reorder Alerts page). Each is one bounded `SELECT ... LIMIT 25` that excludes rows the rule already has a job for (`NOT EXISTS`), with the rule's conditions **compiled into the WHERE clause** (closed field/operator tables, values bound) so non-matching rows cannot crowd matching ones out of the batch, and re-checked in memory. Re-arm of reorder jobs is one bounded `DELETE`.

**Dedupe and the job table.** `automation_jobs` (`UNIQUE (rule_id, job_key)`) is both the "already fired" memory and the retry queue: state `CLAIMED` (with a lease) -> `DONE` / `SKIPPED` / `FAILED` / `RETRY`. Two passes racing (or two serverless instances) can only both *insert* the same key once; the loser's `RETURNING` is empty. An advisory lock (`pg_try_advisory_xact_lock`) additionally makes a concurrent pass for the same organization return `busy`. A stale `CLAIMED` job (process died) is **never repeated blindly** for actions that change something (marked FAILED, "interrupted"), and is retried for `SEND_TO_CHANNEL` (at-least-once for a message; a duplicate Slack message is the lesser evil). Failed sends retry on later passes (not before 1 min, then 5 min) up to 3 attempts; each attempt is its own append-only run row. Scan keys are never purged (they are the memory); event keys older than 90 days are purged lazily, at most once an hour per organization per process.

**Caps** (documented constants): per pass 10 runs/rule and 30/organization; per rolling 24 h 100/rule and 300/organization (one grouped query); 25 rows per scan per rule; 50 events per pass; rules per organization 50. A rule is auto-disabled after 5 consecutive failed runs.

### 13.1 Why no connection is held across I/O

Same incident, same discipline as §12. `DATABASE_POOL_MAX` is 3 and the pooler allows ~15 clients project-wide. The only network call in the engine is the channel send, and it runs **between** two short transactions: `prepareSendIn` (read the connection + ciphertext) -> `sendWithPlan` (decrypt, SSRF-guarded HTTP, **no transaction open**) -> `recordSendIn` + the run record. `channel-and-integrations.test.ts` asserts, with the connection tracker, that at the instant the HTTP client runs `tracker.active === 0` and that scoped transactions never overlap (`maxActive === 1`). Nothing in the new modules uses `Promise.all` / `allSettled` / `race`, a private `pg` connection, or a timer (structural test); the page that lists rules, runs, channels and contacts makes its calls sequentially. Nothing was added to the shared layout, the shell or `withTenant` (structural test); the notifications nav item has no live badge and the unread count is computed only on the notifications page and the home card (one aggregate).

### 13.2 Measured database budgets

Counted at the driver (every statement including `BEGIN` / `set_config` / `COMMIT`), real engine, real database, `src/tests/integration/automation/query-budget.test.ts`:

| Operation | Statements | Transactions |
|---|---|---|
| Pass, archived / paused / busy early exit | 4 | 1 |
| Pass, no rules | 5 | 1 |
| Pass, 1 event rule and 1 pending event (no match); also 15 events; also 6 event rules | **10, 10, 10** (independent of M events and of N event rules) | 1 |
| Pass, 1 / 3 scan rules, nothing to do | 10 / 12 (+1 bounded SELECT per scan rule, +1 `DELETE` for a reorder re-arm) | 1 |
| Pass + one successful `NOTIFY_IN_APP` run | **21** (the plan, then one run transaction), identical for 1 or 4 recipients | 2 |
| Pass + one `SEND_TO_CHANNEL` run | **25** (the plan, a short read transaction, one HTTP call, a record transaction) | 3 (none open during the call) |

The once-an-hour retention `DELETE` adds one statement to the first pass of a process. A post-response pass costs the same and runs after the response, so a request that creates an invoice is not slower; the business transaction gains nothing.

### 13.3 Integrations

`IntegrationProvider` (`provider.ts`) is the adapter contract; `registry.ts` resolves **implemented** providers only (today `slack_incoming_webhook`); `catalog.ts` lists everything else as data-only "coming soon" entries. `IntegrationService` (`connection-service.ts`) owns persistence, encryption, audit and the integration log; providers are stateless and never see the database. Reads happen in a short transaction, network I/O (DNS vetting at connect, the test message, a send) outside any transaction, writes in a second short transaction. The engine uses three narrow entry points of the service (`prepareSendIn`, `sendWithPlan`, `recordSendIn`) so a send costs two transactions of its own, not three.

### 13.4 Notifications

`NotificationService.createIn(tx, ...)` runs inside the action's transaction (select existing unread duplicates, bump their `occurrences`, insert the rest: at most three statements however many recipients). Listing, marking read, dismissing and the unread aggregate are one short transaction each. The page groups a rule's items for display (no spam).

### 13.5 Where automations stop

`CREATE_DRAFT_PURCHASE_ORDER` is the only action that writes books-adjacent data, and it goes through `PurchaseOrderService.createIn` inside a **savepoint** (a refusal by the service - an inactive supplier - skips the run without poisoning the transaction), re-checks stock at the moment of acting, never sends, converts or posts, and leaves the ledger and trial balance byte-identical (asserted). Everything else in the system that needs a person still needs one.

## 14. OAuth 2.0 for third-party apps (Phase 10 Slice 4)

Master spec §54. Threat model and decisions: `docs/security.md` section 20; schema: `docs/database.md` section 2v; developer guide: `docs/api.md` section 1a. Code: `src/domain/oauth/*` (the logic), thin routes at `src/app/oauth/*`, `src/app/api/oauth/*` and `src/app/.well-known/*`, the management UI at `src/app/[orgSlug]/settings/oauth-apps` and `src/app/app/authorised-apps`.

```
 third-party app                                  Money Matters
 ---------------                                  -------------
 browser  --> GET /oauth/authorize ------------>  page (server component): parse (no DB) -> session -> client index -> ONE tenant tx
              ?client_id&redirect_uri&scope         [app + org archive flag + membership, one joined SELECT] -> consent screen
              &state&code_challenge(S256)
 person   --> POST /oauth/authorize/decision -->  Origin + session + HMAC token -> re-validate everything -> code row + audit (same tx)
 browser  <-- hand-off page -> redirect_uri?code&state&iss
 server   --> POST /api/oauth/token ----------->  rate limit (Postgres, 1 stmt) -> client index -> ONE tenant tx:
              (code + code_verifier)                client auth, claim code (atomic), PKCE, grant, refresh + access rows, audit
 server   --> GET/POST /api/v1/* -------------->  Bearer mmo_at_...: ONE joined lookup (token + membership + user + org) + 1 rate-limit stmt
              Authorization: Bearer access token     -> the SAME pipeline as an API key (scopes, permissions, idempotency, one withTenant)
```

**One pipeline.** `authenticateApiKey` (still the name; it authenticates *any* bearer credential) dispatches on the token label: `mm_live_` -> `api_key_index`, `mmo_at_` -> `oauth_access_tokens`. Both resolve to an `ApiPrincipal` (`credential: "api_key" | "oauth"`); `keyId` is the id rate limiting and idempotency are scoped to (the key id, or the **grant** id). The handler, endpoint registry, scope checks, draft guard, idempotency, errors and OpenAPI (`bearerAuth` **or** `oauth2` on every protected operation) are unchanged and credential-agnostic.

**Where the logic lives**

| Module | Role |
|---|---|
| `credentials.ts`, `pkce.ts`, `redirect-uri.ts` | token formats and hashing, S256 verification, redirect-URI rules (pure, unit-tested) |
| `authorize-service.ts` | the authorization decision: `preview` / `approve` / `deny`, the order of checks that makes an open redirect impossible |
| `token-service.ts` | code exchange, refresh with rotation + reuse detection, RFC 7009 revocation; each one tenant transaction |
| `grant-store.ts` | the single function that revokes (grant row + access-token index rows, one transaction) |
| `app-service.ts`, `grant-service.ts` | the human management side (`oauth_app:manage` + HUMAN; own-grant revoke for any member) |
| `bearer.ts` | access-token lookup and the pure `resolveAccessToken` (intersection rule) |
| `http.ts` | the form-encoded shell of the token and revocation endpoints |
| `rate-limit.ts`, `client-lookup.ts` | the only other modules that use the bare `db` handle (non-tenant by nature) |
| `csrf.ts`, `metadata.ts`, `constants.ts`, `errors.ts` | consent CSRF token, RFC 8414 document, pinned tunables, error classes |

### 14.1 Measured database budgets

Counted at the driver (every statement including `BEGIN` / `set_config` / `COMMIT`), real handlers, real database, `src/tests/integration/oauth/oauth-query-budget.test.ts`. Sequential everywhere; **at most one pooled connection and one tenant transaction per operation** (asserted with the connection tracker); no `Promise.all`, private connection or raw SQL in the new modules (structural test); nothing added to the shared layout, shell or `withTenant`.

| Operation | Statements | Tenant tx | Composition |
|---|---|---|---|
| Authenticated API request, **OAuth bearer** (`GET /me`) | **2** | 0 | (1) token index joined to membership + user + organization; (2) one rate-limit upsert - **identical to an API key** |
| Authenticated read (`GET /customers`) | **6** | 1 | the 2 above + the same single tenant transaction as for a key (key: 6) |
| Malformed token / unknown prefix / wrong secret | 0 / 1 / 1 | 0 | rejected on shape; or one lookup |
| Consent page render | **6** | 1 | session user lookup (1), client index (1), `BEGIN`, `set_config`, ONE joined SELECT (app + organization + membership), `COMMIT` |
| Consent approval (Allow) | 8 | 1 | client index, tx: joined SELECT, code INSERT, audit INSERT, expired-code purge |
| Token exchange (code -> tokens) | **14** | 1 | rate limit (1, address + client together), client index (1), tx: app SELECT, code SELECT, membership SELECT, code claim UPDATE, grant INSERT, code UPDATE, refresh INSERT, access INSERT, audit INSERT |
| Refresh | **13** | 1 | rate limit, client index, tx: app SELECT, one joined SELECT (refresh + grant + membership + user), claim UPDATE, refresh INSERT, access INSERT, grant UPDATE, two grant-scoped purges |
| Revocation (RFC 7009) | 10 | 1 | rate limit, client index, tx: app SELECT, token lookup, grant UPDATE, access-token UPDATE, audit INSERT |
| Token endpoint, unknown client | 2 | 0 | rate limit + client index; the tenant transaction is never opened |
| Token endpoint, bad content type / query string | 0 | 0 | rejected before any query |

The OAuth-bearer request costs **exactly** what an API-key request costs (the target was "at most +1"). The exchange and refresh figures are larger only because they *are* the writes; they happen once per hour per authorisation, not per API call. Housekeeping is bounded and rides inside those transactions (expired codes purged at approval; a grant's long-expired refresh/access rows purged at refresh); the stale rate-window purge runs after the response on roughly 1% of token-endpoint calls.

### 14.2 Why the endpoints are plain route handlers

`/api/oauth/*` is authenticated by **client credentials**, never the browser session: the middleware bypasses NextAuth for it, deletes the cookie header, refuses every method but POST (so no CORS preflight is ever answered) and the routes do not import the session layer. `/oauth/authorize` is a real page that sends a signed-out visitor to `/login?next=<full URL>` itself (the middleware's generic redirect would drop the query string). The consent decision hands off with a small interstitial page instead of a 3xx because browsers apply the consent page's `form-action 'self'` CSP to a form submission's redirect chain; the interstitial navigates with a meta refresh and a visible link.
