import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { oauthAccessTokens, oauthApps, oauthAuthorizationCodes, oauthClientIndex, oauthGrants, oauthRefreshTokens } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { loadTableSecurityRows, evaluateIsolation } from "@/db/isolation-audit";
import { Pool } from "pg";
import { adminDb, closeTestPools, createTestOrg, pgMessage, resetDatabase } from "../../helpers/db";
import { connect, consent, pkcePair, registerApp, resetOAuthThrottle } from "../../helpers/oauth";
import { lookupClient } from "@/domain/oauth/client-lookup";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { OAuthGrantService } from "@/domain/oauth/grant-service";
import { generateAccessToken, generateClientId } from "@/domain/oauth/credentials";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * Tenant isolation for every OAuth table (docs/security.md section 20): the four tenant tables are invisible and unwritable
 * across organizations, and the two non-tenant lookup indexes (client index, access-token index) can be READ without a tenant
 * context (authentication happens before the organization is known) but never WRITTEN for another organization.
 */
describe("OAuth tenant isolation", () => {
  let a: { owner: Actor; organizationId: string };
  let b: { owner: Actor; organizationId: string };
  let appA: Awaited<ReturnType<typeof registerApp>>;
  let appB: Awaited<ReturnType<typeof registerApp>>;
  let tokensA: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    await resetDatabase();
    resetOAuthThrottle();
    a = await createTestOrg("oauth-iso-a");
    b = await createTestOrg("oauth-iso-b");
    appA = await registerApp(a.owner, { name: "App A" });
    appB = await registerApp(b.owner, { name: "App B" });
    tokensA = await connect(a.owner.userId, appA);
    const { challenge } = pkcePair();
    await consent(a.owner.userId, appA.clientId, challenge); // leaves one unused code in A
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("inside organization B's tenant context, A's apps, grants, codes and refresh tokens are invisible", async () => {
    const seen = await withTenant(b.organizationId, async (tx) => ({
      apps: await tx.select().from(oauthApps),
      grants: await tx.select().from(oauthGrants),
      codes: await tx.select().from(oauthAuthorizationCodes),
      refresh: await tx.select().from(oauthRefreshTokens),
    }));
    expect(seen.apps.map((r) => r.id)).toEqual([appB.appId]);
    expect(seen.grants).toHaveLength(0);
    expect(seen.codes).toHaveLength(0);
    expect(seen.refresh).toHaveLength(0);
    const own = await withTenant(a.organizationId, async (tx) => ({ grants: await tx.select().from(oauthGrants), refresh: await tx.select().from(oauthRefreshTokens), codes: await tx.select().from(oauthAuthorizationCodes) }));
    expect(own.grants).toHaveLength(1);
    expect(own.refresh).toHaveLength(1);
    expect(own.codes).toHaveLength(2);
  });

  it("with NO tenant context the four tenant tables return nothing at all", async () => {
    const { db } = await import("@/db/client");
    for (const table of [oauthApps, oauthGrants, oauthAuthorizationCodes, oauthRefreshTokens]) {
      expect(await db.select().from(table)).toHaveLength(0);
    }
  });

  it("B cannot write rows into A: WITH CHECK refuses an app, grant, code or refresh token naming A", async () => {
    const msg = (run: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>) => pgMessage(withTenant(b.organizationId, run));
    expect(
      await msg((tx) =>
        tx.insert(oauthApps).values({ organizationId: a.organizationId, clientId: generateClientId(), name: "x", clientType: "PUBLIC", redirectUris: ["https://x.test/cb"], scopes: ["contacts:read"], createdByUserId: b.owner.userId }),
      ),
    ).toMatch(/row-level security/);
    const [grantA] = await adminDb().select().from(oauthGrants);
    expect(
      await msg((tx) => tx.insert(oauthRefreshTokens).values({ organizationId: a.organizationId, grantId: grantA!.id, tokenHash: "h".repeat(64), expiresAt: new Date(Date.now() + 1000) })),
    ).toMatch(/row-level security/);
    expect(
      await msg((tx) => tx.insert(oauthGrants).values({ organizationId: a.organizationId, appId: appA.appId, userId: b.owner.userId, scopes: ["contacts:read"] })),
    ).toMatch(/row-level security/);
  });

  it("B cannot UPDATE or DELETE A's rows (zero rows affected)", async () => {
    const result = await withTenant(b.organizationId, async (tx) => {
      const upd = await tx.update(oauthGrants).set({ revokedAt: new Date() }).returning({ id: oauthGrants.id });
      const del = await tx.delete(oauthAuthorizationCodes).returning({ id: oauthAuthorizationCodes.id });
      return { upd, del };
    });
    expect(result.upd).toHaveLength(0);
    expect(result.del).toHaveLength(0);
    expect(await adminDb().select().from(oauthGrants)).toHaveLength(1);
  });

  it("the access-token index can be READ without a tenant context (that is what authentication does) but is not secret-bearing", async () => {
    const { db } = await import("@/db/client");
    const rows = await db.select().from(oauthAccessTokens);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(tokensA.access);
    expect(rows[0]?.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a tenant transaction for B cannot MINT, REVOKE or PURGE another organization's access token or client row", async () => {
    const [grantA] = await adminDb().select().from(oauthGrants);
    const forged = generateAccessToken();
    // Naming organization A from B's context is refused by the INSERT policy (the composite FK alone would have passed).
    const mint = await pgMessage(
      withTenant(b.organizationId, (tx) =>
        tx.insert(oauthAccessTokens).values({
          organizationId: a.organizationId,
          grantId: grantA!.id,
          appId: appA.appId,
          clientId: appA.clientId,
          userId: a.owner.userId,
          prefix: forged.prefix,
          secretHash: forged.hash,
          scopes: ["invoices:read"],
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      ),
    );
    expect(mint).toMatch(/row-level security/);
    // Naming B with A's grant id fails the composite foreign key.
    const fk = await pgMessage(
      withTenant(b.organizationId, (tx) =>
        tx.insert(oauthAccessTokens).values({
          organizationId: b.organizationId,
          grantId: grantA!.id,
          appId: appB.appId,
          clientId: appB.clientId,
          userId: b.owner.userId,
          prefix: forged.prefix,
          secretHash: forged.hash,
          scopes: ["invoices:read"],
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      ),
    );
    expect(fk).toMatch(/foreign key/);
    const forgedClient = await pgMessage(
      withTenant(b.organizationId, (tx) => tx.insert(oauthClientIndex).values({ id: appA.appId, organizationId: a.organizationId, clientId: generateClientId(), clientType: "PUBLIC" })),
    );
    expect(forgedClient).toMatch(/row-level security|duplicate key/);

    const touched = await withTenant(b.organizationId, async (tx) => {
      const revoked = await tx.update(oauthAccessTokens).set({ revokedAt: new Date() }).returning({ id: oauthAccessTokens.id });
      const purged = await tx.delete(oauthAccessTokens).returning({ id: oauthAccessTokens.id });
      return { revoked, purged };
    });
    expect(touched.revoked).toHaveLength(0);
    expect(touched.purged).toHaveLength(0);
    expect(await adminDb().select().from(oauthAccessTokens)).toHaveLength(1);
  });

  it("the grants mm_app holds are exactly the narrow ones: no UPDATE of hashes, no DELETE where there should be none", async () => {
    const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
    try {
      const priv = async (table: string, p: string) => (await admin.query("select has_table_privilege('mm_app', $1, $2) as ok", [table, p])).rows[0].ok as boolean;
      const col = async (table: string, column: string) => (await admin.query("select has_column_privilege('mm_app', $1, $2, 'UPDATE') as ok", [table, column])).rows[0].ok as boolean;
      // Immutable client index.
      expect(await priv("oauth_client_index", "SELECT")).toBe(true);
      expect(await priv("oauth_client_index", "INSERT")).toBe(true);
      expect(await priv("oauth_client_index", "UPDATE")).toBe(false);
      expect(await priv("oauth_client_index", "DELETE")).toBe(false);
      // Access-token index: only revoked_at is updatable, never the hash / prefix / organization / grant / scopes.
      expect(await col("oauth_access_tokens", "revoked_at")).toBe(true);
      for (const c of ["secret_hash", "prefix", "organization_id", "grant_id", "user_id", "scopes", "expires_at", "client_id"]) {
        expect(await col("oauth_access_tokens", c), c).toBe(false);
      }
      // Apps: hash can be re-keyed (rotation) but identity columns cannot.
      expect(await col("oauth_apps", "secret_hash")).toBe(true);
      for (const c of ["organization_id", "client_id", "client_type", "created_by_user_id"]) expect(await col("oauth_apps", c), c).toBe(false);
      expect(await priv("oauth_apps", "DELETE")).toBe(false);
      // Grants: never deleted; only revocation + refresh stamp columns change.
      expect(await priv("oauth_grants", "DELETE")).toBe(false);
      for (const c of ["scopes", "user_id", "app_id", "organization_id"]) expect(await col("oauth_grants", c), c).toBe(false);
      // Codes and refresh tokens: only used_at / grant_id may change; the hashes never.
      expect(await col("oauth_authorization_codes", "code_hash")).toBe(false);
      expect(await col("oauth_authorization_codes", "code_challenge")).toBe(false);
      expect(await col("oauth_authorization_codes", "used_at")).toBe(true);
      expect(await col("oauth_refresh_tokens", "token_hash")).toBe(false);
      expect(await col("oauth_refresh_tokens", "used_at")).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it("the build-time isolation audit is clean with every OAuth table in place", async () => {
    const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL });
    try {
      const rows = await loadTableSecurityRows(admin);
      const oauth = rows.filter((r) => r.table_name.startsWith("oauth_"));
      expect(oauth.map((r) => r.table_name).sort()).toEqual([
        "oauth_access_tokens",
        "oauth_apps",
        "oauth_authorization_codes",
        "oauth_client_index",
        "oauth_grants",
        "oauth_rate_windows",
        "oauth_refresh_tokens",
      ]);
      expect(evaluateIsolation(rows).problems).toEqual([]);
      // The four tenant tables are tenant-scoped with FORCEd RLS; the two lookup indexes carry organization_id but are exempt.
      for (const t of ["oauth_apps", "oauth_grants", "oauth_authorization_codes", "oauth_refresh_tokens"]) {
        const row = oauth.find((r) => r.table_name === t)!;
        expect(row.tenant_scoped && row.rls_enabled && row.rls_forced, t).toBe(true);
      }
    } finally {
      await admin.end();
    }
  });

  it("client lookup resolves a client id to its own organization only", async () => {
    expect((await lookupClient(appA.clientId))?.organizationId).toBe(a.organizationId);
    expect((await lookupClient(appB.clientId))?.organizationId).toBe(b.organizationId);
    expect(await lookupClient("mmo_c_" + "x".repeat(22))).toBeNull();
    expect(await lookupClient("not-a-client")).toBeNull();
  });

  it("B's owner cannot see, edit, rotate, disable, delete or revoke anything of A's through the services", async () => {
    expect((await OAuthAppService.list(b.owner)).map((x) => x.id)).toEqual([appB.appId]);
    await expect(OAuthAppService.update(b.owner, appA.appId, { name: "hijack", redirectUris: ["https://x.test/cb"], scopes: ["contacts:read"] })).rejects.toThrow(/not found/i);
    await expect(OAuthAppService.rotateSecret(b.owner, appA.appId)).rejects.toThrow(/not found/i);
    await expect(OAuthAppService.setDisabled(b.owner, appA.appId, true)).rejects.toThrow(/not found/i);
    await expect(OAuthAppService.delete(b.owner, appA.appId)).rejects.toThrow(/not found/i);
    const [grantA] = await adminDb().select().from(oauthGrants);
    await expect(OAuthGrantService.revoke(b.owner, grantA!.id)).rejects.toThrow(/not found/i);
    expect(await OAuthGrantService.listForOrganization(b.owner)).toHaveLength(0);
    expect((await adminDb().select().from(oauthGrants))[0]?.revokedAt).toBeNull();
  });
});
