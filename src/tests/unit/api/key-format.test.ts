import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { displayKey, generateApiKey, hashApiKey, hashesEqual, parseApiKey, parseBearer } from "@/domain/api/api-key-format";

describe("API key format", () => {
  it("is mm_live_<8 char non-secret prefix>_<256-bit secret as 43 base64url characters>", () => {
    const k = generateApiKey();
    expect(k.fullKey).toMatch(/^mm_live_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(k.fullKey.startsWith(`mm_live_${k.prefix}_`)).toBe(true);
    // 43 base64url chars decode to exactly 32 bytes = 256 bits.
    const secret = k.fullKey.slice("mm_live_".length + 8 + 1);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
  });

  it("is high entropy: 2,000 keys never repeat a secret and the prefix alphabet is uniformly used", () => {
    const secrets = new Set<string>();
    const prefixes = new Set<string>();
    const letters = new Map<string, number>();
    for (let i = 0; i < 2000; i += 1) {
      const k = generateApiKey();
      secrets.add(k.fullKey.slice(-43));
      prefixes.add(k.prefix);
      for (const ch of k.prefix) letters.set(ch, (letters.get(ch) ?? 0) + 1);
    }
    expect(secrets.size).toBe(2000);
    expect(prefixes.size).toBeGreaterThan(1990); // 36^8 possibilities: a collision in 2,000 is vanishingly unlikely
    expect(letters.size).toBe(36); // every character of the alphabet appears
    // Roughly uniform: the expected count per letter is 16000/36 ~ 444; none should be wildly off.
    for (const n of letters.values()) {
      expect(n).toBeGreaterThan(300);
      expect(n).toBeLessThan(600);
    }
  });

  it("stores only a SHA-256 hex digest of the whole key", () => {
    const k = generateApiKey();
    expect(k.secretHash).toBe(createHash("sha256").update(k.fullKey).digest("hex"));
    expect(k.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.secretHash).not.toContain(k.fullKey.slice(-43));
    expect(hashApiKey(k.fullKey)).toBe(k.secretHash);
  });

  it("parses only well-formed keys, with no database involved", () => {
    const k = generateApiKey();
    expect(parseApiKey(k.fullKey)).toEqual({ prefix: k.prefix, secretHash: k.secretHash });
    for (const bad of [
      "",
      "garbage",
      k.fullKey.toUpperCase(),
      k.fullKey + "x",
      k.fullKey.slice(0, -1),
      k.fullKey.replace("mm_live_", "mm_test_"),
      `mm_live_${k.prefix.toUpperCase()}_${k.fullKey.slice(-43)}`,
      `mm_live_${k.prefix}-${k.fullKey.slice(-43)}`,
      `${k.fullKey}\n`,
      "mm_live_abcdefgh_" + "!".repeat(43),
      "x".repeat(5000),
    ]) {
      expect(parseApiKey(bad), bad.slice(0, 40)).toBeNull();
    }
  });

  it("compares hashes in constant-time form and rejects any difference, including length", () => {
    const a = hashApiKey("one");
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashApiKey("two"))).toBe(false);
    expect(hashesEqual(a, a.slice(0, -1))).toBe(false);
    expect(hashesEqual("", a)).toBe(false);
    const flipped = (a[0] === "0" ? "1" : "0") + a.slice(1);
    expect(hashesEqual(a, flipped)).toBe(false);
  });

  it("takes the credential only from a Bearer Authorization header", () => {
    expect(parseBearer("Bearer abc")).toBe("abc");
    expect(parseBearer("bearer abc")).toBe("abc");
    expect(parseBearer("Bearer   abc  ")).toBe("abc");
    for (const bad of [null, undefined, "", "abc", "Basic abc", "Bearer", "Bearer a b", "Token abc"]) expect(parseBearer(bad)).toBeNull();
  });

  it("shows a key as prefix only", () => {
    const k = generateApiKey();
    expect(displayKey(k.prefix)).toContain(k.prefix);
    expect(displayKey(k.prefix)).not.toContain(k.fullKey.slice(-43));
  });
});
