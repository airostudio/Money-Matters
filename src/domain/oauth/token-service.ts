import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  oauthAccessTokens,
  oauthApps,
  oauthAuthorizationCodes,
  oauthGrants,
  oauthRefreshTokens,
  organizationMemberships,
  organizations,
  users,
} from "@/db/schema";
import { withTenant, type TenantDb } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import type { Actor } from "@/domain/permissions/permission-service";
import { API_SCOPES, isApiScope } from "@/domain/api/scopes";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  EXPIRED_ACCESS_RETENTION_DAYS,
  REFRESH_TOKEN_TTL_DAYS,
  USED_REFRESH_RETENTION_DAYS,
} from "./constants";
import { lookupClient } from "./client-lookup";
import {
  generateAccessToken,
  generateRefreshToken,
  hashCredential,
  hashesEqual,
  isAuthorizationCodeShape,
  isClientSecretShape,
  isRefreshTokenShape,
  looksLikeAccessToken,
  parseAccessToken,
} from "./credentials";
import { OAuthProtocolError, oauthErrors } from "./errors";
import { auditGrantRevoked, revokeGrant } from "./grant-store";
import { isValidCodeVerifier, verifyCodeVerifier } from "./pkce";
import { redirectUriMatches } from "./redirect-uri";
import { parseScopeString } from "./authorize-service";

/**
 * The token endpoint's grant handling (RFC 6749 section 4.1.3 / 6, RFC 7636, RFC 7009, RFC 9700). Pure domain: the HTTP
 * layer (src/domain/oauth/http.ts) parses the form, rate-limits and shapes the response.
 *
 * Every flow runs inside ONE tenant transaction for the client's organization, opened after a single immutable
 * client-index lookup. Failures that must STILL leave a mark (a burned code, a revoked grant after replay or reuse, an
 * anomaly audit row) return a result instead of throwing, so the transaction commits; failures that change nothing throw
 * and roll back.
 *
 * Authorization codes: single-use, claimed by an atomic `UPDATE ... WHERE used_at IS NULL RETURNING`. Any failed
 * validation AFTER the code is found (wrong client, wrong redirect_uri, bad PKCE verifier) burns it. A code presented a
 * second time revokes the grant its first use created. Refresh tokens: rotated on every use by the same atomic claim; a
 * used token presented again revokes the whole grant (RFC 9700 section 4.14). Nothing here logs a credential.
 */
export interface ClientCredentials {
  clientId: string;
  /** The client secret presented (HTTP Basic or form body), or null. */
  secret: string | null;
  viaBasic: boolean;
}

export interface TokenSuccess {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

type Step<T> = { ok: true; value: T } | { ok: false; error: OAuthProtocolError };
const fail = (error: OAuthProtocolError): { ok: false; error: OAuthProtocolError } => ({ ok: false, error });

interface ClientApp {
  id: string;
  organizationId: string;
  clientId: string;
  name: string;
  scopes: string[];
  redirectUris: string[];
}

/** Audit rows written by the authorization server itself (protocol events), attributed to the grant's person in the payload. */
function serverActor(userId: string, organizationId: string): Actor {
  return { userId, organizationId, role: "OWNER", type: "SYSTEM" };
}

/** Looks the client up, opens its organization, authenticates it, and runs `work`. Authentication failures throw (nothing to keep). */
async function withClient<T>(
  creds: ClientCredentials,
  work: (tx: TenantDb, app: ClientApp, orgId: string, orgArchived: boolean) => Promise<T>,
): Promise<T> {
  const client = await lookupClient(creds.clientId);
  if (!client) {
    hashCredential(creds.secret ?? creds.clientId); // keep the unknown-client path doing comparable work
    throw oauthErrors.invalidClient(creds.viaBasic);
  }
  return withTenant(client.organizationId, async (tx) => {
    const [row] = await tx
      .select({ app: oauthApps, archivedAt: organizations.archivedAt })
      .from(oauthApps)
      .innerJoin(organizations, eq(organizations.id, oauthApps.organizationId))
      .where(and(eq(oauthApps.id, client.appId), eq(oauthApps.organizationId, client.organizationId), eq(oauthApps.clientId, creds.clientId)))
      .limit(1);
    if (!row || row.app.deletedAt || row.app.disabledAt) throw oauthErrors.invalidClient(creds.viaBasic);
    const app = row.app;
    if (app.clientType === "PUBLIC") {
      if (creds.secret !== null) throw oauthErrors.invalidClient(creds.viaBasic);
    } else {
      const presented = creds.secret;
      const good =
        presented !== null && isClientSecretShape(presented) && app.secretHash !== null && hashesEqual(hashCredential(presented), app.secretHash);
      if (!good) throw oauthErrors.invalidClient(creds.viaBasic);
    }
    return work(tx, { id: app.id, organizationId: app.organizationId, clientId: app.clientId, name: app.name, scopes: app.scopes, redirectUris: app.redirectUris }, client.organizationId, Boolean(row.archivedAt));
  });
}

/** The person's current standing in the organization: can the grant still act at all? */
async function memberStanding(tx: TenantDb, organizationId: string, userId: string) {
  const [row] = await tx
    .select({ role: organizationMemberships.role, active: organizationMemberships.isActive, disabledAt: users.disabledAt })
    .from(users)
    .leftJoin(
      organizationMemberships,
      and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, users.id)),
    )
    .where(eq(users.id, userId))
    .limit(1);
  const usable = Boolean(row && row.role && row.active && !row.disabledAt);
  return { usable, role: row?.role ?? null };
}

async function issueTokens(
  tx: TenantDb,
  args: { organizationId: string; grantId: string; appId: string; clientId: string; userId: string; accessScopes: string[]; now: Date },
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const refresh = generateRefreshToken();
  const access = generateAccessToken();
  await tx.insert(oauthRefreshTokens).values({
    organizationId: args.organizationId,
    grantId: args.grantId,
    tokenHash: refresh.hash,
    expiresAt: new Date(args.now.getTime() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  await tx.insert(oauthAccessTokens).values({
    organizationId: args.organizationId,
    grantId: args.grantId,
    appId: args.appId,
    clientId: args.clientId,
    userId: args.userId,
    prefix: access.prefix,
    secretHash: access.hash,
    scopes: args.accessScopes,
    expiresAt: new Date(args.now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
  });
  return { accessToken: access.token, refreshToken: refresh.token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

function isPrefixCollision(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (e.code ?? e.cause?.code) === "23505" && (e.constraint ?? e.cause?.constraint) === "oauth_access_tokens_prefix_unique";
}

/** Runs `attempt` again (a fresh transaction) on the vanishingly rare access-token prefix collision. */
async function withPrefixRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!isPrefixCollision(error) || i >= 5) throw error;
    }
  }
}

function success(tokens: { accessToken: string; refreshToken: string; expiresIn: number }, scopes: readonly string[]): TokenSuccess {
  return { access_token: tokens.accessToken, token_type: "Bearer", expires_in: tokens.expiresIn, refresh_token: tokens.refreshToken, scope: scopes.join(" ") };
}

export interface CodeExchangeInput {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export async function exchangeAuthorizationCode(creds: ClientCredentials, input: CodeExchangeInput, now: Date = new Date()): Promise<TokenSuccess> {
  if (!isValidCodeVerifier(input.codeVerifier)) throw oauthErrors.invalidGrant("The code_verifier is missing or malformed.");
  if (!isAuthorizationCodeShape(input.code)) throw oauthErrors.invalidGrant();

  const result = await withPrefixRetry(() =>
    withClient(creds, async (tx, app, orgId, orgArchived): Promise<Step<TokenSuccess>> => {
      if (orgArchived) return fail(oauthErrors.invalidGrant("The organization is archived."));
      const [code] = await tx
        .select()
        .from(oauthAuthorizationCodes)
        .where(and(eq(oauthAuthorizationCodes.codeHash, hashCredential(input.code)), eq(oauthAuthorizationCodes.organizationId, orgId)))
        .limit(1);
      if (!code) return fail(oauthErrors.invalidGrant());

      const server = serverActor(code.userId, orgId);
      const burn = async () => {
        await tx
          .update(oauthAuthorizationCodes)
          .set({ usedAt: now })
          .where(and(eq(oauthAuthorizationCodes.id, code.id), isNull(oauthAuthorizationCodes.usedAt)));
      };
      const anomaly = async (action: string, detail: string) => {
        await AuditService.record(tx, server, {
          action,
          entityType: "OAuthApp",
          entityId: code.appId,
          after: { clientId: app.clientId, grantedToUserId: code.userId, detail },
        });
      };

      if (code.appId !== app.id) {
        await burn();
        await anomaly("oauth_code.client_mismatch", "authorization code presented by a different client");
        return fail(oauthErrors.invalidGrant());
      }

      const replay = async (): Promise<Step<TokenSuccess>> => {
        // A used code presented again: whatever its first use created is revoked (RFC 6749 section 4.1.2 / 10.5).
        const [fresh] = await tx.select({ grantId: oauthAuthorizationCodes.grantId }).from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.id, code.id)).limit(1);
        if (fresh?.grantId) {
          const revoked = await revokeGrant(tx, orgId, fresh.grantId, "CODE_REPLAY", null, now);
          if (revoked) await auditGrantRevoked(tx, server, revoked, "CODE_REPLAY", { clientId: app.clientId });
        }
        await anomaly("oauth_code.replayed", "authorization code presented twice; the grant it created was revoked");
        return fail(oauthErrors.invalidGrant());
      };

      if (code.usedAt) return replay();
      if (code.expiresAt.getTime() <= now.getTime()) return fail(oauthErrors.invalidGrant());

      if (input.redirectUri !== code.redirectUri) {
        await burn();
        await anomaly("oauth_code.redirect_mismatch", "redirect_uri differs from the one the code was issued for");
        return fail(oauthErrors.invalidGrant("redirect_uri does not match the authorization request."));
      }
      if (!verifyCodeVerifier(input.codeVerifier, code.codeChallenge)) {
        await burn();
        await anomaly("oauth_code.pkce_failed", "code_verifier does not match the code_challenge");
        return fail(oauthErrors.invalidGrant("The code_verifier does not match the code_challenge."));
      }
      // Defence in depth: the redirect URI must (still) be one the app has registered.
      if (!redirectUriMatches(app.redirectUris, code.redirectUri)) {
        await burn();
        return fail(oauthErrors.invalidGrant("redirect_uri is no longer registered for this app."));
      }

      const standing = await memberStanding(tx, orgId, code.userId);
      if (!standing.usable) {
        await burn();
        return fail(oauthErrors.invalidGrant("The user who authorised this request is no longer active in the organization."));
      }
      // The scopes can only ever be the ones consented to, and still inside the app's current ceiling.
      const scopes = API_SCOPES.filter((s) => code.scopes.includes(s) && app.scopes.includes(s));
      if (scopes.length === 0) {
        await burn();
        return fail(oauthErrors.invalidScope("None of the authorised scopes is enabled for this app any more."));
      }

      // THE atomic claim: exactly one request can flip used_at; a concurrent duplicate gets zero rows and is a replay.
      const claimed = await tx
        .update(oauthAuthorizationCodes)
        .set({ usedAt: now })
        .where(and(eq(oauthAuthorizationCodes.id, code.id), isNull(oauthAuthorizationCodes.usedAt), sql`${oauthAuthorizationCodes.expiresAt} > ${now}`))
        .returning({ id: oauthAuthorizationCodes.id });
      if (claimed.length === 0) return replay();

      const [grant] = await tx
        .insert(oauthGrants)
        .values({ organizationId: orgId, appId: app.id, userId: code.userId, scopes })
        .returning({ id: oauthGrants.id });
      if (!grant) throw new Error("Failed to create the grant.");
      await tx.update(oauthAuthorizationCodes).set({ grantId: grant.id }).where(eq(oauthAuthorizationCodes.id, code.id));
      const tokens = await issueTokens(tx, { organizationId: orgId, grantId: grant.id, appId: app.id, clientId: app.clientId, userId: code.userId, accessScopes: scopes, now });
      await AuditService.record(tx, server, {
        action: "oauth_grant.created",
        entityType: "OAuthGrant",
        entityId: grant.id,
        after: { clientId: app.clientId, appName: app.name, grantedToUserId: code.userId, scopes },
      });
      return { ok: true, value: success(tokens, scopes) };
    }),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

export interface RefreshInput {
  refreshToken: string;
  /** Optional narrowing for the NEW access token (must be a subset of the grant's scopes). */
  scope?: string;
}

export async function refreshAccessToken(creds: ClientCredentials, input: RefreshInput, now: Date = new Date()): Promise<TokenSuccess> {
  if (!isRefreshTokenShape(input.refreshToken)) throw oauthErrors.invalidGrant();

  const result = await withPrefixRetry(() =>
    withClient(creds, async (tx, app, orgId, orgArchived): Promise<Step<TokenSuccess>> => {
      if (orgArchived) return fail(oauthErrors.invalidGrant("The organization is archived."));
      const [row] = await tx
        .select({
          tokenId: oauthRefreshTokens.id,
          expiresAt: oauthRefreshTokens.expiresAt,
          usedAt: oauthRefreshTokens.usedAt,
          grantId: oauthGrants.id,
          appId: oauthGrants.appId,
          userId: oauthGrants.userId,
          scopes: oauthGrants.scopes,
          revokedAt: oauthGrants.revokedAt,
          role: organizationMemberships.role,
          active: organizationMemberships.isActive,
          userDisabledAt: users.disabledAt,
        })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthRefreshTokens.grantId))
        .leftJoin(
          organizationMemberships,
          and(eq(organizationMemberships.organizationId, oauthGrants.organizationId), eq(organizationMemberships.userId, oauthGrants.userId)),
        )
        .leftJoin(users, eq(users.id, oauthGrants.userId))
        .where(and(eq(oauthRefreshTokens.tokenHash, hashCredential(input.refreshToken)), eq(oauthRefreshTokens.organizationId, orgId)))
        .limit(1);
      if (!row) return fail(oauthErrors.invalidGrant());

      const server = serverActor(row.userId, orgId);
      if (row.appId !== app.id) {
        await AuditService.record(tx, server, {
          action: "oauth_token.client_mismatch",
          entityType: "OAuthGrant",
          entityId: row.grantId,
          after: { clientId: app.clientId, grantedToUserId: row.userId, detail: "refresh token presented by a different client" },
        });
        return fail(oauthErrors.invalidGrant());
      }
      if (row.revokedAt) return fail(oauthErrors.invalidGrant());

      const reuse = async (): Promise<Step<TokenSuccess>> => {
        // A rotated (used) refresh token came back: either the client lost it or someone stole it. Kill the whole grant.
        const revoked = await revokeGrant(tx, orgId, row.grantId, "REFRESH_REUSE", null, now);
        if (revoked) await auditGrantRevoked(tx, server, revoked, "REFRESH_REUSE", { clientId: app.clientId });
        await AuditService.record(tx, server, {
          action: "oauth_token.reuse_detected",
          entityType: "OAuthGrant",
          entityId: row.grantId,
          after: { clientId: app.clientId, grantedToUserId: row.userId, detail: "a rotated refresh token was presented again; the grant was revoked" },
        });
        return fail(oauthErrors.invalidGrant());
      };

      if (row.usedAt) return reuse();
      if (row.expiresAt.getTime() <= now.getTime()) return fail(oauthErrors.invalidGrant());
      if (!row.role || !row.active || row.userDisabledAt) {
        return fail(oauthErrors.invalidGrant("The user who authorised this grant is no longer active in the organization."));
      }

      let accessScopes = API_SCOPES.filter((s) => row.scopes.includes(s) && app.scopes.includes(s));
      if (input.scope !== undefined) {
        const asked = parseScopeString(input.scope);
        if (asked.length === 0 || asked.some((s) => !isApiScope(s) || !row.scopes.includes(s))) {
          return fail(oauthErrors.invalidScope("The requested scope exceeds the scope originally granted."));
        }
        accessScopes = accessScopes.filter((s) => asked.includes(s));
      }
      if (accessScopes.length === 0) return fail(oauthErrors.invalidScope("None of the granted scopes is enabled for this app any more."));

      // THE atomic rotation claim. Zero rows = a concurrent request already used this token = reuse.
      const claimed = await tx
        .update(oauthRefreshTokens)
        .set({ usedAt: now })
        .where(and(eq(oauthRefreshTokens.id, row.tokenId), isNull(oauthRefreshTokens.usedAt)))
        .returning({ id: oauthRefreshTokens.id });
      if (claimed.length === 0) return reuse();

      const tokens = await issueTokens(tx, { organizationId: orgId, grantId: row.grantId, appId: app.id, clientId: app.clientId, userId: row.userId, accessScopes, now });
      await tx.update(oauthGrants).set({ lastRefreshedAt: now }).where(eq(oauthGrants.id, row.grantId));
      // Bounded growth, scoped to this grant: expired / long-used refresh rows and long-expired access-lookup rows.
      await tx
        .delete(oauthRefreshTokens)
        .where(
          and(
            eq(oauthRefreshTokens.grantId, row.grantId),
            or(
              lt(oauthRefreshTokens.expiresAt, now),
              lt(oauthRefreshTokens.usedAt, new Date(now.getTime() - USED_REFRESH_RETENTION_DAYS * 86_400_000)),
            ),
          ),
        );
      await tx
        .delete(oauthAccessTokens)
        .where(
          and(
            eq(oauthAccessTokens.organizationId, orgId),
            eq(oauthAccessTokens.grantId, row.grantId),
            lt(oauthAccessTokens.expiresAt, new Date(now.getTime() - EXPIRED_ACCESS_RETENTION_DAYS * 86_400_000)),
          ),
        );
      return { ok: true, value: success(tokens, accessScopes) };
    }),
  );
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * RFC 7009 revocation, called BY THE CLIENT with a token it holds. Revoking either kind of token revokes the whole grant
 * (the simplest behaviour that can never leave a usable sibling token behind). Per RFC 7009 section 2.2 an unknown,
 * malformed or already-revoked token is NOT an error (the caller gets the same 200): only failed client authentication
 * is. A token that belongs to a different client is left alone.
 */
export async function revokeToken(creds: ClientCredentials, token: string, now: Date = new Date()): Promise<void> {
  await withClient(creds, async (tx, app, orgId) => {
    let grantId: string | null = null;
    let userId: string | null = null;
    if (looksLikeAccessToken(token)) {
      const parsed = parseAccessToken(token);
      if (!parsed) return;
      const [row] = await tx
        .select({ grantId: oauthAccessTokens.grantId, appId: oauthAccessTokens.appId, userId: oauthAccessTokens.userId, hash: oauthAccessTokens.secretHash })
        .from(oauthAccessTokens)
        .where(and(eq(oauthAccessTokens.prefix, parsed.prefix), eq(oauthAccessTokens.organizationId, orgId)))
        .limit(1);
      if (!row || !hashesEqual(parsed.hash, row.hash) || row.appId !== app.id) return;
      grantId = row.grantId;
      userId = row.userId;
    } else if (isRefreshTokenShape(token)) {
      const [row] = await tx
        .select({ grantId: oauthGrants.id, appId: oauthGrants.appId, userId: oauthGrants.userId })
        .from(oauthRefreshTokens)
        .innerJoin(oauthGrants, eq(oauthGrants.id, oauthRefreshTokens.grantId))
        .where(and(eq(oauthRefreshTokens.tokenHash, hashCredential(token)), eq(oauthRefreshTokens.organizationId, orgId)))
        .limit(1);
      if (!row || row.appId !== app.id) return;
      grantId = row.grantId;
      userId = row.userId;
    } else {
      return;
    }
    const revoked = await revokeGrant(tx, orgId, grantId, "CLIENT", null, now);
    if (revoked && userId) await auditGrantRevoked(tx, serverActor(userId, orgId), revoked, "CLIENT", { clientId: app.clientId });
  });
}
