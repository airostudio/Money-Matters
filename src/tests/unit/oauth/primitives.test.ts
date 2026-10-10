import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ACCESS_TOKEN_LABEL,
  constantTimeEqual,
  generateAccessToken,
  generateAuthorizationCode,
  generateClientId,
  generateClientSecret,
  generateRefreshToken,
  hashCredential,
  isAuthorizationCodeShape,
  isClientId,
  isClientSecretShape,
  isRefreshTokenShape,
  looksLikeAccessToken,
  parseAccessToken,
  s256,
} from "@/domain/oauth/credentials";
import { isValidCodeChallenge, isValidCodeVerifier, verifyCodeVerifier, SUPPORTED_CODE_CHALLENGE_METHODS } from "@/domain/oauth/pkce";
import {
  InvalidRedirectUriError,
  buildRedirectUrl,
  redirectUriMatches,
  validateHomepageUrl,
  validateRegisteredRedirectUri,
  validateRegisteredRedirectUris,
} from "@/domain/oauth/redirect-uri";
import { signConsentToken, verifyConsentToken } from "@/domain/oauth/csrf";
import { buildMetadata, issuerFor } from "@/domain/oauth/metadata";
import * as C from "@/domain/oauth/constants";
import { API_SCOPES } from "@/domain/api/scopes";
import { parseAuthorizeParams, parseScopeString } from "@/domain/oauth/authorize-service";
import { readClientCredentials } from "@/domain/oauth/http";

describe("credential formats", () => {
  it("every credential is opaque random, distinct-prefixed, the right shape, and stored only as a SHA-256", () => {
    const secret = generateClientSecret();
    const code = generateAuthorizationCode();
    const access = generateAccessToken();
    const refresh = generateRefreshToken();
    expect(isClientId(generateClientId())).toBe(true);
    expect(isClientSecretShape(secret.secret)).toBe(true);
    expect(isAuthorizationCodeShape(code.code)).toBe(true);
    expect(parseAccessToken(access.token)?.prefix).toBe(access.prefix);
    expect(isRefreshTokenShape(refresh.token)).toBe(true);
    for (const [value, hash] of [[secret.secret, secret.hash], [code.code, code.hash], [access.token, access.hash], [refresh.token, refresh.hash]] as const) {
      expect(hash).toBe(createHash("sha256").update(value).digest("hex"));
      expect(hash).toBe(hashCredential(value));
      expect(value).not.toContain(".");
    }
    expect(secret.secret).toMatch(/^mmo_cs_/);
    expect(code.code).toMatch(/^mmo_ac_/);
    expect(access.token).toMatch(/^mmo_at_/);
    expect(refresh.token).toMatch(/^mmo_rt_/);
    expect(access.token.startsWith("mm_live_")).toBe(false);
  });

  it("is high entropy: 5,000 generated tokens never collide and 256 bits of secret each", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(generateRefreshToken().token);
    expect(seen.size).toBe(5000);
    expect(generateRefreshToken().token.length).toBe("mmo_rt_".length + 43);
  });

  it("a JWT-looking or oversized or wrongly-labelled value is not accepted anywhere", () => {
    expect(parseAccessToken("eyJhbGciOiJub25lIn0.e30.")).toBeNull();
    expect(parseAccessToken(`${ACCESS_TOKEN_LABEL}short`)).toBeNull();
    expect(parseAccessToken(`${ACCESS_TOKEN_LABEL}abcdefgh_${"A".repeat(200)}`)).toBeNull();
    expect(parseAccessToken(`mm_live_abcdefgh_${"A".repeat(43)}`)).toBeNull();
    expect(looksLikeAccessToken(`mm_live_abcdefgh_${"A".repeat(43)}`)).toBe(false);
    expect(isRefreshTokenShape(`mmo_rt_${"A".repeat(42)}`)).toBe(false);
    expect(isAuthorizationCodeShape(`mmo_ac_${"A".repeat(44)}`)).toBe(false);
  });

  it("constant-time comparison is correct for equal, different and different-length inputs", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("PKCE (RFC 7636), S256 only", () => {
  // RFC 7636 appendix B test vector.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("matches the RFC 7636 appendix B vector", () => {
    expect(s256(verifier)).toBe(challenge);
    expect(verifyCodeVerifier(verifier, challenge)).toBe(true);
  });

  it("rejects a wrong verifier, a malformed verifier and a malformed challenge", () => {
    expect(verifyCodeVerifier(verifier.replace("d", "e"), challenge)).toBe(false);
    expect(verifyCodeVerifier("short", challenge)).toBe(false);
    expect(verifyCodeVerifier(`${verifier}!`, challenge)).toBe(false);
    expect(verifyCodeVerifier(verifier, challenge.slice(1))).toBe(false);
    // plain would be verifier === challenge: it must not verify.
    expect(verifyCodeVerifier(verifier, verifier)).toBe(false);
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeChallenge(challenge)).toBe(true);
    expect(isValidCodeChallenge(`${challenge}=`)).toBe(false);
  });

  it("S256 is the only method advertised", () => {
    expect([...SUPPORTED_CODE_CHALLENGE_METHODS]).toEqual(["S256"]);
  });
});

describe("redirect URIs", () => {
  it("accepts https and http loopback only", () => {
    for (const ok of ["https://app.example.com/cb", "https://app.example.com/a/b?x=1", "http://localhost/cb", "http://localhost:8080/cb", "http://127.0.0.1:5000/cb", "http://[::1]:7000/cb"]) {
      expect(validateRegisteredRedirectUri(ok), ok).toBe(ok);
    }
  });

  it("rejects wildcards, fragments, credentials, other schemes, non-loopback http, whitespace and junk", () => {
    for (const bad of [
      "",
      "   ",
      "https://*.example.com/cb",
      "https://app.example.com/*",
      "https://app.example.com/cb#frag",
      "https://user:pw@app.example.com/cb",
      "http://app.example.com/cb",
      "http://example.localhost.evil.com/cb",
      "javascript:alert(1)",
      "data:text/html,hi",
      "myapp://callback",
      "ftp://app.example.com/cb",
      "//app.example.com/cb",
      "/relative",
      "https://app.example.com/ cb",
      "not a uri",
      `https://app.example.com/${"a".repeat(2100)}`,
    ]) {
      expect(() => validateRegisteredRedirectUri(bad), bad.slice(0, 40)).toThrow(InvalidRedirectUriError);
    }
  });

  it("a list needs 1..10 unique entries", () => {
    expect(() => validateRegisteredRedirectUris([], 10)).toThrow(/at least one/);
    expect(() => validateRegisteredRedirectUris(["https://a.example.com/cb", "https://a.example.com/cb"], 10)).toThrow(/twice/);
    expect(() => validateRegisteredRedirectUris(Array.from({ length: 11 }, (_, i) => `https://a.example.com/${i}`), 10)).toThrow(/at most 10/);
    expect(validateRegisteredRedirectUris(["https://a.example.com/cb "], 10)).toEqual(["https://a.example.com/cb"]);
  });

  it("matches EXACTLY: no prefix, no case change, no trailing slash, no extra query, no scheme downgrade", () => {
    const reg = ["https://app.example.com/callback"];
    expect(redirectUriMatches(reg, "https://app.example.com/callback")).toBe(true);
    for (const bad of [
      "https://app.example.com/callback/",
      "https://app.example.com/callback?x=1",
      "https://app.example.com/callback#x",
      "https://app.example.com/Callback",
      "https://APP.example.com/callback",
      "http://app.example.com/callback",
      "https://app.example.com/callback/../x",
      "https://app.example.com:444/callback",
      "https://app.example.com.evil.test/callback",
      "https://evil.test/callback?https://app.example.com/callback",
      "https://app.example.com/callbackx",
      "",
    ]) {
      expect(redirectUriMatches(reg, bad), bad).toBe(false);
    }
  });

  it("a registered LOOPBACK uri matches any port (RFC 8252) but nothing else may differ", () => {
    const reg = ["http://127.0.0.1/cb", "http://localhost:3000/auth"];
    expect(redirectUriMatches(reg, "http://127.0.0.1:51234/cb")).toBe(true);
    expect(redirectUriMatches(reg, "http://127.0.0.1/cb")).toBe(true);
    expect(redirectUriMatches(reg, "http://localhost:9999/auth")).toBe(true);
    expect(redirectUriMatches(reg, "http://127.0.0.1:51234/other")).toBe(false);
    expect(redirectUriMatches(reg, "http://127.0.0.1:51234/cb?x=1")).toBe(false);
    expect(redirectUriMatches(reg, "https://127.0.0.1:51234/cb")).toBe(false);
    expect(redirectUriMatches(reg, "http://localhost:51234/cb")).toBe(false);
    expect(redirectUriMatches(reg, "http://[::1]:1/cb")).toBe(false);
    // An https registration never gets port flexibility.
    expect(redirectUriMatches(["https://app.example.com/cb"], "https://app.example.com:8443/cb")).toBe(false);
    // Nor does a non-loopback http host presented against a loopback registration.
    expect(redirectUriMatches(reg, "http://evil.test:80/cb")).toBe(false);
  });

  it("homepage URLs are https (or loopback) and optional", () => {
    expect(validateHomepageUrl("")).toBeNull();
    expect(validateHomepageUrl(undefined)).toBeNull();
    expect(validateHomepageUrl("https://app.example.com")).toBe("https://app.example.com");
    expect(() => validateHomepageUrl("javascript:alert(1)")).toThrow();
    expect(() => validateHomepageUrl("http://app.example.com")).toThrow();
  });

  it("buildRedirectUrl appends parameters and keeps an existing query", () => {
    const url = new URL(buildRedirectUrl("https://app.example.com/cb?tenant=1", { code: "c", state: "s s", iss: "https://x.test", skip: undefined }));
    expect(url.searchParams.get("tenant")).toBe("1");
    expect(url.searchParams.get("code")).toBe("c");
    expect(url.searchParams.get("state")).toBe("s s");
    expect(url.searchParams.has("skip")).toBe(false);
  });
});

describe("consent CSRF token", () => {
  const req = { clientId: "mmo_c_x", redirectUri: "https://a.example.com/cb", scope: "contacts:read", state: "st", codeChallenge: "c".repeat(43) };
  const now = new Date("2026-01-01T00:00:00Z");

  it("verifies for the same person and request, and for nothing else", () => {
    const token = signConsentToken("user-1", req, now);
    expect(verifyConsentToken(token, "user-1", req, now)).toBe(true);
    expect(verifyConsentToken(token, "user-2", req, now)).toBe(false);
    for (const key of Object.keys(req) as Array<keyof typeof req>) {
      expect(verifyConsentToken(token, "user-1", { ...req, [key]: `${req[key]}x` }, now), key).toBe(false);
    }
  });

  it("expires after ten minutes, and rejects tampering, truncation and junk", () => {
    const token = signConsentToken("user-1", req, now);
    expect(verifyConsentToken(token, "user-1", req, new Date(now.getTime() + 9 * 60_000))).toBe(true);
    expect(verifyConsentToken(token, "user-1", req, new Date(now.getTime() + 11 * 60_000))).toBe(false);
    const [exp, mac] = token.split(".") as [string, string];
    expect(verifyConsentToken(`${Number(exp) + 3600}.${mac}`, "user-1", req, now)).toBe(false);
    expect(verifyConsentToken(`${exp}.${mac.slice(0, -2)}AA`, "user-1", req, now)).toBe(false);
    for (const junk of ["", ".", "abc", "1.", ".abc", "x".repeat(500), `${exp}`]) expect(verifyConsentToken(junk, "user-1", req, now)).toBe(false);
  });
});

describe("authorization-server metadata (RFC 8414)", () => {
  const m = buildMetadata("https://mm.example.test");
  it("advertises exactly what is implemented: code + refresh only, S256 only, no implicit / password / client credentials / introspection", () => {
    expect(m.issuer).toBe("https://mm.example.test");
    expect(m.authorization_endpoint).toBe("https://mm.example.test/oauth/authorize");
    expect(m.token_endpoint).toBe("https://mm.example.test/api/oauth/token");
    expect(m.revocation_endpoint).toBe("https://mm.example.test/api/oauth/revoke");
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.scopes_supported).toEqual([...API_SCOPES]);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/introspection|implicit|password|client_credentials|"plain"/);
  });
  it("derives the issuer from NEXTAUTH_URL when set, else from the request origin", () => {
    expect(issuerFor("http://internal:3000/x", { NEXTAUTH_URL: "https://mm.example.test/app" })).toBe("https://mm.example.test");
    expect(issuerFor("http://localhost:3000/x", {})).toBe("http://localhost:3000");
    expect(issuerFor("http://localhost:3000/x", { NEXTAUTH_URL: "not a url" })).toBe("http://localhost:3000");
  });
});

describe("tunables are pinned", () => {
  it("access 1 hour, refresh 30 days, code 60 seconds, 10 apps per organization", () => {
    expect(C.ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
    expect(C.REFRESH_TOKEN_TTL_DAYS).toBe(30);
    expect(C.AUTH_CODE_TTL_SECONDS).toBe(60);
    expect(C.CONSENT_FORM_TTL_SECONDS).toBe(600);
    expect(C.MAX_APPS_PER_ORG).toBe(10);
    expect(C.MAX_REDIRECT_URIS_PER_APP).toBe(10);
    expect(C.MAX_TOKEN_BODY_BYTES).toBe(8192);
    expect(C.TOKEN_LIMIT_PER_IP_PER_MINUTE).toBe(60);
    expect(C.TOKEN_LIMIT_PER_CLIENT_PER_MINUTE).toBe(300);
    expect(C.API_LIMIT_PER_GRANT_PER_MINUTE).toBe(60);
  });
});

describe("request parsing", () => {
  it("authorize params: client_id and redirect_uri are mandatory and single-valued; the rest are optional strings", () => {
    expect(parseAuthorizeParams({})).toBeNull();
    expect(parseAuthorizeParams({ client_id: "a" })).toBeNull();
    expect(parseAuthorizeParams({ client_id: ["a", "b"], redirect_uri: "https://x" })).toBeNull();
    expect(parseAuthorizeParams({ client_id: "a", redirect_uri: "x".repeat(3000) })).toBeNull();
    expect(parseAuthorizeParams({ client_id: "a", redirect_uri: "https://x", state: ["1", "2"] })?.state).toBeUndefined();
    expect(parseAuthorizeParams({ client_id: "a", redirect_uri: "https://x", state: "ok" })?.state).toBe("ok");
  });
  it("scope strings split on spaces, de-duplicate and drop blanks", () => {
    expect(parseScopeString("a  b a")).toEqual(["a", "b"]);
    expect(parseScopeString("")).toEqual([]);
  });
  it("client credentials: Basic (url-decoded), body secret, never both, mismatched ids refused", () => {
    const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;
    expect(readClientCredentials(basic("cid", "se:cret"), new URLSearchParams())).toEqual({ clientId: "cid", secret: "se:cret", viaBasic: true });
    expect(readClientCredentials(null, new URLSearchParams({ client_id: "cid", client_secret: "s" }))).toEqual({ clientId: "cid", secret: "s", viaBasic: false });
    expect(readClientCredentials(null, new URLSearchParams({ client_id: "cid" }))).toEqual({ clientId: "cid", secret: null, viaBasic: false });
    expect(() => readClientCredentials(basic("cid", "s"), new URLSearchParams({ client_secret: "s" }))).toThrow(/one client authentication method/);
    expect(() => readClientCredentials(basic("cid", "s"), new URLSearchParams({ client_id: "other" }))).toThrow(/does not match/);
    expect(() => readClientCredentials("Bearer abc", new URLSearchParams())).toThrow(/Client authentication failed/);
    expect(() => readClientCredentials(null, new URLSearchParams())).toThrow(/client_id is required/);
  });
});
