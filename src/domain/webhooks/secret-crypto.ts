import { loadKeyring, secretEncryptionStatus, type Env, type Keyring } from "@/domain/security/secret-encryption";

/**
 * Encryption of webhook signing secrets at rest (docs/security.md section 16).
 *
 * The mechanism (AES-256-GCM under `WEBHOOK_SECRET_ENCRYPTION_KEY`, key versioning, fail-closed, AAD binding) lives in
 * `src/domain/security/secret-encryption.ts`, generalised in Phase 10 Slice 3 so integration credentials use the very same
 * machinery. This module keeps the webhook-facing names and the webhook-worded error, and re-exports the primitives
 * unchanged: `encryptSecret` / `decryptSecret` default to the `webhook` purpose, whose additional authenticated data is
 * byte-for-byte what it always was, so every secret already stored still decrypts.
 */
export {
  ENCRYPTION_KEY_ENV,
  ENCRYPTION_KEY_VERSION_ENV,
  SecretDecryptionError,
  decryptSecret,
  encryptSecret,
  loadKeyring,
  type Env,
  type Keyring,
  type KeyringResult,
} from "@/domain/security/secret-encryption";

export class WebhookEncryptionUnavailableError extends Error {
  constructor(reason: string) {
    super(`Webhooks are disabled: ${reason}`);
    this.name = "WebhookEncryptionUnavailableError";
  }
}

export function webhookEncryptionStatus(env: Env = process.env): { configured: true } | { configured: false; reason: string } {
  return secretEncryptionStatus(env);
}

export function requireKeyring(env: Env = process.env): Keyring {
  const result = loadKeyring(env);
  if (!result.ok) throw new WebhookEncryptionUnavailableError(result.reason);
  return result.keyring;
}
