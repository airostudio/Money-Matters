/**
 * Tunables for OAuth 2.0 for third-party apps (Phase 10 Slice 4, docs/security.md section 20). Every number here is
 * pinned by a test so loosening one is a deliberate, reviewed change.
 */
/** Access tokens are short-lived: a leaked one is useful for at most an hour (and dies at once on revoke / demotion). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** A refresh token lives 30 days from the moment it is issued; every use ROTATES it, so an active app never expires. */
export const REFRESH_TOKEN_TTL_DAYS = 30;
/** An authorization code is redeemable for at most 60 seconds, once. */
export const AUTH_CODE_TTL_SECONDS = 60;
/** The signed consent form is valid for ten minutes (a person reading a consent screen). */
export const CONSENT_FORM_TTL_SECONDS = 10 * 60;
/**
 * A rotated refresh token is kept (marked used) this long so presenting it again is recognised as REUSE and revokes the
 * grant; afterwards it is purged and a replay is merely an unknown token (`invalid_grant`).
 */
export const USED_REFRESH_RETENTION_DAYS = 7;
/** Expired access-token lookup rows are purged (per grant, at refresh) once they are this old. */
export const EXPIRED_ACCESS_RETENTION_DAYS = 1;
/** Registered applications per organisation (soft-deleted ones do not count). */
export const MAX_APPS_PER_ORG = 10;
export const MAX_REDIRECT_URIS_PER_APP = 10;
export const MAX_APP_NAME_LENGTH = 80;
export const MAX_APP_DESCRIPTION_LENGTH = 300;
export const MAX_URL_LENGTH = 2000;

/** Token / revocation endpoint request budgets per fixed 60-second window (Postgres counters, src/domain/oauth/rate-limit.ts). */
export const TOKEN_LIMIT_PER_IP_PER_MINUTE = 60;
export const TOKEN_LIMIT_PER_CLIENT_PER_MINUTE = 300;
/** An access token's API requests share the platform default of 60 requests per minute per grant. */
export const API_LIMIT_PER_GRANT_PER_MINUTE = 60;

/** Largest form body the token / revocation endpoints will read. */
export const MAX_TOKEN_BODY_BYTES = 8 * 1024;

export const GRANT_REVOKE_REASONS = [
  "USER",
  "ADMIN",
  "APP_DISABLED",
  "APP_DELETED",
  "APP_SCOPES_REDUCED",
  "CODE_REPLAY",
  "REFRESH_REUSE",
  "CLIENT",
] as const;
export type GrantRevokeReason = (typeof GRANT_REVOKE_REASONS)[number];
