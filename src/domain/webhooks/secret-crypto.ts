import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of webhook signing secrets at rest (docs/security.md section 16).
 *
 * Signing needs the RAW secret, so unlike an API key it cannot be stored as a one-way hash. It is encrypted with
 * AES-256-GCM under a key held ONLY in the environment (`WEBHOOK_SECRET_ENCRYPTION_KEY`: 32 random bytes, base64 -
 * `openssl rand -base64 32`), never in the database. A database dump alone therefore reveals no usable secret.
 *
 * Stored value = base64( version(1 byte) | iv(12) | tag(16) | ciphertext ), plus the version in its own column. The
 * additional authenticated data binds a ciphertext to its organization AND subscription row, so a copied ciphertext cannot
 * be replayed into another row. Key rotation: the keyring holds the current key (its version is
 * WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION, default 1) and any older ones as WEBHOOK_SECRET_ENCRYPTION_KEY_V<n>; new
 * ciphertexts use the current version, old ones still decrypt until re-encrypted by a secret rotation.
 *
 * FAIL CLOSED: when the key is missing or malformed, `loadKeyring` returns a reason instead of throwing, webhook creation
 * and delivery are refused, and nothing else in the application is affected (the build does not read this variable).
 */
export const ENCRYPTION_KEY_ENV = "WEBHOOK_SECRET_ENCRYPTION_KEY";
export const ENCRYPTION_KEY_VERSION_ENV = "WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type Env = Record<string, string | undefined>;

export interface Keyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export type KeyringResult = { ok: true; keyring: Keyring } | { ok: false; reason: string };

export class WebhookEncryptionUnavailableError extends Error {
  constructor(reason: string) {
    super(`Webhooks are disabled: ${reason}`);
    this.name = "WebhookEncryptionUnavailableError";
  }
}

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptionError";
  }
}

/** Strictly decodes a base64 key: it must round-trip exactly and be 32 bytes. */
function decodeKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== KEY_BYTES) return null;
  if (buf.toString("base64") !== trimmed) return null;
  return buf;
}

export function loadKeyring(env: Env = process.env): KeyringResult {
  const raw = env[ENCRYPTION_KEY_ENV];
  if (!raw || raw.trim() === "") return { ok: false, reason: `${ENCRYPTION_KEY_ENV} is not set` };
  const current = decodeKey(raw);
  if (!current) return { ok: false, reason: `${ENCRYPTION_KEY_ENV} must be 32 random bytes, base64-encoded (openssl rand -base64 32)` };

  const versionRaw = env[ENCRYPTION_KEY_VERSION_ENV];
  const version = versionRaw === undefined || versionRaw.trim() === "" ? 1 : Number(versionRaw);
  if (!Number.isInteger(version) || version < 1 || version > 255) return { ok: false, reason: `${ENCRYPTION_KEY_VERSION_ENV} must be an integer from 1 to 255` };

  const keys = new Map<number, Buffer>([[version, current]]);
  for (let v = 1; v <= 255; v += 1) {
    if (v === version) continue;
    const old = env[`${ENCRYPTION_KEY_ENV}_V${v}`];
    if (!old) continue;
    const decoded = decodeKey(old);
    if (!decoded) return { ok: false, reason: `${ENCRYPTION_KEY_ENV}_V${v} is not a valid base64 32-byte key` };
    keys.set(v, decoded);
  }
  return { ok: true, keyring: { currentVersion: version, keys } };
}

export function webhookEncryptionStatus(env: Env = process.env): { configured: true } | { configured: false; reason: string } {
  const result = loadKeyring(env);
  return result.ok ? { configured: true } : { configured: false, reason: result.reason };
}

export function requireKeyring(env: Env = process.env): Keyring {
  const result = loadKeyring(env);
  if (!result.ok) throw new WebhookEncryptionUnavailableError(result.reason);
  return result.keyring;
}

function aad(organizationId: string, subscriptionId: string): Buffer {
  return Buffer.from(`mm-webhook-secret:v1:${organizationId}:${subscriptionId}`, "utf8");
}

export function encryptSecret(
  plaintext: string,
  context: { organizationId: string; subscriptionId: string },
  keyring: Keyring,
): { ciphertext: string; keyVersion: number } {
  const key = keyring.keys.get(keyring.currentVersion) as Buffer;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context.organizationId, context.subscriptionId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([Buffer.from([keyring.currentVersion]), iv, tag, body]);
  return { ciphertext: packed.toString("base64"), keyVersion: keyring.currentVersion };
}

export function decryptSecret(
  ciphertext: string,
  context: { organizationId: string; subscriptionId: string },
  keyring: Keyring,
): string {
  const packed = Buffer.from(ciphertext, "base64");
  if (packed.length < 1 + IV_BYTES + TAG_BYTES + 1) throw new SecretDecryptionError("The stored secret is malformed.");
  const version = packed[0] as number;
  const key = keyring.keys.get(version);
  if (!key) throw new SecretDecryptionError(`No encryption key is configured for key version ${version}.`);
  const iv = packed.subarray(1, 1 + IV_BYTES);
  const tag = packed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = packed.subarray(1 + IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad(context.organizationId, context.subscriptionId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampered ciphertext or a ciphertext moved to another row: indistinguishable on purpose, and no detail leaks.
    throw new SecretDecryptionError("The stored secret could not be decrypted (wrong key or tampered data).");
  }
}
