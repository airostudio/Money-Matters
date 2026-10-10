-- Row-Level Security + grants for Phase 8 Slice 2 (BAS / GST preparation). Read docs/security.md alongside this file.
--
-- bas_statements: a FINALISED statement is an immutable snapshot. The DB itself enforces it: UPDATE and DELETE are
--   separate policies that only match rows whose status is still 'DRAFT' (USING), so an UPDATE/DELETE aimed at a
--   FINALISED row silently affects zero rows for mm_app, whatever the application code does. The WITH CHECK on UPDATE
--   allows the DRAFT -> FINALISED transition itself.
-- bas_lodgement_records: APPEND-ONLY (SELECT + INSERT, no UPDATE, no DELETE grant).

GRANT SELECT, INSERT, UPDATE, DELETE ON bas_statements TO mm_app;
GRANT SELECT, INSERT ON bas_lodgement_records TO mm_app;

ALTER TABLE bas_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE bas_statements FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_bas_statements_select ON bas_statements FOR SELECT
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_isolation_bas_statements_insert ON bas_statements FOR INSERT
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_isolation_bas_statements_update ON bas_statements FOR UPDATE
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND status = 'DRAFT')
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_isolation_bas_statements_delete ON bas_statements FOR DELETE
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND status = 'DRAFT');

ALTER TABLE bas_lodgement_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE bas_lodgement_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_bas_lodgement_records ON bas_lodgement_records
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
