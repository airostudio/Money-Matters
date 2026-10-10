import { and, desc, eq, isNull } from "drizzle-orm";
import { oauthApps, oauthGrants, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission } from "@/domain/permissions/roles";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { OAuthGrantNotFoundError } from "./errors";
import { auditGrantRevoked, revokeGrant } from "./grant-store";

/**
 * The human side of grants.
 *  - ANY member lists and revokes THEIR OWN authorisations in an organization (withdrawing your own consent is not a
 *    privilege and needs no permission - but it does need a HUMAN: a token cannot revoke or list grants).
 *  - An Owner / Administrator (`oauth_app:manage`) can list every active grant of an app and revoke any grant in their
 *    organization.
 * Someone else's grant is reported as NOT FOUND to a member without the permission, never as forbidden, so ids do not leak.
 * Revocation is immediate (src/domain/oauth/grant-store.ts) and audited in the same transaction.
 */
export interface GrantSummary {
  id: string;
  appId: string;
  appName: string;
  appHomepageUrl: string | null;
  clientId: string;
  scopes: string[];
  createdAt: Date;
  lastRefreshedAt: Date | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
}

function assertHuman(actor: Actor): void {
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("oauth_app:manage", actor.role);
}

const grantColumns = {
  id: oauthGrants.id,
  appId: oauthGrants.appId,
  appName: oauthApps.name,
  appHomepageUrl: oauthApps.homepageUrl,
  clientId: oauthApps.clientId,
  scopes: oauthGrants.scopes,
  createdAt: oauthGrants.createdAt,
  lastRefreshedAt: oauthGrants.lastRefreshedAt,
  userId: oauthGrants.userId,
  userName: users.name,
  userEmail: users.email,
};

export const OAuthGrantService = {
  /** The apps the acting person has authorised in this organization (active grants only). */
  async listOwn(actor: Actor): Promise<GrantSummary[]> {
    assertHuman(actor);
    return withTenant(actor.organizationId, async (tx) =>
      tx
        .select(grantColumns)
        .from(oauthGrants)
        .innerJoin(oauthApps, eq(oauthApps.id, oauthGrants.appId))
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(and(eq(oauthGrants.organizationId, actor.organizationId), eq(oauthGrants.userId, actor.userId), isNull(oauthGrants.revokedAt)))
        .orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id)),
    );
  },

  /**
   * The person's own authorisations in EVERY company they belong to (the "Authorised apps" page). Companies are read ONE AT A
   * TIME, each through the person's real membership; archived companies are skipped (`listMembershipsForUser` excludes them,
   * and nothing can act in them). Capped so a pathological membership list cannot make the page long.
   */
  async listOwnAcrossOrganizations(userId: string, maxOrganizations = 25) {
    const memberships = (await OrganizationService.listMembershipsForUser(userId)).slice(0, maxOrganizations);
    const sections: Array<{ organizationId: string; organizationName: string; grants: GrantSummary[] }> = [];
    for (const m of memberships) {
      const grants = await OAuthGrantService.listOwn({ userId, organizationId: m.organization.id, role: m.role });
      if (grants.length > 0) sections.push({ organizationId: m.organization.id, organizationName: m.organization.name, grants });
    }
    return sections;
  },

  /** Every active grant in the organization (optionally one app's) - Owner / Administrator only. */
  async listForOrganization(actor: Actor, appId?: string): Promise<GrantSummary[]> {
    assertHuman(actor);
    assertPermission(actor, "oauth_app:manage");
    return withTenant(actor.organizationId, async (tx) =>
      tx
        .select(grantColumns)
        .from(oauthGrants)
        .innerJoin(oauthApps, eq(oauthApps.id, oauthGrants.appId))
        .innerJoin(users, eq(users.id, oauthGrants.userId))
        .where(
          and(
            eq(oauthGrants.organizationId, actor.organizationId),
            isNull(oauthGrants.revokedAt),
            appId ? eq(oauthGrants.appId, appId) : undefined,
          ),
        )
        .orderBy(desc(oauthGrants.createdAt), desc(oauthGrants.id)),
    );
  },

  /** Revokes a grant: your own, or (with `oauth_app:manage`) anyone's in this organization. Idempotent. */
  async revoke(actor: Actor, grantId: string) {
    assertHuman(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [grant] = await tx
        .select({ id: oauthGrants.id, userId: oauthGrants.userId, revokedAt: oauthGrants.revokedAt })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.organizationId, actor.organizationId)))
        .for("update");
      const own = grant?.userId === actor.userId;
      const admin = roleHasPermission(actor.role, "oauth_app:manage");
      if (!grant || (!own && !admin)) throw new OAuthGrantNotFoundError();
      if (grant.revokedAt) return { id: grantId, alreadyRevoked: true };
      const reason = own ? "USER" : "ADMIN";
      const revoked = await revokeGrant(tx, actor.organizationId, grantId, reason, actor.userId);
      if (revoked) await auditGrantRevoked(tx, actor, revoked, reason);
      return { id: grantId, alreadyRevoked: !revoked };
    });
  },
};
