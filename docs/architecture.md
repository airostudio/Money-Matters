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
three snapshot reads described in §12 - so the `POST /invoices` figure above (20 when it was measured) grows by exactly those four statements
and is still independent of the number of lines; `api-query-budget.test.ts` is unchanged and still passes.

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

