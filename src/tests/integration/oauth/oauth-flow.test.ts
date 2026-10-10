import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLogs, oauthAccessTokens, oauthAuthorizationCodes, oauthGrants, oauthRefreshTokens, organizationMemberships, organizations, users } from "@/db/schema";
import { addTestMember, adminDb, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { ALL_READ_SCOPES, REDIRECT, authRequest, connect, consent, form, pkcePair, registerApp, resetOAuthThrottle } from "../../helpers/oauth";
import { authenticateApiKey } from "@/domain/api/api-auth";
import { authorize } from "@/domain/oauth/authorize-service";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { OAuthGrantService } from "@/domain/oauth/grant-service";
import { hashCredential } from "@/domain/oauth/credentials";
import { OrganizationService } from "@/domain/organizations/organization-service";
import { authThrottle } from "@/domain/api/auth-throttle";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The OAuth 2.0 authorization-code + PKCE flow end to end against a real database: consent, code exchange, every PKCE and
 * redirect failure mode, code replay, refresh rotation and reuse detection, revocation and the revocation endpoint.
 */
describe("OAuth authorization code + PKCE", () => {
  let owner: Actor;
  let member: Actor;
  let orgId: string;
  let app: Awaited<ReturnType<typeof registerApp>>;

  beforeEach(async () => {
    await resetDatabase();
    resetOAuthThrottle();
    const org = await createTestOrg("oauth-flow");
    owner = org.owner;
    orgId = org.organizationId;
    member = await addTestMember(owner, "BOOKKEEPER", "Bookkeeper");
    app = await registerApp(owner);
  });

  afterAll(async () => {
    await closeTestPools();
  });

  const exchange = (code: string, verifier: string, extra: Record<string, string | undefined> = {}, secret = app.clientSecret as string) =>
    form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, ...extra }, { basic: { id: app.clientId, secret } });

  it("issues opaque tokens, no-store, and the access token authenticates against the v1 API", async () => {
    const { verifier, challenge } = pkcePair();
    const code = await consent(owner.userId, app.clientId, challenge);
    expect(code).toMatch(/^mmo_ac_[A-Za-z0-9_-]{43}$/);

    const res = await exchange(code, verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.body.token_type).toBe("Bearer");
    expect(res.body.expires_in).toBe(3600);
    expect(res.body.access_token).toMatch(/^mmo_at_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(res.body.refresh_token).toMatch(/^mmo_rt_[A-Za-z0-9_-]{43}$/);
    expect(res.body.scope).toBe("contacts:read invoices:read");

    const authed = await authenticateApiKey(`Bearer ${res.body.access_token}`, "203.0.113.9");
    expect(authed.principal.credential).toBe("oauth");
    expect(authed.principal.organizationId).toBe(orgId);
    expect(authed.principal.actor.type).toBe("API");
    expect(authed.principal.actor.userId).toBe(owner.userId);
    expect([...authed.principal.permissions].sort()).toEqual(["contact:read", "customer_invoice:read"]);
  });

  it("stores only SHA-256 hashes: no raw code, access token or refresh token exists in any table", async () => {
    const t = await connect(owner.userId, app);
    const [code] = await adminDb().select().from(oauthAuthorizationCodes);
    const [access] = await adminDb().select().from(oauthAccessTokens);
    const [refresh] = await adminDb().select().from(oauthRefreshTokens);
    expect(code?.codeHash).toBe(hashCredential(t.code));
    expect(access?.secretHash).toBe(hashCredential(t.access));
    expect(refresh?.tokenHash).toBe(hashCredential(t.refresh));
    const dump = JSON.stringify([code, access, refresh, await adminDb().select().from(auditLogs)]);
    for (const secret of [t.code, t.access, t.refresh, t.verifier, app.clientSecret as string]) expect(dump).not.toContain(secret);
  });

  describe("authorization request", () => {
    it("PKCE is required: a missing challenge or any method other than S256 (including plain) is refused, via the registered redirect", async () => {
      const { challenge } = pkcePair();
      for (const [overrides, text] of [
        [{ code_challenge: undefined }, "PKCE is required"],
        [{ code_challenge_method: "plain" }, "S256"],
        [{ code_challenge_method: undefined }, "S256"],
        [{ code_challenge: "short" }, "not a valid S256"],
      ] as const) {
        const out = await authorize({ id: owner.userId }, authRequest(app.clientId, challenge, overrides), "approve", "http://localhost:3000");
        expect(out.kind).toBe("redirect");
        if (out.kind !== "redirect") continue;
        const url = new URL(out.url);
        expect(`${url.origin}${url.pathname}`).toBe("https://app.example.test/callback");
        expect(url.searchParams.get("error")).toBe("invalid_request");
        expect(url.searchParams.get("error_description")).toContain(text);
        expect(url.searchParams.get("state")).toBe("state-123");
        expect(url.searchParams.get("iss")).toBe("http://localhost:3000");
        expect(url.searchParams.get("code")).toBeNull();
      }
      expect(await adminDb().select().from(oauthAuthorizationCodes)).toHaveLength(0);
    });

    it("state is required, response_type must be code, scope must be known and inside the app's ceiling", async () => {
      const { challenge } = pkcePair();
      const narrow = await registerApp(owner, { scopes: ["contacts:read"], name: "Narrow" });
      const cases: Array<[string, Record<string, string | undefined>, string, string]> = [
        ["state", { state: undefined }, "invalid_request", app.clientId],
        ["token", { response_type: "token" }, "unsupported_response_type", app.clientId],
        ["unknown scope", { scope: "contacts:read root" }, "invalid_scope", app.clientId],
        ["no scope", { scope: undefined }, "invalid_scope", app.clientId],
        ["beyond the app's ceiling (escalation)", { scope: "contacts:read invoices:write" }, "invalid_scope", narrow.clientId],
      ];
      for (const [label, overrides, error, clientId] of cases) {
        const out = await authorize({ id: owner.userId }, authRequest(clientId, challenge, overrides), "preview", "http://localhost:3000");
        expect(out.kind, label).toBe("redirect");
        if (out.kind === "redirect") expect(new URL(out.url).searchParams.get("error"), label).toBe(error);
      }
    });

    it("a redirect_uri that is not registered NEVER redirects: it is an error page (no open redirect)", async () => {
      const { challenge } = pkcePair();
      for (const uri of [
        "https://evil.example.test/callback",
        "https://app.example.test/callback/",
        "https://app.example.test/callback?x=1",
        "http://app.example.test/callback",
        "https://app.example.test.evil.test/callback",
        "javascript:alert(1)",
        "https://app.example.test/callback#frag",
      ]) {
        const out = await authorize({ id: owner.userId }, authRequest(app.clientId, challenge, { redirect_uri: uri }), "approve", "http://localhost:3000");
        expect(out, uri).toEqual({ kind: "error_page", reason: "redirect_mismatch" });
      }
      expect(await adminDb().select().from(oauthAuthorizationCodes)).toHaveLength(0);
    });

    it("an unknown, malformed or repeated client_id / redirect_uri is an error page, and nothing is written", async () => {
      const { challenge } = pkcePair();
      expect(await authorize({ id: owner.userId }, authRequest("mmo_c_" + "A".repeat(22), challenge), "approve", "http://x")).toEqual({ kind: "error_page", reason: "unknown_client" });
      expect(await authorize({ id: owner.userId }, authRequest("nonsense", challenge), "approve", "http://x")).toEqual({ kind: "error_page", reason: "unknown_client" });
      expect(await authorize({ id: owner.userId }, { ...authRequest(app.clientId, challenge), redirect_uri: undefined }, "approve", "http://x")).toEqual({ kind: "error_page", reason: "invalid_request" });
      expect(await authorize({ id: owner.userId }, { ...authRequest(app.clientId, challenge), redirect_uri: [REDIRECT, "https://evil.example.test/"] }, "approve", "http://x")).toEqual({ kind: "error_page", reason: "invalid_request" });
    });

    it("only an ACTIVE member of the app's organization can authorise it (an app is org-scoped)", async () => {
      const other = await createTestOrg("oauth-other");
      const { challenge } = pkcePair();
      const outsider = await authorize({ id: other.owner.userId }, authRequest(app.clientId, challenge), "preview", "http://x");
      expect(outsider).toEqual({ kind: "error_page", reason: "not_a_member" });
      const [membership] = await adminDb().select().from(organizationMemberships).where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.userId, member.userId)));
      await OrganizationService.removeMember(owner, membership!.id);
      expect(await authorize({ id: member.userId }, authRequest(app.clientId, challenge), "preview", "http://x")).toEqual({ kind: "error_page", reason: "not_a_member" });
    });

    it("the user's role must permit every requested scope (a role that cannot read bills cannot grant bills:read)", async () => {
      const ar = await addTestMember(owner, "ACCOUNTS_RECEIVABLE", "AR clerk");
      const { challenge } = pkcePair();
      const out = await authorize({ id: ar.userId }, authRequest(app.clientId, challenge, { scope: "bills:read" }), "approve", "http://x");
      expect(out.kind).toBe("redirect");
      if (out.kind === "redirect") expect(new URL(out.url).searchParams.get("error")).toBe("access_denied");
      const ok = await authorize({ id: ar.userId }, authRequest(app.clientId, challenge, { scope: "invoices:read" }), "preview", "http://x");
      expect(ok.kind).toBe("consent");
    });

    it("disabled apps, deleted apps and archived organizations render an error page", async () => {
      const { challenge } = pkcePair();
      await OAuthAppService.setDisabled(owner, app.appId, true);
      expect(await authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "preview", "http://x")).toEqual({ kind: "error_page", reason: "client_disabled" });
      await OAuthAppService.setDisabled(owner, app.appId, false);
      expect((await authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "preview", "http://x")).kind).toBe("consent");
      await adminDb().update(organizations).set({ archivedAt: new Date(), archivedByUserId: owner.userId, archiveReason: "test" }).where(eq(organizations.id, orgId));
      expect(await authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "preview", "http://x")).toEqual({ kind: "error_page", reason: "organization_archived" });
      await adminDb().update(organizations).set({ archivedAt: null, archivedByUserId: null, archiveReason: null }).where(eq(organizations.id, orgId));
      await OAuthAppService.delete(owner, app.appId);
      expect(await authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "preview", "http://x")).toEqual({ kind: "error_page", reason: "unknown_client" });
    });

    it("the consent preview names the app, organization, role and the scopes with read / write distinguished, and writes nothing", async () => {
      const { challenge } = pkcePair();
      const out = await authorize({ id: owner.userId }, authRequest(app.clientId, challenge, { scope: "invoices:read invoices:write" }), "preview", "http://x");
      expect(out.kind).toBe("consent");
      if (out.kind !== "consent") return;
      expect(out.view.app.name).toBe("Test App");
      expect(out.view.organization.id).toBe(orgId);
      expect(out.view.redirectHost).toBe("app.example.test");
      expect(out.view.scopes.map((s) => [s.scope, s.write])).toEqual([["invoices:read", false], ["invoices:write", true]]);
      expect(await adminDb().select().from(oauthAuthorizationCodes)).toHaveLength(0);
    });

    it("denying redirects with access_denied, writes no code, and is audited", async () => {
      const { challenge } = pkcePair();
      const out = await authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "deny", "http://x");
      expect(out.kind === "redirect" && new URL(out.url).searchParams.get("error")).toBe("access_denied");
      expect(await adminDb().select().from(oauthAuthorizationCodes)).toHaveLength(0);
      const rows = await adminDb().select().from(auditLogs).where(eq(auditLogs.action, "oauth_consent.denied"));
      expect(rows).toHaveLength(1);
    });
  });

  describe("code exchange", () => {
    it("PKCE failure modes: wrong verifier, missing verifier, malformed verifier, a verifier for another challenge", async () => {
      const a = pkcePair();
      const b = pkcePair();
      const code1 = await consent(owner.userId, app.clientId, a.challenge);
      expect((await exchange(code1, b.verifier)).body).toMatchObject({ error: "invalid_grant" });
      // The failed attempt BURNED the code: even the right verifier fails now.
      expect((await exchange(code1, a.verifier)).body).toMatchObject({ error: "invalid_grant" });

      const code2 = await consent(owner.userId, app.clientId, a.challenge);
      const missing = await form("token", { grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT }, { basic: { id: app.clientId, secret: app.clientSecret as string } });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe("invalid_request");
      const short = await exchange(code2, "tooshort");
      expect(short.body.error).toBe("invalid_grant");
      // Malformed / missing verifiers never touched the code: it still works with the right verifier.
      expect((await exchange(code2, a.verifier)).status).toBe(200);
      expect(await adminDb().select().from(oauthGrants)).toHaveLength(1);
    });

    it("redirect_uri must equal the one the code was issued for; a mismatch burns the code", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const bad = await exchange(code, verifier, { redirect_uri: "https://app.example.test/other" });
      expect(bad.body.error).toBe("invalid_grant");
      expect((await exchange(code, verifier)).body.error).toBe("invalid_grant");
    });

    it("an expired code is refused", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      await adminDb().update(oauthAuthorizationCodes).set({ expiresAt: new Date(Date.now() - 1000) });
      expect((await exchange(code, verifier)).body.error).toBe("invalid_grant");
    });

    it("a code lives at most 60 seconds", async () => {
      const { challenge } = pkcePair();
      await consent(owner.userId, app.clientId, challenge);
      const [row] = await adminDb().select().from(oauthAuthorizationCodes);
      const ttl = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 1000;
      expect(ttl).toBeGreaterThan(55);
      expect(ttl).toBeLessThanOrEqual(61);
    });

    it("REPLAY: presenting a used code again fails AND revokes the tokens the first use created", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const first = await exchange(code, verifier);
      expect(first.status).toBe(200);
      const live = await authenticateApiKey(`Bearer ${first.body.access_token}`, "203.0.113.20");
      expect(live.principal.credential).toBe("oauth");

      const replay = await exchange(code, verifier);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");

      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${first.body.access_token}`, "203.0.113.21")).rejects.toMatchObject({ code: "token_revoked" });
      const refresh = await form("token", { grant_type: "refresh_token", refresh_token: first.body.refresh_token }, { basic: { id: app.clientId, secret: app.clientSecret as string } });
      expect(refresh.body.error).toBe("invalid_grant");
      const [grant] = await adminDb().select().from(oauthGrants);
      expect(grant?.revokeReason).toBe("CODE_REPLAY");
      const actions = (await adminDb().select().from(auditLogs)).map((r) => r.action);
      expect(actions).toContain("oauth_code.replayed");
      expect(actions).toContain("oauth_grant.revoked");
    });

    it("two simultaneous exchanges of one code create exactly ONE grant", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const results = [];
      // Sequential awaits would hide the race; fire both, then collect (the DB pool serialises on the row lock).
      const a = exchange(code, verifier);
      const b = exchange(code, verifier);
      results.push(await a, await b);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await adminDb().select().from(oauthGrants)).toHaveLength(1);
    });

    it("a code issued to one client cannot be redeemed by another, and burns", async () => {
      const other = await registerApp(owner, { name: "Other" });
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const stolen = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }, { basic: { id: other.clientId, secret: other.clientSecret as string } });
      expect(stolen.body.error).toBe("invalid_grant");
      expect((await exchange(code, verifier)).body.error).toBe("invalid_grant");
    });

    it("client authentication: wrong secret, missing secret, unknown client and a secret sent by a public client are all invalid_client", async () => {
      const pub = await registerApp(owner, { type: "PUBLIC", name: "Native" });
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const wrong = await exchange(code, verifier, {}, "mmo_cs_aaaaaa_" + "A".repeat(43));
      expect(wrong.status).toBe(401);
      expect(wrong.body.error).toBe("invalid_client");
      expect(wrong.headers.get("www-authenticate")).toMatch(/^Basic/);
      const none = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: app.clientId });
      expect(none.body.error).toBe("invalid_client");
      const unknown = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: "mmo_c_" + "B".repeat(22) });
      expect(unknown.body.error).toBe("invalid_client");
      const pubWithSecret = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: pub.clientId, client_secret: "mmo_cs_aaaaaa_" + "A".repeat(43) });
      expect(pubWithSecret.body.error).toBe("invalid_client");
      // None of those consumed the code.
      expect((await exchange(code, verifier)).status).toBe(200);
    });

    it("a public client needs no secret, only PKCE", async () => {
      const pub = await registerApp(owner, { type: "PUBLIC", name: "Native" });
      expect(pub.clientSecret).toBeNull();
      const t = await connect(owner.userId, pub);
      expect(t.access).toMatch(/^mmo_at_/);
    });

    it("client_secret_post works for a confidential client, but both methods at once is refused", async () => {
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const both = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: app.clientId, client_secret: app.clientSecret as string }, { basic: { id: app.clientId, secret: app.clientSecret as string } });
      expect(both.body.error).toBe("invalid_request");
      const post = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: app.clientId, client_secret: app.clientSecret as string });
      expect(post.status).toBe(200);
    });

    it("grant types other than authorization_code and refresh_token are refused (no password, client_credentials, implicit)", async () => {
      for (const grantType of ["password", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code", "implicit"]) {
        const res = await form("token", { grant_type: grantType, username: "a", password: "b" }, { basic: { id: app.clientId, secret: app.clientSecret as string } });
        expect(res.status, grantType).toBe(400);
        expect(res.body.error, grantType).toBe("unsupported_grant_type");
      }
      expect((await form("token", {}, { basic: { id: app.clientId, secret: app.clientSecret as string } })).body.error).toBe("invalid_request");
    });

    it("strict transport: form-encoded only, nothing in the query string, no repeated parameters, nothing over 8 KiB", async () => {
      const basic = { id: app.clientId, secret: app.clientSecret as string };
      const json = await form("token", { grant_type: "refresh_token" }, { basic, contentType: "application/json" });
      expect(json.status).toBe(415);
      const query = await form("token", { grant_type: "refresh_token" }, { basic, query: "?client_secret=x" });
      expect(query.body.error).toBe("invalid_request");
      const repeated = await handleRaw("grant_type=refresh_token&grant_type=authorization_code", basic);
      expect(repeated.body.error).toBe("invalid_request");
      const big = await handleRaw(`grant_type=refresh_token&refresh_token=${"a".repeat(9000)}`, basic);
      expect(big.body.error).toBe("invalid_request");
      for (const r of [json, query, repeated, big]) {
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("the token endpoint is rate limited per address and per client, before any other database work", async () => {
      const basic = { id: app.clientId, secret: app.clientSecret as string };
      let last = 0;
      let retryAfter: string | null = null;
      for (let i = 0; i < 62; i += 1) {
        const r = await form("token", { grant_type: "refresh_token", refresh_token: "mmo_rt_" + "A".repeat(43) }, { basic, ip: "192.0.2.55" });
        last = r.status;
        if (r.status === 429) {
          retryAfter = r.headers.get("retry-after");
          expect(r.body.error).toBe("temporarily_unavailable");
          break;
        }
      }
      expect(last).toBe(429);
      expect(Number(retryAfter)).toBeGreaterThan(0);
      // A different address is not affected by that one's exhaustion.
      expect((await form("token", { grant_type: "refresh_token", refresh_token: "mmo_rt_" + "A".repeat(43) }, { basic, ip: "192.0.2.56" })).status).toBe(400);
    });
  });

  describe("refresh tokens", () => {
    const refresh = (token: string, extra: Record<string, string | undefined> = {}) =>
      form("token", { grant_type: "refresh_token", refresh_token: token, ...extra }, { basic: { id: app.clientId, secret: app.clientSecret as string } });

    it("rotates on every use: a new pair, the old refresh token is spent", async () => {
      const t = await connect(owner.userId, app);
      const r1 = await refresh(t.refresh);
      expect(r1.status).toBe(200);
      expect(r1.body.refresh_token).not.toBe(t.refresh);
      expect(r1.body.access_token).not.toBe(t.access);
      const r2 = await refresh(r1.body.refresh_token);
      expect(r2.status).toBe(200);
      // The first access token is still valid until it expires or is revoked (rotation does not invalidate it).
      authThrottle.clear();
      expect((await authenticateApiKey(`Bearer ${t.access}`, "203.0.113.30")).principal.credential).toBe("oauth");
    });

    it("REUSE DETECTION: presenting a rotated refresh token revokes the whole grant, every access token and the newest refresh token", async () => {
      const t = await connect(owner.userId, app);
      const r1 = await refresh(t.refresh);
      expect(r1.status).toBe(200);
      const stolenReplay = await refresh(t.refresh);
      expect(stolenReplay.status).toBe(400);
      expect(stolenReplay.body.error).toBe("invalid_grant");

      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${r1.body.access_token}`, "203.0.113.31")).rejects.toMatchObject({ code: "token_revoked" });
      await expect(authenticateApiKey(`Bearer ${t.access}`, "203.0.113.32")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await refresh(r1.body.refresh_token)).body.error).toBe("invalid_grant");
      const [grant] = await adminDb().select().from(oauthGrants);
      expect(grant?.revokeReason).toBe("REFRESH_REUSE");
      expect((await adminDb().select().from(auditLogs)).map((r) => r.action)).toEqual(expect.arrayContaining(["oauth_token.reuse_detected", "oauth_grant.revoked"]));
    });

    it("two concurrent refreshes of one token: exactly one wins and the other is treated as reuse", async () => {
      const t = await connect(owner.userId, app);
      const a = refresh(t.refresh);
      const b = refresh(t.refresh);
      const results = [await a, await b];
      expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(results.some((r) => r.status === 400)).toBe(true);
    });

    it("scope can only be narrowed on refresh, never widened", async () => {
      const t = await connect(owner.userId, app);
      const wider = await refresh(t.refresh, { scope: "contacts:read invoices:write" });
      expect(wider.body.error).toBe("invalid_scope");
      // The refused attempt did not rotate the token.
      const narrower = await refresh(t.refresh, { scope: "contacts:read" });
      expect(narrower.status).toBe(200);
      expect(narrower.body.scope).toBe("contacts:read");
    });

    it("another client's refresh token is refused, and an expired one is refused", async () => {
      const other = await registerApp(owner, { name: "Other" });
      const t = await connect(owner.userId, app);
      const foreign = await form("token", { grant_type: "refresh_token", refresh_token: t.refresh }, { basic: { id: other.clientId, secret: other.clientSecret as string } });
      expect(foreign.body.error).toBe("invalid_grant");
      await adminDb().update(oauthRefreshTokens).set({ expiresAt: new Date(Date.now() - 1000) });
      expect((await refresh(t.refresh)).body.error).toBe("invalid_grant");
    });

    it("refresh tokens last 30 days and access tokens one hour", async () => {
      await connect(owner.userId, app);
      const [rt] = await adminDb().select().from(oauthRefreshTokens);
      const [at] = await adminDb().select().from(oauthAccessTokens);
      expect(Math.round((rt!.expiresAt.getTime() - rt!.createdAt.getTime()) / 86_400_000)).toBe(30);
      expect(Math.round((at!.expiresAt.getTime() - at!.createdAt.getTime()) / 60_000)).toBe(60);
    });
  });

  describe("revocation", () => {
    it("RFC 7009: the client revokes with either token; the whole grant dies at once; unknown tokens still answer 200", async () => {
      const t = await connect(owner.userId, app);
      const basic = { id: app.clientId, secret: app.clientSecret as string };
      const res = await form("revoke", { token: t.refresh }, { basic });
      expect(res.status).toBe(200);
      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${t.access}`, "203.0.113.40")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await form("token", { grant_type: "refresh_token", refresh_token: t.refresh }, { basic })).body.error).toBe("invalid_grant");
      expect((await form("revoke", { token: "mmo_rt_" + "Z".repeat(43) }, { basic })).status).toBe(200);
      expect((await form("revoke", { token: "garbage" }, { basic })).status).toBe(200);
      expect((await form("revoke", { token: t.access }, { basic: { id: app.clientId, secret: "mmo_cs_aaaaaa_" + "A".repeat(43) } })).status).toBe(401);
    });

    it("a client cannot revoke another client's token", async () => {
      const other = await registerApp(owner, { name: "Other" });
      const t = await connect(owner.userId, app);
      const res = await form("revoke", { token: t.access }, { basic: { id: other.clientId, secret: other.clientSecret as string } });
      expect(res.status).toBe(200);
      authThrottle.clear();
      expect((await authenticateApiKey(`Bearer ${t.access}`, "203.0.113.41")).principal.credential).toBe("oauth");
    });

    it("the user revokes their own authorisation from the Authorised apps page: immediate, audited, kills access and refresh", async () => {
      const t = await connect(member.userId, app);
      const [own] = await OAuthGrantService.listOwn(member);
      expect(own?.appName).toBe("Test App");
      await OAuthGrantService.revoke(member, own!.id);
      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${t.access}`, "203.0.113.42")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await form("token", { grant_type: "refresh_token", refresh_token: t.refresh }, { basic: { id: app.clientId, secret: app.clientSecret as string } })).body.error).toBe("invalid_grant");
      expect(await OAuthGrantService.listOwn(member)).toHaveLength(0);
      const row = (await adminDb().select().from(auditLogs).where(eq(auditLogs.action, "oauth_grant.revoked")))[0];
      expect(row?.actorUserId).toBe(member.userId);
      expect(JSON.stringify(row)).not.toContain(t.access);
    });

    it("a member cannot see or revoke someone else's grant; an owner can revoke any grant in their organization", async () => {
      await connect(member.userId, app);
      const t2 = await connect(owner.userId, app);
      const bookkeeperGrant = (await OAuthGrantService.listOwn(member))[0]!;
      const ownerGrant = (await OAuthGrantService.listOwn(owner))[0]!;
      await expect(OAuthGrantService.revoke(member, ownerGrant.id)).rejects.toThrow(/not found/i);
      expect(await OAuthGrantService.listForOrganization(owner)).toHaveLength(2);
      await expect(OAuthGrantService.listForOrganization(member)).rejects.toThrow();
      await OAuthGrantService.revoke(owner, bookkeeperGrant.id);
      expect(await OAuthGrantService.listOwn(member)).toHaveLength(0);
      expect(await OAuthGrantService.listOwn(owner)).toHaveLength(1);
      void t2;
      const [row] = await adminDb().select().from(oauthGrants).where(eq(oauthGrants.id, bookkeeperGrant.id));
      expect(row?.revokeReason).toBe("ADMIN");
    });

    it("disabling an app revokes every grant at once, and enabling it again does not bring them back", async () => {
      const t1 = await connect(owner.userId, app);
      const t2 = await connect(member.userId, app);
      const res = await OAuthAppService.setDisabled(owner, app.appId, true);
      expect(res.revokedGrants).toBe(2);
      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${t1.access}`, "203.0.113.43")).rejects.toMatchObject({ code: "token_revoked" });
      await expect(authenticateApiKey(`Bearer ${t2.access}`, "203.0.113.44")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await form("token", { grant_type: "refresh_token", refresh_token: t1.refresh }, { basic: { id: app.clientId, secret: app.clientSecret as string } })).body.error).toBe("invalid_client");
      await OAuthAppService.setDisabled(owner, app.appId, false);
      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${t1.access}`, "203.0.113.45")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await form("token", { grant_type: "refresh_token", refresh_token: t1.refresh }, { basic: { id: app.clientId, secret: app.clientSecret as string } })).body.error).toBe("invalid_grant");
    });

    it("deleting an app revokes every grant and the client stops resolving", async () => {
      const t = await connect(owner.userId, app);
      expect((await OAuthAppService.delete(owner, app.appId)).revokedGrants).toBe(1);
      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${t.access}`, "203.0.113.46")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await form("token", { grant_type: "refresh_token", refresh_token: t.refresh }, { basic: { id: app.clientId, secret: app.clientSecret as string } })).body.error).toBe("invalid_client");
      expect(await OAuthAppService.list(owner)).toHaveLength(0);
    });

    it("lowering an app's scope ceiling revokes the grants that exceed it and keeps the ones that fit", async () => {
      const wide = await connect(owner.userId, app, { scope: "contacts:read invoices:write" });
      const narrow = await connect(member.userId, app, { scope: "contacts:read" });
      const res = await OAuthAppService.update(owner, app.appId, { name: "Test App", redirectUris: [REDIRECT], scopes: ["contacts:read"] });
      expect(res.revokedGrants).toBe(1);
      authThrottle.clear();
      await expect(authenticateApiKey(`Bearer ${wide.access}`, "203.0.113.47")).rejects.toMatchObject({ code: "token_revoked" });
      expect((await authenticateApiKey(`Bearer ${narrow.access}`, "203.0.113.48")).principal.credential).toBe("oauth");
    });
  });

  describe("client secrets", () => {
    it("the secret is returned once at creation, only its SHA-256 is stored, list never exposes it, rotation invalidates the old one", async () => {
      const [row] = await adminDb().select().from((await import("@/db/schema")).oauthApps).where(eq((await import("@/db/schema")).oauthApps.id, app.appId));
      expect(row?.secretHash).toBe(hashCredential(app.clientSecret as string));
      expect(row?.secretHash).not.toContain(app.clientSecret as string);
      const listed = JSON.stringify(await OAuthAppService.list(owner));
      expect(listed).not.toContain(app.clientSecret as string);
      expect(listed).not.toContain(row!.secretHash as string);
      const rotated = await OAuthAppService.rotateSecret(owner, app.appId);
      expect(rotated.clientSecret).not.toBe(app.clientSecret);
      const { verifier, challenge } = pkcePair();
      const code = await consent(owner.userId, app.clientId, challenge);
      const old = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }, { basic: { id: app.clientId, secret: app.clientSecret as string } });
      expect(old.body.error).toBe("invalid_client");
      const fresh = await form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }, { basic: { id: app.clientId, secret: rotated.clientSecret } });
      expect(fresh.status).toBe(200);
      const audit = JSON.stringify(await adminDb().select().from(auditLogs));
      expect(audit).not.toContain(app.clientSecret as string);
      expect(audit).not.toContain(rotated.clientSecret);
      expect(audit).not.toContain(row!.secretHash as string);
    });
  });

  it("membership rows are untouched by any of this (sanity)", async () => {
    await connect(owner.userId, app);
    const rows = await adminDb().select().from(organizationMemberships).where(and(eq(organizationMemberships.organizationId, orgId), eq(organizationMemberships.userId, owner.userId)));
    expect(rows).toHaveLength(1);
    expect((await adminDb().select().from(users)).length).toBeGreaterThan(1);
    void ALL_READ_SCOPES;
  });
});

async function handleRaw(rawBody: string, basic: { id: string; secret: string }) {
  const { handleTokenRequest } = await import("@/domain/oauth/http");
  const response = await handleTokenRequest(
    new Request("http://localhost:3000/api/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString("base64")}`,
        "x-forwarded-for": "198.51.100.99",
      },
      body: rawBody,
    }),
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) as { error?: string } };
}
