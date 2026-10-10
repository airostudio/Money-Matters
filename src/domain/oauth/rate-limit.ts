import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { RATE_WINDOW_SECONDS, evaluateWindow, type RateLimitState } from "@/domain/api/rate-limit";

/**
 * Rate limiting for OAuth, on the SAME Postgres fixed-window mechanism as API keys (src/domain/api/rate-limit.ts): one
 * atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per request, window math by the database clock so every app
 * instance agrees, no Redis. The only differences are the key (a text bucket in `oauth_rate_windows`, so a grant, a
 * client and an IP address can share a table) and that SEVERAL buckets are advanced in ONE statement (the token endpoint
 * counts both the caller's address and the client id).
 *
 *   `api:<grant id>`        API requests made with an access token (default 60 / minute / grant)
 *   `tok:ip:<address>`      token + revocation endpoint calls from one address
 *   `tok:client:<client>`   token + revocation endpoint calls naming one client id
 */
export interface BucketRequest {
  bucket: string;
  limit: number;
}

export interface BucketResult extends RateLimitState {
  bucket: string;
}

/** Counts one request against every bucket (ONE statement). Results are in the order requested. */
export async function consumeBuckets(requests: readonly BucketRequest[], nowMs: number = Date.now()): Promise<BucketResult[]> {
  if (requests.length === 0) return [];
  const values = sql.join(requests.map((r) => sql`(${r.bucket}, now(), 1)`), sql`, `);
  const result = await db.execute<{ bucket: string; request_count: number; reset_in: string }>(sql`
    INSERT INTO oauth_rate_windows AS w (bucket, window_start, request_count)
    VALUES ${values}
    ON CONFLICT (bucket) DO UPDATE SET
      window_start = CASE WHEN w.window_start + make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision) <= now()
                          THEN now() ELSE w.window_start END,
      request_count = CASE WHEN w.window_start + make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision) <= now()
                           THEN 1 ELSE w.request_count + 1 END
    RETURNING w.bucket, w.request_count,
              EXTRACT(EPOCH FROM (w.window_start + make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision) - now())) AS reset_in
  `);
  const byBucket = new Map(result.rows.map((row) => [row.bucket, row]));
  return requests.map((r) => {
    const row = byBucket.get(r.bucket);
    if (!row) throw new Error("OAuth rate-limit counter returned no row.");
    return { bucket: r.bucket, ...evaluateWindow(Number(row.request_count), r.limit, Number(row.reset_in), nowMs) };
  });
}

export async function consumeBucket(bucket: string, limit: number, nowMs: number = Date.now()): Promise<RateLimitState> {
  const [result] = await consumeBuckets([{ bucket, limit }], nowMs);
  if (!result) throw new Error("OAuth rate-limit counter returned no row.");
  return result;
}

/** Deletes counters whose window ended over an hour ago (bounded table). Called rarely, after the response is decided. */
export async function purgeStaleBuckets(): Promise<void> {
  await db.execute(sql`DELETE FROM oauth_rate_windows WHERE window_start < now() - interval '1 hour'`);
}
