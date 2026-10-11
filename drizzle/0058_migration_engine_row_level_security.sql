-- Row-Level Security + grants for the migration engine (docs/migration.md, docs/security.md section 22).
--
-- migration_batches: SELECT, INSERT, UPDATE. A batch is never deleted: a rolled-back or discarded one stays as history.
-- migration_rows:    SELECT, INSERT, UPDATE. Staged rows are never erased either (they are the audit of what a file contained).

GRANT SELECT, INSERT, UPDATE ON migration_batches TO mm_app;
GRANT SELECT, INSERT, UPDATE ON migration_rows TO mm_app;

ALTER TABLE migration_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_migration_batches ON migration_batches
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE migration_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_migration_rows ON migration_rows
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
