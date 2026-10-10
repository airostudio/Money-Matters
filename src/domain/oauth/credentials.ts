import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hashApiKey, hashesEqual, randomPrefix } from "@/domain/api/api-key-format";

/**
 * Credential formats for OAuth (docs/security.md section 20). All are opaque random strings from the OS CSPRNG - never
 * JWTs, nothing is decoded - with a distinct, greppable label so a leaked one is recognisable by secret scanners and
 * is never mistaken for an API key (`mm_live_`).
 *
 *   client id            mmo_c_<22 base64url chars>                public identifier (not a secret)
 *   client secret        mmo_cs_<tag6>_<43 base64url chars>        confidential clients only; shown once
 *   authorization code   mmo_ac_<43 base64url chars>               single use, <= 60 s
 *   access token         mmo_at_<prefix8>_<43 base64url chars>     1 h; <prefix8> is the lookup index, not a secret
 *   refresh token        mmo_rt_<43 base64url chars>               30 d, rotated on every use
 *
 * Storage: only the SHA-256 (hex) of the WHOLE string. As for API keys, a fast hash is the right tool - the secret is 256
 * bits of uniform randomness, so there is nothing to guess and bcrypt's work factor would only be a pre-auth CPU lever.
 * Comparison is constant-time (`hashesEqual`). Nothing here is ever logged or audited.
 */
export const CLIENT_ID_LABEL = "mmo_c_";
export const CLIENT_SECRET_LABEL = "mmo_cs_";
export const AUTH_CODE_LABEL = "mmo_ac_";
export const ACCESS_TOKEN_LABEL = "mmo_at_";
export const REFRESH_TOKEN_LABEL = "mmo_rt_";

const SECRET_BYTES = 32;
const CLIENT_ID_PATTERN = /^mmo_c_[A-Za-z0-9_-]{22}$/;
const CLIENT_SECRET_PATTERN = /^mmo_cs_([a-z0-9]{6})_[A-Za-z0-9_-]{43}$/;
const AUTH_CODE_PATTERN = /^mmo_ac_[A-Za-z0-9_-]{43}$/;
const ACCESS_TOKEN_PATTERN = /^mmo_at_([a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_PATTERN = /^mmo_rt_[A-Za-z0-9_-]{43}$/;

/** Hex SHA-256 of a credential. */
export const hashCredential = hashApiKey;
export { hashesEqual };

const secretPart = () => randomBytes(SECRET_BYTES).toString("base64url");

export function generateClientId(): string {
  return `${CLIENT_ID_LABEL}${randomBytes(16).toString("base64url")}`;
}

export function generateClientSecret(): { secret: string; tag: string; hash: string } {
  const tag = randomPrefix().slice(0, 6);
  const secret = `${CLIENT_SECRET_LABEL}${tag}_${secretPart()}`;
  return { secret, tag, hash: hashCredential(secret) };
}

export function generateAuthorizationCode(): { code: string; hash: string } {
  const code = `${AUTH_CODE_LABEL}${secretPart()}`;
  return { code, hash: hashCredential(code) };
}

export function generateAccessToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomPrefix();
  const token = `${ACCESS_TOKEN_LABEL}${prefix}_${secretPart()}`;
  return { token, prefix, hash: hashCredential(token) };
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = `${REFRESH_TOKEN_LABEL}${secretPart()}`;
  return { token, hash: hashCredential(token) };
}

export const isClientId = (value: string): boolean => value.length <= 64 && CLIENT_ID_PATTERN.test(value);
export const isClientSecretShape = (value: string): boolean => value.length <= 128 && CLIENT_SECRET_PATTERN.test(value);
export const isAuthorizationCodeShape = (value: string): boolean => value.length <= 128 && AUTH_CODE_PATTERN.test(value);
export const isRefreshTokenShape = (value: string): boolean => value.length <= 128 && REFRESH_TOKEN_PATTERN.test(value);

/** Does the bearer string claim to be an OAuth access token (decides which authenticator handles it)? */
export const looksLikeAccessToken = (bearer: string): boolean => bearer.startsWith(ACCESS_TOKEN_LABEL);

/** DB-free validation of a presented access token: exact shape or null. Garbage never reaches the database. */
export function parseAccessToken(presented: string): { prefix: string; hash: string } | null {
  if (presented.length > 128) return null;
  const match = ACCESS_TOKEN_PATTERN.exec(presented);
  if (!match) return null;
  return { prefix: match[1] as string, hash: hashCredential(presented) };
}

/** base64url(SHA-256(input)) - the PKCE S256 transform. */
export function s256(input: string): string {
  return createHash("sha256").update(input, "ascii").digest("base64url");
}

/** Constant-time equality of two strings of any length (never short-circuits on content). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}
