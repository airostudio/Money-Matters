import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { authEvents, loginThrottles, users } from "@/db/schema";
import { LoginService } from "@/domain/auth/login-service";
import { authOptions, LOGIN_LOCKED_PREFIX } from "@/lib/auth";
import { emailHash, ipHash, type RequestContext } from "@/domain/auth/request-context";
import { ACCOUNT_POLICY, IP_POLICY, lockSecondsForLevel } from "@/domain/auth/login-throttle";
import { adminDb, closeTestPools, createTestUser, pgMessage, resetDatabase } from "../../helpers/db";

const PASSWORD = "correct horse battery";
const CTX: RequestContext = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36" };
let passwordHash: string;

async function userWithPassword(label = "Login") {
  const u = await createTestUser(label);
  await db.update(users).set({ passwordHash }).where(eq(users.id, u.id));
  return u;
}

async function failTimes(email: string, n: number, ctx: RequestContext = CTX) {
  for (let i = 0; i < n; i += 1) await LoginService.authenticate({ email, password: "wrong-password", context: ctx });
}

async function bucket(email: string) {
  const [row] = await adminDb().select().from(loginThrottles).where(eq(loginThrottles.bucket, `acct:${emailHash(email)}`));
  return row;
}

async function age(email: string, patch: { windowSecondsAgo?: number; lockedUntilSecondsFromNow?: number | null }) {
  const b = `acct:${emailHash(email)}`;
  if (patch.windowSecondsAgo !== undefined) {
    await adminDb().execute(sql`UPDATE login_throttles SET window_start = now() - make_interval(secs => ${patch.windowSecondsAgo}) WHERE bucket = ${b}`);
  }
  if (patch.lockedUntilSecondsFromNow !== undefined) {
    if (patch.lockedUntilSecondsFromNow === null) {
      await adminDb().execute(sql`UPDATE login_throttles SET locked_until = NULL WHERE bucket = ${b}`);
    } else {
      await adminDb().execute(sql`UPDATE login_throttles SET locked_until = now() + make_interval(secs => ${patch.lockedUntilSecondsFromNow}) WHERE bucket = ${b}`);
    }
  }
}

// Every sign-in attempt pays a real bcrypt (work factor 12), so the multi-attempt scenarios need room.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("Login security: throttling, lockout, uniform responses, audit", () => {
  beforeAll(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 12);
  });
  afterAll(async () => {
    await closeTestPools();
  });
  beforeEach(async () => {
    await resetDatabase();
    vi.restoreAllMocks();
  });

  it("lock policy maths: 15 minutes doubling, capped at 24 hours", () => {
    expect([0, 1, 2, 3].map((l) => lockSecondsForLevel(ACCOUNT_POLICY, l))).toEqual([900, 1800, 3600, 7200]);
    expect(lockSecondsForLevel(ACCOUNT_POLICY, 10)).toBe(24 * 3600);
    expect(lockSecondsForLevel(ACCOUNT_POLICY, 99)).toBe(24 * 3600);
  });

  it("4 failures do not lock; the 5th starts a 15 minute lock; the next attempt is refused even with the right password", async () => {
    const u = await userWithPassword();
    await failTimes(u.email, 4);
    expect((await bucket(u.email))?.lockedUntil).toBeNull();
    // Still can sign in with the right password after 4 failures (and that clears the counter).
    const okAfterFour = await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX });
    expect(okAfterFour.status).toBe("ok");
    expect(await bucket(u.email)).toBeUndefined();

    await failTimes(u.email, 5);
    const row = await bucket(u.email);
    expect(row?.lockedUntil).not.toBeNull();
    expect(row!.lockLevel).toBe(1);
    const secs = (row!.lockedUntil!.getTime() - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(890);
    expect(secs).toBeLessThanOrEqual(900);

    const refused = await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX });
    expect(refused.status).toBe("locked");
    if (refused.status === "locked") expect(refused.retryAfterSeconds).toBeGreaterThan(880);
  });

  it("lock boundary: still locked 1s before the end, signed in 1s after", async () => {
    const u = await userWithPassword();
    await failTimes(u.email, 5);
    await age(u.email, { lockedUntilSecondsFromNow: 2 });
    expect((await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX })).status).toBe("locked");
    await age(u.email, { lockedUntilSecondsFromNow: -1 });
    expect((await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX })).status).toBe("ok");
  });

  it("a locked bucket is not advanced by refused attempts and refused attempts write no rows", async () => {
    const u = await userWithPassword();
    await failTimes(u.email, 5);
    const eventsBefore = (await adminDb().select().from(authEvents)).length;
    const before = await bucket(u.email);
    for (let i = 0; i < 3; i += 1) await LoginService.authenticate({ email: u.email, password: "nope", context: CTX });
    const after = await bucket(u.email);
    expect(after?.failures).toBe(before?.failures);
    expect(after?.lockLevel).toBe(before?.lockLevel);
    expect(after?.lockedUntil?.getTime()).toBe(before?.lockedUntil?.getTime());
    expect((await adminDb().select().from(authEvents)).length).toBe(eventsBefore);
  });

  it("consecutive lockouts double: 15, then 30 minutes; the level decays after 24 hours of quiet", async () => {
    const u = await userWithPassword();
    await failTimes(u.email, 5);
    await age(u.email, { lockedUntilSecondsFromNow: -5 });
    await failTimes(u.email, 5);
    let row = await bucket(u.email);
    expect(row!.lockLevel).toBe(2);
    let secs = (row!.lockedUntil!.getTime() - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(1780);
    expect(secs).toBeLessThanOrEqual(1800);

    // 24h + a bit after the lock ended, the next lockout is a first-level one again.
    await age(u.email, { lockedUntilSecondsFromNow: -(24 * 3600 + 60), windowSecondsAgo: 3 * 24 * 3600 });
    await failTimes(u.email, 5);
    row = await bucket(u.email);
    expect(row!.lockLevel).toBe(1);
    secs = (row!.lockedUntil!.getTime() - Date.now()) / 1000;
    expect(secs).toBeLessThanOrEqual(900);
  });

  it("window boundary: failures older than the 15 minute window start counting again", async () => {
    const u = await userWithPassword();
    await failTimes(u.email, 4);
    await age(u.email, { windowSecondsAgo: ACCOUNT_POLICY.windowSeconds + 1 });
    await failTimes(u.email, 1);
    const row = await bucket(u.email);
    expect(row?.failures).toBe(1);
    expect(row?.lockedUntil).toBeNull();

    // Just inside the window the old failures still count: 4 + 1 trips the lock.
    await resetDatabase();
    const v = await userWithPassword("Window");
    await failTimes(v.email, 4);
    await age(v.email, { windowSecondsAgo: ACCOUNT_POLICY.windowSeconds - 5 });
    await failTimes(v.email, 1);
    expect((await bucket(v.email))?.lockedUntil).not.toBeNull();
  });

  it("an unknown email is throttled and locked exactly like a real one (no account-existence oracle)", async () => {
    const real = await userWithPassword();
    const ghost = "nobody.here@example.test";
    const outcomesReal: string[] = [];
    const outcomesGhost: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      outcomesReal.push((await LoginService.authenticate({ email: real.email, password: "wrong", context: { ...CTX, ip: `198.51.100.${i}` } })).status);
      outcomesGhost.push((await LoginService.authenticate({ email: ghost, password: "wrong", context: { ...CTX, ip: `198.51.100.${i}` } })).status);
    }
    expect(outcomesGhost).toEqual(outcomesReal);
    expect(outcomesReal).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid", "locked", "locked"]);
  });

  it("wrong password, unknown email and a suspended account are the same outcome", async () => {
    const real = await userWithPassword();
    const suspended = await userWithPassword("Suspended");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, suspended.id));
    const a = await LoginService.authenticate({ email: real.email, password: "wrong", context: CTX });
    const b = await LoginService.authenticate({ email: "ghost@example.test", password: "wrong", context: CTX });
    const c = await LoginService.authenticate({ email: suspended.email, password: PASSWORD, context: CTX });
    expect([a, b, c]).toEqual([{ status: "invalid" }, { status: "invalid" }, { status: "invalid" }]);
  });

  it("uniform cost: bcrypt runs exactly once for an unknown email, a wrong password and a right one", async () => {
    const real = await userWithPassword();
    const spy = vi.spyOn(bcrypt, "compare");
    await LoginService.authenticate({ email: "ghost@example.test", password: "x", context: CTX });
    expect(spy).toHaveBeenCalledTimes(1);
    await LoginService.authenticate({ email: real.email, password: "x", context: CTX });
    expect(spy).toHaveBeenCalledTimes(2);
    await LoginService.authenticate({ email: real.email, password: PASSWORD, context: CTX });
    expect(spy).toHaveBeenCalledTimes(3);
    // And the hash compared for an unknown email has the production work factor.
    const unknownHash = spy.mock.calls[0]![1] as string;
    expect(unknownHash.startsWith("$2a$12$")).toBe(true);
  });

  it("per-address throttle: 30 failures across different emails lock that address for everyone behind it", async () => {
    const real = await userWithPassword();
    for (let i = 0; i < IP_POLICY.maxFailures; i += 1) {
      await LoginService.authenticate({ email: `spray${i}@example.test`, password: "wrong", context: CTX });
    }
    const attempt = await LoginService.authenticate({ email: real.email, password: PASSWORD, context: CTX });
    expect(attempt.status).toBe("locked");
    // The same correct credentials from another address are fine.
    const other = await LoginService.authenticate({ email: real.email, password: PASSWORD, context: { ...CTX, ip: "198.51.100.99" } });
    expect(other.status).toBe("ok");
  });

  it("success clears the account counter and stamps last_login_at; lock events are audited", async () => {
    const u = await userWithPassword();
    await failTimes(u.email, 5);
    await age(u.email, { lockedUntilSecondsFromNow: -1 });
    const ok = await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX });
    expect(ok.status).toBe("ok");
    expect(await bucket(u.email)).toBeUndefined();
    const [row] = await db.select({ lastLoginAt: users.lastLoginAt }).from(users).where(eq(users.id, u.id));
    expect(row?.lastLoginAt).toBeInstanceOf(Date);
    const events = await adminDb().select().from(authEvents);
    const kinds = events.map((e) => e.event);
    expect(kinds.filter((k) => k === "login_failed")).toHaveLength(5);
    expect(kinds).toContain("login_locked");
    expect(kinds).toContain("login_success");
  });

  it("audit rows hold no raw email, address or full user agent; new device/location is flagged only after a first sign-in", async () => {
    const u = await userWithPassword();
    await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX });
    await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX });
    await LoginService.authenticate({ email: u.email, password: PASSWORD, context: { ip: "203.0.113.200", userAgent: CTX.userAgent } });
    await LoginService.authenticate({ email: u.email, password: PASSWORD, context: { ip: "198.51.100.5", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15" } });
    const events = (await adminDb().select().from(authEvents).orderBy(authEvents.createdAt)).filter((e) => e.event === "login_success");
    // 1st: nothing to compare with; 2nd: same device+network; 3rd: same /24 -> same location; 4th: new family AND network.
    expect(events.map((e) => e.newDevice)).toEqual([false, false, false, true]);
    expect(events[0]!.userAgentFamily).toBe("Chrome on Windows");
    expect(events[3]!.userAgentFamily).toBe("Safari on macOS");
    const dump = JSON.stringify(await adminDb().select().from(authEvents)) + JSON.stringify(await adminDb().select().from(loginThrottles));
    expect(dump).not.toContain(u.email);
    expect(dump).not.toContain("203.0.113");
    expect(dump).not.toContain("198.51.100");
    expect(dump).not.toContain("Mozilla");
    expect(events[0]!.emailHash).toBe(emailHash(u.email));
    expect(events[0]!.ipHash).toBe(ipHash(CTX.ip));
  });

  it("is case/space-insensitive on the email for throttling (one account, one bucket)", async () => {
    const u = await userWithPassword();
    for (let i = 0; i < 5; i += 1) {
      await LoginService.authenticate({ email: i % 2 ? ` ${u.email.toUpperCase()} ` : u.email, password: "wrong", context: CTX });
    }
    expect((await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX })).status).toBe("locked");
  });

  it("NextAuth authorize: returns a user on success, null on failure, and a coded error when locked", async () => {
    const u = await userWithPassword();
    const provider = authOptions.providers[0] as unknown as {
      options: { authorize: (c: Record<string, string>, req: { headers: Record<string, string> }) => Promise<unknown> };
    };
    const req = { headers: { "x-forwarded-for": "203.0.113.50, 10.0.0.1", "user-agent": CTX.userAgent } };
    expect(await provider.options.authorize({ email: u.email, password: PASSWORD }, req)).toMatchObject({ id: u.id, email: u.email });
    for (let i = 0; i < 5; i += 1) expect(await provider.options.authorize({ email: u.email, password: "wrong" }, req)).toBeNull();
    await expect(provider.options.authorize({ email: u.email, password: PASSWORD }, req)).rejects.toThrow(LOGIN_LOCKED_PREFIX);
    // The address recorded is the first hop of X-Forwarded-For, hashed.
    const [row] = await adminDb().select().from(authEvents).where(eq(authEvents.event, "login_success"));
    expect(row?.ipHash).toBe(ipHash("203.0.113.50"));
  });

  it("grants: auth_events is append-only and the throttle table cannot be read for personal data", async () => {
    const u = await userWithPassword();
    await LoginService.authenticate({ email: u.email, password: PASSWORD, context: CTX });
    expect(await pgMessage(db.execute(sql`UPDATE auth_events SET event = 'x'`))).toMatch(/permission denied/);
    expect(await pgMessage(db.execute(sql`DELETE FROM auth_events`))).toMatch(/permission denied/);
    expect(await pgMessage(db.execute(sql`TRUNCATE auth_events`))).toMatch(/permission denied/);
  });
});
