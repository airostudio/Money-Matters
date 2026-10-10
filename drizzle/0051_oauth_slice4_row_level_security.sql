-- Row-Level Security + grants for Phase 10 Slice 4 (OAuth 2.0 for third-party apps: authorization code + PKCE). Read
-- docs/security.md section 20 alongside this file.
--
-- Four TENANT tables get the ordinary single-variable policy, exactly like every other slice (ENABLE + FORCE row-level
-- security, one policy keyed on app.current_org_id; src/db/isolation-audit.ts verifies it at build time):
--   oauth_apps                registered applications (hash of the client secret, never the secret)
--   oauth_grants              one row per consent that minted tokens
--   oauth_authorization_codes single-use codes (hash only)
--   oauth_refresh_tokens      rotating refresh tokens (hash only)
--
-- Three tables are deliberately NOT tenant tables, because the endpoints that read them run BEFORE the organisation is
-- known (a client id or a bearer token is what identifies it) - the same stance, and the same bounding by GRANTs and a
-- composite foreign key, as api_key_index (0043) and organization_invite_index (0047):
--   oauth_client_index   client_id -> (app id, organisation id, client type). SELECT + INSERT only: IMMUTABLE for mm_app
--                        (no UPDATE, no DELETE). Everything mutable is read from the RLS-protected oauth_apps row once the
--                        tenant context is open. The composite FK (id, organization_id) -> oauth_apps(id, organization_id)
--                        means a row for an app that does not exist in that organisation cannot be inserted, and the
--                        matching oauth_apps row is itself RLS-protected, so a transaction scoped to organisation A cannot
--                        plant a client id that resolves into organisation B.
--   oauth_access_tokens  prefix -> (token, grant, app, organisation, user, scopes, validity, SHA-256 hash). SELECT + INSERT,
--                        UPDATE of ONLY revoked_at, and DELETE (used only for the grant-scoped purge of long-expired rows).
--                        The hash / prefix / organisation / grant / user / scopes can never be rewritten. The composite FK
--                        (grant_id, organization_id) -> oauth_grants(id, organization_id) stops a row for another
--                        organisation's grant being forged from a tenant transaction.
--   oauth_rate_windows   text bucket -> fixed-window counter. Holds only counters. SELECT, INSERT, UPDATE, DELETE (purge).
--
-- oauth_apps: registered and edited by OWNER/ADMINISTRATOR humans (audited). Soft-deleted via deleted_at, so no DELETE.
-- oauth_grants: created at code exchange, then revoked (UPDATE of the revocation / refresh-stamp columns only). Never deleted.
-- oauth_authorization_codes: inserted, consumed (UPDATE of ONLY used_at and grant_id), and purged when old (DELETE).
-- oauth_refresh_tokens: inserted, rotated (UPDATE of ONLY used_at), and purged when old (DELETE).

GRANT SELECT, INSERT ON oauth_apps TO mm_app;
GRANT UPDATE (name, description, homepage_url, redirect_uris, scopes, secret_prefix, secret_hash, secret_rotated_at, updated_at, disabled_at, disabled_by_user_id, deleted_at, deleted_by_user_id) ON oauth_apps TO mm_app;

ALTER TABLE oauth_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_apps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_oauth_apps ON oauth_apps
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT ON oauth_grants TO mm_app;
GRANT UPDATE (last_refreshed_at, revoked_at, revoked_by_user_id, revoke_reason) ON oauth_grants TO mm_app;

ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_oauth_grants ON oauth_grants
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON oauth_authorization_codes TO mm_app;
GRANT UPDATE (used_at, grant_id) ON oauth_authorization_codes TO mm_app;

ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_oauth_authorization_codes ON oauth_authorization_codes
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, DELETE ON oauth_refresh_tokens TO mm_app;
GRANT UPDATE (used_at) ON oauth_refresh_tokens TO mm_app;

ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_oauth_refresh_tokens ON oauth_refresh_tokens
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- oauth_client_index: the narrow, immutable, non-tenant lookup (see the header).
GRANT SELECT, INSERT ON oauth_client_index TO mm_app;

-- oauth_access_tokens: the narrow, non-tenant bearer lookup (see the header).
GRANT SELECT, INSERT, DELETE ON oauth_access_tokens TO mm_app;
GRANT UPDATE (revoked_at) ON oauth_access_tokens TO mm_app;

-- Write-side isolation for the two lookup indexes (stronger than api_key_index / organization_invite_index have).
-- A composite foreign key alone does NOT stop a transaction scoped to organisation B from inserting an index row that
-- names organisation A and an A-owned app / grant id it happens to know: foreign-key checks bypass row-level security. So
-- these two tables also carry row-level security with an ASYMMETRIC policy set:
--   * SELECT is open (USING true): the authorize / token endpoints and bearer authentication run BEFORE any organisation is
--     known, so they must read by client id / token prefix without a tenant context. (Rows hold only ids, public client
--     metadata and SHA-256 hashes of 256-bit random tokens.)
--   * INSERT / UPDATE / DELETE are only possible for rows of the transaction's OWN organisation
--     (organization_id = app.current_org_id), so a tenant transaction can never mint, revoke or purge another
--     organisation's client or token rows. Every write in the application already happens inside that organisation's
--     withTenant transaction (src/domain/oauth/*).
-- src/db/isolation-audit.ts still lists both tables in RLS_EXEMPT_TABLES (they are not "one policy keyed on the
-- organisation" tables) and its "RLS enabled but no policy" check is satisfied.
ALTER TABLE oauth_client_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_client_index FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_client_index_read ON oauth_client_index FOR SELECT USING (true);
CREATE POLICY oauth_client_index_write ON oauth_client_index FOR INSERT
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE oauth_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_access_tokens_read ON oauth_access_tokens FOR SELECT USING (true);
CREATE POLICY oauth_access_tokens_insert ON oauth_access_tokens FOR INSERT
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY oauth_access_tokens_update ON oauth_access_tokens FOR UPDATE
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY oauth_access_tokens_delete ON oauth_access_tokens FOR DELETE
  USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- oauth_rate_windows: counters only.
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_rate_windows TO mm_app;
