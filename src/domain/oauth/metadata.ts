import { API_SCOPES } from "@/domain/api/scopes";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414), served at `/.well-known/oauth-authorization-server`. Public,
 * unauthenticated, identical for every caller and containing nothing about any organization. What it advertises is
 * exactly what is implemented - no implicit, no password, no client-credentials grant, PKCE S256 only, no introspection.
 */
export function issuerFor(requestUrl: string, env: Record<string, string | undefined> = process.env): string {
  const configured = (env.NEXTAUTH_URL ?? "").trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request's own origin
    }
  }
  return new URL(requestUrl).origin;
}

export function buildMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    scopes_supported: [...API_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/api/v1/openapi.json`,
  };
}
