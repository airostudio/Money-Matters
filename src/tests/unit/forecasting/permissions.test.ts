import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";

/**
 * `CashForecastService` gates on `forecast:read` and reads receivables,
 * payables, recurring templates, payment runs and the ledger on that single
 * check (each reused service re-asserts its own permission as well). That is
 * only a non-widening of access if every role holding `forecast:read` also
 * already holds each underlying read permission — this test pins the
 * invariant so a future role-matrix edit can't silently break it.
 */
const UNDERLYING: Permission[] = [
  "journal:read",
  "financial_report:read",
  "bank_account:read",
  "customer_invoice:read",
  "supplier_bill:read",
  "recurring_invoice:read",
  "recurring_bill:read",
  "payment_run:read",
];

describe("forecast / scenario permission matrix", () => {
  const roles = Object.keys(ROLE_PERMISSIONS) as MembershipRole[];

  it("every role with forecast:read already holds every underlying read permission the forecast uses", () => {
    for (const role of roles.filter((r) => roleHasPermission(r, "forecast:read"))) {
      for (const p of UNDERLYING) {
        expect(roleHasPermission(role, p), `${role} has forecast:read but lacks ${p}`).toBe(true);
      }
    }
  });

  it("every role with scenario:read also holds forecast:read (the scenario view includes the forecast context)", () => {
    for (const role of roles.filter((r) => roleHasPermission(r, "scenario:read"))) {
      expect(roleHasPermission(role, "forecast:read"), role).toBe(true);
    }
  });

  it("manage permissions imply the read permission", () => {
    for (const role of roles) {
      if (roleHasPermission(role, "forecast:manage")) expect(roleHasPermission(role, "forecast:read")).toBe(true);
      if (roleHasPermission(role, "scenario:manage")) expect(roleHasPermission(role, "scenario:read")).toBe(true);
    }
  });

  it("roles without finance visibility get neither", () => {
    for (const role of ["EMPLOYEE", "PAYROLL_MANAGER", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE"] as MembershipRole[]) {
      expect(roleHasPermission(role, "forecast:read"), role).toBe(false);
      expect(roleHasPermission(role, "scenario:read"), role).toBe(false);
    }
  });

  it("MANAGER and READ_ONLY can read forecasts but cannot read pay runs — the payroll-omission case", () => {
    for (const role of ["MANAGER", "READ_ONLY"] as MembershipRole[]) {
      expect(roleHasPermission(role, "forecast:read")).toBe(true);
      expect(roleHasPermission(role, "payrun:read")).toBe(false);
      expect(roleHasPermission(role, "forecast:manage")).toBe(false);
      expect(roleHasPermission(role, "scenario:manage")).toBe(false);
    }
  });
});
