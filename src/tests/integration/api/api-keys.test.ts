import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { call, get, makeKey, resetApiThrottle } from "../../helpers/api";
import { ApiKeyService, InvalidApiKeyInputError } from "@/domain/api/api-key-service";
import { InvalidScopeError } from "@/domain/api/scopes";
import { PermissionDeniedError, type Actor } from "@/domain/permissions/permission-service";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { withTenant } from "@/db/tenant";
import { apiKeyIndex, apiKeys, auditLogs } from "@/db/schema";
import { db } from "@/db/client";
import { users } from "@/db/schema";

describe("API keys: creation, secrecy, authentication and immediate revocation", () => {
  let owner: Actor;
  let orgId: string;
  const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    const org = await createTestOrg("api-keys");
    owner = org.owner;
    orgId = org.organizationId;
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPools();
  });

  it("returns the secret exactly once; list/get never reveal it or its hash; only the hash is stored (non-tenant index)", async () => {
    const key = await makeKey(owner, ["contacts:read"]);
    expect(key.secret).toMatch(/^mm_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);

    const listed = await ApiKeyService.list(owner);
    expect(listed).toHaveLength(1);
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain(key.secret);
    expect(serialised).not.toMatch(/hash/i);
    expect(listed[0]).toMatchObject({ prefix: key.prefix, status: "ACTIVE", scopes: ["contacts:read"], createdByUserId: owner.userId });

    // The tenant row has no secret column at all; the index holds the SHA-256 only.
    const tenantRow = await withTenant(orgId, (tx) => tx.select().from(apiKeys));
    expect(JSON.stringify(tenantRow)).not.toContain(key.secret);
    const [indexRow] = await db.select().from(apiKeyIndex).where(eq(apiKeyIndex.id, key.id));
    expect(indexRow?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(indexRow)).not.toContain(key.secret);
  });

  it("writes no secret and no hash to the audit log (only id, prefix, scopes), for create, use-adjacent writes and revoke", async () => {
    const key = await makeKey(owner, ["contacts:read", "contacts:write"]);
    await ApiKeyService.revoke(owner, key.id);
    const [indexRow] = await db.select().from(apiKeyIndex).where(eq(apiKeyIndex.id, key.id));
    const rows = await withTenant(orgId, (tx) => tx.select().from(auditLogs));
    const text = JSON.stringify(rows);
    expect(text).not.toContain(key.secret);
    expect(text).not.toContain(key.secret.split("_").pop() as string);
    expect(text).not.toContain(indexRow?.secretHash as string);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("api_key.created");
    expect(actions).toContain("api_key.revoked");
    const created = rows.find((r) => r.action === "api_key.created");
    expect(created?.entityId).toBe(key.id);
    expect(created?.actorType).toBe("HUMAN");
    expect(JSON.stringify(created?.after)).toContain(key.prefix);
  });

  it("authenticates a valid key and reports its organization, scopes and effective permissions on /me", async () => {
    const key = await makeKey(owner, ["invoices:write", "contacts:read"]);
    const res = await get("/me", key.secret);
    expect(res.status).toBe(200);
    expect(res.body.data.organization_id).toBe(orgId);
    expect(res.body.data.scopes).toEqual(["contacts:read", "invoices:write"]);
    expect(res.body.data.effective_permissions).toEqual(["contact:read", "customer_invoice:manage", "customer_invoice:read"]);
    expect(res.body.data.api_key.prefix).toBe(key.prefix);
    expect(res.text).not.toContain(key.secret);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects missing, malformed, unknown and wrong-secret keys with the same 401 problem", async () => {
    const key = await makeKey(owner, ["contacts:read"]);
    const wrongSecret = key.secret.slice(0, -1) + (key.secret.endsWith("A") ? "B" : "A");
    for (const presented of [null, "garbage", "mm_live_short", wrongSecret, "mm_live_zzzzzzzz_" + "A".repeat(43)]) {
      const res = await get("/me", presented);
      expect(res.status, String(presented)).toBe(401);
      expect(res.body.code).toBe("invalid_api_key");
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.body.requestId).toBe(res.headers.get("x-request-id"));
    }
  });

  it("accepts the key ONLY from the Authorization header, never the query string or a cookie", async () => {
    const key = await makeKey(owner, ["contacts:read"]);
    const viaQuery = await call("GET", `/me?api_key=${key.secret}`, { key: null });
    expect(viaQuery.status).toBe(401); // authentication happens first and finds no Authorization header
    const viaCookie = await call("GET", "/me", { key: null, headers: { cookie: `api_key=${key.secret}; next-auth.session-token=abc` } });
    expect(viaCookie.status).toBe(401);
    const viaBasic = await call("GET", "/me", { key: null, headers: { authorization: `Basic ${Buffer.from(key.secret).toString("base64")}` } });
    expect(viaBasic.status).toBe(401);
  });

  it("revocation takes effect on the very next request", async () => {
    const key = await makeKey(owner, ["contacts:read"]);
    expect((await get("/me", key.secret)).status).toBe(200);
    await ApiKeyService.revoke(owner, key.id);
    const after = await get("/me", key.secret);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("api_key_revoked");
    // Revoking again is harmless.
    expect((await ApiKeyService.revoke(owner, key.id)).alreadyRevoked).toBe(true);
    expect((await ApiKeyService.list(owner))[0]?.status).toBe("REVOKED");
  });

  it("an expired key stops working", async () => {
    const key = await makeKey(owner, ["contacts:read"], { expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await get("/me", key.secret)).status).toBe(200);
    await admin.query("UPDATE api_key_index SET expires_at = now() - interval '1 second' WHERE id = $1", [key.id]);
    await admin.query("UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = $1", [key.id]);
    const res = await get("/me", key.secret);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("api_key_expired");
    expect((await ApiKeyService.list(owner))[0]?.status).toBe("EXPIRED");
  });

  describe("effective permissions follow the creator's CURRENT standing", () => {
    it("a creator who is removed from the organization kills the key immediately", async () => {
      const creator = await addTestMember(owner, "ADMINISTRATOR", "Creator");
      const key = await makeKey(creator, ["contacts:read"]);
      expect((await get("/me", key.secret)).status).toBe(200);
      const membership = (await OrganizationService.listMembers(owner)).find((m) => m.userId === creator.userId);
      await OrganizationService.removeMember(owner, membership!.membershipId);
      const res = await get("/me", key.secret);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("api_key_owner_inactive");
    });

    it("a creator who is suspended (users.disabled_at) kills the key immediately, and reinstating revives it", async () => {
      const creator = await addTestMember(owner, "ADMINISTRATOR", "Suspended");
      const key = await makeKey(creator, ["contacts:read"]);
      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, creator.userId));
      const res = await get("/me", key.secret);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("api_key_owner_inactive");
      await db.update(users).set({ disabledAt: null }).where(eq(users.id, creator.userId));
      expect((await get("/me", key.secret)).status).toBe(200);
    });

    it("a demoted creator shrinks the key: write scope stops working, read keeps working only where the new role allows", async () => {
      const creator = await addTestMember(owner, "ADMINISTRATOR", "Demoted");
      const key = await makeKey(creator, ["contacts:read", "contacts:write", "invoices:read"]);
      const customer = { display_name: "Before demotion", currency: "AUD" };
      expect((await call("POST", "/customers", { key: key.secret, body: customer })).status).toBe(201);

      const membership = (await OrganizationService.listMembers(owner)).find((m) => m.userId === creator.userId);
      await OrganizationService.updateMemberRole(owner, membership!.membershipId, "READ_ONLY");

      const me = await get("/me", key.secret);
      expect(me.status).toBe(200);
      expect(me.body.data.effective_permissions).toEqual(["contact:read", "customer_invoice:read"]);

      const write = await call("POST", "/customers", { key: key.secret, body: { ...customer, display_name: "After demotion" } });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe("permission_denied");
      expect((await get("/customers", key.secret)).status).toBe(200);
    });

    it("a key can never do more than its scopes: a read scope cannot write even for an OWNER creator", async () => {
      const key = await makeKey(owner, ["contacts:read"]);
      const res = await call("POST", "/customers", { key: key.secret, body: { display_name: "Nope", currency: "AUD" } });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("insufficient_scope");
    });
  });

  describe("management is human-only and limited to Owner / Administrator", () => {
    it("every role without api_key:manage is refused create, list and revoke", async () => {
      const key = await makeKey(owner, ["contacts:read"]);
      for (const role of ["ACCOUNTANT", "BOOKKEEPER", "MANAGER", "READ_ONLY", "ACCOUNTS_PAYABLE", "ACCOUNTS_RECEIVABLE", "PAYROLL_MANAGER", "EMPLOYEE"] as const) {
        const member = await addTestMember(owner, role, role);
        await expect(ApiKeyService.create(member, { name: "x", scopes: ["contacts:read"] }), role).rejects.toThrow(PermissionDeniedError);
        await expect(ApiKeyService.list(member), role).rejects.toThrow(PermissionDeniedError);
        await expect(ApiKeyService.revoke(member, key.id), role).rejects.toThrow(PermissionDeniedError);
      }
    });

    it("an AI, system or API actor is refused even with the OWNER role", async () => {
      for (const type of ["AI", "SYSTEM", "API"] as const) {
        const actor: Actor = { ...owner, type };
        await expect(ApiKeyService.create(actor, { name: "x", scopes: ["contacts:read"] }), type).rejects.toThrow(PermissionDeniedError);
        await expect(ApiKeyService.list(actor), type).rejects.toThrow(PermissionDeniedError);
      }
    });

    it("rejects unknown scopes, empty scope lists, bad names and out-of-bounds expiry and rate limits", async () => {
      await expect(ApiKeyService.create(owner, { name: "x", scopes: ["admin:everything"] })).rejects.toThrow(InvalidScopeError);
      await expect(ApiKeyService.create(owner, { name: "x", scopes: ["journals:write"] })).rejects.toThrow(InvalidScopeError);
      await expect(ApiKeyService.create(owner, { name: "x", scopes: [] })).rejects.toThrow(InvalidScopeError);
      await expect(ApiKeyService.create(owner, { name: "  ", scopes: ["contacts:read"] })).rejects.toThrow(InvalidApiKeyInputError);
      await expect(ApiKeyService.create(owner, { name: "x", scopes: ["contacts:read"], expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(InvalidApiKeyInputError);
      await expect(ApiKeyService.create(owner, { name: "x", scopes: ["contacts:read"], expiresAt: new Date(Date.now() + 5 * 365 * 86_400_000) })).rejects.toThrow(InvalidApiKeyInputError);
      await expect(ApiKeyService.create(owner, { name: "x", scopes: ["contacts:read"], rateLimitPerMinute: 100_000 })).rejects.toThrow();
      await expect(ApiKeyService.create(owner, { name: "x", scopes: ["contacts:read"], rateLimitPerMinute: 1 })).rejects.toThrow();
    });

    it("cannot revoke another organization's key (not found)", async () => {
      const other = await createTestOrg("api-keys-other");
      const foreign = await makeKey(other.owner, ["contacts:read"]);
      await expect(ApiKeyService.revoke(owner, foreign.id)).rejects.toThrow(/not found/i);
      expect((await get("/me", foreign.secret)).status).toBe(200);
    });
  });
});
