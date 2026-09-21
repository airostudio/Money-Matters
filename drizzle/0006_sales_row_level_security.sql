-- Row-Level Security for Phase 3 Slice 1's sales tables — same pattern as
-- drizzle/0004_bank_feed_row_level_security.sql; see docs/database.md §3 and
-- docs/security.md §2 for why FORCE is required and why grants are
-- role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  invoices,
  invoice_lines,
  payments,
  payment_allocations
TO mm_app;

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;

ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_invoices ON invoices
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_invoice_lines ON invoice_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_payments ON payments
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_payment_allocations ON payment_allocations
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
