import { createHmac } from "node:crypto";
import { CONSENT_FORM_TTL_SECONDS } from "./constants";
import { constantTimeEqual } from "./credentials";
import type { AuthorizeRequest } from "./authorize-service";

/**
 * CSRF protection for the consent decision (the allow / deny POST). Defence in depth, three independent layers, all of
 * which must pass (src/app/oauth/authorize/decision/route.ts):
 *   1. the request must be a same-origin browser POST (the `Origin` header must be this site);
 *   2. the signed-in session must still belong to the person the form was issued to;
 *   3. THIS token: an HMAC over (person, expiry, and the exact authorization request - client, redirect URI, scope,
 *      state, PKCE challenge), keyed from NEXTAUTH_SECRET. A page on another site cannot forge one (it cannot read this
 *      page, and has no key), and a token issued for one request cannot approve a different one - it is bound to the
 *      person and to the request they were shown, and expires after ten minutes.
 * The token carries no secret and is not stored. It is NOT what authorises access: approving still re-validates the whole
 * request server-side and consent is always explicit.
 */
function key(): Buffer {
  const secret = (process.env.NEXTAUTH_SECRET ?? "").trim();
  if (secret.length < 16) throw new Error("NEXTAUTH_SECRET is not configured.");
  // A purpose-specific subkey, so this MAC can never be confused with anything else derived from the same secret.
  return createHmac("sha256", secret).update("money-matters:oauth-consent:v1").digest();
}

function mac(userId: string, expires: number, request: AuthorizeRequest): string {
  const material = JSON.stringify([userId, expires, request.clientId, request.redirectUri, request.scope, request.state, request.codeChallenge]);
  return createHmac("sha256", key()).update(material).digest("base64url");
}

export function signConsentToken(userId: string, request: AuthorizeRequest, now: Date = new Date()): string {
  const expires = Math.floor(now.getTime() / 1000) + CONSENT_FORM_TTL_SECONDS;
  return `${expires}.${mac(userId, expires, request)}`;
}

export function verifyConsentToken(token: string, userId: string, request: AuthorizeRequest, now: Date = new Date()): boolean {
  const dot = token.indexOf(".");
  if (dot < 1 || token.length > 200) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isInteger(expires) || expires < Math.floor(now.getTime() / 1000)) return false;
  return constantTimeEqual(token.slice(dot + 1), mac(userId, expires, request));
}
