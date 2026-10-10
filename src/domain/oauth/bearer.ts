import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { oauthAccessTokens, organizationMemberships, organizations, users } from "@/db/schema";
import type { ApiPrincipal } from "@/domain/api/api-auth";
import { apiErrors } from "@/domain/api/errors";
import { effectivePermissions } from "@/domain/api/scopes";
import type { MembershipRole } from "@/domain/permissions/roles";
import { hashesEqual } from "./credentials";

/**
 * Bearer authentication with an OAuth ACCESS TOKEN (`mmo_at_<prefix>_<secret>`), the sibling of the API-key lookup in
 * src/domain/api/api-auth.ts - and, like it, ONE joined query: the token row (non-tenant index) with the consenting
 * person's membership, their account state and the organization's archive flag. Nothing else touches the database before
 * the rate-limit statement, so an OAuth-authenticated request costs exactly what an API-key one does.
 *
 * Revocation needs no extra lookup: revoking a grant, disabling or deleting an app, and a replay / reuse detection all
 * stamp `oauth_access_tokens.revoked_at` in the same transaction that makes the change.
 *
 * THE RULE (docs/security.md section 20): the token's power is NEVER stored. On every request it is
 *   granted scopes  INTERSECT  the consenting person's CURRENT role in that organization  INTERSECT  API_ALLOWED_PERMISSIONS
 * (`effectivePermissions`, the very function API keys use), so a demotion shrinks it and a removal / suspension / seat
 * removal / archive kills it on the next request - no refresh, no waiting for expiry.
 */
export interface AccessTokenRow {
  id: string;
  organizationId: string;
  grantId: string;
  appId: string;
  clientId: string;
  userId: string;
  prefix: string;
  secretHash: string;
  scopes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
  membershipRole: MembershipRole | null;
  membershipActive: boolean | null;
  userDisabledAt: Date | null;
  organizationArchivedAt: Date | null;
}

export async function lookupAccessTokenByPrefix(prefix: string): Promise<AccessTokenRow | null> {
  const [row] = await db
    .select({
      id: oauthAccessTokens.id,
      organizationId: oauthAccessTokens.organizationId,
      grantId: oauthAccessTokens.grantId,
      appId: oauthAccessTokens.appId,
      clientId: oauthAccessTokens.clientId,
      userId: oauthAccessTokens.userId,
      prefix: oauthAccessTokens.prefix,
      secretHash: oauthAccessTokens.secretHash,
      scopes: oauthAccessTokens.scopes,
      expiresAt: oauthAccessTokens.expiresAt,
      revokedAt: oauthAccessTokens.revokedAt,
      membershipRole: organizationMemberships.role,
      membershipActive: organizationMemberships.isActive,
      userDisabledAt: users.disabledAt,
      organizationArchivedAt: organizations.archivedAt,
    })
    .from(oauthAccessTokens)
    .leftJoin(
      organizationMemberships,
      and(eq(organizationMemberships.organizationId, oauthAccessTokens.organizationId), eq(organizationMemberships.userId, oauthAccessTokens.userId)),
    )
    .leftJoin(users, eq(users.id, oauthAccessTokens.userId))
    .innerJoin(organizations, eq(organizations.id, oauthAccessTokens.organizationId))
    .where(eq(oauthAccessTokens.prefix, prefix))
    .limit(1);
  return row ?? null;
}

/**
 * Pure decision over a looked-up row: is this token usable right now, and with what power? Mirrors `resolvePrincipal` for
 * API keys so every revoked / expired / archived / person-gone / demoted case is unit-testable without a database.
 */
export function resolveAccessToken(row: AccessTokenRow, presentedHash: string, now: Date): ApiPrincipal {
  if (!hashesEqual(presentedHash, row.secretHash)) throw apiErrors.invalidToken();
  if (row.revokedAt) throw apiErrors.tokenRevoked();
  if (row.expiresAt.getTime() <= now.getTime()) throw apiErrors.tokenExpired();
  if (row.organizationArchivedAt) throw apiErrors.organizationArchived();
  if (!row.membershipRole || !row.membershipActive || row.userDisabledAt) throw apiErrors.authorizationOwnerInactive();

  const permissions = effectivePermissions(row.scopes, row.membershipRole);
  return {
    credential: "oauth",
    keyId: row.grantId, // rate limiting and idempotency are scoped to the GRANT (all of its tokens share one budget)
    prefix: row.prefix,
    organizationId: row.organizationId,
    scopes: row.scopes,
    creatorUserId: row.userId,
    creatorRole: row.membershipRole,
    expiresAt: row.expiresAt,
    permissions,
    oauth: { clientId: row.clientId, grantId: row.grantId, appId: row.appId },
    actor: {
      userId: row.userId,
      organizationId: row.organizationId,
      role: row.membershipRole,
      type: "API",
      grantedPermissions: permissions,
      oauth: { clientId: row.clientId, grantId: row.grantId },
    },
  };
}
