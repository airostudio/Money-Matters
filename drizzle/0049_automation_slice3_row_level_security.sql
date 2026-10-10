-- Row-Level Security + grants for Phase 10 Slice 3 (the Automation Centre, in-app notifications and the integration
-- framework). Read docs/security.md sections 18 and 19 alongside this file. Every new table is an ordinary TENANT table:
-- ENABLE + FORCE row-level security and the single-variable policy keyed on app.current_org_id, exactly like every other
-- slice (src/db/isolation-audit.ts verifies this at build time).
--
-- Grants are deliberately narrow:
--   domain_events            gains UPDATE of ONLY automation_processed_at (alongside the existing dispatched_at).
--   automation_settings      SELECT, INSERT, UPDATE (the emergency "pause all" switch).
--   automation_rules         SELECT, INSERT, UPDATE, DELETE (managed by OWNER/ADMINISTRATOR humans, audited).
--   automation_jobs          SELECT, INSERT, UPDATE, DELETE (dedupe ledger + retry queue; DELETE re-arms a reorder key
--                            and is the retention purge).
--   automation_runs          SELECT, INSERT ONLY. The run log is APPEND-ONLY: no UPDATE and no DELETE grant, so the
--                            application role cannot edit or erase a recorded run. (A rule's deletion nulls rule_id by
--                            the referential-integrity trigger, performed as the table owner, not by mm_app.)
--   notifications            SELECT, INSERT; UPDATE of ONLY the read / dismissed / fold columns; DELETE (retention purge).
--   integration_connections  SELECT, INSERT, UPDATE, DELETE (managed by OWNER/ADMINISTRATOR humans, audited).
--   integration_events       SELECT, INSERT ONLY (append-only integration log; never holds a secret).

GRANT UPDATE (automation_processed_at) ON domain_events TO mm_app;

GRANT SELECT, INSERT, UPDATE ON automation_settings TO mm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_rules TO mm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON automation_jobs TO mm_app;
GRANT SELECT, INSERT ON automation_runs TO mm_app;
GRANT SELECT, INSERT, DELETE ON notifications TO mm_app;
GRANT UPDATE (occurrences, last_occurred_at, read_at, dismissed_at) ON notifications TO mm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integration_connections TO mm_app;
GRANT SELECT, INSERT ON integration_events TO mm_app;

ALTER TABLE automation_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_automation_settings ON automation_settings
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_automation_rules ON automation_rules
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE automation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_automation_jobs ON automation_jobs
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_automation_runs ON automation_runs
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_notifications ON notifications
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_integration_connections ON integration_connections
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_integration_events ON integration_events
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
