# Database

PostgreSQL, accessed through Drizzle ORM (`src/db/schema.ts`; migrations in
`drizzle/`). This document describes the Phase 1 schema and the conventions
every future migration must follow. See
`decisions/0001-database-orm.md` for why Drizzle rather than Prisma.

## 1. Conventions

- Every tenant-owned table has an `organization_id` column (FK →
  `organizations.id`, indexed) and an application-layer helper that requires
  it (`src/db/tenant.ts`). No repository function accepts "find by id"
  without also taking `organizationId` in its signature.
- Primary keys are UUIDs (`gen_random_uuid()`), not auto-increment integers
  (avoids leaking row counts, and merges cleanly across environments/seeds).
- Monetary columns are `Decimal(19, 4)`. Never `Float`/`Int` cents-hack.
- All tables have `createdAt`/`updatedAt`. Mutable business tables also have
  `createdById`/`updatedById`. Immutable tables (journal lines, audit logs)
  have `createdById` only.
- Closed sets are PostgreSQL enums (`account_type`, `journal_entry_status`,
  `fiscal_period_status`, `membership_role`) — not free-text columns — so
  invalid states are unrepresentable, not just validated.
- Soft-delete is used only where accounting history must be preserved
  (accounts, contacts use `isActive`/`archivedAt`, never a hard delete once
  referenced by a posted transaction). Rows with no financial consequence
  (e.g. a draft not yet posted) can be hard-deleted.

## 2. Phase 1 entity groups

### Identity & tenancy
- `User` — authentication identity (email, hashed password for the
  Credentials provider; `passwordHash` nullable to allow future SSO-only
  users).
- `Organization` — a tenant. `slug`, `name`, `baseCurrency`, `country`,
  `industry`.
- `OrganizationMembership` — join of `User`×`Organization` with a
  `MembershipRole`. A user can belong to many organizations with different
  roles in each (master spec §30, §46).

### Chart of accounts & ledger
- `Account` — chart of accounts entry (`code`, `name`, `type`, `subType`,
  `currency`, `isControlAccount`, `isSystemAccount`, `parentAccountId`).
- `FiscalPeriod` — `startDate`, `endDate`, `status` (`OPEN`/`SOFT_LOCKED`/
  `HARD_LOCKED`).
- `JournalEntry` — header: `entryNumber`, `postingDate`, `memo`, `status`
  (`DRAFT`/`POSTED`/`REVERSED`), `sourceType` (`MANUAL`/`OPENING_BALANCE`/…,
  extensible for later phases' AR/AP/payroll-generated journals),
  `reversalOfId`, `reversedById`.
- `JournalLine` — `accountId`, `debit`/`credit` (`Decimal(19,4)`, exactly
  one non-zero per row — enforced in the domain layer by `PostingService`
  rather than a DB CHECK; see `decisions/0003-monetary-precision.md`), `currency`, `exchangeRate`,
  `baseAmount`, `contactId?`, `taxCodeId?`, `memo?`.
- `JournalLineDimension` — join of `JournalLine`×`DimensionValue`.
- `Dimension` / `DimensionValue` — organization-defined slicing axes
  (Project, Location, Department, Customer, …) per master spec §5.

### Contacts & tax
- `Contact` — unified customer/supplier record (`kind`: `CUSTOMER`/
  `SUPPLIER`/`BOTH`), per master spec §29 ("one complete commercial record").
- `Currency` — reference table (code, name, symbol, decimalPlaces).
- `ExchangeRate` — `fromCurrency`, `toCurrency`, `rate`, `asOfDate`,
  `organizationId?` (nullable = system-wide reference rate).
- `TaxCode` — `code`, `name`, `rate`, `jurisdiction`, `effectiveFrom`,
  `effectiveTo` (versioned, per master spec §26/§88 — never hard-code a
  rate without an effective-date range).

### Governance
- `AuditLog` — append-only. `organizationId`, `actorUserId`, `actorType`
  (`HUMAN`/`AI`, ready for Phase 6), `action`, `entityType`, `entityId`,
  `before` (Json?), `after` (Json?), `createdAt`. No `updatedAt` — it never
  changes.
- `Approval` (schema only in Phase 1; approval *engine* is Phase 3+) —
  generic `entityType`/`entityId`, `status`, `requestedById`, `approvedById`.

## 2a. A Drizzle/Postgres pitfall that reintroduces floats — avoid `with:` on money-bearing relations

Drizzle's relational query API (`db.query.<table>.findFirst({ with: {...} })`)
fetches nested relations on Postgres via a server-side JSON aggregate
(`json_build_object`/`json_agg`). Postgres's numeric→json cast emits the
value as a bare JSON *number* literal, and `JSON.parse` on the Node side
then parses that literal into a native JS float — silently reintroducing
the exact precision loss `docs/accounting-engine.md` §4 forbids. This was
caught empirically during Phase 1 testing: a `numeric(19,4)` value of
`123.4567890123` round-tripped through a nested `with:` query as the float
`123.4568`, while the same column read through a plain `.select()...join()`
query came back as the untouched decimal string.

Rule: never use `with:` (nested relational queries) to fetch a table that
has a `numeric` column, directly or through a further-nested relation. Use
explicit `.select().from().leftJoin()`/`.innerJoin()` and group in
application code instead — see `loadLinesForEntries` in
`src/domain/ledger/ledger-service.ts` for the pattern. `with:` remains fine
for relations with no numeric columns (e.g. joining an `Account` or
`Contact` purely for display fields).

## 2b. The connection layer (`src/db/connection.ts`)

Every database consumer resolves its configuration through one pure,
unit-tested module rather than reading `process.env.DATABASE_URL` directly.
It exists because a misconfigured connection string otherwise surfaces as
`TypeError: Invalid URL` from deep inside the driver, with no indication of
which variable is wrong or why. It:

- **Resolves** from a prioritised list of variable names, so a project wired
  up by Vercel's Postgres/Supabase integration works unchanged
  (`DATABASE_URL`, `POSTGRES_URL`, `SUPABASE_DB_URL`, …). Migrations prefer
  explicitly non-pooled names (`DIRECT_DATABASE_URL`,
  `POSTGRES_URL_NON_POOLING`) because DDL, `CREATE ROLE` and session-level
  settings misbehave through a transaction-mode pooler.
- **Repairs** credentials that are legal as passwords but illegal raw inside
  a URI. `@`, `/`, `?`, `#`, spaces and brackets are all common in generated
  database passwords and all make `new URL()` throw; the parser finds the
  userinfo boundary by scanning right-to-left for a plausible host, then
  re-encodes. Stray wrapping quotes from copy-paste are stripped.
- **Diagnoses**, in operator terms: unsubstituted `[YOUR-PASSWORD]`
  placeholders, whitespace, wrong scheme, missing database name — and maps
  driver errno codes (`ENETUNREACH`, `28P01`, `3D000`, …) to what to
  actually change.
- **Derives** the application's connection from `MM_APP_DB_PASSWORD` plus the
  migration connection's host/database when no runtime connection string is
  set, so the same password is not maintained in two places.
- **Forces the runtime connection onto the `mm_app` role** whenever
  `MM_APP_DB_PASSWORD` is set. Pointing `DATABASE_URL` at the admin connection
  is the natural thing to reach for when the app cannot authenticate, and it
  appears to work perfectly — while disabling row-level security for every
  request (§3 below). A failed connection is a far better outcome than silent
  cross-tenant exposure, so the user and password are rewritten and the
  substitution is reported as a warning. Only the user and password change;
  host, port, database and query parameters are left as configured, migration
  connections keep their owner role, and unsetting `MM_APP_DB_PASSWORD` opts
  out for anyone running a differently-named restricted role.
- **Never logs the password.** `redactConnectionString()` is the only
  sanctioned way to put a connection string in a log line.

A known hosting trap encoded here: Supabase's direct host
(`db.<ref>.supabase.co`) is IPv6-only, and IPv4-only platforms — Vercel
among them — cannot reach it regardless of credentials. `resolveConnection`
emits a warning naming the Session pooler as the fix, and
`explainConnectionError` repeats it if the connection then fails.

`npm run db:doctor` (`scripts/db-doctor.ts`) exercises all of the above
read-only, so a connection problem is one command to identify rather than a
deploy cycle.

**Concurrent deploys against the same database.** Vercel deploys Preview and
Production independently, and both point at the same Supabase database
unless deliberately separated — so two builds starting within moments of
each other (in practice: one `git push` landing on both a feature branch
and `main`) both run `db:migrate:ci` against the same schema at once.
Without protection, the first to commit a pending migration succeeds and
the second's identical `CREATE TYPE`/`CREATE TABLE` collides with what the
first just created, failing an otherwise-correct build with a
duplicate-object error. `src/db/migrate.ts` takes a session-scoped Postgres
advisory lock (`pg_try_advisory_lock`) around the migration step, so a
second concurrent run waits for the first to finish and then finds nothing
pending, rather than racing it — verified by launching two `db:migrate`
processes at once against an empty database and confirming the second logs
"waiting for it to finish" and exits clean.

## 2c. Phase 2 entity groups: banking

- `BankAccount` — a bank account as the org sees it, always paired 1:1 with
  the ASSET `Account` it represents (`glAccountId`) — see
  `docs/decisions/0006-bank-feed-abstraction.md`. `provider`/
  `externalAccountId` are `MANUAL`/null until a live feed is connected.
- `BankImportBatch` — one row per statement upload, for traceability.
- `BankTransaction` — a staged line from an imported statement, not yet part
  of the ledger. `amount` follows the bank's own sign convention (positive =
  in, negative = out). `externalId` is always populated (the provider's own
  id, or a content hash for CSV/QIF — `src/domain/banking/external-id.ts`)
  and unique per bank account, so re-importing a file is a no-op.
- `BankRule` — organization-defined auto-categorization
  (`src/domain/banking/bank-rule-matching.ts`), evaluated in priority order
  against each newly-imported transaction.

A `BankTransaction` becomes ledger history only once reconciled — matched to
an existing posted `JournalLine` (`ReconciliationService.confirmMatch`) or
posted as a new balanced entry with `sourceType: "BANK_TRANSACTION"`
(`ReconciliationService.createJournalFromTransaction`), always through
`PostingService`, so every Phase 1 invariant (period lock, active accounts,
debit=credit) still applies to bank-originated entries.

## 3. Row-Level Security

Every tenant table gets an RLS policy of the shape:

```sql
alter table accounts enable row level security;
alter table accounts force row level security;
create policy tenant_isolation_accounts on accounts
  using (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
```

`withTenant()` sets `app.current_org_id` via `set_config(..., true)` —
transaction-local, equivalent to `SET LOCAL` — inside each request's
transaction (`src/db/tenant.ts`), using the org resolved from the
authenticated session, never a client-supplied header or body value.

Two details that are load-bearing rather than stylistic:

- `nullif(..., '')` because an unset custom GUC reads back as the empty
  string, not NULL, and `''::uuid` raises rather than simply matching no
  rows.
- `FORCE` (migration `0002`) because PostgreSQL exempts a table's owner from
  its own policies — see `docs/security.md` §2.

RLS is hand-authored SQL in `drizzle/0001_row_level_security.sql` and
`drizzle/0002_force_row_level_security.sql`; Drizzle's schema DSL does not
model policies, so they live in migrations, version-controlled like any
other.

## 4. Why Drizzle over Prisma or an ORM tied to Supabase

See `decisions/0001-database-orm.md`. Short version: Drizzle gives typed
migrations and a typed client while remaining plain PostgreSQL underneath —
`DATABASE_URL` can point at Supabase Postgres, a local Postgres, or any
other Postgres, satisfying "the database should remain portable Postgres".
Prisma was the original choice; its engine binaries could not be fetched in
the build environment, and the portability requirement made Drizzle a
straight swap.

## 5. What's deferred

Sales (`Invoice`, `Payment`), purchases (`Bill`, `PurchaseOrder`), inventory,
payroll, budgets, and everything else in the master spec's entity list
(§62) are modeled in later phases, each with its own ledger-posting
consequence documented before implementation, per master spec §84/§85
("financial features additionally require correct ledger consequence").
Within Phase 2 itself, a live bank feed provider, AI-assisted fuzzy
reconciliation, document AI (receipt/invoice capture), expense management,
object storage, a background job queue, and a cache are not yet built — see
`docs/roadmap.md`.
