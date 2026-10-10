import { and, asc, count, eq, isNull } from "drizzle-orm";
import { oauthApps, oauthClientIndex, oauthGrants, users } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { normaliseScopes, type ApiScope } from "@/domain/api/scopes";
import {
  MAX_APPS_PER_ORG,
  MAX_APP_DESCRIPTION_LENGTH,
  MAX_APP_NAME_LENGTH,
  MAX_REDIRECT_URIS_PER_APP,
} from "./constants";
import { generateClientId, generateClientSecret } from "./credentials";
import { InvalidOAuthInputError, OAuthAppLimitError, OAuthAppNotFoundError } from "./errors";
import { revokeGrantsExceeding, revokeGrantsOfApp, auditGrantRevoked } from "./grant-store";
import { InvalidRedirectUriError, validateHomepageUrl, validateRegisteredRedirectUris } from "./redirect-uri";

/**
 * Management of OAuth applications - the human side of OAuth. Gated on `oauth_app:manage` (OWNER / ADMINISTRATOR only)
 * AND on the actor being a HUMAN: an API key, an OAuth access token, an AI or an automation actor is refused
 * structurally, so a third-party app can never register another app, widen its own scopes or mint itself a secret.
 *
 * An app BELONGS TO the organisation that registered it and can only ever be authorised into that organisation
 * (docs/security.md section 20). A confidential client's secret is returned by `create` and `rotateSecret` exactly once;
 * only its SHA-256 hash is stored, and neither it nor the hash is ever returned by `list`, audited or logged. Every
 * mutation is audited in its own transaction. Disabling or deleting an app revokes every grant in the same transaction.
 */
export type OAuthAppStatus = "ACTIVE" | "DISABLED";

export interface OAuthAppSummary {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  homepageUrl: string | null;
  clientType: "PUBLIC" | "CONFIDENTIAL";
  redirectUris: string[];
  scopes: string[];
  secretPrefix: string | null;
  secretRotatedAt: Date | null;
  createdAt: Date;
  createdByName: string | null;
  disabledAt: Date | null;
  status: OAuthAppStatus;
  activeGrantCount: number;
}

export interface OAuthAppInput {
  name: string;
  description?: string | null;
  homepageUrl?: string | null;
  redirectUris: readonly string[];
  scopes: readonly string[];
}

export interface CreateOAuthAppInput extends OAuthAppInput {
  clientType: "PUBLIC" | "CONFIDENTIAL";
}

function assertHumanManager(actor: Actor): void {
  assertPermission(actor, "oauth_app:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("oauth_app:manage", actor.role);
}

function validate(input: OAuthAppInput): {
  name: string;
  description: string | null;
  homepageUrl: string | null;
  redirectUris: string[];
  scopes: ApiScope[];
} {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_APP_NAME_LENGTH) {
    throw new InvalidOAuthInputError(`Give the app a name of 1 to ${MAX_APP_NAME_LENGTH} characters.`);
  }
  const description = (input.description ?? "").trim();
  if (description.length > MAX_APP_DESCRIPTION_LENGTH) {
    throw new InvalidOAuthInputError(`The description may be at most ${MAX_APP_DESCRIPTION_LENGTH} characters.`);
  }
  try {
    return {
      name,
      description: description === "" ? null : description,
      homepageUrl: validateHomepageUrl(input.homepageUrl),
      redirectUris: validateRegisteredRedirectUris(input.redirectUris, MAX_REDIRECT_URIS_PER_APP),
      scopes: normaliseScopes(input.scopes),
    };
  } catch (error) {
    if (error instanceof InvalidRedirectUriError) throw new InvalidOAuthInputError(error.message);
    throw error;
  }
}

async function loadApp(tx: TenantDb, organizationId: string, appId: string) {
  const [app] = await tx
    .select()
    .from(oauthApps)
    .where(and(eq(oauthApps.id, appId), eq(oauthApps.organizationId, organizationId), isNull(oauthApps.deletedAt)))
    .for("update");
  if (!app) throw new OAuthAppNotFoundError();
  return app;
}

/** What an audit row may say about an app: never the secret, its hash, or its prefix beyond the display tag. */
function auditShape(app: { name: string; clientId: string; clientType: string; redirectUris: string[]; scopes: string[]; homepageUrl: string | null }) {
  return { name: app.name, clientId: app.clientId, clientType: app.clientType, redirectUris: app.redirectUris, scopes: app.scopes, homepageUrl: app.homepageUrl };
}

export const OAuthAppService = {
  async create(actor: Actor, input: CreateOAuthAppInput) {
    assertHumanManager(actor);
    const valid = validate(input);
    const confidential = input.clientType === "CONFIDENTIAL";
    const secret = confidential ? generateClientSecret() : null;
    const clientId = generateClientId();

    const app = await withTenant(actor.organizationId, async (tx) => {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(oauthApps)
        .where(and(eq(oauthApps.organizationId, actor.organizationId), isNull(oauthApps.deletedAt)));
      if (Number(n) >= MAX_APPS_PER_ORG) throw new OAuthAppLimitError(MAX_APPS_PER_ORG);

      const [row] = await tx
        .insert(oauthApps)
        .values({
          organizationId: actor.organizationId,
          clientId,
          name: valid.name,
          description: valid.description,
          homepageUrl: valid.homepageUrl,
          clientType: input.clientType,
          redirectUris: valid.redirectUris,
          scopes: valid.scopes,
          secretPrefix: secret?.tag ?? null,
          secretHash: secret?.hash ?? null,
          secretRotatedAt: secret ? new Date() : null,
          createdByUserId: actor.userId,
        })
        .returning();
      if (!row) throw new Error("Failed to create the app.");
      await tx.insert(oauthClientIndex).values({
        id: row.id,
        organizationId: actor.organizationId,
        clientId,
        clientType: input.clientType,
      });
      await AuditService.record(tx, actor, {
        action: "oauth_app.created",
        entityType: "OAuthApp",
        entityId: row.id,
        after: auditShape(row),
      });
      return row;
    });
    return {
      app: { id: app.id, clientId: app.clientId, name: app.name, clientType: app.clientType, scopes: app.scopes, redirectUris: app.redirectUris },
      /** The ONLY time the client secret exists outside the caller's own copy (null for a public client). */
      clientSecret: secret?.secret ?? null,
    };
  },

  async list(actor: Actor): Promise<OAuthAppSummary[]> {
    assertHumanManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({
          id: oauthApps.id,
          clientId: oauthApps.clientId,
          name: oauthApps.name,
          description: oauthApps.description,
          homepageUrl: oauthApps.homepageUrl,
          clientType: oauthApps.clientType,
          redirectUris: oauthApps.redirectUris,
          scopes: oauthApps.scopes,
          secretPrefix: oauthApps.secretPrefix,
          secretRotatedAt: oauthApps.secretRotatedAt,
          createdAt: oauthApps.createdAt,
          createdByName: users.name,
          disabledAt: oauthApps.disabledAt,
        })
        .from(oauthApps)
        .leftJoin(users, eq(users.id, oauthApps.createdByUserId))
        .where(and(eq(oauthApps.organizationId, actor.organizationId), isNull(oauthApps.deletedAt)))
        .orderBy(asc(oauthApps.createdAt), asc(oauthApps.id));
      const counts = await tx
        .select({ appId: oauthGrants.appId, n: count() })
        .from(oauthGrants)
        .where(and(eq(oauthGrants.organizationId, actor.organizationId), isNull(oauthGrants.revokedAt)))
        .groupBy(oauthGrants.appId);
      const byApp = new Map(counts.map((c) => [c.appId, Number(c.n)]));
      return rows.map((r) => ({
        ...r,
        createdByName: r.createdByName ?? null,
        status: r.disabledAt ? ("DISABLED" as const) : ("ACTIVE" as const),
        activeGrantCount: byApp.get(r.id) ?? 0,
      }));
    });
  },

  /** Edits name / description / homepage / redirect URIs / allowed scopes. Lowering the scope ceiling revokes grants that exceed it. */
  async update(actor: Actor, appId: string, input: OAuthAppInput) {
    assertHumanManager(actor);
    const valid = validate(input);
    return withTenant(actor.organizationId, async (tx) => {
      const before = await loadApp(tx, actor.organizationId, appId);
      await tx
        .update(oauthApps)
        .set({
          name: valid.name,
          description: valid.description,
          homepageUrl: valid.homepageUrl,
          redirectUris: valid.redirectUris,
          scopes: valid.scopes,
          updatedAt: new Date(),
        })
        .where(and(eq(oauthApps.id, appId), eq(oauthApps.organizationId, actor.organizationId)));
      await AuditService.record(tx, actor, {
        action: "oauth_app.updated",
        entityType: "OAuthApp",
        entityId: appId,
        before: auditShape(before),
        after: auditShape({ ...before, ...valid }),
      });
      const revoked = await revokeGrantsExceeding(tx, actor.organizationId, appId, valid.scopes, actor.userId);
      for (const grant of revoked) await auditGrantRevoked(tx, actor, grant, "APP_SCOPES_REDUCED");
      return { id: appId, revokedGrants: revoked.length };
    });
  },

  /** Issues a new client secret (confidential apps only). The old one stops working at once; existing grants are unaffected. */
  async rotateSecret(actor: Actor, appId: string) {
    assertHumanManager(actor);
    const secret = generateClientSecret();
    await withTenant(actor.organizationId, async (tx) => {
      const app = await loadApp(tx, actor.organizationId, appId);
      if (app.clientType !== "CONFIDENTIAL") throw new InvalidOAuthInputError("A public app has no client secret to rotate.");
      await tx
        .update(oauthApps)
        .set({ secretPrefix: secret.tag, secretHash: secret.hash, secretRotatedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(oauthApps.id, appId), eq(oauthApps.organizationId, actor.organizationId)));
      await AuditService.record(tx, actor, {
        action: "oauth_app.secret_rotated",
        entityType: "OAuthApp",
        entityId: appId,
        before: { name: app.name, clientId: app.clientId, secretPrefix: app.secretPrefix },
        after: { secretPrefix: secret.tag },
      });
    });
    return { clientSecret: secret.secret, secretPrefix: secret.tag };
  },

  /** Disabling revokes every grant of the app immediately; enabling does NOT bring them back (people must consent again). */
  async setDisabled(actor: Actor, appId: string, disabled: boolean) {
    assertHumanManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const app = await loadApp(tx, actor.organizationId, appId);
      if (Boolean(app.disabledAt) === disabled) return { id: appId, revokedGrants: 0 };
      const now = new Date();
      await tx
        .update(oauthApps)
        .set({ disabledAt: disabled ? now : null, disabledByUserId: disabled ? actor.userId : null, updatedAt: now })
        .where(and(eq(oauthApps.id, appId), eq(oauthApps.organizationId, actor.organizationId)));
      let revoked = 0;
      if (disabled) {
        const grants = await revokeGrantsOfApp(tx, actor.organizationId, appId, "APP_DISABLED", actor.userId, now);
        for (const grant of grants) await auditGrantRevoked(tx, actor, grant, "APP_DISABLED");
        revoked = grants.length;
      }
      await AuditService.record(tx, actor, {
        action: disabled ? "oauth_app.disabled" : "oauth_app.enabled",
        entityType: "OAuthApp",
        entityId: appId,
        before: { name: app.name, clientId: app.clientId, status: disabled ? "ACTIVE" : "DISABLED" },
        after: { status: disabled ? "DISABLED" : "ACTIVE", revokedGrants: revoked },
      });
      return { id: appId, revokedGrants: revoked };
    });
  },

  /** Soft-deletes the app (it stops resolving everywhere) and revokes every grant. The audit trail keeps its referent. */
  async delete(actor: Actor, appId: string) {
    assertHumanManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const app = await loadApp(tx, actor.organizationId, appId);
      const now = new Date();
      await tx
        .update(oauthApps)
        .set({ deletedAt: now, deletedByUserId: actor.userId, disabledAt: app.disabledAt ?? now, updatedAt: now })
        .where(and(eq(oauthApps.id, appId), eq(oauthApps.organizationId, actor.organizationId)));
      const grants = await revokeGrantsOfApp(tx, actor.organizationId, appId, "APP_DELETED", actor.userId, now);
      for (const grant of grants) await auditGrantRevoked(tx, actor, grant, "APP_DELETED");
      await AuditService.record(tx, actor, {
        action: "oauth_app.deleted",
        entityType: "OAuthApp",
        entityId: appId,
        before: auditShape(app),
        after: { revokedGrants: grants.length },
      });
      return { id: appId, revokedGrants: grants.length };
    });
  },
};

