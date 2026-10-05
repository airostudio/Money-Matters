import { describe, expect, it } from "vitest";
import { membershipRoleEnum } from "@/db/schema";
import { PERMISSIONS, ROLE_PERMISSIONS, type MembershipRole } from "@/domain/permissions/roles";
import {
  DEFAULT_INVITE_ROLE,
  PERMISSION_AREAS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLES_BY_PRIVILEGE,
  describeDenial,
  isReadOnlyRole,
  isWritePermission,
  readOnlyAreas,
  roleNeedsWriteConfirmation,
  roleOptions,
  writableAreas,
} from "@/domain/permissions/role-info";
import {
  PermissionDeniedError,
  assertPermission,
  parsePermissionDeniedDigest,
} from "@/domain/permissions/permission-service";

const ALL_ROLES = membershipRoleEnum.enumValues as readonly MembershipRole[];

/**
 * Every role is decided EXPLICITLY here, so adding a role to the enum fails
 * the exhaustiveness test below until someone decides whether it is read-only.
 */
const EXPECTED_READ_ONLY: Record<MembershipRole, boolean> = {
  OWNER: false,
  ADMINISTRATOR: false,
  ACCOUNTANT: false,
  BOOKKEEPER: false,
  ACCOUNTS_RECEIVABLE: false,
  ACCOUNTS_PAYABLE: false,
  PAYROLL_MANAGER: false,
  MANAGER: false,
  EMPLOYEE: false,
  READ_ONLY: true,
};

describe("isReadOnlyRole (derived from the permission matrix)", () => {
  it("every role in the enum has an explicit expectation", () => {
    expect([...ALL_ROLES].sort()).toEqual(Object.keys(EXPECTED_READ_ONLY).sort());
  });

  it.each(Object.entries(EXPECTED_READ_ONLY))("%s -> read-only: %s", (role, expected) => {
    expect(isReadOnlyRole(role as MembershipRole)).toBe(expected);
  });

  it("is true exactly when the role holds no non-read permission", () => {
    for (const role of ALL_ROLES) {
      const writes = [...ROLE_PERMISSIONS[role]].filter(isWritePermission);
      expect(isReadOnlyRole(role)).toBe(writes.length === 0);
    }
  });

  it("treats every write-style permission kind as a write, not just :manage", () => {
    for (const p of ["customer_invoice:post", "expense_claim:approve", "customer_invoice:void", "journal:reverse", "bank_transaction:import", "period:close"] as const) {
      expect(isWritePermission(p)).toBe(true);
    }
    for (const p of PERMISSIONS.filter((x) => x.endsWith(":read"))) expect(isWritePermission(p)).toBe(false);
  });
});

describe("write-access confirmation classification", () => {
  it("READ_ONLY never needs confirmation; every role that can write does (OWNER and ADMINISTRATOR included)", () => {
    for (const role of ALL_ROLES) {
      expect(roleNeedsWriteConfirmation(role)).toBe(!EXPECTED_READ_ONLY[role]);
    }
    expect(roleNeedsWriteConfirmation("OWNER")).toBe(true);
    expect(roleNeedsWriteConfirmation("ADMINISTRATOR")).toBe(true);
    expect(roleNeedsWriteConfirmation("READ_ONLY")).toBe(false);
  });
});

describe("role ordering and descriptions cannot drift", () => {
  it("the safe default is READ_ONLY and it is the first option", () => {
    expect(DEFAULT_INVITE_ROLE).toBe("READ_ONLY");
    expect(roleOptions()[0]!.role).toBe("READ_ONLY");
  });

  it("orders every role exactly once, least privileged first and OWNER last", () => {
    expect([...ROLES_BY_PRIVILEGE].sort()).toEqual([...ALL_ROLES].sort());
    expect(new Set(ROLES_BY_PRIVILEGE).size).toBe(ROLES_BY_PRIVILEGE.length);
    expect(ROLES_BY_PRIVILEGE[0]).toBe("READ_ONLY");
    expect(ROLES_BY_PRIVILEGE[ROLES_BY_PRIVILEGE.length - 1]).toBe("OWNER");
    expect(ROLES_BY_PRIVILEGE.indexOf("ADMINISTRATOR")).toBeGreaterThan(ROLES_BY_PRIVILEGE.indexOf("ACCOUNTANT"));
  });

  it("has a non-empty label and description for every role (fails if a role is added without one)", () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_LABELS[role]?.trim().length ?? 0).toBeGreaterThan(0);
      expect(ROLE_DESCRIPTIONS[role]?.trim().length ?? 0).toBeGreaterThan(10);
    }
    expect(Object.keys(ROLE_DESCRIPTIONS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it("names a plain-language area for every permission domain in the matrix", () => {
    for (const permission of PERMISSIONS) {
      const domain = permission.split(":")[0]!;
      expect(PERMISSION_AREAS[domain], `no area for permission domain "${domain}"`).toBeTruthy();
    }
  });

  it("derives can-change / can-only-view from the real matrix", () => {
    expect(writableAreas("READ_ONLY")).toEqual([]);
    expect(readOnlyAreas("READ_ONLY")).toContain("Sales invoices");
    expect(readOnlyAreas("READ_ONLY")).toContain("Reports");
    expect(writableAreas("ACCOUNTS_RECEIVABLE")).toContain("Sales invoices");
    expect(writableAreas("ACCOUNTS_RECEIVABLE")).not.toContain("Bills");
    expect(writableAreas("BOOKKEEPER")).toContain("Journals");
    // A read-only role's options never list anything it can change.
    const ro = roleOptions().find((o) => o.role === "READ_ONLY")!;
    expect(ro.canChange).toEqual([]);
    expect(ro.needsWriteConfirmation).toBe(false);
    expect(roleOptions().find((o) => o.role === "OWNER")!.needsWriteConfirmation).toBe(true);
  });
});

describe("permission-denied presentation", () => {
  it("PermissionDeniedError carries a digest the org error boundary can read back", () => {
    let caught: unknown;
    try {
      assertPermission({ userId: "u", organizationId: "o", role: "READ_ONLY" }, "customer_invoice:manage");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    const digest = (caught as PermissionDeniedError).digest;
    expect(parsePermissionDeniedDigest(digest)).toEqual({ permission: "customer_invoice:manage", role: "READ_ONLY" });
    // The legacy wording the existing tests match on is intact.
    expect((caught as Error).message).toMatch(/does not have permission/);
  });

  it("does not mistake an ordinary error digest for a denial", () => {
    expect(parsePermissionDeniedDigest(undefined)).toBeNull();
    expect(parsePermissionDeniedDigest("1234567890")).toBeNull();
    expect(parsePermissionDeniedDigest("PERMISSION_DENIED")).toBeNull();
  });

  it("describes a refusal in plain words", () => {
    expect(describeDenial("customer_invoice:manage", "READ_ONLY")).toEqual({ area: "Sales invoices", action: "change", roleLabel: "Read only" });
    expect(describeDenial("payrun:read", "BOOKKEEPER")).toMatchObject({ area: "Pay runs", action: "view" });
    expect(describeDenial("something_new:read", "WEIRD")).toMatchObject({ area: "something new", roleLabel: "WEIRD" });
  });
});
