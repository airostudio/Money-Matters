-- Row-Level Security for Phase 4 Slice 1's purchases tables — same pattern
-- as drizzle/0006_sales_row_level_security.sql; see docs/database.md §3 and
-- docs/security.md §2 for why FORCE is required and why grants are
-- role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  bills,
  bill_lines,
  supplier_payments,
  supplier_payment_allocations
TO mm_app;

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE bills FORCE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_payment_allocations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_bills ON bills
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_bill_lines ON bill_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_supplier_payments ON supplier_payments
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_supplier_payment_allocations ON supplier_payment_allocations
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
