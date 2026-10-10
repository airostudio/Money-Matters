import { MAX_URL_LENGTH } from "./constants";

/**
 * Redirect URI rules (RFC 6749 section 3.1.2, RFC 8252 section 7.3, RFC 9700 section 2.1).
 *
 * REGISTRATION accepts only:
 *   - `https://` URIs; or
 *   - `http://` URIs whose host is a LOOPBACK literal (`localhost`, `127.0.0.1`, `[::1]`) - for native and local
 *     development apps, which cannot hold a public https endpoint.
 * It rejects: wildcards, fragments, embedded credentials, whitespace/control characters, any other scheme (so no
 * `javascript:`, `data:` or custom-scheme redirect), and anything over `MAX_URL_LENGTH`.
 *
 * MATCHING is EXACT string comparison against the registered list - no prefix matching, no pattern, no normalisation -
 * with one RFC 8252 exception: for a registered LOOPBACK URI the PORT is ignored (a native app binds an ephemeral port
 * at run time), while scheme, host, path and query must still match exactly. The authorize endpoint never redirects to
 * a URI that does not match: it renders an error page instead, so it cannot be used as an open redirector.
 */
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class InvalidRedirectUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRedirectUriError";
  }
}

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.has(hostname.toLowerCase());

/** Returns the URI trimmed and validated, or throws `InvalidRedirectUriError` saying exactly what is wrong. */
export function validateRegisteredRedirectUri(raw: string): string {
  const uri = raw.trim();
  if (uri === "") throw new InvalidRedirectUriError("A redirect URI is empty.");
  if (uri.length > MAX_URL_LENGTH) throw new InvalidRedirectUriError("A redirect URI is too long.");
  if (/[\s\u0000-\u001f\u007f]/.test(uri)) throw new InvalidRedirectUriError(`"${uri.slice(0, 60)}" contains whitespace or control characters.`);
  if (uri.includes("*")) throw new InvalidRedirectUriError("Wildcards are not allowed in a redirect URI. Register each exact URI.");
  if (uri.includes("#")) throw new InvalidRedirectUriError("A redirect URI must not contain a fragment (#).");
  const url = parse(uri);
  if (!url) throw new InvalidRedirectUriError(`"${uri.slice(0, 60)}" is not a valid absolute URI.`);
  if (url.username || url.password) throw new InvalidRedirectUriError("A redirect URI must not contain a username or password.");
  if (url.protocol === "https:") {
    if (!url.hostname) throw new InvalidRedirectUriError("A redirect URI needs a host.");
    return uri;
  }
  if (url.protocol === "http:") {
    if (!isLoopbackHost(url.hostname)) {
      throw new InvalidRedirectUriError("Plain http is only allowed for localhost, 127.0.0.1 or [::1]. Use https for anything else.");
    }
    return uri;
  }
  throw new InvalidRedirectUriError("A redirect URI must use https (or http for localhost / 127.0.0.1 / [::1]).");
}

/** Validates a list: 1..max entries, each valid, no duplicates. */
export function validateRegisteredRedirectUris(list: readonly string[], max: number): string[] {
  const cleaned = list.map((u) => validateRegisteredRedirectUri(u));
  if (cleaned.length === 0) throw new InvalidRedirectUriError("Register at least one redirect URI.");
  if (cleaned.length > max) throw new InvalidRedirectUriError(`An app may have at most ${max} redirect URIs.`);
  if (new Set(cleaned).size !== cleaned.length) throw new InvalidRedirectUriError("The same redirect URI is listed twice.");
  return cleaned;
}

/** The comparison key for a loopback URI: everything but the port. */
function loopbackKey(url: URL): string {
  return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
}

/** Does `presented` match one of the registered URIs? Exact, except the port of a registered loopback URI. */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (presented.length === 0 || presented.length > MAX_URL_LENGTH) return false;
  if (registered.includes(presented)) return true;
  const presentedUrl = parse(presented);
  if (!presentedUrl || presentedUrl.protocol !== "http:" || !isLoopbackHost(presentedUrl.hostname)) return false;
  if (presentedUrl.hash || presentedUrl.username || presentedUrl.password) return false;
  for (const candidate of registered) {
    const url = parse(candidate);
    if (!url || url.protocol !== "http:" || !isLoopbackHost(url.hostname)) continue;
    if (loopbackKey(url) === loopbackKey(presentedUrl)) return true;
  }
  return false;
}

/** An https (or loopback http) URL for an app's homepage, or null when blank. */
export function validateHomepageUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (value.length > MAX_URL_LENGTH) throw new InvalidRedirectUriError("The homepage URL is too long.");
  const url = parse(value);
  if (!url || url.username || url.password || /[\s\u0000-\u001f]/.test(value)) throw new InvalidRedirectUriError("The homepage must be a valid https URL.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new InvalidRedirectUriError("The homepage must be an https URL.");
  }
  return value;
}

/** Builds the redirect target: the registered URI plus extra query parameters (existing ones are kept). */
export function buildRedirectUrl(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}
