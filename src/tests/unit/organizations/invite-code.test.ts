import { describe, expect, it } from "vitest";
import { INVITE_CODE_LABEL, generateInviteCode, hashInviteCode, normaliseInviteCode } from "@/domain/organizations/invite-code";
import { INVITE_TTL_DAYS } from "@/domain/organizations/limits";
import { inviteExpiry, inviteStatus } from "@/domain/organizations/invite-service";
import { normalizeEmail } from "@/domain/auth/email";

describe("invite code format", () => {
  it("is mmj_ + 32 base32 characters (160 bits, above the 128-bit floor)", () => {
    const { code } = generateInviteCode();
    expect(code).toMatch(/^mmj_[a-z2-7]{32}$/);
    expect(code.startsWith(INVITE_CODE_LABEL)).toBe(true);
    expect(32 * 5).toBeGreaterThanOrEqual(128);
  });

  it("is random: 500 codes are all distinct, and every base32 character appears (no stuck bits)", () => {
    const codes = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const { code } = generateInviteCode();
      codes.add(code);
      for (const ch of code.slice(4)) seen.add(ch);
    }
    expect(codes.size).toBe(500);
    expect(seen.size).toBe(32);
  });

  it("stores only a SHA-256 hash; the prefix is short, non-secret, and not enough to reconstruct the code", () => {
    const { code, prefix, codeHash } = generateInviteCode();
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash).toBe(hashInviteCode(code));
    expect(code.startsWith(prefix)).toBe(true);
    expect(prefix).toHaveLength(INVITE_CODE_LABEL.length + 6);
    expect(codeHash).not.toContain(code.slice(4, 14));
    expect(hashInviteCode(code)).not.toBe(hashInviteCode(`${code}x`));
  });
});

describe("invite code normalisation (what a person typed or pasted)", () => {
  const { code } = generateInviteCode();

  it("accepts the code with surrounding whitespace, upper case, spaces or hyphens in groups", () => {
    expect(normaliseInviteCode(`  ${code}\n`)).toBe(code);
    expect(normaliseInviteCode(code.toUpperCase())).toBe(code);
    const grouped = `${code.slice(0, 8)}-${code.slice(8, 16)} ${code.slice(16)}`;
    expect(normaliseInviteCode(grouped)).toBe(code);
  });

  it("rejects anything that is not the exact shape, without ever needing the database", () => {
    for (const bad of ["", "mmj_", "mmj_short", `${code}a`, code.slice(0, -1), code.replace("mmj_", "mm_"), `mmj_${"1".repeat(32)}`, "x".repeat(500), "mm_live_abcdefgh_" + "a".repeat(43)]) {
      expect(normaliseInviteCode(bad), bad.slice(0, 20)).toBeNull();
    }
    expect(normaliseInviteCode(undefined as unknown as string)).toBeNull();
  });
});

describe("invite validity", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("expires INVITE_TTL_DAYS (7) after creation", () => {
    expect(INVITE_TTL_DAYS).toBe(7);
    expect(inviteExpiry(now).toISOString()).toBe("2026-06-08T00:00:00.000Z");
  });

  it("status: pending until used, revoked or past its expiry (the expiry instant itself is expired)", () => {
    const expiresAt = inviteExpiry(now);
    const base = { usedAt: null, revokedAt: null, expiresAt };
    expect(inviteStatus(base, now)).toBe("PENDING");
    expect(inviteStatus(base, new Date(expiresAt.getTime() - 1))).toBe("PENDING");
    expect(inviteStatus(base, expiresAt)).toBe("EXPIRED");
    expect(inviteStatus({ ...base, revokedAt: now }, now)).toBe("REVOKED");
    expect(inviteStatus({ ...base, usedAt: now }, now)).toBe("USED");
    expect(inviteStatus({ ...base, usedAt: now, revokedAt: now }, now)).toBe("USED");
  });
});

describe("email-match rule used at redemption", () => {
  it("compares normalised addresses: case and surrounding whitespace never matter, anything else does", () => {
    expect(normalizeEmail("  Jane.Smith@Example.COM ")).toBe("jane.smith@example.com");
    expect(normalizeEmail("Jane@Example.com")).toBe(normalizeEmail("jane@example.com "));
    expect(normalizeEmail("jane@example.com")).not.toBe(normalizeEmail("jane+x@example.com"));
    expect(normalizeEmail("jane@example.com")).not.toBe(normalizeEmail("jane@example.co"));
  });
});
