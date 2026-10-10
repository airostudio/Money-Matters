import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  SecretDecryptionError,
  WebhookEncryptionUnavailableError,
  decryptSecret,
  encryptSecret,
  loadKeyring,
  requireKeyring,
  webhookEncryptionStatus,
} from "@/domain/webhooks/secret-crypto";

const key = () => randomBytes(32).toString("base64");
const ctx = { organizationId: "11111111-1111-1111-1111-111111111111", subscriptionId: "22222222-2222-2222-2222-222222222222" };

function ring(env: Record<string, string | undefined>) {
  const r = loadKeyring(env);
  if (!r.ok) throw new Error(r.reason);
  return r.keyring;
}

describe("webhook secret encryption (AES-256-GCM)", () => {
  it("round-trips a secret and never stores the plaintext", () => {
    const keyring = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() });
    const { ciphertext, keyVersion } = encryptSecret("whsec_super_secret", ctx, keyring);
    expect(keyVersion).toBe(1);
    expect(ciphertext).not.toContain("whsec_super_secret");
    expect(Buffer.from(ciphertext, "base64").toString("latin1")).not.toContain("super_secret");
    expect(decryptSecret(ciphertext, ctx, keyring)).toBe("whsec_super_secret");
  });

  it("uses a fresh random IV: the same plaintext encrypts differently every time", () => {
    const keyring = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() });
    expect(encryptSecret("s", ctx, keyring).ciphertext).not.toBe(encryptSecret("s", ctx, keyring).ciphertext);
  });

  it("detects tampering with any byte of the ciphertext", () => {
    const keyring = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() });
    const { ciphertext } = encryptSecret("whsec_abc", ctx, keyring);
    const bytes = Buffer.from(ciphertext, "base64");
    for (const index of [1, 13, 20, bytes.length - 1]) {
      const copy = Buffer.from(bytes);
      copy[index] = (copy[index] as number) ^ 0x01;
      expect(() => decryptSecret(copy.toString("base64"), ctx, keyring), `byte ${index}`).toThrow(SecretDecryptionError);
    }
    expect(() => decryptSecret("", ctx, keyring)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret("AAAA", ctx, keyring)).toThrow(SecretDecryptionError);
  });

  it("fails with the wrong key and reveals nothing about why", () => {
    const { ciphertext } = encryptSecret("whsec_abc", ctx, ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() }));
    expect(() => decryptSecret(ciphertext, ctx, ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() }))).toThrow(SecretDecryptionError);
  });

  it("binds a ciphertext to its organization and subscription (a copied ciphertext does not decrypt elsewhere)", () => {
    const keyring = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() });
    const { ciphertext } = encryptSecret("whsec_abc", ctx, keyring);
    expect(() => decryptSecret(ciphertext, { ...ctx, subscriptionId: "33333333-3333-3333-3333-333333333333" }, keyring)).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(ciphertext, { ...ctx, organizationId: "44444444-4444-4444-4444-444444444444" }, keyring)).toThrow(SecretDecryptionError);
  });

  it("records the key version and decrypts old ciphertexts after the key is rotated (keyring keeps old versions)", () => {
    const oldKey = key();
    const newKey = key();
    const v1 = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: oldKey });
    const old = encryptSecret("whsec_old", ctx, v1);
    expect(old.keyVersion).toBe(1);
    expect(Buffer.from(old.ciphertext, "base64")[0]).toBe(1);

    const rotated = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: newKey, WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION: "2", WEBHOOK_SECRET_ENCRYPTION_KEY_V1: oldKey });
    expect(rotated.currentVersion).toBe(2);
    expect(decryptSecret(old.ciphertext, ctx, rotated)).toBe("whsec_old");
    const fresh = encryptSecret("whsec_new", ctx, rotated);
    expect(fresh.keyVersion).toBe(2);
    expect(Buffer.from(fresh.ciphertext, "base64")[0]).toBe(2);
    expect(decryptSecret(fresh.ciphertext, ctx, rotated)).toBe("whsec_new");

    // Dropping the old key makes old ciphertexts undecryptable - loudly, not silently.
    const withoutOld = ring({ WEBHOOK_SECRET_ENCRYPTION_KEY: newKey, WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION: "2" });
    expect(() => decryptSecret(old.ciphertext, ctx, withoutOld)).toThrow(/key version 1/);
  });
});

describe("fail closed when the key is missing or invalid", () => {
  it("reports not configured with a clear reason, and never throws from the status helpers", () => {
    expect(loadKeyring({})).toEqual({ ok: false, reason: expect.stringContaining("WEBHOOK_SECRET_ENCRYPTION_KEY is not set") });
    expect(webhookEncryptionStatus({ WEBHOOK_SECRET_ENCRYPTION_KEY: "  " })).toMatchObject({ configured: false });
    expect(webhookEncryptionStatus({ WEBHOOK_SECRET_ENCRYPTION_KEY: key() })).toEqual({ configured: true });
  });

  it.each([
    ["not base64", "%%%not-base64%%%"],
    ["16 bytes", randomBytes(16).toString("base64")],
    ["33 bytes", randomBytes(33).toString("base64")],
    ["64 hex chars", randomBytes(32).toString("hex")],
    ["non-canonical base64", `${randomBytes(32).toString("base64").slice(0, -2)}B=`],
    ["a passphrase", "correct horse battery staple"],
  ])("rejects a malformed key (%s)", (_name, value) => {
    const result = loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: value });
    // 64 hex chars happens to be valid base64 of 48 bytes; either way it is not 32 bytes.
    expect(result.ok).toBe(false);
  });

  it("rejects a bad version and a bad old key", () => {
    expect(loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key(), WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION: "0" }).ok).toBe(false);
    expect(loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key(), WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION: "256" }).ok).toBe(false);
    expect(loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key(), WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION: "x" }).ok).toBe(false);
    expect(loadKeyring({ WEBHOOK_SECRET_ENCRYPTION_KEY: key(), WEBHOOK_SECRET_ENCRYPTION_KEY_V2: "short" }).ok).toBe(false);
  });

  it("requireKeyring throws the typed error that the UI turns into a 'webhooks are disabled' message", () => {
    expect(() => requireKeyring({})).toThrow(WebhookEncryptionUnavailableError);
    expect(() => requireKeyring({})).toThrow(/Webhooks are disabled/);
  });
});
