-- Row-Level Security for Phase 7 Slice 2's Inventory tables — same pattern
-- as every prior slice's RLS migration (e.g.
-- drizzle/0022_projects_slice1_row_level_security.sql); see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  products,
  inventory_movements,
  inventory_adjustments
TO mm_app;

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_products ON products
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_inventory_movements ON inventory_movements
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_adjustments FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_inventory_adjustments ON inventory_adjustments
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
