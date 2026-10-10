# 0001 — Drizzle ORM as the database access layer

## Status
Accepted. Originally recorded as "Prisma"; superseded in Phase 1 by Drizzle
before any Prisma code shipped, and corrected here. The codebase has never
used Prisma and must not (the master build prompt forbids it).

## Context
The database must remain portable PostgreSQL (not tied to Supabase-specific
APIs), while still giving strong typing for a financial-integrity-critical
codebase and a migration workflow that produces reviewable, versioned SQL.
Row-Level Security, CHECK constraints, partial indexes, triggers and role
grants are central to the design (tenant isolation, immutable posted history)
and must be first-class, not escape hatches.

## Decision
Use Drizzle ORM (`drizzle-orm/node-postgres`, `pg` pool) against a plain
PostgreSQL connection, with `drizzle-kit` generating schema snapshots and
hand-written SQL migrations in `drizzle/NNNN_*.sql`. The schema lives in
`src/db/schema.ts`; migrations are applied by `src/db/migrate.ts`, which
records each file's SHA-256 in `drizzle.__drizzle_migrations`.

RLS policies, FORCE ROW LEVEL SECURITY, CHECK constraints, grants to the
restricted `mm_app` role and immutability policies are written as plain SQL
in the same migration files, so they version alongside schema changes.
Tenant scoping is applied per transaction via `withTenant`
(`app.current_org_id`) and `withUserScope` (`app.current_user_id`). A
build-time audit (`src/db/isolation-audit.ts`) fails if any tenant table
lacks forced RLS and a policy.

## Alternatives considered
- **Prisma** — the original choice. Rejected: it cannot express RLS, CHECK
  constraints or per-transaction session settings natively, so most of the
  integrity model would live in raw SQL outside its type system; its
  `Decimal` handling and migration diffing also fought the hand-written SQL
  workflow. Prohibited outright by the project's requirements.
- **Supabase JS client with PostgREST** — fast to start, but pushes query
  logic into ad-hoc client calls and couples the codebase to Supabase's REST
  surface. Rejected: conflicts with "database should remain portable
  Postgres."
- **Raw SQL / Kysely** — maximal control, but more boilerplate for a schema
  this size and no schema-derived types. Drizzle gives typed queries while
  still allowing raw SQL where needed.

## Consequences
- `DATABASE_URL` can point at Supabase Postgres, local Postgres, or any other
  Postgres — no code change required. Migrations use `DIRECT_DATABASE_URL`
  (schema owner); the app runs as the non-superuser `mm_app` role so RLS is
  never bypassed.
- Money is stored as `numeric` and handled in the domain layer by the `Money`
  type, never as floating point (see ADR 0003).
- Ledger invariants (balanced entries, one nonzero side per line, immutable
  posted history) are enforced both in the domain layer (`PostingService`)
  and, where practical, by database constraints and policies, and are
  covered by property-based tests against a real database (see
  `docs/accounting-engine.md`).
- Migrations are forward-only, hand-reviewed SQL; some (for example the
  Phase 8 and Phase 10 additions) have no drizzle-kit snapshot, which is
  accepted because `migrate.ts` applies files directly.
