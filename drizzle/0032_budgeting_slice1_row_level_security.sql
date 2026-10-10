-- Row-Level Security for Phase 9 Slice 1's Budgeting tables — same pattern
-- as every prior slice's RLS migration (e.g.
-- drizzle/0026_fixed_assets_slice3_row_level_security.sql); see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  budgets,
  budget_lines
TO mm_app;

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_budgets ON budgets
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_budget_lines ON budget_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
