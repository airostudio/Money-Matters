import { getCurrentUser } from "@/lib/session";
import { authorize, type RawParams } from "@/domain/oauth/authorize-service";
import { verifyConsentToken } from "@/domain/oauth/csrf";
import { issuerFor } from "@/domain/oauth/metadata";

/**
 * The consent decision (Allow / Deny). A same-origin form POST only, defended in depth:
 *   1. `application/x-www-form-urlencoded` and a small body;
 *   2. the `Origin` header must be this site (a browser always sends it on a cross-site POST);
 *   3. the signed-in session must exist (NextAuth cookie, read here and ONLY here in the OAuth surface);
 *   4. the CSRF token must verify: an HMAC bound to this person and to the exact request they were shown;
 *   5. the whole authorization request is then RE-VALIDATED from scratch by `authorize` (client, redirect URI, PKCE,
 *      scopes, membership, role) - nothing in the form is trusted.
 * On success the person is sent to the app's registered redirect URI with the single-use `code` (or `error=access_denied`).
 * The hand-off is a tiny interstitial page, not a 3xx: browsers apply the consent page's CSP `form-action` to the redirect
 * chain of a form submission, and the app's address is (rightly) not in it. The interstitial navigates with a meta refresh
 * and a visible link. Responses are `no-store` with no Referer, so the code is not leaked onwards.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_FORM_BYTES = 16 * 1024;
const FORM_FIELDS = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"] as const;

const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } as const;

// A RELATIVE Location (valid per RFC 9110) so it cannot be wrong behind a proxy that rewrites the host.
function errorRedirect(_request: Request, reason: string): Response {
  return new Response(null, { status: 303, headers: { Location: `/oauth/error?reason=${encodeURIComponent(reason)}`, ...noStore } });
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function handOff(target: string): Response {
  const href = escapeHtml(target);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Returning to the app</title><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${href}"></head><body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:28rem;padding:0 1rem"><p>Returning you to the app&hellip;</p><p><a href="${href}" rel="noreferrer">Continue</a> if you are not redirected.</p></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...noStore } });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set([new URL(request.url).origin, issuerFor(request.url)]);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) allowed.add(`${request.headers.get("x-forwarded-proto") ?? "https"}://${forwardedHost}`);
  return allowed.has(origin);
}

export async function POST(request: Request): Promise<Response> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(type)) return errorRedirect(request, "csrf");
  if (Number(request.headers.get("content-length") ?? "0") > MAX_FORM_BYTES) return errorRedirect(request, "csrf");
  if (!sameOrigin(request)) return errorRedirect(request, "csrf");

  const text = await request.text();
  if (text.length > MAX_FORM_BYTES) return errorRedirect(request, "csrf");
  const form = new URLSearchParams(text);

  const user = await getCurrentUser();
  if (!user) return errorRedirect(request, "session");

  const raw: RawParams = {};
  for (const field of FORM_FIELDS) {
    const values = form.getAll(field);
    if (values.length > 1) return errorRedirect(request, "invalid_request");
    if (values.length === 1) raw[field] = values[0] as string;
  }
  const decision = form.get("decision");
  const csrf = form.get("csrf");
  if ((decision !== "allow" && decision !== "deny") || !csrf) return errorRedirect(request, "csrf");

  const signedFor = {
    clientId: (raw.client_id as string | undefined) ?? "",
    redirectUri: (raw.redirect_uri as string | undefined) ?? "",
    scope: (raw.scope as string | undefined) ?? "",
    state: (raw.state as string | undefined) ?? "",
    codeChallenge: (raw.code_challenge as string | undefined) ?? "",
  };
  if (!verifyConsentToken(csrf, user.id, signedFor)) return errorRedirect(request, "csrf");

  const outcome = await authorize({ id: user.id }, raw, decision === "allow" ? "approve" : "deny", issuerFor(request.url));
  if (outcome.kind === "redirect") return handOff(outcome.url);
  if (outcome.kind === "error_page") return errorRedirect(request, outcome.reason);
  return errorRedirect(request, "invalid_request");
}
