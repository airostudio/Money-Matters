/**
 * Errors of the OAuth domain. Two families:
 *  - management errors (`InvalidOAuthInputError`, `OAuthAppNotFoundError`, ...) carry a message safe to show a person in
 *    the settings UI;
 *  - `OAuthProtocolError` is a RFC 6749 section 5.2 error response (`error` + `error_description`) for the token and
 *    revocation endpoints. The description is deliberately generic where detail would help an attacker.
 */
export class InvalidOAuthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOAuthInputError";
  }
}

export class OAuthAppNotFoundError extends Error {
  constructor() {
    super("Application not found in this organization.");
    this.name = "OAuthAppNotFoundError";
  }
}

export class OAuthGrantNotFoundError extends Error {
  constructor() {
    super("Authorisation not found.");
    this.name = "OAuthGrantNotFoundError";
  }
}

export class OAuthAppLimitError extends Error {
  constructor(readonly limit: number) {
    super(`An organization may register at most ${limit} apps. Delete one you no longer use first.`);
    this.name = "OAuthAppLimitError";
  }
}

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "temporarily_unavailable"
  | "server_error";

export class OAuthProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(description);
    this.name = "OAuthProtocolError";
  }
}

export const oauthErrors = {
  invalidRequest: (description: string) => new OAuthProtocolError(400, "invalid_request", description),
  invalidClient: (basic = false) =>
    new OAuthProtocolError(401, "invalid_client", "Client authentication failed.", basic ? { "WWW-Authenticate": 'Basic realm="oauth", charset="UTF-8"' } : {}),
  invalidGrant: (description = "The authorization code, refresh token or grant is invalid, expired or revoked.") =>
    new OAuthProtocolError(400, "invalid_grant", description),
  unsupportedGrantType: () =>
    new OAuthProtocolError(400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported."),
  invalidScope: (description: string) => new OAuthProtocolError(400, "invalid_scope", description),
  rateLimited: (retryAfter: number) =>
    new OAuthProtocolError(429, "temporarily_unavailable", "Too many requests. Retry later.", { "Retry-After": String(retryAfter) }),
  server: () => new OAuthProtocolError(500, "server_error", "The server could not process the request."),
};
