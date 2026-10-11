-- Row-Level Security + grants for the approval engine (master spec s.45). Every table is an ordinary TENANT table:
-- ENABLE + FORCE row-level security and the single-variable policy keyed on app.current_org_id.
--
-- approval_policies:  SELECT, INSERT, UPDATE. No DELETE: a policy is deactivated, never erased.
-- approval_requests:  SELECT, INSERT, UPDATE (status transitions). No DELETE: a resubmission is a NEW request.
-- approval_steps:     SELECT, INSERT, UPDATE (status / reassignment). No DELETE.
-- approval_decisions: SELECT, INSERT ONLY. The decision log is append-only.

GRANT SELECT, INSERT, UPDATE ON approval_policies TO mm_app;
GRANT SELECT, INSERT, UPDATE ON approval_requests TO mm_app;
GRANT SELECT, INSERT, UPDATE ON approval_steps TO mm_app;
GRANT SELECT, INSERT ON approval_decisions TO mm_app;

ALTER TABLE approval_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_approval_policies ON approval_policies
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_approval_requests ON approval_requests
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_approval_steps ON approval_steps
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_approval_decisions ON approval_decisions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
