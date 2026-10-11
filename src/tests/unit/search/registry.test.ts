import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { membershipRoleEnum } from "@/db/schema";
import { PERMISSIONS, roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import { SEARCH_KINDS, SEARCH_KIND_SPECS, searchableKindsFor } from "@/domain/search/entities";
import { PAGE_PERMISSION_OVERRIDES, STATIC_COMMANDS } from "@/domain/search/commands";
import { CREATE_ACTIONS, createActionsFor, createGroupsFor } from "@/components/shell/nav-config";
import { buildPaletteItems } from "@/components/shell/palette-model";
import { pageFileFor, pageRequirements } from "../../helpers/page-guards";

const ROLES = membershipRoleEnum.enumValues as readonly MembershipRole[];
const SRC = path.resolve(__dirname, "../../..");

describe("search entity registry: permission -> entity", () => {
  it("every kind has a spec whose permissions are real, and links to a page that exists", () => {
    expect(Object.keys(SEARCH_KIND_SPECS).sort()).toEqual([...SEARCH_KINDS].sort());
    for (const kind of SEARCH_KINDS) {
      const spec = SEARCH_KIND_SPECS[kind];
      expect(spec.permissions.length, kind).toBeGreaterThan(0);
      for (const p of spec.permissions) expect(PERMISSIONS as readonly string[], `${kind}: ${p}`).toContain(p);
      const href = spec.href({ id: "00000000-0000-0000-0000-000000000000", ref: "00000000-0000-0000-0000-000000000001" });
      // Walk the route folders; an id segment must land on the single dynamic `[param]` folder at that level.
      let cur = path.join(SRC, "app/[orgSlug]");
      for (const segment of href.split("/").filter(Boolean)) {
        if (/^0{8}-/.test(segment)) {
          const dynamic = readdirSync(cur).find((n) => /^\[[A-Za-z]+\]$/.test(n));
          expect(dynamic, `${kind}: no dynamic folder under ${cur}`).toBeTruthy();
          cur = path.join(cur, dynamic!);
        } else {
          cur = path.join(cur, segment);
        }
      }
      expect(existsSync(path.join(cur, "page.tsx")), `${kind} -> ${href}`).toBe(true);
    }
  });

  it("the detail page behind each kind needs nothing the kind's permissions do not already require", () => {
    const detailPage: Record<string, string> = {
      customer: "sales/customers/[contactId]",
      supplier: "purchases/suppliers/[contactId]",
      invoice: "sales/invoices/[invoiceId]",
      quote: "sales/quotes/[quoteId]",
      bill: "purchases/bills/[billId]",
      purchase_order: "purchases/purchase-orders/[poId]",
      employee: "payroll/employees/[employeeId]",
      bank_transaction: "money/[bankAccountId]",
      project: "projects/[projectId]",
      product: "inventory/[productId]",
    };
    // Calls on these pages that are made only for a role that holds a further permission (the page checks first).
    const conditional: Record<string, string[]> = {
      purchase_order: ["AccountService.list"],
      bank_transaction: ["FuzzyReconciliationService.suggestMatches", "ReconciliationService.findCandidateMatches"],
      project: ["TimesheetService.getRunningTimer", "ProjectTimeBillingService.previewUnbilled"],
      product: ["InventoryService.listMovements", "AccountService.list"],
    };
    for (const [kind, rel] of Object.entries(detailPage)) {
      const file = path.join(SRC, "app/[orgSlug]", rel, "page.tsx");
      expect(existsSync(file), rel).toBe(true);
      const req = pageRequirements(file);
      const spec = SEARCH_KIND_SPECS[kind as keyof typeof SEARCH_KIND_SPECS];
      const needed = req.serviceCalls
        .filter((c) => c.permission && !(conditional[kind] ?? []).includes(c.call))
        .map((c) => c.permission as Permission);
      for (const p of needed) expect(spec.permissions, `${kind} detail page calls need ${p}`).toContain(p);
    }
  });

  // Hand-written from the role matrix in roles.ts (NOT computed by the code under test).
  const ALL = [...SEARCH_KINDS];
  const EXPECTED: Record<MembershipRole, string[]> = {
    OWNER: ALL,
    ADMINISTRATOR: ALL,
    ACCOUNTANT: ALL,
    BOOKKEEPER: ALL,
    MANAGER: ALL.filter((k) => k !== "employee" && k !== "bank_transaction"),
    READ_ONLY: ALL.filter((k) => k !== "employee" && k !== "bank_transaction"),
    ACCOUNTS_RECEIVABLE: ["customer", "invoice", "quote", "account", "payment", "project", "product"],
    // AP and EMPLOYEE can list projects but not open one (the project page needs timesheet:read and account:read too).
    ACCOUNTS_PAYABLE: ["supplier", "bill", "purchase_order", "account", "supplier_payment", "product"],
    PAYROLL_MANAGER: ["account", "employee", "project"],
    EMPLOYEE: [],
  };
  for (const role of ROLES) {
    it(`searchableKindsFor(${role}) is exactly what the role may read`, () => {
      expect([...searchableKindsFor(role)].sort()).toEqual([...EXPECTED[role]].sort());
    });
  }

  it("a narrower grant (API-style) can only remove kinds, never add", () => {
    expect(searchableKindsFor("OWNER", new Set<Permission>(["employee:read"]))).toEqual(["employee"]);
    expect(searchableKindsFor("EMPLOYEE", new Set<Permission>(["employee:read", "project:read"]))).toEqual([]);
    expect(searchableKindsFor("READ_ONLY", new Set<Permission>())).toEqual([]);
  });

  it("employees are searchable only with employee:read, and payroll-only secrets never are", () => {
    for (const role of ROLES) {
      expect(searchableKindsFor(role).includes("employee"), role).toBe(roleHasPermission(role, "employee:read"));
    }
  });
});

describe("palette commands: every command's permissions match its destination page's own guard", () => {
  // Calls made only when the page has already checked a further permission (conditional), so they are not requirements.
  const CONDITIONAL: Record<string, string[]> = {
    "/expenses/new": ["OrganizationService.listMembers", "ReceiptService.get"],
    "/settings": ["OrganizationService.listMembers", "InviteService.list"],
    "/payroll/my": ["LeaveService.list"],
  };
  const needsOf = (hrefNoSlug: string): Permission[] => {
    const file = pageFileFor(hrefNoSlug);
    if (!file) return [];
    const req = pageRequirements(file);
    const skip = CONDITIONAL[hrefNoSlug.split("?")[0]!] ?? [];
    return [
      ...req.gates,
      ...req.serviceCalls.filter((c) => c.permission && !skip.includes(c.call)).map((c) => c.permission as Permission),
    ];
  };

  it("each Create action lists exactly the permissions its /new page checks and loads (no more, no less)", () => {
    expect(CREATE_ACTIONS).toHaveLength(9);
    for (const a of CREATE_ACTIONS) {
      expect(pageFileFor(a.href), a.href).not.toBeNull();
      expect([...new Set(a.permissions)].sort(), a.href).toEqual([...new Set(needsOf(a.href))].sort());
    }
  });

  it("each static command lists every permission its destination page needs", () => {
    for (const c of STATIC_COMMANDS) {
      expect(pageFileFor(c.href), c.href).not.toBeNull();
      for (const p of needsOf(c.href)) expect(c.permissions, `${c.id} -> ${c.href} needs ${p}`).toContain(p);
    }
  });

  it("no role is offered a 'Go to' / command / Create entry whose page would refuse it", () => {
    let checked = 0;
    for (const role of ROLES) {
      for (const item of buildPaletteItems("acme", role, "ACCOUNTANT")) {
        const href = item.href.replace(/^\/acme/, "");
        if (href === "" || href === "/") continue; // Home renders for everyone and checks per widget
        if (!pageFileFor(href)) continue; // e.g. /practice lives outside [orgSlug]
        checked += 1;
        for (const p of needsOf(href)) {
          expect(roleHasPermission(role, p), `${role} is offered "${item.label}" (${href}) but the page needs ${p}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(150);
  });

  it("every override is for a real nav destination and only ever adds requirements", () => {
    for (const [href, perms] of Object.entries(PAGE_PERMISSION_OVERRIDES)) {
      expect(pageFileFor(href), href).not.toBeNull();
      for (const p of perms) expect(PERMISSIONS as readonly string[]).toContain(p);
    }
  });
});

describe("Create menu per role", () => {
  const labels = (role: MembershipRole) => createActionsFor(role).map((a) => a.label);
  const FULL = ["Invoice", "Quote", "Customer", "Bill", "Expense claim", "Purchase order", "Supplier", "Project", "Journal entry"];

  it("owner, administrator, accountant and bookkeeper get everything, grouped Sales / Purchases / Other", () => {
    for (const role of ["OWNER", "ADMINISTRATOR", "ACCOUNTANT", "BOOKKEEPER"] as const) {
      expect(labels(role).sort(), role).toEqual([...FULL].sort());
      const groups = createGroupsFor(role);
      expect(groups.map((g) => g.group)).toEqual(["Sales", "Purchases", "Other"]);
      expect(groups[0]!.actions.map((a) => a.label)).toEqual(["Invoice", "Quote", "Customer"]);
      expect(groups[1]!.actions.map((a) => a.label)).toEqual(["Bill", "Expense claim", "Purchase order", "Supplier"]);
      expect(groups[2]!.actions.map((a) => a.label)).toEqual(["Project", "Journal entry"]);
    }
  });

  it("restricted roles see only what they can complete (hand-checked against roles.ts)", () => {
    expect(labels("ACCOUNTS_RECEIVABLE").sort()).toEqual(["Customer", "Expense claim", "Invoice", "Project", "Quote", "Supplier"].sort());
    expect(labels("ACCOUNTS_PAYABLE").sort()).toEqual(["Bill", "Customer", "Expense claim", "Purchase order", "Supplier"].sort());
    expect(labels("MANAGER").sort()).toEqual(["Expense claim", "Project"].sort());
    expect(labels("PAYROLL_MANAGER")).toEqual(["Expense claim"]);
  });

  it("is hidden entirely (no groups) for roles with no create permission", () => {
    // EMPLOYEE holds expense_claim:manage but not account:read, which the new-claim page loads: that page would refuse them.
    for (const role of ["READ_ONLY", "EMPLOYEE"] as const) {
      expect(createGroupsFor(role), role).toEqual([]);
    }
  });
});
