-- Row-Level Security for Phase 2's banking tables — same pattern as
-- drizzle/0001_row_level_security.sql and drizzle/0002_force_row_level_security.sql;
-- see docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  bank_accounts,
  bank_import_batches,
  bank_transactions,
  bank_rules
TO mm_app;

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE bank_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_import_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE bank_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_bank_accounts ON bank_accounts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_bank_import_batches ON bank_import_batches
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_bank_transactions ON bank_transactions
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_bank_rules ON bank_rules
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
