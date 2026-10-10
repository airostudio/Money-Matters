-- Row-Level Security for Phase 9 Slice 2's Cash Flow Intelligence & Scenario
-- Modelling tables — same pattern as every prior slice's RLS migration (e.g.
-- drizzle/0032_budgeting_slice1_row_level_security.sql); see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  scenarios,
  cash_forecast_settings
TO mm_app;

ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenarios FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_scenarios ON scenarios
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE cash_forecast_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_forecast_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_cash_forecast_settings ON cash_forecast_settings
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
