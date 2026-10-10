import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { oauthAccessTokens, oauthGrants } from "@/db/schema";
import type { TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";
import type { GrantRevokeReason } from "./constants";

/**
 * The ONE place a grant is revoked. Revocation is immediate and total: the grant row is stamped, and every access token
 * minted from it is stamped in the non-tenant lookup index IN THE SAME TRANSACTION, so the very next API request with any
 * of them fails. Refresh tokens need no stamp: the refresh path joins the grant and refuses a revoked one.
 *
 * Takes an open tenant transaction so each caller (user, admin, app disable, code replay, refresh reuse, the revocation
 * endpoint) revokes atomically with its own audit row.
 */
export interface RevokedGrant {
  id: string;
  appId: string;
  userId: string;
}

async function killTokens(tx: TenantDb, organizationId: string, grantIds: string[], now: Date): Promise<void> {
  if (grantIds.length === 0) return;
  await tx
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(oauthAccessTokens.organizationId, organizationId), inArray(oauthAccessTokens.grantId, grantIds), isNull(oauthAccessTokens.revokedAt)));
}

/** Revokes one grant. Returns the grant when THIS call revoked it, or null when it was missing / already revoked. */
export async function revokeGrant(
  tx: TenantDb,
  organizationId: string,
  grantId: string,
  reason: GrantRevokeReason,
  byUserId: string | null,
  now: Date = new Date(),
): Promise<RevokedGrant | null> {
  const [row] = await tx
    .update(oauthGrants)
    .set({ revokedAt: now, revokedByUserId: byUserId, revokeReason: reason })
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.organizationId, organizationId), isNull(oauthGrants.revokedAt)))
    .returning({ id: oauthGrants.id, appId: oauthGrants.appId, userId: oauthGrants.userId });
  if (!row) return null;
  await killTokens(tx, organizationId, [row.id], now);
  return row;
}

/** Revokes every active grant of an app (disable / delete). Returns what was revoked. */
export async function revokeGrantsOfApp(
  tx: TenantDb,
  organizationId: string,
  appId: string,
  reason: GrantRevokeReason,
  byUserId: string | null,
  now: Date = new Date(),
): Promise<RevokedGrant[]> {
  const rows = await tx
    .update(oauthGrants)
    .set({ revokedAt: now, revokedByUserId: byUserId, revokeReason: reason })
    .where(and(eq(oauthGrants.appId, appId), eq(oauthGrants.organizationId, organizationId), isNull(oauthGrants.revokedAt)))
    .returning({ id: oauthGrants.id, appId: oauthGrants.appId, userId: oauthGrants.userId });
  await killTokens(tx, organizationId, rows.map((r) => r.id), now);
  return rows;
}

/** Revokes the active grants of an app whose scopes are NOT all within `allowedScopes` (the app's ceiling was lowered). */
export async function revokeGrantsExceeding(
  tx: TenantDb,
  organizationId: string,
  appId: string,
  allowedScopes: readonly string[],
  byUserId: string | null,
  now: Date = new Date(),
): Promise<RevokedGrant[]> {
  const rows = await tx
    .update(oauthGrants)
    .set({ revokedAt: now, revokedByUserId: byUserId, revokeReason: "APP_SCOPES_REDUCED" })
    .where(
      and(
        eq(oauthGrants.appId, appId),
        eq(oauthGrants.organizationId, organizationId),
        isNull(oauthGrants.revokedAt),
        sql`NOT (${oauthGrants.scopes} <@ ${sql.param([...allowedScopes])}::text[])`,
      ),
    )
    .returning({ id: oauthGrants.id, appId: oauthGrants.appId, userId: oauthGrants.userId });
  await killTokens(tx, organizationId, rows.map((r) => r.id), now);
  return rows;
}

/**
 * One audit row for a revoked grant. `actor` is whoever caused it (the person, an admin, or - for protocol anomalies
 * and the revocation endpoint - the grant's own API-typed actor). Names ids and the reason; never a token.
 */
export async function auditGrantRevoked(
  tx: TenantDb,
  actor: Actor,
  grant: RevokedGrant,
  reason: GrantRevokeReason,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await AuditService.record(tx, actor, {
    action: "oauth_grant.revoked",
    entityType: "OAuthGrant",
    entityId: grant.id,
    after: { appId: grant.appId, grantedToUserId: grant.userId, reason },
    metadata: { oauthReason: reason, ...extra },
  });
}
