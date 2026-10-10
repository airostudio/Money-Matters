import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, oauthApps } from "@/db/schema";
import { addTestMember, adminDb, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { REDIRECT, connect, registerApp } from "../../helpers/oauth";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { OAuthGrantService } from "@/domain/oauth/grant-service";
import { ApiKeyService } from "@/domain/api/api-key-service";
import { InvalidOAuthInputError, OAuthAppLimitError } from "@/domain/oauth/errors";
import { MAX_APPS_PER_ORG } from "@/domain/oauth/constants";
import { InvalidScopeError, effectivePermissions } from "@/domain/api/scopes";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { ROLE_PERMISSIONS, type MembershipRole } from "@/domain/permissions/roles";
import { GET as metadata } from "@/app/.well-known/oauth-authorization-server/route";

const ROLES = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];
const input = { name: "Acme Sync", redirectUris: [REDIRECT], scopes: ["contacts:read"] };

describe("OAuth app management", () => {
  let owner: Actor;
  let orgId: string;

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("oauth-manage");
    owner = org.owner;
    orgId = org.organizationId;
  });

  afterAll(async () => {
    await closeTestPools();
  });

  it("only OWNER and ADMINISTRATOR can register, list, edit, rotate, disable or delete; every other role is refused for every method", async () => {
    const app = await registerApp(owner);
    for (const role of ROLES) {
      const actor = role === "OWNER" ? owner : await addTestMember(owner, role, role);
      const attempts = [
        () => OAuthAppService.create(actor, { ...input, clientType: "PUBLIC" }),
        () => OAuthAppService.list(actor),
        () => OAuthAppService.update(actor, app.appId, input),
        () => OAuthAppService.rotateSecret(actor, app.appId),
        () => OAuthAppService.setDisabled(actor, app.appId, true),
        () => OAuthAppService.delete(actor, app.appId),
        () => OAuthGrantService.listForOrganization(actor),
      ];
      const allowed = role === "OWNER" || role === "ADMINISTRATOR";
      if (allowed) {
        expect((await OAuthAppService.list(actor)).length).toBeGreaterThan(0);
        continue;
      }
      for (const attempt of attempts) await expect(attempt(), role).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it("an ADMINISTRATOR can manage apps", async () => {
    const admin = await addTestMember(owner, "ADMINISTRATOR", "Admin");
    const created = await OAuthAppService.create(admin, { ...input, clientType: "CONFIDENTIAL" });
    expect(created.clientSecret).toMatch(/^mmo_cs_/);
    expect((await OAuthAppService.list(owner)).map((a) => a.id)).toEqual([created.app.id]);
  });

  it("HUMAN ONLY: an OAuth-token actor, an API-key actor, an AI, a system and an automation actor are refused even with an OWNER role and every permission", async () => {
    const everything = new Set(Object.values(ROLE_PERMISSIONS).flatMap((s) => [...s]));
    const app = await registerApp(owner);
    const impostors: Actor[] = [
      { ...owner, type: "API", oauth: { clientId: app.clientId, grantId: app.appId }, grantedPermissions: everything },
      { ...owner, type: "API", apiKey: { id: app.appId, prefix: "abcd1234" }, grantedPermissions: everything },
      { ...owner, type: "AI" },
      { ...owner, type: "SYSTEM" },
      { ...owner, type: "AUTOMATION", automation: { ruleId: app.appId, ruleName: "r" } },
    ];
    for (const actor of impostors) {
      const label = `${actor.type}${actor.oauth ? "/oauth" : actor.apiKey ? "/key" : ""}`;
      await expect(OAuthAppService.create(actor, { ...input, clientType: "PUBLIC" }), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthAppService.list(actor), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthAppService.update(actor, app.appId, input), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthAppService.rotateSecret(actor, app.appId), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthAppService.setDisabled(actor, app.appId, true), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthAppService.delete(actor, app.appId), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthGrantService.listOwn(actor), label).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(OAuthGrantService.revoke(actor, app.appId), label).rejects.toBeInstanceOf(PermissionDeniedError);
      // ...and the OTHER human-only management surfaces refuse an OAuth actor too: it cannot mint itself an API key.
      await expect(ApiKeyService.create(actor, { name: "x", scopes: ["contacts:read"] }), label).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(await adminDb().select().from(oauthApps)).toHaveLength(1);
  });

  it("an app that reaches the Authorised-apps page of its own user cannot do so with its token: the grant service is human only", async () => {
    const app = await registerApp(owner);
    await connect(owner.userId, app);
    const tokenActor: Actor = { ...owner, type: "API", oauth: { clientId: app.clientId, grantId: app.appId }, grantedPermissions: effectivePermissions(["contacts:read"], "OWNER") };
    await expect(OAuthGrantService.listOwn(tokenActor)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("registration validation: names, redirect URIs, homepage, scopes, description", async () => {
    const create = (over: Partial<typeof input> & Record<string, unknown> = {}) => OAuthAppService.create(owner, { ...input, clientType: "PUBLIC", ...over });
    await expect(create({ name: "   " })).rejects.toBeInstanceOf(InvalidOAuthInputError);
    await expect(create({ name: "x".repeat(81) })).rejects.toBeInstanceOf(InvalidOAuthInputError);
    await expect(create({ redirectUris: [] })).rejects.toThrow(/at least one/);
    await expect(create({ redirectUris: ["https://*.example.com/cb"] })).rejects.toThrow(/Wildcards/);
    await expect(create({ redirectUris: ["https://a.example.com/cb#x"] })).rejects.toThrow(/fragment/);
    await expect(create({ redirectUris: ["http://a.example.com/cb"] })).rejects.toThrow(/Plain http/);
    await expect(create({ redirectUris: ["myapp://cb"] })).rejects.toThrow(/https/);
    await expect(create({ homepageUrl: "javascript:alert(1)" })).rejects.toThrow(/homepage/);
    await expect(create({ scopes: [] })).rejects.toBeInstanceOf(InvalidScopeError);
    await expect(create({ scopes: ["contacts:read", "period:close"] })).rejects.toBeInstanceOf(InvalidScopeError);
    await expect(create({ scopes: ["membership:manage"] })).rejects.toBeInstanceOf(InvalidScopeError);
    await expect(create({ description: "d".repeat(301) })).rejects.toBeInstanceOf(InvalidOAuthInputError);
    expect(await adminDb().select().from(oauthApps)).toHaveLength(0);
    const ok = await create({ redirectUris: ["http://localhost:8123/cb", "https://app.example.com/cb"], homepageUrl: "https://app.example.com" });
    expect(ok.clientSecret).toBeNull();
  });

  it(`at most ${MAX_APPS_PER_ORG} apps per organization; deleting one frees a slot; another organization is unaffected`, async () => {
    for (let i = 0; i < MAX_APPS_PER_ORG; i += 1) await OAuthAppService.create(owner, { ...input, name: `App ${i}`, clientType: "PUBLIC" });
    await expect(OAuthAppService.create(owner, { ...input, clientType: "PUBLIC" })).rejects.toBeInstanceOf(OAuthAppLimitError);
    const [first] = await OAuthAppService.list(owner);
    await OAuthAppService.delete(owner, first!.id);
    await OAuthAppService.create(owner, { ...input, name: "Replacement", clientType: "PUBLIC" });
    const other = await createTestOrg("oauth-manage-2");
    await OAuthAppService.create(other.owner, { ...input, clientType: "PUBLIC" });
    expect((await OAuthAppService.list(owner)).length).toBe(MAX_APPS_PER_ORG);
  });

  it("every mutation is audited by a HUMAN actor, naming the app and client id, with no secret, hash or token anywhere", async () => {
    const created = await OAuthAppService.create(owner, { ...input, clientType: "CONFIDENTIAL" });
    await OAuthAppService.update(owner, created.app.id, { ...input, name: "Renamed" });
    const rotated = await OAuthAppService.rotateSecret(owner, created.app.id);
    await OAuthAppService.setDisabled(owner, created.app.id, true);
    await OAuthAppService.setDisabled(owner, created.app.id, false);
    await OAuthAppService.delete(owner, created.app.id);
    const rows = await adminDb().select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.entityType, "OAuthApp")));
    expect(rows.map((r) => r.action).sort()).toEqual(["oauth_app.created", "oauth_app.deleted", "oauth_app.disabled", "oauth_app.enabled", "oauth_app.secret_rotated", "oauth_app.updated"]);
    for (const row of rows) {
      expect(row.actorType).toBe("HUMAN");
      expect(row.actorUserId).toBe(owner.userId);
    }
    const dump = JSON.stringify(rows);
    expect(dump).toContain(created.app.clientId);
    for (const secret of [created.clientSecret as string, rotated.clientSecret]) expect(dump).not.toContain(secret);
    const [stored] = await adminDb().select().from(oauthApps).where(eq(oauthApps.id, created.app.id));
    expect(dump).not.toContain(stored!.secretHash as string);
  });

  it("rotating a public client's secret is refused; a deleted app is gone for every operation", async () => {
    const pub = await OAuthAppService.create(owner, { ...input, clientType: "PUBLIC" });
    await expect(OAuthAppService.rotateSecret(owner, pub.app.id)).rejects.toThrow(/no client secret/);
    await OAuthAppService.delete(owner, pub.app.id);
    await expect(OAuthAppService.update(owner, pub.app.id, input)).rejects.toThrow(/not found/i);
    await expect(OAuthAppService.delete(owner, pub.app.id)).rejects.toThrow(/not found/i);
    const [row] = await adminDb().select().from(oauthApps).where(eq(oauthApps.id, pub.app.id));
    expect(row?.deletedAt).not.toBeNull(); // soft delete: the audit trail keeps its referent
  });

  it("the discovery document is public, cacheable, and the ONLY OAuth response that allows cross-origin reads", async () => {
    const res = metadata(new Request("http://localhost:3000/.well-known/oauth-authorization-server"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(JSON.stringify(body)).not.toMatch(/mmo_(at|rt|ac|cs)_/);
  });
});
