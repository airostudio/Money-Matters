import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption of secrets at rest (docs/security.md sections 16 and 19). One mechanism, several purposes: webhook signing
 * secrets (Phase 10 Slice 2) and integration credentials such as a Slack incoming-webhook URL (Slice 3).
 *
 * A secret that must be USED later (signing needs the raw secret; a webhook URL is the credential itself) cannot be
 * stored as a one-way hash. It is encrypted with AES-256-GCM under a key held ONLY in the environment
 * (`WEBHOOK_SECRET_ENCRYPTION_KEY`: 32 random bytes, base64 - `openssl rand -base64 32`; the name is kept so existing
 * deployments need no change), never in the database. A database dump alone therefore reveals no usable secret.
 *
 * Stored value = base64( version(1 byte) | iv(12) | tag(16) | ciphertext ), plus the version in its own column. The
 * additional authenticated data binds a ciphertext to its PURPOSE, organization AND row, so a copied ciphertext cannot be
 * replayed into another row, another organization, or from one purpose into another (a webhook secret cannot be
 * presented as an integration credential). The `webhook` purpose keeps the original AAD byte for byte, so every
 * ciphertext written before this generalisation still decrypts. Key rotation: the keyring holds the current key (its
 * version is WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION, default 1) and any older ones as WEBHOOK_SECRET_ENCRYPTION_KEY_V<n>;
 * new ciphertexts use the current version, old ones still decrypt until re-encrypted.
 *
 * FAIL CLOSED: when the key is missing or malformed, `loadKeyring` returns a reason instead of throwing, and every
 * feature that needs a secret is refused; nothing else in the application is affected (the build does not read it).
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

/** What a ciphertext is bound to. `webhook` is the legacy/default purpose and keeps its original AAD. */
export type SecretPurpose = "webhook" | "integration";

export interface SecretContext {
  organizationId: string;
  /** The id of the row that holds the ciphertext: a webhook subscription, or an integration connection (see `purpose`). */
  subscriptionId: string;
  purpose?: SecretPurpose;
}

export class SecretEncryptionUnavailableError extends Error {
  constructor(reason: string) {
    super(`Secret storage is disabled: ${reason}`);
    this.name = "SecretEncryptionUnavailableError";
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

export function secretEncryptionStatus(env: Env = process.env): { configured: true } | { configured: false; reason: string } {
  const result = loadKeyring(env);
  return result.ok ? { configured: true } : { configured: false, reason: result.reason };
}

export function requireSecretKeyring(env: Env = process.env): Keyring {
  const result = loadKeyring(env);
  if (!result.ok) throw new SecretEncryptionUnavailableError(result.reason);
  return result.keyring;
}

function aad(context: SecretContext): Buffer {
  const purpose = context.purpose ?? "webhook";
  // The webhook form is byte-for-byte the original, so ciphertexts written before the purpose existed still decrypt.
  const label = purpose === "webhook" ? "mm-webhook-secret:v1" : `mm-secret:v1:${purpose}`;
  return Buffer.from(`${label}:${context.organizationId}:${context.subscriptionId}`, "utf8");
}

export function encryptSecret(plaintext: string, context: SecretContext, keyring: Keyring): { ciphertext: string; keyVersion: number } {
  const key = keyring.keys.get(keyring.currentVersion) as Buffer;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([Buffer.from([keyring.currentVersion]), iv, tag, body]);
  return { ciphertext: packed.toString("base64"), keyVersion: keyring.currentVersion };
}

export function decryptSecret(ciphertext: string, context: SecretContext, keyring: Keyring): string {
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
    decipher.setAAD(aad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampered ciphertext or a ciphertext moved to another row: indistinguishable on purpose, and no detail leaks.
    throw new SecretDecryptionError("The stored secret could not be decrypted (wrong key or tampered data).");
  }
}
