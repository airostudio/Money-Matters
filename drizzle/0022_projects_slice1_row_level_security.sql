-- Row-Level Security for Phase 7 Slice 1's Projects/Jobs & Time Tracking
-- tables — same pattern as every prior slice's RLS migration (e.g.
-- drizzle/0018_ai_controller_slice2_row_level_security.sql); see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  projects,
  project_tasks,
  timesheet_entries
TO mm_app;

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_projects ON projects
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE project_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_project_tasks ON project_tasks
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_timesheet_entries ON timesheet_entries
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
