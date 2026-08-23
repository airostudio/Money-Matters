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

## 8. Events (future phases)

Phase 1 does not yet need background workers, so no queue/outbox is stood
up. The domain layer already emits typed "would-be domain events" as return
values from services (e.g. `PostingService.postJournal()` returns a
`JournalPosted` result) so that when an outbox table and worker are
introduced (Phase 2+, once bank feeds/webhooks exist), wiring an
`OutboxService.enqueue()` call after each service method is additive, not a
refactor.

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
