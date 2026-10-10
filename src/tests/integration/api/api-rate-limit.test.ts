import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { closeTestPools, createTestOrg, resetDatabase } from "../../helpers/db";
import { call, get, makeKey, resetApiThrottle } from "../../helpers/api";
import type { Actor } from "@/domain/permissions/permission-service";
import { THROTTLE_MAX_FAILURES } from "@/domain/api/auth-throttle";

describe("API rate limiting (Postgres fixed window, one atomic statement per request)", () => {
  let owner: Actor;
  const admin = new Pool({ connectionString: process.env.DIRECT_DATABASE_URL, max: 1 });

  beforeEach(async () => {
    await resetDatabase();
    resetApiThrottle();
    owner = (await createTestOrg("api-rate")).owner;
  });

  afterAll(async () => {
    await admin.end();
    await closeTestPools();
  });

  it("answers every response with X-RateLimit-Limit/Remaining/Reset, counting down from the limit", async () => {
    const k = await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 10 });
    const first = await get("/customers", k.secret);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-limit")).toBe("10");
    expect(first.headers.get("x-ratelimit-remaining")).toBe("9");
    const reset = Number(first.headers.get("x-ratelimit-reset"));
    expect(reset).toBeGreaterThan(Date.now() / 1000);
    expect(reset).toBeLessThanOrEqual(Date.now() / 1000 + 61);
    const second = await get("/customers", k.secret);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("8");
    // Error responses after authentication carry them too (a 404 and a 403 still cost a request).
    const notFound = await get("/customers/00000000-0000-4000-8000-000000000000", k.secret);
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("x-ratelimit-remaining")).toBe("7");
    const forbidden = await get("/invoices", k.secret);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("x-ratelimit-remaining")).toBe("6");
  });

  it("defaults to 60 per minute", async () => {
    const k = await makeKey(owner, ["contacts:read"]);
    const res = await get("/me", k.secret);
    expect(res.headers.get("x-ratelimit-limit")).toBe("60");
    expect(res.body.data.rate_limit.limit).toBe(60);
  });

  it("returns 429 with Retry-After and the headers once the limit is exceeded, only for that key, and recovers after the window", async () => {
    const k = await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 10 });
    const bystander = await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 10 });

    for (let i = 0; i < 10; i += 1) expect((await get("/me", k.secret)).status, `request ${i + 1}`).toBe(200);
    const limited = await get("/me", k.secret);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: "rate_limited", status: 429 });
    expect(limited.headers.get("content-type")).toContain("application/problem+json");
    expect(limited.headers.get("x-ratelimit-limit")).toBe("10");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(Number(limited.headers.get("x-ratelimit-reset"))).toBeGreaterThan(Date.now() / 1000);
    expect(limited.body.requestId).toBe(limited.headers.get("x-request-id"));

    // Another key (same organization) is unaffected.
    expect((await get("/me", bystander.secret)).status).toBe(200);
    // Still limited on the next try.
    expect((await get("/me", k.secret)).status).toBe(429);

    // The window passes (move it into the past; the database clock is what the counter uses).
    await admin.query("UPDATE api_rate_windows SET window_start = now() - interval '61 seconds' WHERE key_id = $1", [k.id]);
    const recovered = await get("/me", k.secret);
    expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-ratelimit-remaining")).toBe("9");
  });

  it("counts concurrent requests atomically (no lost updates)", async () => {
    const k = await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 100 });
    const results = await Promise.all(Array.from({ length: 12 }, () => get("/me", k.secret)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const { rows } = await admin.query("SELECT request_count FROM api_rate_windows WHERE key_id = $1", [k.id]);
    expect(rows[0].request_count).toBe(12);
    const remaining = results.map((r) => Number(r.headers.get("x-ratelimit-remaining"))).sort((a, b) => a - b);
    expect(remaining).toEqual(Array.from({ length: 12 }, (_, i) => 88 + i)); // each request saw a distinct count
  });

  it("invalid secrets for a real prefix never consume the real key's quota", async () => {
    const k = await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 10 });
    const forged = k.secret.slice(0, -1) + (k.secret.endsWith("A") ? "B" : "A");
    for (let i = 0; i < 15; i += 1) {
      const res = await call("GET", "/me", { key: forged, ip: `198.51.100.${i}` });
      expect(res.status).toBe(401);
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    }
    const real = await get("/me", k.secret);
    expect(real.status).toBe(200);
    expect(real.headers.get("x-ratelimit-remaining")).toBe("9");
  });

  it("repeated failures from one address are cut off with 429 BEFORE any database query", async () => {
    const k = await makeKey(owner, ["contacts:read"]);
    const forged = k.secret.slice(0, -1) + (k.secret.endsWith("A") ? "B" : "A");
    for (let i = 0; i < THROTTLE_MAX_FAILURES; i += 1) {
      expect((await call("GET", "/me", { key: forged, ip: "192.0.2.50" })).status).toBe(401);
    }
    const pg = await import("pg");
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      const blocked = await call("GET", "/me", { key: forged, ip: "192.0.2.50" });
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe("too_many_failed_attempts");
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(spy).not.toHaveBeenCalled();
      // Garbage that is not even shaped like a key is rejected with no query at all, from a fresh address.
      const garbage = await call("GET", "/me", { key: "not-a-key", ip: "192.0.2.51" });
      expect(garbage.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // A different address is unaffected.
    expect((await call("GET", "/me", { key: k.secret, ip: "192.0.2.99" })).status).toBe(200);
  });

  it("stamps last_used_at at most once a minute, so reads do not become writes", async () => {
    const k = await makeKey(owner, ["contacts:read"], { rateLimitPerMinute: 100 });
    const read = async () => (await admin.query("SELECT last_used_at FROM api_key_index WHERE id = $1", [k.id])).rows[0].last_used_at as Date | null;
    expect(await read()).toBeNull();
    await get("/me", k.secret);
    const first = await read();
    expect(first).toBeInstanceOf(Date);
    await get("/me", k.secret);
    await get("/me", k.secret);
    expect((await read())?.getTime()).toBe(first!.getTime()); // not rewritten within the minute
    await admin.query("UPDATE api_key_index SET last_used_at = now() - interval '2 minutes' WHERE id = $1", [k.id]);
    await get("/me", k.secret);
    expect((await read())!.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });
});
