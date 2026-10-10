import { createHash, randomBytes } from "node:crypto";

/**
 * Invite code format: `mmj_<32 characters of lower-case base32>`.
 *
 *  - 20 random bytes (160 bits) from the OS CSPRNG, base32 encoded (a-z, 2-7: no ambiguous 0/1/8/9 characters, easy
 *    to read out or paste). 160 bits comfortably exceeds the 128-bit floor.
 *  - Storage: only the SHA-256 (hex) of the normalised code is stored, in `organization_invite_index`. As with API
 *    keys, a fast hash is right here: the secret is uniformly random, so there is nothing to guess and no dictionary
 *    to run; a slow KDF would only add cost. The invite row keeps a short NON-secret display prefix (the first six
 *    characters after `mmj_`), enough to tell invites apart in a list and far too short to help anyone guess a code.
 *  - The code is shown to the creator exactly once and is never logged, audited, or stored.
 *
 * The code is a BEARER secret handed over out of band, so redemption additionally requires the redeeming account's
 * email to equal the invite's email, and failed attempts are throttled (invite-service.ts).
 */
export const INVITE_CODE_LABEL = "mmj_";
const CODE_BYTES = 20;
const BODY_LENGTH = 32; // 160 bits / 5 bits per base32 character
const PREFIX_BODY_CHARS = 6;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const CODE_PATTERN = new RegExp(`^${INVITE_CODE_LABEL}[a-z2-7]{${BODY_LENGTH}}$`);

export interface GeneratedInviteCode {
  /** The complete code. Shown once, never stored. */
  code: string;
  /** Non-secret display prefix, e.g. `mmj_ab3d9f`. */
  prefix: string;
  /** Hex SHA-256 of `code`. */
  codeHash: string;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function generateInviteCode(): GeneratedInviteCode {
  const body = base32(randomBytes(CODE_BYTES));
  const code = `${INVITE_CODE_LABEL}${body}`;
  return { code, prefix: `${INVITE_CODE_LABEL}${body.slice(0, PREFIX_BODY_CHARS)}`, codeHash: hashInviteCode(code) };
}

/**
 * Cheap, DB-free normalisation of what a person typed or pasted: trims, lower-cases, and drops spaces and hyphens
 * (so a code read out in groups still works). Returns the canonical code, or `null` when it is not even the right
 * shape - garbage never reaches the database.
 */
export function normaliseInviteCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 128) return null;
  const compact = input.trim().toLowerCase().replace(/[\s-]+/g, "");
  return CODE_PATTERN.test(compact) ? compact : null;
}
