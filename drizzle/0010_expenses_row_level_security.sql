-- Row-Level Security for Phase 2 Slice 2's expense-management and document
-- tables — same pattern as drizzle/0006_sales_row_level_security.sql and
-- drizzle/0008_purchases_row_level_security.sql; see docs/database.md §3 and
-- docs/security.md §2 for why FORCE is required and why grants are
-- role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  uploaded_receipts,
  expense_claims,
  expense_claim_lines
TO mm_app;

ALTER TABLE uploaded_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claim_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE uploaded_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE expense_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE expense_claim_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_uploaded_receipts ON uploaded_receipts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_expense_claims ON expense_claims
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_expense_claim_lines ON expense_claim_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
