import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, oauthAuthorizationCodes } from "@/db/schema";

let currentUser: { id: string; email: string; name: string } | null = null;
vi.mock("@/lib/session", () => ({ getCurrentUser: async () => currentUser }));

import { POST } from "@/app/oauth/authorize/decision/route";
import { adminDb, addTestMember, closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { REDIRECT, authRequest, pkcePair, registerApp } from "../../helpers/oauth";
import { authorize } from "@/domain/oauth/authorize-service";
import { signConsentToken } from "@/domain/oauth/csrf";
import type { Actor } from "@/domain/permissions/permission-service";

/**
 * The consent decision POST: same-origin form post, a signed-in person, and a CSRF token bound to that person and to the exact
 * request they were shown. The page itself is a server component; this drives the real route handler.
 */
describe("OAuth consent decision (CSRF and re-validation)", () => {
  let owner: Actor;
  let other: Actor;
  let app: Awaited<ReturnType<typeof registerApp>>;
  const origin = "http://localhost:3000";

  beforeEach(async () => {
    await resetDatabase();
    const org = await createTestOrg("oauth-consent");
    owner = org.owner;
    other = await addTestMember(owner, "BOOKKEEPER", "Other");
    app = await registerApp(owner);
    currentUser = { id: owner.userId, email: "o@example.test", name: "Owner" };
  });

  afterAll(async () => {
    await closeTestPools();
  });

  const shown = () => {
    const { challenge } = pkcePair();
    const raw = authRequest(app.clientId, challenge);
    return {
      request: { clientId: raw.client_id as string, redirectUri: raw.redirect_uri as string, scope: raw.scope as string, state: raw.state as string, codeChallenge: raw.code_challenge as string },
      fields: raw,
    };
  };

  const post = (fields: Record<string, string>, opts: { origin?: string | null; contentType?: string } = {}) => {
    const headers = new Headers({ "content-type": opts.contentType ?? "application/x-www-form-urlencoded" });
    if (opts.origin !== null) headers.set("origin", opts.origin ?? origin);
    return POST(new Request(`${origin}/oauth/authorize/decision`, { method: "POST", headers, body: new URLSearchParams(fields).toString() }));
  };
  const codes = () => adminDb().select().from(oauthAuthorizationCodes);
  const errorReason = (res: Response) => (res.status === 303 ? new URL(res.headers.get("location") as string, origin).searchParams.get("reason") : null);

  it("a valid Allow issues exactly one code, hands off to the REGISTERED redirect with no-store / no-referrer, and audits the consent", async () => {
    const { request, fields } = shown();
    const res = await post({ ...fields, decision: "allow", csrf: signConsentToken(owner.userId, request) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    const href = /<a href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") as string;
    const target = new URL(href);
    expect(`${target.origin}${target.pathname}`).toBe(REDIRECT);
    expect(target.searchParams.get("code")).toMatch(/^mmo_ac_/);
    expect(target.searchParams.get("state")).toBe("state-123");
    expect(await codes()).toHaveLength(1);
    expect((await adminDb().select().from(auditLogs).where(eq(auditLogs.action, "oauth_consent.approved"))).length).toBe(1);
    expect(JSON.stringify(await adminDb().select().from(auditLogs))).not.toContain(target.searchParams.get("code") as string);
  });

  it("Deny returns access_denied to the registered redirect and writes no code", async () => {
    const { request, fields } = shown();
    const res = await post({ ...fields, decision: "deny", csrf: signConsentToken(owner.userId, request) });
    const html = await res.text();
    const target = new URL(/<a href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&") as string);
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("code")).toBeNull();
    expect(await codes()).toHaveLength(0);
  });

  it("CSRF: no Origin, a foreign Origin, a wrong content type, a missing / forged / expired / other-person's / other-request's token are ALL refused with nothing written", async () => {
    const { request, fields } = shown();
    const good = signConsentToken(owner.userId, request);
    const cases: Array<[string, Promise<Response>]> = [
      ["no origin", post({ ...fields, decision: "allow", csrf: good }, { origin: null })],
      ["foreign origin", post({ ...fields, decision: "allow", csrf: good }, { origin: "https://evil.example.test" })],
      ["json body", post({ ...fields, decision: "allow", csrf: good }, { contentType: "application/json" })],
      ["no token", post({ ...fields, decision: "allow" })],
      ["forged token", post({ ...fields, decision: "allow", csrf: `${Math.floor(Date.now() / 1000) + 600}.${"A".repeat(43)}` })],
      ["token of another person", post({ ...fields, decision: "allow", csrf: signConsentToken(other.userId, request) })],
      ["token for another request", post({ ...fields, decision: "allow", csrf: signConsentToken(owner.userId, { ...request, state: "different" }) })],
      ["expired token", post({ ...fields, decision: "allow", csrf: signConsentToken(owner.userId, request, new Date(Date.now() - 3_600_000)) })],
      ["tampered field (scope widened after the token was issued)", post({ ...fields, scope: "invoices:write contacts:read", decision: "allow", csrf: good })],
      ["tampered redirect_uri", post({ ...fields, redirect_uri: "https://evil.example.test/cb", decision: "allow", csrf: good })],
      ["missing decision", post({ ...fields, csrf: good })],
      ["unknown decision", post({ ...fields, decision: "maybe", csrf: good })],
    ];
    for (const [label, pending] of cases) {
      const res = await pending;
      expect(res.status, label).toBe(303);
      expect(res.headers.get("location"), label).toMatch(/^\/oauth\/error\?reason=/);
      expect(res.headers.get("location"), label).not.toContain("evil.example.test");
    }
    expect(await codes()).toHaveLength(0);
  });

  it("signed out: refused with the 'session' reason and nothing written", async () => {
    const { request, fields } = shown();
    currentUser = null;
    const res = await post({ ...fields, decision: "allow", csrf: signConsentToken(owner.userId, request) });
    expect(errorReason(res)).toBe("session");
    expect(await codes()).toHaveLength(0);
  });

  it("a repeated field is refused (ambiguous), and an authorised token cannot approve a request the app was never allowed to make", async () => {
    const { request, fields } = shown();
    const body = new URLSearchParams({ ...fields, decision: "allow", csrf: signConsentToken(owner.userId, request) });
    body.append("scope", "invoices:write");
    const repeated = await POST(new Request(`${origin}/oauth/authorize/decision`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: body.toString() }));
    expect(errorReason(repeated)).toBe("invalid_request");

    // A genuine token for a request that fails validation (scope beyond the app's ceiling) still produces no code.
    const narrow = await registerApp(owner, { scopes: ["contacts:read"], name: "Narrow" });
    const { challenge } = pkcePair();
    const raw = authRequest(narrow.clientId, challenge, { scope: "invoices:write" });
    const req = { clientId: raw.client_id as string, redirectUri: raw.redirect_uri as string, scope: raw.scope as string, state: raw.state as string, codeChallenge: raw.code_challenge as string };
    const res = await post({ ...raw, decision: "allow", csrf: signConsentToken(owner.userId, req) });
    const target = new URL(/<a href="([^"]+)"/.exec(await res.text())?.[1]?.replace(/&amp;/g, "&") as string);
    expect(target.searchParams.get("error")).toBe("invalid_scope");
    expect(await codes()).toHaveLength(0);
  });

  it("a person who is not a member of the app's organization cannot approve even with a valid token for themselves", async () => {
    const outsider = await createTestOrg("oauth-outsider");
    currentUser = { id: outsider.owner.userId, email: "x@example.test", name: "Outsider" };
    const { request, fields } = shown();
    const res = await post({ ...fields, decision: "allow", csrf: signConsentToken(outsider.owner.userId, request) });
    expect(errorReason(res)).toBe("not_a_member");
    expect(await codes()).toHaveLength(0);
  });

  it("the preview for an unregistered redirect is an error page, never a redirect (same service the page calls)", async () => {
    const { challenge } = pkcePair();
    const out = await authorize({ id: owner.userId }, authRequest(app.clientId, challenge, { redirect_uri: "https://evil.example.test/cb" }), "preview", origin);
    expect(out).toEqual({ kind: "error_page", reason: "redirect_mismatch" });
  });
});
