# Database

PostgreSQL, accessed through Prisma (`prisma/schema.prisma`). This document
describes the Phase 1 schema and the conventions every future migration must
follow.

## 1. Conventions

- Every tenant-owned table has `organizationId String` (FK →
  `Organization.id`, indexed) and an application-layer helper that requires
  it (`src/db/tenant.ts`). No repository function accepts "find by id"
  without also taking `organizationId` in its signature.
- Primary keys are `cuid()` strings, not auto-increment integers (avoids
  leaking row counts, and merges cleanly across environments/seeds).
- Monetary columns are `Decimal(19, 4)`. Never `Float`/`Int` cents-hack.
- All tables have `createdAt`/`updatedAt`. Mutable business tables also have
  `createdById`/`updatedById`. Immutable tables (journal lines, audit logs)
  have `createdById` only.
- Enums are Prisma enums for closed sets (`AccountType`, `JournalEntryStatus`,
  `FiscalPeriodStatus`, `MembershipRole`) — not free-text columns — so
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
  one non-zero per row — enforced in the domain layer, not by a DB CHECK,
  because Prisma's `Decimal` CHECK support is limited; see
  `decisions/0003-monetary-precision.md`), `currency`, `exchangeRate`,
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

## 3. Row-Level Security

Every tenant table gets an RLS policy of the shape:

```sql
alter table "Account" enable row level security;
create policy tenant_isolation on "Account"
  using (organization_id = current_setting('app.current_org_id', true)::text);
```

The Prisma client sets `app.current_org_id` via `SET LOCAL` inside each
request's transaction (`src/db/tenant.ts`), using the org resolved from the
authenticated session — never a client-supplied header/body value. RLS
policies live in `prisma/migrations/*_enable_rls/migration.sql` (Prisma
schema does not model RLS directly, so it is hand-authored SQL in a
migration, checked into version control like any other migration).

## 4. Why Prisma over raw SQL or an ORM tied to Supabase

See `decisions/0001-database-orm.md`. Short version: Prisma gives typed
migrations and a typed client while remaining plain PostgreSQL underneath —
`DATABASE_URL` can point at Supabase Postgres, a local Postgres, or any
other Postgres, satisfying "the database should remain portable Postgres."

## 5. What's deferred

Banking (`BankAccount`, `BankTransaction`, `BankRule`), sales (`Invoice`,
`Payment`), purchases (`Bill`, `PurchaseOrder`), inventory, payroll, budgets,
and everything else in the master spec's entity list (§62) are modeled in
later phases, each with its own ledger-posting consequence documented before
implementation, per master spec §84/§85 ("financial features additionally
require correct ledger consequence").
