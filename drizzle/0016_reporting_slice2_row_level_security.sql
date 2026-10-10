-- Row-Level Security for Phase 5 Slice 2's report builder
-- (`saved_reports`) — same pattern as
-- drizzle/0008_purchases_row_level_security.sql and every RLS migration
-- since; see docs/database.md §3 and docs/security.md §2 for why FORCE is
-- required and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON saved_reports TO mm_app;

ALTER TABLE saved_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_reports FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_saved_reports ON saved_reports
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
