import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeyIndex, organizationMemberships, organizations, users } from "@/db/schema";
import type { Actor } from "@/domain/permissions/permission-service";
import type { MembershipRole, Permission } from "@/domain/permissions/roles";
import { apiErrors, ApiError } from "./errors";
import { hashesEqual, parseApiKey, parseBearer, hashApiKey } from "./api-key-format";
import { authThrottle, type AuthThrottle } from "./auth-throttle";
import { consumeRateLimit, resolveLimit, type RateLimitState } from "./rate-limit";
import { effectivePermissions } from "./scopes";
import { looksLikeAccessToken, parseAccessToken } from "@/domain/oauth/credentials";
import { lookupAccessTokenByPrefix, resolveAccessToken } from "@/domain/oauth/bearer";
import { consumeBucket } from "@/domain/oauth/rate-limit";
import { API_LIMIT_PER_GRANT_PER_MINUTE } from "@/domain/oauth/constants";

/**
 * Authenticating an API request (docs/security.md section 15). The credential arrives ONLY in the
 * `Authorization: Bearer <credential>` header - never the query string, never a cookie. TWO credential kinds resolve into
 * the SAME `ApiPrincipal`: an API key (`mm_live_...`) and, since Phase 10 Slice 4, an OAuth access token (`mmo_at_...`,
 * src/domain/oauth/bearer.ts). Everything downstream (scopes, effective permissions, the Actor, rate limiting,
 * idempotency, errors) is credential-agnostic.
 *
 * Query budget (either kind): ONE lookup query (the credential's index row joined to the person's membership, account
 * state and the organization's archive flag) + ONE rate-limit statement, then the request's work in a single withTenant.
 * Nothing else touches the database here.
 */
export interface ApiPrincipal {
  /** Which kind of credential authenticated this request. */
  credential: "api_key" | "oauth";
  /**
   * The id rate limiting and idempotency are scoped to: the API key's id, or - for an OAuth access token - the id of the
   * GRANT it was minted from (every token of a grant shares one budget and one idempotency namespace).
   */
  keyId: string;
  prefix: string;
  organizationId: string;
  scopes: string[];
  creatorUserId: string;
  /** The creator's role in this organization RIGHT NOW (read on this request, never cached). */
  creatorRole: MembershipRole;
  expiresAt: Date | null;
  permissions: ReadonlySet<Permission>;
  /** Present for an OAuth access token: which app (client id) and grant acted. Null for an API key. */
  oauth: { clientId: string; grantId: string; appId: string } | null;
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
  /** Set when the key's organization is ARCHIVED (folded into the one lookup join - no extra query). Optional so older fixtures still type-check; absent means active. */
  organizationArchivedAt?: Date | null;
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
      organizationArchivedAt: organizations.archivedAt,
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
    .innerJoin(organizations, eq(organizations.id, apiKeyIndex.organizationId))
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
  if (row.organizationArchivedAt) throw apiErrors.organizationArchived();
  if (!row.membershipRole || !row.membershipActive || row.userDisabledAt) throw apiErrors.apiKeyOwnerInactive();

  const permissions = effectivePermissions(row.scopes, row.membershipRole);
  return {
    credential: "api_key",
    keyId: row.id,
    prefix: row.prefix,
    organizationId: row.organizationId,
    scopes: row.scopes,
    creatorUserId: row.createdByUserId,
    creatorRole: row.membershipRole,
    expiresAt: row.expiresAt,
    permissions,
    oauth: null,
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
  /** Test seam: replaces the API-key lookup query. */
  lookup?: typeof lookupKeyByPrefix;
  /** Test seam: replaces the OAuth access-token lookup query. */
  lookupAccessToken?: typeof lookupAccessTokenByPrefix;
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

  if (looksLikeAccessToken(bearer)) {
    // OAuth access token: same pipeline, different index. Garbage never reaches the database (parseAccessToken).
    const token = parseAccessToken(bearer);
    if (!token) return fail(apiErrors.invalidToken());
    const tokenRow = await (options.lookupAccessToken ?? lookupAccessTokenByPrefix)(token.prefix);
    if (!tokenRow) {
      hashApiKey(bearer);
      return fail(apiErrors.invalidToken());
    }
    let oauthPrincipal: ApiPrincipal;
    try {
      oauthPrincipal = resolveAccessToken(tokenRow, token.hash, now);
    } catch (error) {
      return fail(error as ApiError);
    }
    throttle.recordSuccess(client);
    const oauthRate = await consumeBucket(`api:${oauthPrincipal.keyId}`, API_LIMIT_PER_GRANT_PER_MINUTE, now.getTime());
    if (!oauthRate.allowed) {
      throw new ApiError(429, "rate_limited", "Rate limit exceeded", `This authorisation is limited to ${API_LIMIT_PER_GRANT_PER_MINUTE} requests per minute. Retry after ${oauthRate.resetInSeconds} seconds.`, {
        headers: { "Retry-After": String(oauthRate.resetInSeconds), ...rateLimitHeaders(oauthRate) },
      });
    }
    return { principal: oauthPrincipal, rate: oauthRate };
  }

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
