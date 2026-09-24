-- Row-Level Security for Phase 4 Slice 2's purchase orders, recurring
-- bills, supplier credits, and payment runs — same pattern as
-- drizzle/0008_purchases_row_level_security.sql and
-- drizzle/0012_sales_slice2_row_level_security.sql; see docs/database.md §3
-- and docs/security.md §2 for why FORCE is required and why grants are
-- role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  purchase_orders,
  purchase_order_lines,
  purchase_order_receipts,
  purchase_order_receipt_lines,
  recurring_bill_templates,
  recurring_bill_template_lines,
  bill_recurring_source,
  supplier_credit_notes,
  supplier_credit_note_lines,
  supplier_credit_allocations,
  payment_runs,
  payment_run_items
TO mm_app;

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_bill_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_bill_template_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_recurring_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_run_items ENABLE ROW LEVEL SECURITY;

ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_receipt_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE recurring_bill_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE recurring_bill_template_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE bill_recurring_source FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_note_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE supplier_credit_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_run_items FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_purchase_orders ON purchase_orders
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_purchase_order_lines ON purchase_order_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_purchase_order_receipts ON purchase_order_receipts
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_purchase_order_receipt_lines ON purchase_order_receipt_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_recurring_bill_templates ON recurring_bill_templates
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_recurring_bill_template_lines ON recurring_bill_template_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_bill_recurring_source ON bill_recurring_source
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_supplier_credit_notes ON supplier_credit_notes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_supplier_credit_note_lines ON supplier_credit_note_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_supplier_credit_allocations ON supplier_credit_allocations
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_payment_runs ON payment_runs
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_payment_run_items ON payment_run_items
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
