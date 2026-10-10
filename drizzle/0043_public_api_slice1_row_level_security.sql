-- Row-Level Security + grants for Phase 10 Slice 1 (the public developer API: API keys, rate
-- windows, idempotency records). Read docs/security.md section 15 alongside this file.
--
-- Two TENANT tables get the ordinary single-variable policy, exactly like every other slice:
--   api_keys              the management record of a key (never the secret or its hash)
--   api_idempotency_keys  replay records for API POSTs
-- Two tables are deliberately NOT tenant tables, because the API's authentication runs BEFORE the
-- organization is known (the key is what identifies it):
--   api_key_index         prefix -> (organization, key id, secret hash, creator, validity)
--   api_rate_windows      one request counter row per key
-- Neither is reachable from a tenant policy and neither holds any financial data. Their exposure is
-- bounded by GRANTs instead of RLS (the same stance as organization_memberships, see
-- src/db/isolation-audit.ts RLS_EXEMPT_TABLES):
--   * api_key_index: SELECT + INSERT, and UPDATE of ONLY revoked_at and last_used_at. No DELETE, no
--     TRUNCATE, and the hash / prefix / organization / creator / scopes can never be rewritten. The
--     composite foreign key (id, organization_id) -> api_keys(id, organization_id) means an index
--     row for a key that does not exist in that organization cannot be inserted, and the matching
--     api_keys row is itself RLS-protected, so a transaction scoped to organization A cannot mint a
--     working key for organization B.
--   * api_rate_windows: SELECT + INSERT + UPDATE (the atomic upsert). No DELETE.

-- api_keys: created, then revoked (UPDATE of the revocation columns only). Never deleted - the
-- audit trail and the idempotency records refer to it.
GRANT SELECT, INSERT ON api_keys TO mm_app;
GRANT UPDATE (revoked_at, revoked_by_user_id) ON api_keys TO mm_app;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_api_keys ON api_keys
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- api_idempotency_keys: inserted first, completed (UPDATE), and purged after 24 hours (DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON api_idempotency_keys TO mm_app;

ALTER TABLE api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_api_idempotency_keys ON api_idempotency_keys
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- api_key_index: the narrow, non-tenant lookup (see the header).
GRANT SELECT, INSERT ON api_key_index TO mm_app;
GRANT UPDATE (revoked_at, last_used_at) ON api_key_index TO mm_app;

-- api_rate_windows: one counter row per key.
GRANT SELECT, INSERT, UPDATE ON api_rate_windows TO mm_app;
