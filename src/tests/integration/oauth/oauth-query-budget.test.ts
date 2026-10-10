import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { instrumentTenant, tracker } from "../../helpers/connection-tracker";

vi.mock("@/db/tenant", async (importOriginal) => instrumentTenant(await importOriginal<typeof import("@/db/tenant")>()));

import pg from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { REDIRECT, authRequest, connect, form, pkcePair, registerApp, resetOAuthThrottle } from "../../helpers/oauth";
import { get, makeKey, resetApiThrottle } from "../../helpers/api";
import { authorize } from "@/domain/oauth/authorize-service";
import { UserService } from "@/domain/auth/user-service";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The per-request DATABASE budget for OAuth (docs/architecture.md section 8): the Supabase session pooler caps the project
 * at ~15 clients and the pool is 3, so every OAuth operation must cost a small FIXED number of sequential statements and
 * never hold more than one connection at a time. Counted at the driver (every statement including BEGIN / set_config /
 * COMMIT) with the real handlers and the real database. The numbers are asserted as ceilings AND printed so the docs can
 * quote them; an OAuth-authenticated API request must cost exactly what an API-key request costs.
 */
describe("OAuth per-request database budget", () => {
  let owner: Actor;
  let app: Awaited<ReturnType<typeof registerApp>>;
  let statements: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    resetOAuthThrottle();
    const org = await createTestOrg("oauth-budget");
    owner = org.owner;
    app = await registerApp(owner);
    tracker.reset();
    statements = [];
    spy?.mockRestore();
    const original = pg.Client.prototype.query;
    spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const first = args[0] as string | { text?: string };
      statements.push(typeof first === "string" ? first : (first?.text ?? ""));
      return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
  });

  afterAll(async () => {
    spy?.mockRestore();
    await closeTestPools();
  });

  const measure = async <T extends { status?: number }>(run: () => Promise<T>) => {
    statements = [];
    tracker.reset();
    const res = await run();
    return { res, statements: statements.length, tenantCalls: tracker.tenantCalls.length, maxActive: tracker.maxActive, sql: [...statements] };
  };

  it("token exchange, refresh, revocation, consent render and approval stay within a fixed number of statements, one connection at a time", async () => {
    // Consent render = the page's session lookup (1 users query) + authorize(preview).
    const { verifier, challenge } = pkcePair();
    const render = await measure(async () => {
      await UserService.getActiveIdentity(owner.userId);
      return authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "preview", "http://localhost:3000").then(() => ({ status: 200 }));
    });
    const approve = await measure(() => authorize({ id: owner.userId }, authRequest(app.clientId, challenge), "approve", "http://localhost:3000").then((o) => ({ status: 200, o })));
    const code = new URL((approve.res as unknown as { o: { url: string } }).o.url).searchParams.get("code") as string;

    const exchange = await measure(() =>
      form("token", { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }, { basic: { id: app.clientId, secret: app.clientSecret as string } }),
    );
    expect(exchange.res.status).toBe(200);
    const refreshToken = exchange.res.body.refresh_token as string;
    const accessToken = exchange.res.body.access_token as string;

    const refresh = await measure(() => form("token", { grant_type: "refresh_token", refresh_token: refreshToken }, { basic: { id: app.clientId, secret: app.clientSecret as string } }));
    expect(refresh.res.status).toBe(200);

    const revoke = await measure(() => form("revoke", { token: refresh.res.body.refresh_token }, { basic: { id: app.clientId, secret: app.clientSecret as string } }));
    expect(revoke.res.status).toBe(200);

    const rows = { render, approve, exchange, refresh, revoke };
    for (const [name, m] of Object.entries(rows)) {
      // eslint-disable-next-line no-console
      console.log(`[budget] ${name}: ${m.statements} statements, ${m.tenantCalls} tenant tx, max concurrent ${m.maxActive}`);
      expect(m.maxActive, name).toBeLessThanOrEqual(1);
      expect(m.tenantCalls, name).toBeLessThanOrEqual(1);
    }
    expect(render.statements).toBeLessThanOrEqual(6); // users lookup, client index, BEGIN, set_config, joined SELECT, COMMIT
    expect(approve.statements).toBeLessThanOrEqual(8);
    expect(exchange.statements).toBeLessThanOrEqual(14);
    expect(refresh.statements).toBeLessThanOrEqual(13);
    expect(revoke.statements).toBeLessThanOrEqual(10);
    void accessToken;
  });

  it("an OAuth-bearer API request costs EXACTLY what an API-key request costs (lookup + rate-limit, then the same single tenant transaction)", async () => {
    const t = await connect(owner.userId, app, { scope: "contacts:read accounts:read" });
    const key = (await makeKey(owner, ["contacts:read", "accounts:read"], { rateLimitPerMinute: 600 })).secret;

    const keyMe = await measure(() => get("/me", key));
    const oauthMe = await measure(() => get("/me", t.access));
    expect(keyMe.statements).toBe(2);
    expect(oauthMe.statements).toBe(2);
    expect(oauthMe.tenantCalls).toBe(0);
    expect(oauthMe.sql[0]).toMatch(/oauth_access_tokens/);
    expect(oauthMe.sql[1]).toMatch(/oauth_rate_windows/);

    const keyList = await measure(() => get("/customers?limit=25", key));
    const oauthList = await measure(() => get("/customers?limit=25", t.access));
    expect(oauthList.statements).toBe(keyList.statements);
    expect(oauthList.tenantCalls).toBe(1);
    expect(oauthList.maxActive).toBe(1);
    // eslint-disable-next-line no-console
    console.log(`[budget] api me: key ${keyMe.statements} / oauth ${oauthMe.statements}; list: key ${keyList.statements} / oauth ${oauthList.statements}`);
  });

  it("rejections are cheap: a malformed token costs 0 statements, an unknown prefix 1, a wrong-secret / revoked one 1", async () => {
    expect((await measure(() => get("/me", "mmo_at_nope"))).statements).toBe(0);
    expect((await measure(() => get("/me", `mmo_at_zzzzzzzz_${"A".repeat(43)}`))).statements).toBe(1);
    const t = await connect(owner.userId, app, { scope: "contacts:read" });
    const wrong = await measure(() => get("/me", t.access.slice(0, -2) + (t.access.endsWith("AA") ? "BB" : "AA")));
    expect(wrong.res.status).toBe(401);
    expect(wrong.statements).toBe(1);
  });

  it("token endpoint rejections: bad content type / query / missing client 0 statements; unknown client 2 (rate limit + client index)", async () => {
    const basic = { id: app.clientId, secret: app.clientSecret as string };
    expect((await measure(() => form("token", { grant_type: "refresh_token" }, { basic, contentType: "application/json" }))).statements).toBe(0);
    expect((await measure(() => form("token", { grant_type: "refresh_token" }, { basic, query: "?x=1" }))).statements).toBe(0);
    const unknown = await measure(() => form("token", { grant_type: "refresh_token", refresh_token: "mmo_rt_" + "A".repeat(43), client_id: "mmo_c_" + "Q".repeat(22) }));
    expect(unknown.statements).toBe(2); // rate limit + client index; the tenant transaction is never opened
    expect(unknown.tenantCalls).toBe(0);
  });
});
