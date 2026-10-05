-- Row-Level Security + grants for Phase 9 Slice 4 (multi-entity consolidation).
--
-- These tables are USER-scoped: a consolidation group belongs to the user who
-- built it and spans organizations, so the `app.current_org_id` tenant policy
-- cannot apply. They get the same strength of protection by other means:
--   * RLS is ENABLED and FORCEd on every table (the owner role is not exempt);
--   * the ONLY predicate is `owner_user_id = app.current_user_id`, a session
--     variable set per transaction by withUserScope() (src/db/user-scope.ts) —
--     exactly as narrow as withTenant()'s `app.current_org_id`;
--   * there is NO multi-organization predicate, no bypass policy, no
--     SECURITY DEFINER function anywhere in this migration (a structural test
--     asserts it);
--   * a group member / mapping / intercompany row can only be INSERTed for an
--     organization the owner is an ACTIVE MEMBER of (checked in the policy
--     itself, so even a bug in the application layer cannot pull in an
--     organization the user does not belong to). The finer "holds
--     consolidation:manage in that entity" rule is a role-matrix check and is
--     enforced in the application layer, with the entity's own role;
--   * grants are minimal and the history tables are APPEND-ONLY (SELECT +
--     INSERT only): adjustments, adjustment lines, and the group audit log.
-- See docs/security.md section 12 and docs/database.md.
-- entity_groups: a group is renamed/archived, never deleted (no DELETE grant, no DELETE policy).
GRANT SELECT, INSERT, UPDATE ON entity_groups TO mm_app;
ALTER TABLE entity_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_groups_select ON entity_groups FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_groups_insert ON entity_groups FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_groups_update ON entity_groups FOR UPDATE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_members: INSERT additionally requires the owner to be an active member of the organization being added.
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_group_members TO mm_app;
ALTER TABLE entity_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_members FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_members_select ON entity_group_members FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_members_insert ON entity_group_members FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.user_id = entity_group_members.owner_user_id
        AND m.organization_id = entity_group_members.member_organization_id
        AND m.is_active = true
    ));
CREATE POLICY user_scope_entity_group_members_update ON entity_group_members FOR UPDATE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_members_delete ON entity_group_members FOR DELETE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_accounts: the group's own chart of accounts.
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_group_accounts TO mm_app;
ALTER TABLE entity_group_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_accounts_select ON entity_group_accounts FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_accounts_insert ON entity_group_accounts FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_accounts_update ON entity_group_accounts FOR UPDATE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_accounts_delete ON entity_group_accounts FOR DELETE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_account_mappings: INSERT requires active membership of the mapped entity.
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_group_account_mappings TO mm_app;
ALTER TABLE entity_group_account_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_account_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_account_mappings_select ON entity_group_account_mappings FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_account_mappings_insert ON entity_group_account_mappings FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.user_id = entity_group_account_mappings.owner_user_id
        AND m.organization_id = entity_group_account_mappings.member_organization_id
        AND m.is_active = true
    ));
CREATE POLICY user_scope_entity_group_account_mappings_update ON entity_group_account_mappings FOR UPDATE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid) WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_account_mappings_delete ON entity_group_account_mappings FOR DELETE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_intercompany_accounts: re-designating is delete + insert (audited), so no UPDATE grant.
GRANT SELECT, INSERT, DELETE ON entity_group_intercompany_accounts TO mm_app;
ALTER TABLE entity_group_intercompany_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_intercompany_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_intercompany_accounts_select ON entity_group_intercompany_accounts FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_intercompany_accounts_insert ON entity_group_intercompany_accounts FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM organization_memberships m
      WHERE m.user_id = entity_group_intercompany_accounts.owner_user_id
        AND m.organization_id = entity_group_intercompany_accounts.member_organization_id
        AND m.is_active = true
    ));
CREATE POLICY user_scope_entity_group_intercompany_accounts_delete ON entity_group_intercompany_accounts FOR DELETE USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_adjustments: APPEND-ONLY: a reversal is a new row pointing back at the original; UPDATE/DELETE/TRUNCATE are refused by Postgres itself.
GRANT SELECT, INSERT ON entity_group_adjustments TO mm_app;
ALTER TABLE entity_group_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_adjustments_select ON entity_group_adjustments FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_adjustments_insert ON entity_group_adjustments FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_adjustment_lines: APPEND-ONLY, like its header.
GRANT SELECT, INSERT ON entity_group_adjustment_lines TO mm_app;
ALTER TABLE entity_group_adjustment_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_adjustment_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_adjustment_lines_select ON entity_group_adjustment_lines FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_adjustment_lines_insert ON entity_group_adjustment_lines FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

-- entity_group_audit_logs: APPEND-ONLY group-level audit trail.
GRANT SELECT, INSERT ON entity_group_audit_logs TO mm_app;
ALTER TABLE entity_group_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_group_audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY user_scope_entity_group_audit_logs_select ON entity_group_audit_logs FOR SELECT USING (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);
CREATE POLICY user_scope_entity_group_audit_logs_insert ON entity_group_audit_logs FOR INSERT WITH CHECK (owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid);

