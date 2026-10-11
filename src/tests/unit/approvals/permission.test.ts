import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/domain/permissions/roles";
import { API_ALLOWED_PERMISSIONS, isForbiddenForApi } from "@/domain/api/scopes";
import { AUTOMATION_ALLOWED_PERMISSIONS, isForbiddenForAutomation } from "@/domain/automation/vocabulary";

describe("approval:manage permission", () => {
  it("is held only by OWNER and ADMINISTRATOR, and unreachable by API scopes and automations", () => {
    expect(PERMISSIONS as readonly string[]).toContain("approval:manage");
    for (const [role, set] of Object.entries(ROLE_PERMISSIONS)) {
      expect(set.has("approval:manage"), role).toBe(role === "OWNER" || role === "ADMINISTRATOR");
    }
    expect(isForbiddenForApi("approval:manage")).toBe(true);
    expect(API_ALLOWED_PERMISSIONS.has("approval:manage")).toBe(false);
    expect(isForbiddenForAutomation("approval:manage")).toBe(true);
    expect(AUTOMATION_ALLOWED_PERMISSIONS.has("approval:manage")).toBe(false);
  });

  it("the existing role permissions of the AP / AR / payroll roles are untouched by the approval engine", () => {
    for (const role of ["ACCOUNTS_PAYABLE", "ACCOUNTS_RECEIVABLE", "PAYROLL_MANAGER"] as const) {
      expect(ROLE_PERMISSIONS[role].has("approval:manage"), role).toBe(false);
    }
  });
});
