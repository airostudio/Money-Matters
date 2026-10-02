-- Row-Level Security for Phase 6 Slice 3's auto-execution tables — same
-- pattern as drizzle/0018_ai_controller_slice2_row_level_security.sql and
-- every other tenant table's RLS migration; see docs/database.md §3 and
-- docs/security.md §2 for why FORCE is required and why grants are
-- role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  ai_auto_approved_actions,
  ai_auto_executions
TO mm_app;

ALTER TABLE ai_auto_approved_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_auto_approved_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ai_auto_approved_actions ON ai_auto_approved_actions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE ai_auto_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_auto_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ai_auto_executions ON ai_auto_executions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
