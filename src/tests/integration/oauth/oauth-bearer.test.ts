import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, invoices, oauthAccessTokens, organizationMemberships, organizations, users } from "@/db/schema";
import { addTestMember, adminDb, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { connect, registerApp, resetOAuthThrottle } from "../../helpers/oauth";
import { call, get, post, resetApiThrottle } from "../../helpers/api";
import { createSalesFixtures } from "../../helpers/sales";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { OAuthGrantService } from "@/domain/oauth/grant-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * OAuth bearer authentication in the v1 API. THE rule under test: an access token's power is the granted scopes
 * INTERSECTED with the consenting person's CURRENT role, recomputed on every request, so a demotion shrinks it and a removal,
 * suspension, seat removal or archive kills it on the very next call - with no refresh and no waiting for expiry.
 */
describe("OAuth access tokens against /api/v1", () => {
  let owner: Actor;
  let orgId: string;
  let app: Awaited<ReturnType<typeof registerApp>>;
  let sales: Awaited<ReturnType<typeof createSalesFixtures>>;

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    resetOAuthThrottle();
    const org = await createTestOrg("oauth-bearer");
    owner = org.owner;
    orgId = org.organizationId;
    app = await registerApp(owner);
    sales = await createSalesFixtures(owner, org.baseCurrency);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  const membershipOf = async (userId: string) => {
    const [m] = await adminDb().select().from(organizationMemberships).where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.userId, userId)));
    return m!;
  };

  const invoiceBody = () => ({
    customer_id: sales.customerContactId,
    issue_date: "2026-03-10",
    due_date: "2026-04-10",
    currency: "AUD",
    ar_account_id: sales.arAccountId,
    lines: [{ description: "Consulting", quantity: "2", unit_price: "150.00", account_id: sales.revenueAccountId, tax_code_id: sales.taxCodeId }],
  });

  it("GET /me describes an OAuth credential: scopes, effective permissions, client and grant - never a secret", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read contacts:read" });
    const res = await get("/me", t.access);
    expect(res.status).toBe(200);
    const me = res.body.data;
    expect(me.auth_type).toBe("oauth");
    expect(me.api_key).toBeNull();
    expect(me.oauth.client_id).toBe(app.clientId);
    expect(me.scopes).toEqual(["contacts:read", "invoices:read"]);
    expect(me.effective_permissions).toEqual(["contact:read", "customer_invoice:read"]);
    expect(res.headers.get("x-ratelimit-limit")).toBe("60");
    expect(res.text).not.toContain(t.access);
    expect(res.text).not.toContain(t.refresh);
  });

  it("scopes are enforced: a token without invoices:read gets 403 insufficient_scope", async () => {
    const t = await connect(owner.userId, app, { scope: "contacts:read" });
    const res = await get("/invoices", t.access);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("insufficient_scope");
    expect((await get("/customers", t.access)).status).toBe(200);
  });

  it("writes are DRAFTS ONLY and audited as the API actor, with the client and grant (and never a token)", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read invoices:write" });
    const res = await post("/invoices", t.access, invoiceBody(), { idempotencyKey: "oauth-1" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("DRAFT");
    const [invoice] = await adminDb().select().from(invoices);
    expect(invoice?.status).toBe("DRAFT");

    const rows = (await adminDb().select().from(auditLogs)).filter((r) => r.actorType === "API");
    expect(rows.length).toBeGreaterThan(0);
    const created = rows.find((r) => r.action.includes("invoice"));
    expect(created?.actorUserId).toBe(owner.userId);
    const meta = created?.metadata as Record<string, unknown>;
    expect(meta.viaOAuth).toBe(true);
    expect(meta.oauthClientId).toBe(app.clientId);
    expect(meta.oauthAuthorisedBy).toBe(owner.userId);
    expect(JSON.stringify(rows)).not.toContain(t.access);

    // Posting / approving / voiding / paying have no endpoint and no scope at all.
    for (const [method, path] of [["POST", "/invoices/x/post"], ["POST", "/payments"], ["POST", "/journals"]] as const) {
      const r = await call(method, path.replace("/x/", `/${res.body.data.id}/`), { key: t.access, body: {} }).catch((e: Error) => ({ status: 0, text: e.message }));
      expect(r.status === 0 || r.status >= 400, path).toBe(true);
    }
  });

  it("idempotency works for tokens: a replay returns the original, scoped to the grant (the FK to api_keys is gone)", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read invoices:write" });
    const first = await post("/invoices", t.access, invoiceBody(), { idempotencyKey: "same-key" });
    const replay = await post("/invoices", t.access, invoiceBody(), { idempotencyKey: "same-key" });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await adminDb().select().from(invoices)).toHaveLength(1);
  });

  it("DEMOTION mid-grant: the very next request is limited to the new role (OWNER -> READ_ONLY loses invoice writes, keeps reads)", async () => {
    const member = await addTestMember(owner, "BOOKKEEPER", "Clerk");
    const t = await connect(member.userId, app, { scope: "invoices:read invoices:write" });
    expect((await post("/invoices", t.access, invoiceBody(), { idempotencyKey: "d-1" })).status).toBe(201);

    await OrganizationService.updateMemberRole(owner, (await membershipOf(member.userId)).id, "READ_ONLY", { confirmWriteAccess: false });
    const write = await post("/invoices", t.access, invoiceBody(), { idempotencyKey: "d-2" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe("permission_denied");
    expect((await get("/invoices", t.access)).status).toBe(200);
    const me = await get("/me", t.access);
    expect(me.body.data.effective_permissions).toEqual(["customer_invoice:read"]);
  });

  it("a role that loses the permission entirely (-> EMPLOYEE has no invoice read) is refused with 403, not served", async () => {
    const member = await addTestMember(owner, "BOOKKEEPER", "Clerk");
    const t = await connect(member.userId, app, { scope: "invoices:read" });
    await OrganizationService.updateMemberRole(owner, (await membershipOf(member.userId)).id, "EMPLOYEE", { confirmWriteAccess: true });
    resetApiThrottle();
    const res = await get("/invoices", t.access);
    expect(res.status).toBe(403);
  });

  it("REMOVAL / SEAT REMOVAL of the authorising user: the token stops working at once (401 authorization_owner_inactive)", async () => {
    const member = await addTestMember(owner, "BOOKKEEPER", "Clerk");
    const t = await connect(member.userId, app, { scope: "invoices:read" });
    expect((await get("/invoices", t.access)).status).toBe(200);
    await OrganizationService.removeMember(owner, (await membershipOf(member.userId)).id);
    const res = await get("/invoices", t.access);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("authorization_owner_inactive");
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("SUSPENDED user: refused immediately, and refresh is refused too", async () => {
    const member = await addTestMember(owner, "BOOKKEEPER", "Clerk");
    const t = await connect(member.userId, app, { scope: "invoices:read" });
    await adminDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, member.userId));
    const res = await get("/invoices", t.access);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("authorization_owner_inactive");
    const { form } = await import("../../helpers/oauth");
    const refresh = await form("token", { grant_type: "refresh_token", refresh_token: t.refresh }, { basic: { id: app.clientId, secret: app.clientSecret as string } });
    expect(refresh.body.error).toBe("invalid_grant");
  });

  it("ARCHIVED organization: the API refuses (403 organization_archived), refresh and new consents are refused, and restoring brings it back untouched", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read" });
    await adminDb().update(organizations).set({ archivedAt: new Date(), archivedByUserId: owner.userId, archiveReason: "closing" }).where(eq(organizations.id, orgId));
    const res = await get("/invoices", t.access);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("organization_archived");
    const { form } = await import("../../helpers/oauth");
    expect((await form("token", { grant_type: "refresh_token", refresh_token: t.refresh }, { basic: { id: app.clientId, secret: app.clientSecret as string } })).body.error).toBe("invalid_grant");
    await adminDb().update(organizations).set({ archivedAt: null, archivedByUserId: null, archiveReason: null }).where(eq(organizations.id, orgId));
    resetApiThrottle();
    expect((await get("/invoices", t.access)).status).toBe(200);
  });

  it("REVOKED grant, DISABLED app, expired token and tampered / unknown tokens are all 401 with a WWW-Authenticate challenge", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read" });
    const [grant] = await OAuthGrantService.listOwn(owner);

    const tampered = t.access.slice(0, -3) + (t.access.endsWith("AAA") ? "BBB" : "AAA");
    const bad = await get("/me", tampered);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("invalid_token");
    expect(bad.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect((await get("/me", "mmo_at_zzzzzzzz_" + "A".repeat(43))).body.code).toBe("invalid_token");
    expect((await get("/me", "mmo_at_short")).body.code).toBe("invalid_token");

    await adminDb().update(oauthAccessTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    resetApiThrottle();
    const expired = await get("/me", t.access);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe("token_expired");
    await adminDb().update(oauthAccessTokens).set({ expiresAt: new Date(Date.now() + 3_600_000) });

    await OAuthGrantService.revoke(owner, grant!.id);
    resetApiThrottle();
    const revoked = await get("/me", t.access);
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe("token_revoked");

    const t2 = await connect(owner.userId, app, { scope: "invoices:read" });
    resetApiThrottle();
    expect((await get("/me", t2.access)).status).toBe(200);
    await OAuthAppService.setDisabled(owner, app.appId, true);
    resetApiThrottle();
    expect((await get("/me", t2.access)).body.code).toBe("token_revoked");
  });

  it("an API key and an OAuth token are separate credentials: neither's prefix is accepted by the other's lookup", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read" });
    expect((await get("/me", t.access.replace("mmo_at_", "mm_live_"))).status).toBe(401);
    const { makeKey } = await import("../../helpers/api");
    const key = await makeKey(owner, ["invoices:read"]);
    expect((await get("/me", key.secret.replace("mm_live_", "mmo_at_"))).status).toBe(401);
    expect((await get("/me", key.secret)).body.data.auth_type).toBe("api_key");
  });

  it("an access token is rate limited per grant with the same headers and Retry-After as a key", async () => {
    const t = await connect(owner.userId, app, { scope: "invoices:read" });
    let limited = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 62; i += 1) {
      const res = await get("/me", t.access);
      if (res.status === 429) {
        limited = i + 1;
        retryAfter = res.headers.get("retry-after");
        expect(res.body.code).toBe("rate_limited");
        break;
      }
    }
    expect(limited).toBe(61);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("a token never works across organizations: an app and its grants belong to ONE organization", async () => {
    const other = await createTestOrg("oauth-bearer-other");
    const t = await connect(owner.userId, app, { scope: "invoices:read" });
    const me = await get("/me", t.access);
    expect(me.body.data.organization_id).toBe(orgId);
    expect(me.body.data.organization_id).not.toBe(other.organizationId);
    // The list only ever contains this organization's data.
    const list = await get("/customers", t.access);
    expect(JSON.stringify(list.body)).not.toContain(other.organizationId);
  });
});
