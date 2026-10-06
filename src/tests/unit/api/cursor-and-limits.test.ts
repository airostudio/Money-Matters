import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@/domain/api/cursor";
import { ApiError } from "@/domain/api/errors";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MAX_RATE_LIMIT_PER_MINUTE,
  MIN_RATE_LIMIT_PER_MINUTE,
  assertValidRateLimit,
  evaluateWindow,
  resolveLimit,
} from "@/domain/api/rate-limit";
import { AuthThrottle, clientAddress } from "@/domain/api/auth-throttle";
import { canonicalJson, isExpired, parseIdempotencyKey, requestHash, IDEMPOTENCY_RETENTION_MS } from "@/domain/api/idempotency";

const SECRET = "unit-test-secret";
const ORG = "11111111-1111-4111-8111-111111111111";
const scope = { organizationId: ORG, query: "invoices.list|status=DRAFT" };
const position = { t: "2026-03-10T09:30:00.123456Z", i: "22222222-2222-4222-8222-222222222222" };

function expectInvalidCursor(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    expect((e as ApiError).code).toBe("invalid_cursor");
    return;
  }
  throw new Error("expected invalid_cursor");
}

describe("pagination cursors", () => {
  it("round-trips an opaque, versioned token", () => {
    const c = encodeCursor(position, scope, SECRET);
    expect(c.startsWith("c1.")).toBe(true);
    expect(c).not.toContain(position.i); // opaque: the id is inside base64url, not readable
    expect(decodeCursor(c, scope, SECRET)).toEqual(position);
  });

  it("rejects tampering with the payload, the signature or the version", () => {
    const c = encodeCursor(position, scope, SECRET);
    const [v, payload, sig] = c.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ o: ORG, q: scope.query, t: "2000-01-01T00:00:00.000000Z", i: position.i })).toString("base64url");
    expectInvalidCursor(() => decodeCursor(`${v}.${forged}.${sig}`, scope, SECRET));
    expectInvalidCursor(() => decodeCursor(`${v}.${payload}.${sig.slice(0, -2)}AA`, scope, SECRET));
    expectInvalidCursor(() => decodeCursor(`c2.${payload}.${sig}`, scope, SECRET));
    expectInvalidCursor(() => decodeCursor(`${v}.${payload}`, scope, SECRET));
    expectInvalidCursor(() => decodeCursor(c, scope, "another-secret"));
  });

  it("is bound to the organization and to the exact endpoint + filters that produced it", () => {
    const c = encodeCursor(position, scope, SECRET);
    expectInvalidCursor(() => decodeCursor(c, { ...scope, organizationId: "33333333-3333-4333-8333-333333333333" }, SECRET));
    expectInvalidCursor(() => decodeCursor(c, { ...scope, query: "invoices.list|status=PAID" }, SECRET));
    expectInvalidCursor(() => decodeCursor(c, { ...scope, query: "bills.list|status=DRAFT" }, SECRET));
  });

  it("rejects garbage and oversized input without throwing anything but invalid_cursor", () => {
    for (const bad of ["", "x", "a.b.c", "c1..", "c1.!!!.???", "c1." + "A".repeat(700) + ".AAAA", "💥"]) {
      expectInvalidCursor(() => decodeCursor(bad, scope, SECRET));
    }
  });

  it("refuses a validly SIGNED cursor whose contents are not a timestamp and a UUID (no SQL fragment can ride in a cursor)", () => {
    expectInvalidCursor(() => decodeCursor(encodeCursor({ t: "not a date", i: position.i }, scope, SECRET), scope, SECRET));
    expectInvalidCursor(() => decodeCursor(encodeCursor({ t: position.t, i: "'; drop table invoices;--" }, scope, SECRET), scope, SECRET));
    expectInvalidCursor(() => decodeCursor(encodeCursor({ t: "2026-03-10T09:30:00.123Z", i: position.i }, scope, SECRET), scope, SECRET));
  });
});

describe("rate limit window math", () => {
  it("defaults to 60/min and clamps any per-key override into the platform bounds", () => {
    expect(DEFAULT_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(resolveLimit(null)).toBe(60);
    expect(resolveLimit(undefined)).toBe(60);
    expect(resolveLimit(120)).toBe(120);
    expect(resolveLimit(1)).toBe(MIN_RATE_LIMIT_PER_MINUTE);
    expect(resolveLimit(10_000_000)).toBe(MAX_RATE_LIMIT_PER_MINUTE);
    expect(resolveLimit(Number.NaN)).toBe(60);
    expect(resolveLimit(99.9)).toBe(99);
  });

  it("validates a typed limit strictly", () => {
    expect(() => assertValidRateLimit(60)).not.toThrow();
    for (const bad of [0, 9, 601, 1.5, Number.NaN, -1]) expect(() => assertValidRateLimit(bad), String(bad)).toThrow();
  });

  it("allows up to and including the limit, then rejects; remaining never goes negative", () => {
    const now = 1_700_000_000_000;
    expect(evaluateWindow(1, 60, 59.2, now)).toMatchObject({ allowed: true, remaining: 59, limit: 60, resetInSeconds: 60 });
    expect(evaluateWindow(60, 60, 5, now)).toMatchObject({ allowed: true, remaining: 0 });
    const over = evaluateWindow(61, 60, 5, now);
    expect(over).toMatchObject({ allowed: false, remaining: 0, resetInSeconds: 5 });
    expect(over.resetAt).toBe(Math.floor(now / 1000) + 5);
  });

  it("never reports a zero Retry-After", () => {
    expect(evaluateWindow(100, 60, 0, 0).resetInSeconds).toBe(1);
    expect(evaluateWindow(100, 60, -3, 0).resetInSeconds).toBe(1);
  });
});

describe("per-IP failure throttle", () => {
  it("cuts a client off after repeated failures, only for the window, and a success clears it", () => {
    const t = new AuthThrottle(3, 1000, 100);
    const ip = "198.51.100.1";
    expect(t.retryAfterSeconds(ip, 0)).toBe(0);
    t.recordFailure(ip, 0);
    t.recordFailure(ip, 10);
    expect(t.retryAfterSeconds(ip, 20)).toBe(0);
    t.recordFailure(ip, 30);
    expect(t.retryAfterSeconds(ip, 40)).toBeGreaterThan(0);
    expect(t.retryAfterSeconds("198.51.100.2", 40)).toBe(0); // other clients unaffected
    expect(t.retryAfterSeconds(ip, 1500)).toBe(0); // window over
    t.recordFailure(ip, 2000);
    t.recordFailure(ip, 2001);
    t.recordFailure(ip, 2002);
    expect(t.retryAfterSeconds(ip, 2003)).toBeGreaterThan(0);
    t.recordSuccess(ip);
    expect(t.retryAfterSeconds(ip, 2004)).toBe(0);
  });

  it("is bounded in memory", () => {
    const t = new AuthThrottle(3, 60_000, 50);
    for (let i = 0; i < 500; i += 1) t.recordFailure(`ip-${i}`, i);
    expect(t.size).toBeLessThanOrEqual(50);
  });

  it("reads the first X-Forwarded-For hop, else X-Real-IP, else a shared bucket", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientAddress(new Headers({ "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.10");
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});

describe("idempotency request identity", () => {
  it("canonicalises JSON so key order and whitespace do not matter, but values and structure do", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson({ a: "1" })).not.toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
  });

  it("hashes method + path + canonical body", () => {
    const base = requestHash("POST", "/api/v1/invoices", { a: 1, b: 2 });
    expect(requestHash("post", "/api/v1/invoices", { b: 2, a: 1 })).toBe(base);
    expect(requestHash("POST", "/api/v1/bills", { a: 1, b: 2 })).not.toBe(base);
    expect(requestHash("POST", "/api/v1/invoices", { a: 1, b: 3 })).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts 1-255 printable ASCII keys and refuses anything else", () => {
    expect(parseIdempotencyKey(null)).toBeNull();
    expect(parseIdempotencyKey("  order-123  ")).toBe("order-123");
    expect(parseIdempotencyKey("a".repeat(255))).toHaveLength(255);
    for (const bad of ["", "   ", "a".repeat(256), "has space", "tab\there", "é", "line\nbreak"]) {
      expect(() => parseIdempotencyKey(bad), JSON.stringify(bad)).toThrow(ApiError);
    }
  });

  it("retains records for 24 hours", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    expect(isExpired(created, new Date(created.getTime() + IDEMPOTENCY_RETENTION_MS - 1))).toBe(false);
    expect(isExpired(created, new Date(created.getTime() + IDEMPOTENCY_RETENTION_MS))).toBe(true);
  });
});
