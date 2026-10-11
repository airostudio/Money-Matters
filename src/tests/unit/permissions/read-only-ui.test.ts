import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadOnlyBanner } from "@/components/shell/read-only-banner";
import { Can } from "@/components/shell/can";
import { PermissionDeniedView } from "@/components/shell/permission-denied";
import { InviteMemberForm } from "@/components/shell/invite-member-form";
import { MemberRoleSelect } from "@/components/shell/member-role-select";
import { Topbar } from "@/components/shell/topbar";
import { createActionsFor } from "@/components/shell/nav-config";
import { deniedViewUnless } from "@/lib/permission-gate";
import { DEFAULT_INVITE_ROLE, roleOptions } from "@/domain/permissions/role-info";
import { membershipRoleEnum } from "@/db/schema";
import type { MembershipRole } from "@/domain/permissions/roles";

// The top bar now contains the command palette, which reads the app router; there is none in a static render.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => "/acme" }));

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noopAction = async () => {};

describe("read-only banner", () => {
  it("appears for a read-only role, says who to ask and that nothing can change", () => {
    const out = html(createElement(ReadOnlyBanner, { role: "READ_ONLY", orgName: "Acme Pty Ltd" }));
    expect(out).toContain('data-testid="read-only-banner"');
    expect(out).toContain("Read-only access");
    expect(out).toContain("Acme Pty Ltd");
    expect(out).toContain("ask the company owner");
    expect(out).toContain("nothing you do here can change the books");
  });

  it("does not appear for any role that can change something", () => {
    for (const role of membershipRoleEnum.enumValues.filter((r) => r !== "READ_ONLY")) {
      expect(html(createElement(ReadOnlyBanner, { role, orgName: "Acme" })), role).toBe("");
    }
  });
});

describe("create actions in the shell", () => {
  it("omit write items for a read-only role and keep them for a poster", () => {
    expect(createActionsFor("READ_ONLY")).toEqual([]);
    expect(createActionsFor("MANAGER").map((a) => a.label)).not.toContain("Journal entry"); // cannot post journals
    for (const role of ["OWNER", "ADMINISTRATOR", "ACCOUNTANT", "BOOKKEEPER"] as MembershipRole[]) {
      expect(createActionsFor(role).map((a) => a.label)).toContain("Journal entry");
    }
  });

  it("the top bar renders no Create menu for READ_ONLY, and does for BOOKKEEPER; both get Search", () => {
    const props = { orgSlug: "acme", orgName: "Acme", userName: "Sam", userEmail: "sam@example.test" };
    const readOnly = html(createElement(Topbar, { ...props, role: "READ_ONLY" }));
    const bookkeeper = html(createElement(Topbar, { ...props, role: "BOOKKEEPER" }));
    expect(readOnly).not.toContain("create-menu-trigger");
    expect(bookkeeper).toContain("create-menu-trigger");
    expect(readOnly).toContain('data-testid="palette-trigger"');
    expect(bookkeeper).toContain('aria-label="Search"');
    expect(bookkeeper).toContain('aria-keyshortcuts="C"');
  });
});

describe("Can / deniedViewUnless (presentation only)", () => {
  it("hides children from a role without the permission", () => {
    const child = createElement("button", null, "New invoice");
    expect(html(createElement(Can, { role: "READ_ONLY", permission: "customer_invoice:manage" }, child))).toBe("");
    expect(html(createElement(Can, { role: "ACCOUNTS_RECEIVABLE", permission: "customer_invoice:manage" }, child))).toContain("New invoice");
  });

  it("returns a friendly view, not an exception, for a write page opened by a read-only role", () => {
    const actor = { userId: "u", organizationId: "o", role: "READ_ONLY" as const };
    const view = deniedViewUnless(actor, "customer_invoice:manage", "acme");
    expect(view).not.toBeNull();
    const out = html(view!);
    expect(out).toContain("can&#x27;t make changes here");
    expect(out).toContain("sales invoices");
    expect(out).toContain("Read only");
    expect(out).toContain("ask an owner or");
    expect(deniedViewUnless({ ...actor, role: "OWNER" }, "customer_invoice:manage", "acme")).toBeNull();
  });

  it("explains a refused read as a view problem", () => {
    const out = html(createElement(PermissionDeniedView, { permission: "payrun:read", role: "READ_ONLY" }));
    expect(out).toContain("have access to this page");
    expect(out).toContain("pay runs");
  });
});

describe("add-member and change-role controls", () => {
  it("preselect READ_ONLY, list roles least to most privileged, and need no confirmation for it", () => {
    const out = html(createElement(InviteMemberForm, { action: noopAction, options: roleOptions(), defaultRole: DEFAULT_INVITE_ROLE }));
    expect(out).toMatch(/<option value="READ_ONLY" selected/);
    const order = [...out.matchAll(/<option value="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("READ_ONLY");
    expect(order[order.length - 1]).toBe("OWNER");
    expect(order).toHaveLength(membershipRoleEnum.enumValues.length);
    expect(out).toContain('data-testid="role-description"');
    expect(out).toContain("Cannot change anything in the books");
    expect(out).not.toContain("confirmWriteAccess");
  });

  it("requires the explicit confirmation as soon as a writer role is the chosen one", () => {
    const out = html(createElement(InviteMemberForm, { action: noopAction, options: roleOptions(), defaultRole: "ADMINISTRATOR" }));
    expect(out).toContain('name="confirmWriteAccess"');
    expect(out).toContain("I understand this person will be able to edit financial data.");
    expect(out).toMatch(/name="confirmWriteAccess"[^>]*required/);
  });

  it("the change-role control lists the same ordered options with descriptions", () => {
    const out = html(
      createElement(MemberRoleSelect, { membershipId: "m1", currentRole: "READ_ONLY", action: noopAction, options: roleOptions() }),
    );
    const order = [...out.matchAll(/<option value="([A-Z_]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("READ_ONLY");
    expect(order[order.length - 1]).toBe("OWNER");
    expect(out).toContain("cannot change anything");
  });
});
