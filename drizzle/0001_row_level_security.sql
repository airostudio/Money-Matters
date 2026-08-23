-- Row-Level Security for tenant isolation.
--
-- This migration must be applied by a superuser/owner role (DIRECT_DATABASE_URL).
-- It creates a restricted, non-superuser "mm_app" role for the application
-- runtime to connect as (DATABASE_URL) — RLS policies are silently bypassed
-- by superusers and table owners in PostgreSQL, so the app must NOT connect
-- as the migration-owning role or isolation would be a no-op.
--
-- See docs/security.md §2 and docs/decisions/0004-multi-tenancy-and-supabase.md.
--
-- mm_app is created WITHOUT a password and WITHOUT login rights here — a
-- fixed, committed password on a role with real privileges is a real
-- vulnerability the moment this runs against an internet-reachable
-- database (mm_app can set app.current_org_id to anything, so a leaked
-- password is a cross-tenant read of the entire database, not just its own
-- grants). src/db/migrate.ts sets a real password and enables LOGIN
-- immediately after this file runs, using MM_APP_DB_PASSWORD if provided or
-- a freshly generated one otherwise (printed once, never committed).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'mm_app') THEN
    CREATE ROLE mm_app WITH NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO mm_app;

-- Reference tables: readable by the app, writable only by the migration/owner role.
GRANT SELECT ON currencies TO mm_app;

-- users / organizations / organization_memberships are not scoped by a
-- single organization_id column (a user spans many orgs; an org's own row
-- has no "owner org" to compare against itself). Isolation for these is
-- enforced at the application layer (a session may only ever read its own
-- user row and its own memberships) and covered by the tenant-isolation
-- test suite. See docs/security.md §2.
GRANT SELECT, INSERT, UPDATE ON users TO mm_app;
GRANT SELECT, INSERT, UPDATE ON organizations TO mm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_memberships TO mm_app;

-- Tenant-owned tables: full CRUD grant, RLS policy narrows every statement
-- to the current session's organization.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  accounts,
  fiscal_periods,
  exchange_rates,
  tax_codes,
  contacts,
  dimensions,
  dimension_values,
  journal_line_dimensions,
  approvals
TO mm_app;

-- Journals are append-mostly but Phase 1 still allows editing/deleting a
-- DRAFT entry (see docs/accounting-engine.md §1) — enforced at the domain
-- layer (PostingService only issues UPDATE/DELETE for status = 'DRAFT'),
-- not by revoking the SQL grant, since the same table also serves the
-- transactional posting write.
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_entries, journal_lines TO mm_app;

-- Audit log is append-only: INSERT + SELECT only, never UPDATE/DELETE,
-- enforced at the database grant level, not just by application discipline.
GRANT SELECT, INSERT ON audit_logs TO mm_app;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dimension_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_line_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_accounts ON accounts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_fiscal_periods ON fiscal_periods
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- exchange_rates.organization_id is nullable (NULL = system-wide reference
-- rate, readable by everyone); only org-specific rows are tenant-checked.
CREATE POLICY tenant_isolation_exchange_rates ON exchange_rates
  USING (
    organization_id IS NULL
    OR organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id IS NULL
    OR organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY tenant_isolation_tax_codes ON tax_codes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_contacts ON contacts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_dimensions ON dimensions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_dimension_values ON dimension_values
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_journal_line_dimensions ON journal_line_dimensions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_approvals ON approvals
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_journal_entries ON journal_entries
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_journal_lines ON journal_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
