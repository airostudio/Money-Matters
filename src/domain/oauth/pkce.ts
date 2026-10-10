import { constantTimeEqual, s256 } from "./credentials";

/**
 * PKCE (RFC 7636) - REQUIRED for every client, public or confidential, and S256 ONLY. There is no `plain` method and no
 * way to register a client that skips PKCE: `code_challenge_method=plain` (or any other value) is refused outright, and a
 * missing challenge is an `invalid_request`. A stolen authorization code is therefore useless without the verifier that
 * never left the client.
 */
export const SUPPORTED_CODE_CHALLENGE_METHODS = ["S256"] as const;

/** A S256 challenge is the base64url of a 32-byte digest: exactly 43 characters. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 section 4.1: 43-128 characters of the unreserved set. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export const isValidCodeChallenge = (value: string): boolean => CHALLENGE_PATTERN.test(value);
export const isValidCodeVerifier = (value: string): boolean => VERIFIER_PATTERN.test(value);

/** Does `verifier` hash (S256) to the stored `challenge`? Constant-time; false for a malformed verifier. */
export function verifyCodeVerifier(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  return constantTimeEqual(s256(verifier), challenge);
}
