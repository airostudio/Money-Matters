-- Row-Level Security for Phase 8 Slice 1's Payroll tables — same pattern as
-- every prior slice's RLS migration (e.g.
-- drizzle/0026_fixed_assets_slice3_row_level_security.sql); see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.
--
-- payroll_tax_rule_sets / payroll_tax_brackets are deliberately NOT given
-- RLS here: they carry no organization_id (they are shared AU regulatory
-- reference data, not per-tenant data — see those tables' doc comments in
-- src/db/schema.ts) and so are correctly exempt from the tenant-isolation
-- audit in src/db/migrate.ts. They still need a plain SELECT grant for the
-- mm_app role to read them at all (no INSERT/UPDATE/DELETE — only the seed
-- migration below, run as the owning role, ever writes these rows).

GRANT SELECT, INSERT, UPDATE, DELETE ON
  employees,
  pay_runs,
  pay_run_lines
TO mm_app;

GRANT SELECT ON
  payroll_tax_rule_sets,
  payroll_tax_brackets
TO mm_app;

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_employees ON employees
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_pay_runs ON pay_runs
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE pay_run_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_run_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_pay_run_lines ON pay_run_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
