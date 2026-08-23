# 0004 — Multi-tenancy via organizationId + RLS, Supabase optional at the infra layer

## Status
Accepted

## Context
Master spec §30/§48: strong multi-entity support, and a coding mistake must
never let one organization read another's data. The platform should be able
to run on Supabase-hosted Postgres for auth/storage/realtime convenience,
without the *data model* depending on Supabase-specific mechanisms (so a
future move to plain RDS/Cloud SQL Postgres is a connection-string change,
not a rewrite).

## Decision
Tenant boundary = `organizationId` column on every tenant-owned table, with
enforcement duplicated at the application layer (mandatory-parameter
repository helpers) and the database layer (Postgres native RLS policies —
not Supabase's `auth.uid()`-flavored helpers, but a plain
`current_setting('app.current_org_id')` policy that works identically on
any Postgres, Supabase or not).

## Alternatives considered
- **Schema-per-tenant** — stronger isolation, but operationally heavy at
  the scale of SMB tenants (hundreds/thousands of orgs) and awkward for
  cross-org accountant practice-mode queries (master spec §42) which need
  to query "all my clients" efficiently. Rejected for this product shape.
- **Database-per-tenant** — same objection, more so.
- **RLS via Supabase's `auth.uid()` helpers directly** — would work, but
  ties the policy definitions to Supabase's auth schema, contradicting the
  portability requirement. Rejected in favor of a provider-agnostic session
  variable set by the app itself.

## Consequences
- Every new tenant table added in later phases must (a) include
  `organizationId`, (b) get an RLS policy in the same migration, (c) get a
  tenant-isolation test case. This is checklist-enforced in code review
  until it's automated (tracked as a Phase 2+ tooling item).
