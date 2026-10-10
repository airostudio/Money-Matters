-- Row-Level Security for Phase 7 Slice 3's Fixed Assets tables — same
-- pattern as every prior slice's RLS migration (e.g.
-- drizzle/0024_inventory_slice2_row_level_security.sql); see
-- docs/database.md §3 and docs/security.md §2 for why FORCE is required
-- and why grants are role-scoped rather than table-open.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  fixed_asset_classes,
  fixed_assets,
  depreciation_entries
TO mm_app;

ALTER TABLE fixed_asset_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_asset_classes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_fixed_asset_classes ON fixed_asset_classes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_fixed_assets ON fixed_assets
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE depreciation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE depreciation_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_depreciation_entries ON depreciation_entries
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
