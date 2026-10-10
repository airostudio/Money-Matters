import { clientAddress } from "@/domain/api/auth-throttle";
import { MAX_TOKEN_BODY_BYTES, TOKEN_LIMIT_PER_CLIENT_PER_MINUTE, TOKEN_LIMIT_PER_IP_PER_MINUTE } from "./constants";
import { isClientId } from "./credentials";
import { OAuthProtocolError, oauthErrors } from "./errors";
import { consumeBuckets, purgeStaleBuckets, type BucketRequest } from "./rate-limit";
import { exchangeAuthorizationCode, refreshAccessToken, revokeToken, type ClientCredentials } from "./token-service";

/**
 * HTTP shell of the token (RFC 6749 section 3.2) and revocation (RFC 7009) endpoints.
 *
 *  - POST only, `application/x-www-form-urlencoded` only (anything else is refused before the body is read), a hard
 *    8 KiB body cap, every parameter at most once, and NOTHING accepted in the query string (a secret in a URL ends up
 *    in logs and Referer headers).
 *  - Client authentication: HTTP Basic (`client_secret_basic`) or `client_secret` in the body (`client_secret_post`) for
 *    confidential clients; `client_id` alone for public ones. Never both.
 *  - Rate limited per address AND per client id with the Postgres counter, BEFORE any other database work.
 *  - Every response - success or error - is `Cache-Control: no-store` JSON (RFC 6749 section 5.1). No CORS header is ever
 *    sent: token requests come from an app's server or native code, not from another site's JavaScript.
 *  - Errors are RFC 6749 section 5.2 bodies; an unexpected failure is a generic `server_error` and the real cause is
 *    logged as its first line only - never a header, body, code or token.
 */
const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...RESPONSE_HEADERS, ...extra } });
}

export function oauthErrorResponse(error: OAuthProtocolError): Response {
  return json(error.status, { error: error.code, error_description: error.description }, error.headers);
}

async function readFormBody(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) {
    throw new OAuthProtocolError(415, "invalid_request", "Content-Type must be application/x-www-form-urlencoded.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_TOKEN_BODY_BYTES) throw oauthErrors.invalidRequest("The request body is too large.");
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOKEN_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oauthErrors.invalidRequest("The request body is too large.");
      }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  const params = new URLSearchParams(text);
  for (const key of new Set(params.keys())) {
    if (params.getAll(key).length > 1) throw oauthErrors.invalidRequest(`The parameter "${key}" must not be repeated.`);
  }
  return params;
}

function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw oauthErrors.invalidClient(true);
  }
}

/** Reads client credentials from Basic auth and/or the body. Throws on none, on both, or on a mismatch. */
export function readClientCredentials(authorization: string | null, params: URLSearchParams): ClientCredentials {
  const bodyId = params.get("client_id");
  const bodySecret = params.get("client_secret");
  const basic = authorization ? /^Basic[ \t]+([A-Za-z0-9+/=_-]+)$/i.exec(authorization.trim()) : null;
  if (authorization && !basic) throw oauthErrors.invalidClient(true);
  if (basic) {
    if (bodySecret !== null) throw oauthErrors.invalidRequest("Use one client authentication method, not both.");
    const decoded = Buffer.from(basic[1] as string, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) throw oauthErrors.invalidClient(true);
    const id = formDecode(decoded.slice(0, colon));
    const secret = formDecode(decoded.slice(colon + 1));
    if (bodyId !== null && bodyId !== id) throw oauthErrors.invalidRequest("client_id does not match the Authorization header.");
    return { clientId: id, secret, viaBasic: true };
  }
  if (!bodyId) throw oauthErrors.invalidRequest("client_id is required.");
  return { clientId: bodyId, secret: bodySecret, viaBasic: false };
}

function logServerError(endpoint: string, error: unknown): void {
  const first = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 300);
  console.error(`[oauth] ${endpoint} failed: ${first}`);
}

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EMAXCONNSESSION", "53300", "57P03"].includes(code ?? "") ||
    /timeout exceeded when trying to connect|EMAXCONNSESSION|max clients reached|Connection terminated/i.test(message);
}

async function rateLimit(request: Request, clientId: string, now: Date): Promise<void> {
  const requests: BucketRequest[] = [{ bucket: `tok:ip:${clientAddress(request.headers)}`, limit: TOKEN_LIMIT_PER_IP_PER_MINUTE }];
  if (isClientId(clientId)) requests.push({ bucket: `tok:client:${clientId}`, limit: TOKEN_LIMIT_PER_CLIENT_PER_MINUTE });
  const results = await consumeBuckets(requests, now.getTime());
  const exceeded = results.find((r) => !r.allowed);
  if (exceeded) throw oauthErrors.rateLimited(exceeded.resetInSeconds);
}

type Endpoint = "token" | "revoke";

async function handle(request: Request, endpoint: Endpoint, now: Date): Promise<Response> {
  try {
    if (new URL(request.url).search !== "") throw oauthErrors.invalidRequest("Send parameters in the request body, not the query string.");
    const params = await readFormBody(request);
    const creds = readClientCredentials(request.headers.get("authorization"), params);
    await rateLimit(request, creds.clientId, now);

    if (endpoint === "revoke") {
      const token = params.get("token");
      if (!token) throw oauthErrors.invalidRequest("token is required.");
      await revokeToken(creds, token, now);
      return new Response(null, { status: 200, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
    }

    const grantType = params.get("grant_type");
    if (grantType === "authorization_code") {
      const code = params.get("code");
      const redirectUri = params.get("redirect_uri");
      const verifier = params.get("code_verifier");
      if (!code || !redirectUri || !verifier) throw oauthErrors.invalidRequest("code, redirect_uri and code_verifier are required.");
      return json(200, await exchangeAuthorizationCode(creds, { code, redirectUri, codeVerifier: verifier }, now));
    }
    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token");
      if (!refreshToken) throw oauthErrors.invalidRequest("refresh_token is required.");
      return json(200, await refreshAccessToken(creds, { refreshToken, scope: params.get("scope") ?? undefined }, now));
    }
    if (!grantType) throw oauthErrors.invalidRequest("grant_type is required.");
    throw oauthErrors.unsupportedGrantType();
  } catch (error) {
    if (error instanceof OAuthProtocolError) return oauthErrorResponse(error);
    logServerError(endpoint, error);
    return isConnectionFailure(error)
      ? json(503, { error: "temporarily_unavailable", error_description: "The service is temporarily unavailable. Retry shortly." }, { "Retry-After": "5" })
      : oauthErrorResponse(oauthErrors.server());
  } finally {
    // Rare housekeeping after the response is decided; never allowed to affect it.
    if (Math.random() < 0.01) await purgeStaleBuckets().catch(() => undefined);
  }
}

export const handleTokenRequest = (request: Request, now: Date = new Date()) => handle(request, "token", now);
export const handleRevocationRequest = (request: Request, now: Date = new Date()) => handle(request, "revoke", now);

export function methodNotAllowedResponse(): Response {
  return json(405, { error: "invalid_request", error_description: "Use POST." }, { Allow: "POST" });
}
