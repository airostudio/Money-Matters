import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/**
 * Per-key rate limiting without Redis: a FIXED WINDOW counter held in Postgres, one row per key
 * (`api_rate_windows`), advanced by ONE atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per request.
 *
 *  - Default 60 requests per 60-second window per key. A key may carry its own limit
 *    (`api_keys.rate_limit_per_minute`) within the platform bounds below; `resolveLimit` clamps whatever is stored.
 *  - The window opens at the first request after the previous one expired and lasts `RATE_WINDOW_SECONDS`;
 *    `X-RateLimit-Reset` / `Retry-After` come straight from that, computed by the database clock, so every
 *    app instance agrees (no per-instance state, no clock skew between instances).
 *  - A fixed window allows a burst of up to 2x the limit straddling a window boundary. That is the accepted
 *    trade-off for a single-statement, lock-light counter; the limit protects the database from a runaway
 *    integration, it is not a billing meter.
 *  - The same statement also stamps `api_key_index.last_used_at`, but only when it is more than a minute old,
 *    so a read-only integration does not turn every GET into a write on the index (docs/security.md s.15).
 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const MIN_RATE_LIMIT_PER_MINUTE = 10;
export const MAX_RATE_LIMIT_PER_MINUTE = 600;
export const RATE_WINDOW_SECONDS = 60;

/** The effective limit for a key: its override clamped into the platform bounds, else the default. */
export function resolveLimit(override: number | null | undefined): number {
  if (override === null || override === undefined || !Number.isFinite(override)) return DEFAULT_RATE_LIMIT_PER_MINUTE;
  return Math.min(MAX_RATE_LIMIT_PER_MINUTE, Math.max(MIN_RATE_LIMIT_PER_MINUTE, Math.floor(override)));
}

export class InvalidRateLimitError extends Error {
  constructor() {
    super(`The rate limit must be a whole number between ${MIN_RATE_LIMIT_PER_MINUTE} and ${MAX_RATE_LIMIT_PER_MINUTE} requests per minute.`);
    this.name = "InvalidRateLimitError";
  }
}

/** Validates a limit a person typed when creating a key (strict; unlike `resolveLimit` it does not clamp). */
export function assertValidRateLimit(value: number): void {
  if (!Number.isInteger(value) || value < MIN_RATE_LIMIT_PER_MINUTE || value > MAX_RATE_LIMIT_PER_MINUTE) {
    throw new InvalidRateLimitError();
  }
}

export interface RateLimitState {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window resets (always >= 1 when rejecting, so `Retry-After` is never 0). */
  resetInSeconds: number;
  /** Unix seconds at which the window resets. */
  resetAt: number;
}

/** Pure window math: given the count AFTER this request was counted, decide and describe. */
export function evaluateWindow(count: number, limit: number, resetInSeconds: number, nowMs: number): RateLimitState {
  const reset = Math.max(1, Math.ceil(resetInSeconds));
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetInSeconds: reset,
    resetAt: Math.floor(nowMs / 1000) + reset,
  };
}

/** Counts one request against `keyId`'s window (one SQL statement) and reports the resulting state. */
export async function consumeRateLimit(keyId: string, limit: number, nowMs: number = Date.now()): Promise<RateLimitState> {
  const result = await db.execute<{ request_count: number; reset_in: string }>(sql`
    WITH rl AS (
      INSERT INTO api_rate_windows AS w (key_id, window_start, request_count)
      VALUES (${keyId}::uuid, now(), 1)
      ON CONFLICT (key_id) DO UPDATE SET
        window_start = CASE WHEN w.window_start + make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision) <= now()
                            THEN now() ELSE w.window_start END,
        request_count = CASE WHEN w.window_start + make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision) <= now()
                             THEN 1 ELSE w.request_count + 1 END
      RETURNING w.request_count, w.window_start
    ), touch AS (
      UPDATE api_key_index SET last_used_at = now()
      WHERE id = ${keyId}::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
      RETURNING 1
    )
    SELECT request_count,
           EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision) - now())) AS reset_in
    FROM rl
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Rate-limit counter returned no row.");
  return evaluateWindow(Number(row.request_count), limit, Number(row.reset_in), nowMs);
}
