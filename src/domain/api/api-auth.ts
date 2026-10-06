import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeyIndex, organizationMemberships, users } from "@/db/schema";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole, Permission } from "@/domain/permissions/roles";
import { apiErrors, ApiError } from "./errors";
import { hashesEqual, parseApiKey, parseBearer, hashApiKey } from "./api-key-format";
import { authThrottle, type AuthThrottle } from "./auth-throttle";
import { consumeRateLimit, resolveLimit, type RateLimitState } from "./rate-limit";
import { effectivePermissions } from "./scopes";

/**
 * Authenticating an API request (docs/security.md section 15). The credential arrives ONLY in the
 * `Authorization: Bearer <key>` header - never the query string, never a cookie. The design leaves room for OAuth:
 * a future `Bearer <access token>` is just another credential `authenticateApiKey`'s caller resolves into the same
 * `ApiPrincipal`; everything downstream (scopes, effective permissions, the Actor, rate limiting, idempotency,
 * errors) is credential-agnostic.
 *
 * Query budget: ONE lookup query (key index joined to the creator's membership and user row) + ONE rate-limit
 * statement, then the request's work in a single withTenant. Nothing else touches the database here.
 */
export interface ApiPrincipal {
  keyId: string;
  prefix: string;
  organizationId: string;
  scopes: string[];
  creatorUserId: string;
  /** The creator's role in this organization RIGHT NOW (read on this request, never cached). */
  creatorRole: MembershipRole;
  expiresAt: Date | null;
  permissions: ReadonlySet<Permission>;
  /** The Actor handed to domain services: type API, role = creator's current role, narrowed to `permissions`. */
  actor: Actor;
}

export interface Authenticated {
  principal: ApiPrincipal;
  rate: RateLimitState;
}

export interface KeyLookupRow {
  id: string;
  organizationId: string;
  prefix: string;
  secretHash: string;
  createdByUserId: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  rateLimitPerMinute: number | null;
  membershipRole: MembershipRole | null;
  membershipActive: boolean | null;
  userDisabledAt: Date | null;
}

/** The single lookup query: key by prefix, with the creator's current membership and suspension flag. */
export async function lookupKeyByPrefix(prefix: string): Promise<KeyLookupRow | null> {
  const [row] = await db
    .select({
      id: apiKeyIndex.id,
      organizationId: apiKeyIndex.organizationId,
      prefix: apiKeyIndex.prefix,
      secretHash: apiKeyIndex.secretHash,
      createdByUserId: apiKeyIndex.createdByUserId,
      scopes: apiKeyIndex.scopes,
      expiresAt: apiKeyIndex.expiresAt,
      revokedAt: apiKeyIndex.revokedAt,
      rateLimitPerMinute: apiKeyIndex.rateLimitPerMinute,
      membershipRole: organizationMemberships.role,
      membershipActive: organizationMemberships.isActive,
      userDisabledAt: users.disabledAt,
    })
    .from(apiKeyIndex)
    .leftJoin(
      organizationMemberships,
      and(
        eq(organizationMemberships.organizationId, apiKeyIndex.organizationId),
        eq(organizationMemberships.userId, apiKeyIndex.createdByUserId),
      ),
    )
    .leftJoin(users, eq(users.id, apiKeyIndex.createdByUserId))
    .where(eq(apiKeyIndex.prefix, prefix))
    .limit(1);
  return row ?? null;
}

/**
 * Pure decision over a looked-up row: is this key usable right now, and with what power? Separated from the query
 * so every revoked / expired / creator-gone / creator-suspended / demoted case is unit-testable.
 */
export function resolvePrincipal(row: KeyLookupRow, presentedHash: string, now: Date): ApiPrincipal {
  if (!hashesEqual(presentedHash, row.secretHash)) throw apiErrors.invalidApiKey();
  if (row.revokedAt) throw apiErrors.apiKeyRevoked();
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) throw apiErrors.apiKeyExpired();
  if (!row.membershipRole || !row.membershipActive || row.userDisabledAt) throw apiErrors.apiKeyOwnerInactive();

  const permissions = effectivePermissions(row.scopes, row.membershipRole);
  return {
    keyId: row.id,
    prefix: row.prefix,
    organizationId: row.organizationId,
    scopes: row.scopes,
    creatorUserId: row.createdByUserId,
    creatorRole: row.membershipRole,
    expiresAt: row.expiresAt,
    permissions,
    actor: {
      userId: row.createdByUserId,
      organizationId: row.organizationId,
      role: row.membershipRole,
      type: "API",
      grantedPermissions: permissions,
      apiKey: { id: row.id, prefix: row.prefix },
    },
  };
}

export interface AuthenticateOptions {
  now?: Date;
  throttle?: AuthThrottle;
  /** Test seam: replaces the lookup query. */
  lookup?: typeof lookupKeyByPrefix;
}

export async function authenticateApiKey(
  authorizationHeader: string | null,
  client: string,
  options: AuthenticateOptions = {},
): Promise<Authenticated> {
  const now = options.now ?? new Date();
  const throttle = options.throttle ?? authThrottle;

  const wait = throttle.retryAfterSeconds(client, now.getTime());
  if (wait > 0) throw apiErrors.tooManyFailures(wait);

  const fail = (error: ApiError): never => {
    throttle.recordFailure(client, now.getTime());
    throw error;
  };

  const bearer = parseBearer(authorizationHeader);
  if (!bearer) return fail(apiErrors.invalidApiKey());
  const parsed = parseApiKey(bearer);
  if (!parsed) return fail(apiErrors.invalidApiKey());

  const row = await (options.lookup ?? lookupKeyByPrefix)(parsed.prefix);
  if (!row) {
    hashApiKey(bearer); // keep the unknown-prefix path doing comparable work
    return fail(apiErrors.invalidApiKey());
  }

  let principal: ApiPrincipal;
  try {
    principal = resolvePrincipal(row, parsed.secretHash, now);
  } catch (error) {
    return fail(error as ApiError);
  }

  // The credential is valid from here on: it is no longer a "failed attempt" for this client.
  throttle.recordSuccess(client);

  const limit = resolveLimit(row.rateLimitPerMinute);
  const rate = await consumeRateLimit(principal.keyId, limit, now.getTime());
  if (!rate.allowed) {
    throw new ApiError(429, "rate_limited", "Rate limit exceeded", `This API key is limited to ${limit} requests per minute. Retry after ${rate.resetInSeconds} seconds.`, {
      headers: { "Retry-After": String(rate.resetInSeconds), ...rateLimitHeaders(rate) },
    });
  }
  return { principal, rate };
}

export function rateLimitHeaders(rate: RateLimitState): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(rate.limit),
    "X-RateLimit-Remaining": String(rate.remaining),
    "X-RateLimit-Reset": String(rate.resetAt),
  };
}
