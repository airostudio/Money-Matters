import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";

/**
 * Failed-sign-in throttling with temporary, exponentially growing lockouts, held in Postgres (`login_throttles`) so every
 * serverless instance agrees and nothing lives in process memory. The same fixed-window-upsert idea as
 * src/domain/api/rate-limit.ts, extended with a lock: ONE atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per
 * counted failure, all time arithmetic on the database clock (no clock skew between instances).
 *
 *   per account (keyed HMAC of the normalised email; exists for unknown emails too, so a lockout reveals nothing):
 *     5 failures within a 15-minute window -> locked 15 minutes; each consecutive lockout doubles (15, 30, 60 ... min),
 *     capped at 24 hours. The level decays back to zero after 24 hours without a lockout, and a successful sign-in clears
 *     the account's counter.
 *   per address (keyed HMAC of the client address): 30 failures within 15 minutes -> locked 15 minutes (same doubling).
 *     Deliberately higher than the account limit so an office behind one address is not locked out by a few typos.
 *
 * Only FAILURES are counted, and a locked bucket is not advanced further (the attempt is refused before any password
 * work), so an attacker cannot extend a victim's lock cheaply and the table stays bounded. Trade-off, accepted and
 * documented in docs/security.md section 22: anyone can lock a known email by failing 5 times (a temporary
 * denial-of-service on that account). The owner's recovery is waiting out the lock, or a platform admin.
 */
export interface ThrottlePolicy {
  maxFailures: number;
  windowSeconds: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
}

export const ACCOUNT_POLICY: ThrottlePolicy = { maxFailures: 5, windowSeconds: 15 * 60, baseLockSeconds: 15 * 60, maxLockSeconds: 24 * 3600 };
export const IP_POLICY: ThrottlePolicy = { maxFailures: 30, windowSeconds: 15 * 60, baseLockSeconds: 15 * 60, maxLockSeconds: 24 * 3600 };
/** A lock level older than this (measured from the end of the last lock) is forgotten. */
export const LEVEL_DECAY_SECONDS = 24 * 3600;
/** Rows untouched for this long are deleted (opportunistically, on a small fraction of failures). */
export const STALE_ROW_DAYS = 3;

export interface ThrottleState {
  failures: number;
  /** Seconds until the lock ends; 0 when not locked. */
  lockedForSeconds: number;
  lockLevel: number;
  /** True only for the failure that has just started a lock. */
  justLocked: boolean;
}

/** Pure description of the lock length for a given level (testable without a database). */
export function lockSecondsForLevel(policy: ThrottlePolicy, level: number): number {
  return Math.min(policy.maxLockSeconds, policy.baseLockSeconds * 2 ** Math.min(Math.max(level, 0), 20));
}

/**
 * Longest remaining lock across the buckets, in seconds (0 = none locked). One SELECT, no writes. The database clock
 * decides, so this and `recordFailure` can never disagree about whether a lock has ended.
 */
export async function remainingLockSeconds(buckets: readonly string[]): Promise<number> {
  if (buckets.length === 0) return 0;
  const list = sql.join(buckets.map((b) => sql`${b}`), sql`, `);
  const result = await db.execute<{ secs: string | null }>(sql`
    SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (locked_until - now()))), 0) AS secs
    FROM login_throttles
    WHERE bucket IN (${list}) AND locked_until IS NOT NULL AND locked_until > now()
  `);
  return Math.max(0, Math.ceil(Number(result.rows[0]?.secs ?? 0)));
}

/** Counts ONE failure against `bucket` and starts a lock when the policy's limit is reached (one atomic statement). */
export async function recordFailure(bucket: string, policy: ThrottlePolicy): Promise<ThrottleState> {
  const W = policy.windowSeconds;
  const M = policy.maxFailures;
  const locked: SQL = sql`(t.locked_until IS NOT NULL AND t.locked_until > now())`;
  const expired: SQL = sql`(t.window_start + make_interval(secs => ${W}::double precision) <= now())`;
  // The lock level to build on: forgotten once the last lock ended more than LEVEL_DECAY_SECONDS ago.
  const baseLevel: SQL = sql`(CASE WHEN t.locked_until IS NOT NULL
      AND t.locked_until + make_interval(secs => ${LEVEL_DECAY_SECONDS}::double precision) < now()
    THEN 0 ELSE t.lock_level END)`;
  const tripping: SQL = sql`(NOT ${locked} AND NOT ${expired} AND t.failures + 1 >= ${M})`;

  const result = await db.execute<{ failures: number; lock_level: number; lock_secs: string | null; tripped: boolean }>(sql`
    INSERT INTO login_throttles AS t (bucket, failures, window_start, locked_until, lock_level, updated_at)
    VALUES (${bucket}, 1, now(), NULL, 0, now())
    ON CONFLICT (bucket) DO UPDATE SET
      failures = CASE WHEN ${locked} THEN t.failures
                      WHEN ${expired} THEN 1
                      WHEN ${tripping} THEN 0
                      ELSE t.failures + 1 END,
      window_start = CASE WHEN ${locked} THEN t.window_start
                          WHEN ${expired} OR ${tripping} THEN now()
                          ELSE t.window_start END,
      lock_level = CASE WHEN ${tripping} THEN ${baseLevel} + 1
                        WHEN ${locked} THEN t.lock_level
                        ELSE ${baseLevel} END,
      locked_until = CASE WHEN ${tripping}
                          THEN now() + make_interval(secs => LEAST(${policy.maxLockSeconds}::double precision,
                                 ${policy.baseLockSeconds}::double precision * power(2, LEAST(${baseLevel}, 20))))
                          ELSE t.locked_until END,
      updated_at = now()
    RETURNING t.failures, t.lock_level,
      -- RETURNING sees the NEW row: a lock started by THIS statement is the only state with zero failures, a window opened
      -- right now (now() is the statement's own timestamp, so the comparison is exact) and a live lock.
      (t.failures = 0 AND t.window_start = now() AND t.locked_until > now()) AS tripped,
      CASE WHEN t.locked_until > now() THEN EXTRACT(EPOCH FROM (t.locked_until - now())) ELSE 0 END AS lock_secs
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Login throttle returned no row.");
  return {
    failures: Number(row.failures),
    lockedForSeconds: Math.max(0, Math.ceil(Number(row.lock_secs ?? 0))),
    lockLevel: Number(row.lock_level),
    justLocked: Boolean(row.tripped),
  };
}

/** A successful sign-in clears the account's counter and lock level. */
export async function clearBucket(bucket: string): Promise<void> {
  await db.execute(sql`DELETE FROM login_throttles WHERE bucket = ${bucket}`);
}

/** Bounded table: delete counters nobody has touched for STALE_ROW_DAYS. Cheap (indexed); called rarely. */
export async function purgeStaleThrottles(): Promise<void> {
  await db.execute(sql`
    DELETE FROM login_throttles
    WHERE updated_at < now() - make_interval(days => ${STALE_ROW_DAYS}) AND (locked_until IS NULL OR locked_until < now())
  `);
}
