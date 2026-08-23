# 0001 — Prisma as the database access layer

## Status
Accepted

## Context
The database must remain portable PostgreSQL (not tied to Supabase-specific
APIs), while still giving strong typing for a financial-integrity-critical
codebase and a migration workflow that produces reviewable, versioned SQL.

## Decision
Use Prisma ORM against a plain `DATABASE_URL` PostgreSQL connection. Row-
Level Security policies (which Prisma cannot express natively) are added as
hand-written SQL inside Prisma migration files, so they version alongside
schema changes rather than living in a separate, easy-to-forget place.

## Alternatives considered
- **Supabase JS client with PostgREST** — fast to start, but pushes query
  logic into ad-hoc client calls scattered across the app rather than a
  typed repository layer, and couples the codebase to Supabase's REST
  surface. Rejected: conflicts with "database should remain portable
  Postgres."
- **Raw SQL / Kysely** — maximal control, no ORM overhead, but higher
  boilerplate for a schema this size in Phase 1 and no migration diffing.
  Reconsider if Prisma's `Decimal`/RLS limitations become a real blocker.
- **Drizzle ORM** — comparable portability story to Prisma; Prisma was
  chosen for more mature migration tooling and ecosystem familiarity. Not a
  strong rejection — revisit if Prisma's `Decimal` column CHECK support
  remains too limited for invariants we want enforced at the DB layer.

## Consequences
- `DATABASE_URL` can point at Supabase Postgres, local Postgres, or any
  other Postgres — no code change required.
- Debit/credit-is-exactly-one-nonzero and balance invariants are enforced in
  the domain layer (`PostingService`), not as a Postgres CHECK constraint,
  because Prisma's raw-SQL migration escape hatch makes this possible but
  not ergonomic to keep in sync with the Prisma schema. Covered instead by
  property-based tests hitting the real database (see
  `docs/accounting-engine.md` §6).
