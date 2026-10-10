import { createHash, randomBytes } from "node:crypto";
import { authorize, type AuthorizeOutcome } from "@/domain/oauth/authorize-service";
import { OAuthAppService } from "@/domain/oauth/app-service";
import { handleRevocationRequest, handleTokenRequest } from "@/domain/oauth/http";
import type { Actor } from "@/domain/permissions/permission-service";
import { authThrottle } from "@/domain/api/auth-throttle";

export const ISSUER = "http://localhost:3000";
export const REDIRECT = "https://app.example.test/callback";
export const ALL_READ_SCOPES = ["contacts:read", "accounts:read", "invoices:read", "bills:read", "payments:read", "journals:read", "reports:read"];

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

export async function registerApp(
  owner: Actor,
  opts: { type?: "PUBLIC" | "CONFIDENTIAL"; scopes?: string[]; redirectUris?: string[]; name?: string } = {},
) {
  const created = await OAuthAppService.create(owner, {
    name: opts.name ?? "Test App",
    description: "A test application",
    homepageUrl: "https://app.example.test",
    clientType: opts.type ?? "CONFIDENTIAL",
    redirectUris: opts.redirectUris ?? [REDIRECT],
    scopes: opts.scopes ?? [...ALL_READ_SCOPES, "invoices:write", "contacts:write"],
  });
  return { appId: created.app.id, clientId: created.app.clientId, clientSecret: created.clientSecret };
}

export interface AuthRequestOverrides {
  [key: string]: string | undefined;
}

export function authRequest(clientId: string, challenge: string, overrides: AuthRequestOverrides = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "invoices:read contacts:read",
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export function codeFrom(outcome: AuthorizeOutcome): string {
  if (outcome.kind !== "redirect" || !outcome.approved) throw new Error(`expected an approved redirect, got ${JSON.stringify(outcome).slice(0, 200)}`);
  const code = new URL(outcome.url).searchParams.get("code");
  if (!code) throw new Error("no code in redirect");
  return code;
}

/** The person approves the consent screen: returns the authorization code. */
export async function consent(userId: string, clientId: string, challenge: string, overrides: AuthRequestOverrides = {}): Promise<string> {
  return codeFrom(await authorize({ id: userId }, authRequest(clientId, challenge, overrides), "approve", ISSUER));
}

export interface TokenCall {
  status: number;
  body: any;
  headers: Headers;
  text: string;
}

export async function form(
  path: "token" | "revoke",
  fields: Record<string, string | undefined>,
  opts: { basic?: { id: string; secret: string }; ip?: string; contentType?: string; query?: string } = {},
): Promise<TokenCall> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(k, v);
  const headers = new Headers({
    "content-type": opts.contentType ?? "application/x-www-form-urlencoded",
    "x-forwarded-for": opts.ip ?? "198.51.100.7",
  });
  if (opts.basic) {
    headers.set("authorization", `Basic ${Buffer.from(`${encodeURIComponent(opts.basic.id)}:${encodeURIComponent(opts.basic.secret)}`).toString("base64")}`);
  }
  const request = new Request(`http://localhost:3000/api/oauth/${path}${opts.query ?? ""}`, { method: "POST", headers, body: body.toString() });
  const response = path === "token" ? await handleTokenRequest(request) : await handleRevocationRequest(request);
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

/** Full happy path for a confidential app: consent + code exchange. Returns the tokens. */
export async function connect(
  userId: string,
  app: { clientId: string; clientSecret: string | null },
  overrides: AuthRequestOverrides = {},
): Promise<{ access: string; refresh: string; verifier: string; code: string; scope: string }> {
  const { verifier, challenge } = pkcePair();
  const code = await consent(userId, app.clientId, challenge, overrides);
  const res = await form(
    "token",
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: overrides.redirect_uri ?? REDIRECT,
      code_verifier: verifier,
      ...(app.clientSecret ? {} : { client_id: app.clientId }),
    },
    app.clientSecret ? { basic: { id: app.clientId, secret: app.clientSecret } } : {},
  );
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.text}`);
  return { access: res.body.access_token, refresh: res.body.refresh_token, verifier, code, scope: res.body.scope };
}

export function resetOAuthThrottle() {
  authThrottle.clear();
}
