-- Row-Level Security for Phase 3 Slice 2's quotes and recurring-invoicing
-- tables — same pattern as drizzle/0006_sales_row_level_security.sql; see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required and
-- why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  quotes,
  quote_lines,
  recurring_invoice_templates,
  recurring_invoice_template_lines,
  invoice_recurring_source
TO mm_app;

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_template_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_recurring_source ENABLE ROW LEVEL SECURITY;

ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
ALTER TABLE quote_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_templates FORCE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_template_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_recurring_source FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_quotes ON quotes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_quote_lines ON quote_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_recurring_invoice_templates ON recurring_invoice_templates
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_recurring_invoice_template_lines ON recurring_invoice_template_lines
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY tenant_isolation_invoice_recurring_source ON invoice_recurring_source
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
