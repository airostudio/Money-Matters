import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { apiKeyIndex, apiKeys, users } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { generateApiKey } from "./api-key-format";
import { assertValidRateLimit, resolveLimit } from "./rate-limit";
import { normaliseScopes, type ApiScope } from "./scopes";

/**
 * Management of API keys (create / list / revoke) - the human side of the public API. Gated on `api_key:manage`
 * (OWNER / ADMINISTRATOR only) AND on the actor being a HUMAN: an AI, system or API actor is refused structurally,
 * so a key can never mint, list or revoke keys (and no AI controller tool touches this service).
 *
 * The secret is returned by `create` exactly once and exists nowhere else: only its SHA-256 hash is stored
 * (in the non-tenant lookup index, never in the tenant `api_keys` row), and neither the secret nor the hash is
 * ever written to the audit log.
 */
export class ApiKeyNotFoundError extends Error {
  constructor() {
    super("API key not found in this organization.");
    this.name = "ApiKeyNotFoundError";
  }
}

export class InvalidApiKeyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApiKeyInputError";
  }
}

/** Longest a key may live: two years. A key with no expiry is allowed (long-lived server integrations are the norm) - the UI nudges towards one. */
export const MAX_KEY_LIFETIME_DAYS = 730;
const MAX_NAME_LENGTH = 80;

export type ApiKeyStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  createdByUserId: string;
  createdByName: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  rateLimitPerMinute: number;
  status: ApiKeyStatus;
}

export interface CreateApiKeyInput {
  name: string;
  scopes: readonly string[];
  expiresAt?: Date | null;
  /** Requests per minute; omitted = the platform default. */
  rateLimitPerMinute?: number | null;
}

function assertHumanManager(actor: Actor): void {
  assertPermission(actor, "api_key:manage");
  if ((actor.type ?? "HUMAN") !== "HUMAN") throw new PermissionDeniedError("api_key:manage", actor.role);
}

export function statusOf(row: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): ApiKeyStatus {
  if (row.revokedAt) return "REVOKED";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

const MAX_PREFIX_ATTEMPTS = 5;

function isPrefixCollision(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e.code ?? e.cause?.code;
  const constraint = e.constraint ?? e.cause?.constraint;
  return code === "23505" && constraint === "api_key_index_prefix_unique";
}

export const ApiKeyService = {
  async create(actor: Actor, input: CreateApiKeyInput, now: Date = new Date()) {
    assertHumanManager(actor);

    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new InvalidApiKeyInputError(`Give the key a name of 1 to ${MAX_NAME_LENGTH} characters, e.g. "Warehouse sync".`);
    }
    const scopes: ApiScope[] = normaliseScopes(input.scopes);
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt) {
      if (expiresAt.getTime() <= now.getTime()) throw new InvalidApiKeyInputError("The expiry date must be in the future.");
      if (expiresAt.getTime() > now.getTime() + MAX_KEY_LIFETIME_DAYS * 86_400_000) {
        throw new InvalidApiKeyInputError(`A key may not live longer than ${MAX_KEY_LIFETIME_DAYS} days; create a new one when it expires.`);
      }
    }
    const rateLimit = input.rateLimitPerMinute ?? null;
    if (rateLimit !== null) assertValidRateLimit(rateLimit);

    for (let attempt = 1; ; attempt += 1) {
      const generated = generateApiKey();
      try {
        const created = await withTenant(actor.organizationId, async (tx) => {
          const [row] = await tx
            .insert(apiKeys)
            .values({
              organizationId: actor.organizationId,
              name,
              prefix: generated.prefix,
              scopes,
              createdByUserId: actor.userId,
              expiresAt,
              rateLimitPerMinute: rateLimit,
            })
            .returning();
          if (!row) throw new Error("Failed to create API key.");

          await tx.insert(apiKeyIndex).values({
            id: row.id,
            organizationId: actor.organizationId,
            prefix: generated.prefix,
            secretHash: generated.secretHash,
            createdByUserId: actor.userId,
            scopes,
            expiresAt,
            rateLimitPerMinute: rateLimit,
          });

          // The audit row names the key by id and prefix. It never contains the secret or its hash.
          await AuditService.record(tx, actor, {
            action: "api_key.created",
            entityType: "ApiKey",
            entityId: row.id,
            after: { name, prefix: row.prefix, scopes, expiresAt, rateLimitPerMinute: rateLimit },
          });
          return row;
        });
        return {
          key: {
            id: created.id,
            name: created.name,
            prefix: created.prefix,
            scopes: created.scopes,
            expiresAt: created.expiresAt,
            rateLimitPerMinute: resolveLimit(created.rateLimitPerMinute),
          },
          /** The ONLY time the secret exists outside the caller's own copy. Show it once; it cannot be retrieved again. */
          secret: generated.fullKey,
        };
      } catch (error) {
        if (isPrefixCollision(error) && attempt < MAX_PREFIX_ATTEMPTS) continue;
        throw error;
      }
    }
  },

  async list(actor: Actor, now: Date = new Date()): Promise<ApiKeySummary[]> {
    assertHumanManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const rows = await tx
        .select({
          id: apiKeys.id,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          createdAt: apiKeys.createdAt,
          createdByUserId: apiKeys.createdByUserId,
          createdByName: users.name,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
          rateLimitPerMinute: apiKeys.rateLimitPerMinute,
          lastUsedAt: apiKeyIndex.lastUsedAt,
        })
        .from(apiKeys)
        .leftJoin(apiKeyIndex, and(eq(apiKeyIndex.id, apiKeys.id), eq(apiKeyIndex.organizationId, apiKeys.organizationId)))
        .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
        .where(eq(apiKeys.organizationId, actor.organizationId))
        .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
      return rows.map((r) => ({
        ...r,
        lastUsedAt: r.lastUsedAt ?? null,
        rateLimitPerMinute: resolveLimit(r.rateLimitPerMinute),
        status: statusOf(r, now),
      }));
    });
  },

  /** Revokes a key. Takes effect on the very next request (the lookup index row is updated in the same transaction). Idempotent. */
  async revoke(actor: Actor, keyId: string) {
    assertHumanManager(actor);
    return withTenant(actor.organizationId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, actor.organizationId)))
        .for("update");
      if (!existing) throw new ApiKeyNotFoundError();
      if (existing.revokedAt) return { id: existing.id, alreadyRevoked: true };

      const now = new Date();
      await tx
        .update(apiKeys)
        .set({ revokedAt: now, revokedByUserId: actor.userId })
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, actor.organizationId), isNull(apiKeys.revokedAt)));
      await tx
        .update(apiKeyIndex)
        .set({ revokedAt: now })
        .where(and(eq(apiKeyIndex.id, keyId), eq(apiKeyIndex.organizationId, actor.organizationId), sql`${apiKeyIndex.revokedAt} IS NULL`));
      await AuditService.record(tx, actor, {
        action: "api_key.revoked",
        entityType: "ApiKey",
        entityId: keyId,
        before: { name: existing.name, prefix: existing.prefix, status: "ACTIVE" },
        after: { status: "REVOKED", revokedAt: now },
      });
      return { id: keyId, alreadyRevoked: false };
    });
  },
};
