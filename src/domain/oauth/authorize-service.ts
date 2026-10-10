import { and, eq, lt, sql } from "drizzle-orm";
import { oauthApps, oauthAuthorizationCodes, organizationMemberships, organizations } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AuditService } from "@/domain/audit/audit-service";
import { API_ALLOWED_PERMISSIONS, API_SCOPES, SCOPE_INFO, isApiScope, type ApiScope, type ScopeInfo } from "@/domain/api/scopes";
import type { Actor } from "@/domain/permissions/permission-service";
import { roleHasPermission, type MembershipRole } from "@/domain/permissions/roles";
import { AUTH_CODE_TTL_SECONDS } from "./constants";
import { generateAuthorizationCode } from "./credentials";
import { lookupClient } from "./client-lookup";
import { isValidCodeChallenge } from "./pkce";
import { buildRedirectUrl, redirectUriMatches } from "./redirect-uri";

/**
 * The authorization endpoint's decision logic (RFC 6749 section 4.1, RFC 7636, RFC 9700), separated from HTTP so every
 * branch is testable. The ORDER of checks is the security property:
 *
 *   1. client_id and redirect_uri are checked FIRST, against the registered app. Until BOTH are proven good the request
 *      can only ever produce an ERROR PAGE - never a redirect - so the endpoint cannot be used as an open redirector.
 *   2. Only then are the remaining parameters (response_type, state, PKCE, scope) validated, and failures are returned
 *      to the (now trusted) redirect URI as `error=...&state=...&iss=...`.
 *   3. The signed-in person must be an ACTIVE member of the app's organization (an app is authorised only into the
 *      organization that registered it) and their role must permit every requested scope.
 *
 * `preview` renders the consent screen; `approve` / `deny` re-run ALL of the above from scratch (nothing in the posted form
 * is trusted) in the same tenant transaction that writes the single-use code and the audit row. Consent is NEVER skipped.
 */
export type RawParams = Record<string, string | string[] | undefined>;

export type ErrorPageReason =
  | "invalid_request"
  | "unknown_client"
  | "client_disabled"
  | "redirect_mismatch"
  | "not_a_member"
  | "organization_archived";

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

export interface ConsentView {
  app: { id: string; name: string; description: string | null; homepageUrl: string | null; clientId: string };
  organization: { id: string; name: string; slug: string };
  role: MembershipRole;
  scopes: ScopeInfo[];
  /** Where the person will be sent: shown on the screen so they can see it is the app's own address. */
  redirectHost: string;
  request: AuthorizeRequest;
}

export type AuthorizeOutcome =
  | { kind: "error_page"; reason: ErrorPageReason }
  | { kind: "redirect"; url: string; approved: boolean }
  | { kind: "consent"; view: ConsentView };

export type AuthorizeMode = "preview" | "approve" | "deny";

const MAX_PARAM_LENGTH = 2048;

function single(raw: RawParams, key: string): string | undefined | null {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return null; // a repeated parameter is ambiguous: refuse rather than guess
  return value;
}

export interface ParsedParams {
  clientId: string;
  redirectUri: string;
  responseType: string | undefined;
  scope: string | undefined;
  state: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
}

/** DB-free parse. Null when client_id / redirect_uri are missing, repeated or absurd - the only case with nothing to say but an error page. */
export function parseAuthorizeParams(raw: RawParams): ParsedParams | null {
  const clientId = single(raw, "client_id");
  const redirectUri = single(raw, "redirect_uri");
  if (!clientId || !redirectUri) return null;
  if (clientId.length > 128 || redirectUri.length > MAX_PARAM_LENGTH) return null;
  const optional = (key: string): string | undefined => {
    const v = single(raw, key);
    return typeof v === "string" && v.length <= MAX_PARAM_LENGTH ? v : undefined;
  };
  // A repeated optional parameter is treated as absent, which then fails its own check (e.g. state) with a redirect error.
  return {
    clientId,
    redirectUri,
    responseType: optional("response_type"),
    scope: optional("scope"),
    state: optional("state"),
    codeChallenge: optional("code_challenge"),
    codeChallengeMethod: optional("code_challenge_method"),
  };
}

export function parseScopeString(scope: string): string[] {
  return [...new Set(scope.split(/[ ]+/).map((s) => s.trim()).filter((s) => s !== ""))];
}

/** Does the role hold EVERY permission each scope maps to (and is each inside the API whitelist)? Returns the scopes it does not. */
export function scopesBeyondRole(scopes: readonly ApiScope[], role: MembershipRole): ApiScope[] {
  return scopes.filter((s) => !SCOPE_INFO[s].permissions.every((p) => API_ALLOWED_PERMISSIONS.has(p) && roleHasPermission(role, p)));
}

function redirectError(redirectUri: string, issuer: string, error: string, description: string, state: string | undefined): AuthorizeOutcome {
  return { kind: "redirect", approved: false, url: buildRedirectUrl(redirectUri, { error, error_description: description, state, iss: issuer }) };
}

export interface AuthorizeUser {
  id: string;
}

export async function authorize(
  user: AuthorizeUser,
  raw: RawParams,
  mode: AuthorizeMode,
  issuer: string,
  now: Date = new Date(),
): Promise<AuthorizeOutcome> {
  const p = parseAuthorizeParams(raw);
  if (!p) return { kind: "error_page", reason: "invalid_request" };

  const client = await lookupClient(p.clientId);
  if (!client) return { kind: "error_page", reason: "unknown_client" };

  return withTenant(client.organizationId, async (tx): Promise<AuthorizeOutcome> => {
    // ONE joined statement: the app, its organization (archive flag) and the person's membership of it.
    const [row] = await tx
      .select({
        app: oauthApps,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        orgArchivedAt: organizations.archivedAt,
        role: organizationMemberships.role,
        memberActive: organizationMemberships.isActive,
      })
      .from(oauthApps)
      .innerJoin(organizations, eq(organizations.id, oauthApps.organizationId))
      .leftJoin(
        organizationMemberships,
        and(eq(organizationMemberships.organizationId, oauthApps.organizationId), eq(organizationMemberships.userId, user.id)),
      )
      .where(and(eq(oauthApps.id, client.appId), eq(oauthApps.organizationId, client.organizationId), eq(oauthApps.clientId, p.clientId)))
      .limit(1);

    if (!row || row.app.deletedAt) return { kind: "error_page", reason: "unknown_client" };
    if (row.app.disabledAt) return { kind: "error_page", reason: "client_disabled" };
    if (row.orgArchivedAt) return { kind: "error_page", reason: "organization_archived" };
    if (!redirectUriMatches(row.app.redirectUris, p.redirectUri)) return { kind: "error_page", reason: "redirect_mismatch" };
    // From here the redirect URI is the app's own registered one: errors may be returned to it.
    if (!row.role || !row.memberActive) return { kind: "error_page", reason: "not_a_member" };

    const fail = (error: string, description: string) => redirectError(p.redirectUri, issuer, error, description, p.state);
    if (p.responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!p.state) return fail("invalid_request", "The state parameter is required.");
    if (!p.codeChallenge) return fail("invalid_request", "PKCE is required: send code_challenge and code_challenge_method=S256.");
    if (p.codeChallengeMethod !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
    if (!isValidCodeChallenge(p.codeChallenge)) return fail("invalid_request", "code_challenge is not a valid S256 challenge.");

    const requested = parseScopeString(p.scope ?? "");
    if (requested.length === 0) return fail("invalid_scope", "The scope parameter is required.");
    const unknown = requested.filter((s) => !isApiScope(s));
    if (unknown.length > 0) return fail("invalid_scope", "One or more requested scopes are not recognised.");
    const scopes = API_SCOPES.filter((s) => requested.includes(s)); // canonical order
    if (scopes.some((s) => !row.app.scopes.includes(s))) return fail("invalid_scope", "A requested scope is not enabled for this app.");
    if (scopesBeyondRole(scopes, row.role).length > 0) {
      return fail("access_denied", "The signed-in user's role does not permit one or more of the requested scopes.");
    }

    const request: AuthorizeRequest = {
      clientId: p.clientId,
      redirectUri: p.redirectUri,
      scope: scopes.join(" "),
      state: p.state,
      codeChallenge: p.codeChallenge,
    };

    if (mode === "preview") {
      return {
        kind: "consent",
        view: {
          app: { id: row.app.id, name: row.app.name, description: row.app.description, homepageUrl: row.app.homepageUrl, clientId: row.app.clientId },
          organization: { id: row.app.organizationId, name: row.orgName, slug: row.orgSlug },
          role: row.role,
          scopes: scopes.map((s) => SCOPE_INFO[s]),
          redirectHost: new URL(p.redirectUri).host,
          request,
        },
      };
    }

    // The person is acting for themselves: a HUMAN actor with their real role.
    const actor: Actor = { userId: user.id, organizationId: client.organizationId, role: row.role };

    if (mode === "deny") {
      await AuditService.record(tx, actor, {
        action: "oauth_consent.denied",
        entityType: "OAuthApp",
        entityId: row.app.id,
        after: { clientId: row.app.clientId, scopes },
      });
      return fail("access_denied", "The user denied the request.");
    }

    const { code, hash } = generateAuthorizationCode();
    await tx.insert(oauthAuthorizationCodes).values({
      organizationId: client.organizationId,
      appId: row.app.id,
      userId: user.id,
      codeHash: hash,
      scopes,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000),
    });
    await AuditService.record(tx, actor, {
      action: "oauth_consent.approved",
      entityType: "OAuthApp",
      entityId: row.app.id,
      after: { clientId: row.app.clientId, scopes },
    });
    // Housekeeping so abandoned consents do not accumulate: codes expired for over a day (bounded, one statement).
    await tx
      .delete(oauthAuthorizationCodes)
      .where(and(eq(oauthAuthorizationCodes.organizationId, client.organizationId), lt(oauthAuthorizationCodes.expiresAt, sql`now() - interval '1 day'`)));
    return { kind: "redirect", approved: true, url: buildRedirectUrl(p.redirectUri, { code, state: p.state, iss: issuer }) };
  });
}
