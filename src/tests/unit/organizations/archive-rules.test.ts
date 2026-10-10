import { describe, expect, it } from "vitest";
import {
  ARCHIVE_REASON_MAX_LENGTH,
  ARCHIVE_REASON_MIN_LENGTH_ADMIN,
  ARCHIVE_REASON_MIN_LENGTH_OWNER,
  InvalidArchiveReasonError,
  OrganizationArchivedError,
  normaliseArchiveReason,
} from "@/domain/organizations/archive-rules";
import { isOrganizationArchivedDigest } from "@/domain/organizations/archived-digest";
import { MAX_OWNED_ACTIVE_COMPANIES, MAX_PENDING_INVITES_PER_ORG } from "@/domain/organizations/limits";
import { CompanyLimitReachedError } from "@/domain/organizations/organization-service";
import { resolvePrincipal, type KeyLookupRow } from "@/domain/api/api-auth";
import { generateApiKey } from "@/domain/api/api-key-format";
import type { ApiError } from "@/domain/api/errors";
import { redactSensitive } from "@/domain/audit/audit-service";

describe("archive reason", () => {
  it("is trimmed and must meet the minimum for its actor (owner 5, platform admin 10) and the maximum", () => {
    expect(normaliseArchiveReason("  closing down  ", ARCHIVE_REASON_MIN_LENGTH_OWNER)).toBe("closing down");
    expect(() => normaliseArchiveReason("    ab  ", ARCHIVE_REASON_MIN_LENGTH_OWNER)).toThrow(InvalidArchiveReasonError);
    expect(() => normaliseArchiveReason(undefined, ARCHIVE_REASON_MIN_LENGTH_OWNER)).toThrow(InvalidArchiveReasonError);
    expect(() => normaliseArchiveReason("too short", ARCHIVE_REASON_MIN_LENGTH_ADMIN)).toThrow(InvalidArchiveReasonError); // 9 chars
    expect(normaliseArchiveReason("long enough!", ARCHIVE_REASON_MIN_LENGTH_ADMIN)).toBe("long enough!");
    expect(() => normaliseArchiveReason("x".repeat(ARCHIVE_REASON_MAX_LENGTH + 1), 5)).toThrow(InvalidArchiveReasonError);
    expect(normaliseArchiveReason("x".repeat(ARCHIVE_REASON_MAX_LENGTH), 5)).toHaveLength(ARCHIVE_REASON_MAX_LENGTH);
  });
});

describe("the archived-aware error", () => {
  it("carries a digest the org error boundary recognises, and a plain-language message", () => {
    const error = new OrganizationArchivedError("org-1");
    expect(isOrganizationArchivedDigest(error.digest)).toBe(true);
    expect(isOrganizationArchivedDigest("PERMISSION_DENIED|x|y")).toBe(false);
    expect(isOrganizationArchivedDigest(undefined)).toBe(false);
    expect(error.message).toMatch(/archived/i);
  });
});

describe("company ownership cap", () => {
  it("is five active companies per person, and the refusal says archived ones do not count", () => {
    expect(MAX_OWNED_ACTIVE_COMPANIES).toBe(5);
    expect(new CompanyLimitReachedError().message).toMatch(/5 active companies/);
    expect(new CompanyLimitReachedError().message).toMatch(/archived companies do not count/i);
  });

  it("caps pending invites per organization", () => {
    expect(MAX_PENDING_INVITES_PER_ORG).toBe(10);
  });
});

describe("API key authentication of an archived organization", () => {
  const key = generateApiKey();
  const now = new Date("2026-06-01T00:00:00Z");
  const base: KeyLookupRow = {
    id: "k1",
    organizationId: "o1",
    prefix: key.prefix,
    secretHash: key.secretHash,
    createdByUserId: "u1",
    scopes: ["invoices:read"],
    expiresAt: null,
    revokedAt: null,
    rateLimitPerMinute: null,
    membershipRole: "OWNER",
    membershipActive: true,
    userDisabledAt: null,
  };
  const code = (row: KeyLookupRow, hash = key.secretHash) => {
    try {
      resolvePrincipal(row, hash, now);
      return "ok";
    } catch (e) {
      return `${(e as ApiError).status} ${(e as ApiError).code}`;
    }
  };

  it("a valid key of an archived organization is refused with a clear 403 problem; an active one still works", () => {
    expect(code(base)).toBe("ok");
    expect(code({ ...base, organizationArchivedAt: null })).toBe("ok");
    expect(code({ ...base, organizationArchivedAt: new Date("2026-05-01") })).toBe("403 organization_archived");
  });

  it("does not disclose the archive to someone holding a WRONG secret, and a revoked/expired key keeps its own error", () => {
    const archived = { ...base, organizationArchivedAt: new Date("2026-05-01") };
    expect(code(archived, "0".repeat(64))).toBe("401 invalid_api_key");
    expect(code({ ...archived, revokedAt: new Date("2026-05-02") })).toBe("401 api_key_revoked");
    expect(code({ ...archived, expiresAt: new Date("2026-05-02") })).toBe("401 api_key_expired");
  });
});

describe("audit redaction of invite secrets", () => {
  it("redacts invite code fields but leaves ordinary account `code` fields alone", () => {
    const out = redactSensitive({ inviteCode: "mmj_x", invite_code: "mmj_y", codeHash: "h", code_hash: "h2", code: "1000", codePrefix: "mmj_ab12cd" }) as Record<string, unknown>;
    expect(out).toEqual({ inviteCode: "[redacted]", invite_code: "[redacted]", codeHash: "[redacted]", code_hash: "[redacted]", code: "1000", codePrefix: "mmj_ab12cd" });
  });
});
