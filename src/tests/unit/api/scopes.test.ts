import { describe, expect, it } from "vitest";
import {
  API_ALLOWED_PERMISSIONS,
  API_SCOPES,
  InvalidScopeError,
  SCOPE_INFO,
  effectivePermissions,
  isForbiddenForApi,
  normaliseScopes,
  scopePermissions,
} from "@/domain/api/scopes";
import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import { PermissionDeniedError, assertPermission, type Actor } from "@/domain/permissions/permission-service";
import { assertHumanWith } from "@/domain/close/period-lock-service";
import { evaluateLockChange } from "@/domain/ledger/period-lock";

const ROLES = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];

/** Permissions that are human-only or administrative by the project's own rules (docs/security.md s.11, docs/ai-agents.md s.3b). */
const HUMAN_ONLY_OR_CRITICAL: Permission[] = [
  "period:close",
  "period:reopen",
  "period:reopen_hard",
  "period:override_soft",
  "period:post_advisor_locked",
  "close_checklist:manage",
  "close_checklist:read",
  "fiscal_period:manage",
  "membership:manage",
  "organization:manage",
  "api_key:manage",
  "payment_run:approve",
  "payment_run:manage",
  "payrun:read",
  "payrun:manage",
  "payrun:post",
  "employee:read",
  "employee:manage",
  "consolidation:manage",
  "client_request:read",
  "client_request:respond",
  "client_request:manage",
  "customer_invoice:post",
  "customer_invoice:void",
  "supplier_bill:post",
  "supplier_bill:void",
  "supplier_payment:manage",
  "customer_payment:manage",
  "journal:post",
  "journal:reverse",
  "tax_code:manage",
  "account:manage",
  "audit:read",
  "bank_transaction:reconcile",
  "expense_claim:approve",
  "timesheet:approve",
];

describe("API scopes", () => {
  it("is a small closed set of ten documented scopes, each with a description", () => {
    expect([...API_SCOPES]).toEqual([
      "contacts:read",
      "contacts:write",
      "accounts:read",
      "invoices:read",
      "invoices:write",
      "bills:read",
      "bills:write",
      "payments:read",
      "journals:read",
      "reports:read",
    ]);
    for (const scope of API_SCOPES) {
      expect(SCOPE_INFO[scope].description.length).toBeGreaterThan(20);
      expect(SCOPE_INFO[scope].write).toBe(scope.endsWith(":write"));
    }
  });

  it("NO scope maps to any human-only, posting, approving, voiding or administrative permission", () => {
    for (const scope of API_SCOPES) {
      for (const permission of SCOPE_INFO[scope].permissions) {
        expect(API_ALLOWED_PERMISSIONS.has(permission), `${scope} -> ${permission} must be in the API whitelist`).toBe(true);
        expect(isForbiddenForApi(permission), `${scope} -> ${permission} is forbidden for the API`).toBe(false);
        expect(HUMAN_ONLY_OR_CRITICAL, `${scope} -> ${permission}`).not.toContain(permission);
      }
    }
    // And the union of everything any scope can ever grant is exactly the whitelist (nothing unused, nothing hidden).
    const union = scopePermissions([...API_SCOPES]);
    expect([...union].sort()).toEqual([...API_ALLOWED_PERMISSIONS].sort());
  });

  it("the whitelist is pinned: adding a permission to the API is a deliberate, reviewed change", () => {
    expect([...API_ALLOWED_PERMISSIONS].sort()).toEqual(
      [
        "account:read",
        "contact:manage",
        "contact:read",
        "customer_invoice:manage",
        "customer_invoice:read",
        "customer_payment:read",
        "financial_report:read",
        "journal:read",
        "supplier_bill:manage",
        "supplier_bill:read",
        "supplier_payment:read",
      ].sort(),
    );
  });

  it("every permission that posts, voids, approves, reverses, reopens or closes is forbidden for the API and absent from the whitelist", () => {
    const critical = PERMISSIONS.filter((p) => /:(post|void|approve|reverse|reopen|reopen_hard|override_soft|post_advisor_locked|close)$/.test(p));
    expect(critical.length).toBeGreaterThan(10);
    for (const p of critical) {
      expect(isForbiddenForApi(p), p).toBe(true);
      expect(API_ALLOWED_PERMISSIONS.has(p), p).toBe(false);
    }
    for (const p of HUMAN_ONLY_OR_CRITICAL) expect(API_ALLOWED_PERMISSIONS.has(p), p).toBe(false);
  });

  it("api_key:manage is held by OWNER and ADMINISTRATOR only", () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, "api_key:manage"), role).toBe(role === "OWNER" || role === "ADMINISTRATOR");
    }
  });

  it("effective permissions = scope permissions INTERSECT the creator's current role, for every role", () => {
    for (const role of ROLES) {
      const granted = effectivePermissions([...API_SCOPES], role);
      for (const p of granted) {
        expect(roleHasPermission(role, p), `${role} gives ${p}`).toBe(true);
        expect(API_ALLOWED_PERMISSIONS.has(p)).toBe(true);
      }
      // Anything the whitelist has that the role also has must be present: nothing is lost either.
      for (const p of API_ALLOWED_PERMISSIONS) expect(granted.has(p), `${role}/${p}`).toBe(roleHasPermission(role, p));
    }
  });

  it("a demoted creator shrinks the same scope list: ADMINISTRATOR -> ACCOUNTS_RECEIVABLE -> READ_ONLY -> EMPLOYEE", () => {
    const scopes = ["invoices:write", "bills:write", "contacts:write", "reports:read"];
    const as = (role: MembershipRole) => [...effectivePermissions(scopes, role)].sort();
    expect(as("ADMINISTRATOR")).toEqual(["contact:manage", "contact:read", "customer_invoice:manage", "customer_invoice:read", "financial_report:read", "journal:read", "supplier_bill:manage", "supplier_bill:read"]);
    expect(as("ACCOUNTS_RECEIVABLE")).toEqual(["contact:manage", "contact:read", "customer_invoice:manage", "customer_invoice:read", "journal:read"]);
    expect(as("READ_ONLY")).toEqual(["contact:read", "customer_invoice:read", "financial_report:read", "journal:read", "supplier_bill:read"]);
    expect(as("EMPLOYEE")).toEqual([]);
  });

  it("a stored scope that is not (or no longer) in the table grants nothing", () => {
    expect([...effectivePermissions(["admin:all", "journals:write", "period:close"], "OWNER")]).toEqual([]);
  });

  it("rejects unknown scopes and an empty list at creation; de-duplicates and orders the rest", () => {
    expect(() => normaliseScopes(["contacts:read", "root"])).toThrow(InvalidScopeError);
    expect(() => normaliseScopes([])).toThrow(InvalidScopeError);
    expect(() => normaliseScopes([42 as unknown as string])).toThrow(InvalidScopeError);
    expect(normaliseScopes(["reports:read", "contacts:read", "reports:read"])).toEqual(["contacts:read", "reports:read"]);
  });

  describe("an API actor is structurally refused every human-only action, whatever scopes it holds", () => {
    const apiOwner: Actor = {
      userId: "u",
      organizationId: "o",
      role: "OWNER",
      type: "API",
      grantedPermissions: effectivePermissions([...API_SCOPES], "OWNER"),
    };

    it("assertHumanWith (period close / reopen / sign-offs) refuses it even as an OWNER with the right role permission", () => {
      for (const p of ["period:close", "period:reopen", "close_checklist:manage"] as const) {
        expect(() => assertHumanWith(apiOwner, p), p).toThrow(PermissionDeniedError);
      }
      // ...and the same role as a HUMAN passes the role check, proving the refusal is the actor type.
      expect(() => assertHumanWith({ userId: "u", organizationId: "o", role: "OWNER" }, "period:close")).not.toThrow();
    });

    it("the lock-change and posting engines treat type API as non-human", () => {
      const change = evaluateLockChange({ from: "OPEN", to: "SOFT_LOCKED", role: "OWNER", actorType: "API", reason: "x".repeat(20) });
      expect(change.ok).toBe(false);
    });

    it("assertPermission only ever NARROWS: a permission outside grantedPermissions is refused even when the role has it", () => {
      for (const p of ["journal:post", "customer_invoice:post", "period:close", "membership:manage", "api_key:manage", "payrun:post"] as const) {
        expect(roleHasPermission("OWNER", p)).toBe(true);
        expect(() => assertPermission(apiOwner, p), p).toThrow(PermissionDeniedError);
      }
      expect(() => assertPermission(apiOwner, "customer_invoice:manage")).not.toThrow();
      // A granted permission the role lacks is still refused (intersection, never union).
      const bogus: Actor = { userId: "u", organizationId: "o", role: "READ_ONLY", type: "API", grantedPermissions: new Set<Permission>(["customer_invoice:manage"]) };
      expect(() => assertPermission(bogus, "customer_invoice:manage")).toThrow(PermissionDeniedError);
    });
  });
});
