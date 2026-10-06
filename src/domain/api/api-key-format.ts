import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API key format: `mm_live_<prefix>_<secret>`.
 *
 *  - `prefix`: 8 random characters of [a-z0-9]. NOT secret - it is shown in the key list, used to look the key up
 *    and named in audit rows, so a person can tell keys apart and the server can find one with a single indexed
 *    query without scanning hashes.
 *  - `secret`: 32 random bytes (256 bits) as 43 base64url characters, from the OS CSPRNG.
 *
 * Storage: only the SHA-256 of the whole key string is stored (hex). A fast hash is the right tool HERE, unlike
 * for passwords: the secret is 256 bits of uniform randomness, so there is nothing to guess and no dictionary to
 * run - the work factor of bcrypt/scrypt exists to slow down guessing LOW-entropy secrets, and would only make
 * every API request slower (and a pre-auth CPU-exhaustion lever) for no security gain. Comparison is constant-time.
 *
 * The full key is returned to the creator exactly once (`generateApiKey`) and is never logged, audited or stored.
 */
export const KEY_PREFIX_LABEL = "mm_live_";
const PREFIX_LENGTH = 8;
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_BYTES = 32;
const SECRET_LENGTH = 43; // base64url of 32 bytes, unpadded

const KEY_PATTERN = new RegExp(`^mm_live_([a-z0-9]{${PREFIX_LENGTH}})_([A-Za-z0-9_-]{${SECRET_LENGTH}})$`);

export interface GeneratedApiKey {
  /** The complete key. Shown once, never stored. */
  fullKey: string;
  prefix: string;
  /** Hex SHA-256 of `fullKey`. */
  secretHash: string;
}

function randomPrefix(): string {
  // Rejection sampling over 256 so every letter is equally likely (36 does not divide 256).
  let out = "";
  const limit = 256 - (256 % PREFIX_ALPHABET.length);
  while (out.length < PREFIX_LENGTH) {
    for (const byte of randomBytes(PREFIX_LENGTH * 2)) {
      if (byte < limit && out.length < PREFIX_LENGTH) out += PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length];
    }
  }
  return out;
}

export function hashApiKey(fullKey: string): string {
  return createHash("sha256").update(fullKey, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomPrefix();
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const fullKey = `${KEY_PREFIX_LABEL}${prefix}_${secret}`;
  return { fullKey, prefix, secretHash: hashApiKey(fullKey) };
}

export interface ParsedApiKey {
  prefix: string;
  /** Hex SHA-256 of the presented key, ready to compare against the stored hash. */
  secretHash: string;
}

/**
 * Cheap, DB-free validation of a presented key: exact shape or `null`. Garbage never reaches the database
 * (docs/security.md section 15: protecting the lookup from being a DB-hammering vector for invalid keys).
 */
export function parseApiKey(presented: string): ParsedApiKey | null {
  if (presented.length > 128) return null;
  const match = KEY_PATTERN.exec(presented);
  if (!match) return null;
  return { prefix: match[1] as string, secretHash: hashApiKey(presented) };
}

/** Constant-time comparison of two hex digests of equal, known length. */
export function hashesEqual(presentedHash: string, storedHash: string): boolean {
  const a = Buffer.from(presentedHash, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) {
    // Still do a comparison of equal-length buffers so the time does not depend on where the lengths differ.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** A key as it is safe to display anywhere: the prefix only. */
export function displayKey(prefix: string): string {
  return `${KEY_PREFIX_LABEL}${prefix}_${"•".repeat(8)}`;
}

/** Extracts the bearer token from an Authorization header, or null. Only the `Bearer` scheme is accepted. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? (match[1] as string) : null;
}
