-- Row-Level Security + grants for "Organisation lifecycle & joining" (archive, create-another-company, invite
-- codes). Read docs/security.md section 17 alongside this file.
--
-- organizations (archived_at / archived_by_user_id / archive_reason): a NON-tenant table with no RLS, exactly as
-- before; mm_app already holds table-level SELECT, INSERT, UPDATE on it (0001). Archive/restore are UPDATEs of those
-- three columns plus updated_at. Nothing about archiving needs a new grant, and there is still NO DELETE grant on
-- organizations or on any append-only table: permanent erasure is deliberately not possible through the app role.
--
-- Two new tables:
--   organization_invites       TENANT table (organization_id, RLS enabled + FORCED + policy). The management record
--                              of an invite: email, role, display prefix, validity and state. Never the code.
--   organization_invite_index  NON-tenant lookup (code hash -> invite id + organization id), because redemption runs
--                              BEFORE the redeemer is a member and so before any organization is known - the same
--                              shape of problem as api_key_index (0043). Bounded by GRANTs instead of RLS:
--                                * SELECT + INSERT only. No UPDATE (a hash can never be rewritten or re-pointed),
--                                  no DELETE, no TRUNCATE.
--                                * It carries no email, role, expiry or state - nothing but what is needed to open
--                                  the organization's tenant transaction. Every decision is made against the
--                                  RLS-protected organization_invites row afterwards.
--                                * The composite foreign key (id, organization_id) -> organization_invites(id,
--                                  organization_id) means a row for an invite that does not exist in that
--                                  organization cannot be inserted, and the matching organization_invites row is
--                                  itself RLS-protected, so a transaction scoped to organization A cannot plant a
--                                  code hash that resolves into organization B.

-- organization_invites: created, then revoked or used (UPDATE of those columns only). Never deleted.
GRANT SELECT, INSERT ON organization_invites TO mm_app;
GRANT UPDATE (revoked_at, revoked_by_user_id, used_at, used_by_user_id) ON organization_invites TO mm_app;

ALTER TABLE organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invites FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_organization_invites ON organization_invites
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- organization_invite_index: the narrow, non-tenant lookup (see the header).
GRANT SELECT, INSERT ON organization_invite_index TO mm_app;
