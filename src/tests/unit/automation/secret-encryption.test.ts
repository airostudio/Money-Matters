import { describe, expect, it } from "vitest";
import { createDecipheriv, randomBytes } from "node:crypto";
import { SecretDecryptionError, SecretEncryptionUnavailableError, decryptSecret, encryptSecret, loadKeyring, requireSecretKeyring, secretEncryptionStatus } from "@/domain/security/secret-encryption";
import * as webhookCrypto from "@/domain/webhooks/secret-crypto";

/**
 * The generalised "secret encryption" (Phase 10 Slice 3) must keep every webhook secret stored before it existed readable,
 * keep the webhook module's names and error wording, and keep a webhook secret and an integration credential from being
 * interchangeable.
 */
const KEY = randomBytes(32).toString("base64");
const ring = () => (loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: KEY }) as { ok: true; keyring: Parameters<typeof encryptSecret>[2] }).keyring;
const ORG = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";

describe("secret encryption: backwards compatibility with stored webhook secrets", () => {
  it("the default (webhook) purpose uses exactly the original additional authenticated data, byte for byte", () => {
    const { ciphertext } = encryptSecret("whsec_example", { organizationId: ORG, subscriptionId: ROW }, ring());
    const packed = Buffer.from(ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), packed.subarray(1, 13));
    decipher.setAAD(Buffer.from(`mm-webhook-secret:v1:${ORG}:${ROW}`, "utf8")); // the format from before the generalisation
    decipher.setAuthTag(packed.subarray(13, 29));
    expect(Buffer.concat([decipher.update(packed.subarray(29)), decipher.final()]).toString("utf8")).toBe("whsec_example");
  });

  it("the webhook module still exports its original names and the webhook-worded error", () => {
    for (const name of ["encryptSecret", "decryptSecret", "loadKeyring", "requireKeyring", "webhookEncryptionStatus", "WebhookEncryptionUnavailableError", "SecretDecryptionError", "ENCRYPTION_KEY_ENV", "ENCRYPTION_KEY_VERSION_ENV"]) {
      expect(webhookCrypto, name).toHaveProperty(name);
    }
    expect(() => webhookCrypto.requireKeyring({})).toThrow(/Webhooks are disabled: WEBHOOK_SECRET_ENCRYPTION_KEY is not set/);
    expect(() => requireSecretKeyring({})).toThrow(SecretEncryptionUnavailableError);
    expect(() => requireSecretKeyring({})).toThrow(/Secret storage is disabled/);
    expect(webhookCrypto.SecretDecryptionError).toBe(SecretDecryptionError);
    expect(webhookCrypto.webhookEncryptionStatus({ WEBHOOK_SECRET_ENCRYPTION_KEY: KEY })).toEqual(secretEncryptionStatus({ WEBHOOK_SECRET_ENCRYPTION_KEY: KEY }));
  });
});

describe("secret encryption: purpose, organization and row binding", () => {
  it("a ciphertext decrypts only for its own purpose, organization and row", () => {
    const context = { organizationId: ORG, subscriptionId: ROW, purpose: "integration" as const };
    const { ciphertext } = encryptSecret("https://hooks.slack.com/services/T/B/x", context, ring());
    expect(decryptSecret(ciphertext, context, ring())).toBe("https://hooks.slack.com/services/T/B/x");
    expect(() => decryptSecret(ciphertext, { ...context, purpose: "webhook" }, ring())).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(ciphertext, { organizationId: ROW, subscriptionId: ROW, purpose: "integration" }, ring())).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(ciphertext, { organizationId: ORG, subscriptionId: ORG, purpose: "integration" }, ring())).toThrow(SecretDecryptionError);
    // and a webhook secret cannot be presented as an integration credential
    const webhook = encryptSecret("whsec", { organizationId: ORG, subscriptionId: ROW }, ring());
    expect(() => decryptSecret(webhook.ciphertext, context, ring())).toThrow(SecretDecryptionError);
  });

  it("encryption is randomised and never contains the plaintext; tampering is detected", () => {
    const context = { organizationId: ORG, subscriptionId: ROW, purpose: "integration" as const };
    const a = encryptSecret("same", context, ring());
    const b = encryptSecret("same", context, ring());
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(Buffer.from(a.ciphertext, "base64").toString("latin1")).not.toContain("same");
    const bytes = Buffer.from(a.ciphertext, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
    expect(() => decryptSecret(bytes.toString("base64"), context, ring())).toThrow(SecretDecryptionError);
  });

  it("fails closed without a valid key and never echoes it", () => {
    expect(loadKeyring({})).toMatchObject({ ok: false });
    const bad = loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: "hunter2-not-a-key" });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("hunter2");
    expect(secretEncryptionStatus({})).toMatchObject({ configured: false });
  });

  it("key rotation: a ciphertext from the previous key version still decrypts while new ones use the new version", () => {
    const oldKey = randomBytes(32).toString("base64");
    const oldRing = (loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: oldKey }) as { ok: true; keyring: Parameters<typeof encryptSecret>[2] }).keyring;
    const context = { organizationId: ORG, subscriptionId: ROW, purpose: "integration" as const };
    const old = encryptSecret("v1 secret", context, oldRing);
    const rotated = (loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: KEY, WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION: "2", WEBHOOK_SECRET_ENCRYPTION_KEY_V1: oldKey }) as { ok: true; keyring: Parameters<typeof encryptSecret>[2] }).keyring;
    expect(decryptSecret(old.ciphertext, context, rotated)).toBe("v1 secret");
    expect(encryptSecret("new", context, rotated).keyVersion).toBe(2);
  });
});
