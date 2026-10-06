import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { apiIdempotencyKeys } from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { apiErrors } from "./errors";

/**
 * Idempotency for API POSTs: a network retry must never create a second invoice.
 *
 * DESIGN (docs/security.md section 15 / docs/api.md):
 *  - The idempotency row is INSERTED FIRST, inside the SAME transaction as the work it protects, under a unique
 *    index on (organization, API key, Idempotency-Key). Two simultaneous identical requests therefore serialise on
 *    that index: the second INSERT waits for the first transaction, and when the first commits it finds the row,
 *    sees the same request hash and REPLAYS the stored response (`Idempotent-Replayed: true`) without running the
 *    work again. Exactly one invoice exists - proved by a real-database concurrency test.
 *  - Because the row and the work commit or roll back together, there is no "in progress" row that a crash could
 *    strand (no half-state to garbage-collect and no stuck key): IN_PROGRESS is simply "the first transaction has
 *    not committed yet", visible to a duplicate as a bounded lock wait. If the wait exceeds `LOCK_WAIT_MS` the
 *    duplicate gets 409 `idempotency_in_progress` + Retry-After instead of hanging a pooled connection.
 *  - The same key with a DIFFERENT request (method, path or body) is refused with 422 `idempotency_key_reuse`.
 *  - Only SUCCESSFUL responses are stored: a failed request (validation, locked period, permission) rolls back,
 *    stores nothing, and may be retried with the same key once the cause is fixed.
 *  - Keys are scoped per API key (two keys may use the same string independently) and retained 24 hours.
 *    Expiry is lazy: an expired row met on a conflict is replaced, and `purgeExpired` deletes old rows (run
 *    opportunistically on writes at most every `PURGE_INTERVAL_MS` per organization per instance, and callable
 *    on demand - there is no job queue to schedule it).
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
export const LOCK_WAIT_MS = 5_000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;
const PURGE_BATCH = 200;

/** JSON with object keys sorted recursively, so key order and whitespace never change a request's identity. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body ?? null)}`).digest("hex");
}

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** Validates an `Idempotency-Key` header value: 1-255 printable ASCII characters (no spaces). */
export function parseIdempotencyKey(header: string | null): string | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (!KEY_PATTERN.test(trimmed)) throw apiErrors.idempotencyKeyInvalid();
  return trimmed;
}

export function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= IDEMPOTENCY_RETENTION_MS;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotentResult extends StoredResponse {
  replayed: boolean;
}

function isLockTimeout(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.code ?? e.cause?.code) === "55P03";
}

const lastPurge = new Map<string, number>();

/** Deletes this organization's expired idempotency rows (at most `PURGE_BATCH` per call). Safe to call on demand. */
export async function purgeExpiredInTx(tx: TenantDb, organizationId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS);
  const result = await tx.execute(sql`
    DELETE FROM api_idempotency_keys
    WHERE id IN (
      SELECT id FROM api_idempotency_keys
      WHERE organization_id = ${organizationId}::uuid AND created_at < ${cutoff.toISOString()}::timestamptz
      LIMIT ${PURGE_BATCH}
    )
  `);
  return result.rowCount ?? 0;
}

export const ApiIdempotencyService = {
  /** On-demand cleanup of one organization's expired records. */
  async purgeExpired(organizationId: string, now: Date = new Date()): Promise<number> {
    return withTenant(organizationId, (tx) => purgeExpiredInTx(tx, organizationId, now));
  },
};

/**
 * Runs `work` exactly once for (organization, API key, idempotency key): see the file comment. `work` receives the
 * SAME transaction, so the created document, its audit rows and the idempotency record are one atomic unit.
 */
export async function runIdempotent(
  scope: { organizationId: string; apiKeyId: string },
  idempotencyKey: string,
  hash: string,
  work: (tx: TenantDb) => Promise<StoredResponse>,
  now: Date = new Date(),
): Promise<IdempotentResult> {
  try {
    return await withTenant(scope.organizationId, async (tx) => {
      // Bound the wait on a concurrent identical request (and only that: reset right after the insert).
      await tx.execute(sql`SELECT set_config('lock_timeout', ${String(LOCK_WAIT_MS)}, true)`);

      let [claimed] = await tx
        .insert(apiIdempotencyKeys)
        .values({ organizationId: scope.organizationId, apiKeyId: scope.apiKeyId, idempotencyKey, requestHash: hash })
        .onConflictDoNothing()
        .returning({ id: apiIdempotencyKeys.id });

      if (!claimed) {
        const [existing] = await tx
          .select()
          .from(apiIdempotencyKeys)
          .where(
            and(
              eq(apiIdempotencyKeys.organizationId, scope.organizationId),
              eq(apiIdempotencyKeys.apiKeyId, scope.apiKeyId),
              eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey),
            ),
          );
        if (existing && !isExpired(existing.createdAt, now)) {
          if (existing.requestHash !== hash) throw apiErrors.idempotencyKeyReuse();
          if (existing.responseStatus === null) throw apiErrors.idempotencyInProgress();
          await tx.execute(sql`SELECT set_config('lock_timeout', '0', true)`);
          return { status: existing.responseStatus, body: existing.responseBody, replayed: true };
        }
        // Expired (older than the retention window): the key is free to be used again.
        if (existing) await tx.delete(apiIdempotencyKeys).where(eq(apiIdempotencyKeys.id, existing.id));
        [claimed] = await tx
          .insert(apiIdempotencyKeys)
          .values({ organizationId: scope.organizationId, apiKeyId: scope.apiKeyId, idempotencyKey, requestHash: hash })
          .returning({ id: apiIdempotencyKeys.id });
      }
      if (!claimed) throw apiErrors.conflict();

      await tx.execute(sql`SELECT set_config('lock_timeout', '0', true)`);

      const response = await work(tx);

      await tx
        .update(apiIdempotencyKeys)
        .set({ responseStatus: response.status, responseBody: response.body as object })
        .where(eq(apiIdempotencyKeys.id, claimed.id));

      const last = lastPurge.get(scope.organizationId) ?? 0;
      if (now.getTime() - last >= PURGE_INTERVAL_MS) {
        lastPurge.set(scope.organizationId, now.getTime());
        await purgeExpiredInTx(tx, scope.organizationId, now);
      }
      return { ...response, replayed: false };
    });
  } catch (error) {
    if (isLockTimeout(error)) throw apiErrors.idempotencyInProgress();
    throw error;
  }
}
