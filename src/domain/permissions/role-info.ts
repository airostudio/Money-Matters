import { PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission, type MembershipRole, type Permission } from "./roles";

/**
 * Everything the "share this company file" UI needs to know about a role,
 * derived from the REAL permission matrix in roles.ts wherever possible so the
 * text a person reads when granting access cannot drift from what the role can
 * actually do. Presentation only: nothing here grants or refuses anything — the
 * services' `assertPermission` calls remain the enforcement.
 */

/**
 * A "write" permission is anything that is not a plain `*:read`: `:manage`,
 * `:post`, `:approve`, `:void`, `:reverse`, `:import`, `:reconcile`, `:close`,
 * `:reopen…`, `:respond`, `:ai_suggest`, … Defined by exclusion on purpose, so
 * a newly added kind of write permission is treated as a write (the safe
 * direction) without anyone remembering to list it.
 */
export function isWritePermission(permission: Permission): boolean {
  return !permission.endsWith(":read");
}

/** True when the role holds no write permission at all — it can look, never change. */
export function isReadOnlyRole(role: MembershipRole): boolean {
  for (const permission of ROLE_PERMISSIONS[role]) {
    if (isWritePermission(permission)) return false;
  }
  return true;
}

/**
 * Granting this role lets the person change financial data (any write
 * permission, which includes OWNER and ADMINISTRATOR), so the person granting
 * it must confirm explicitly. Server-enforced in OrganizationService.
 */
export function roleNeedsWriteConfirmation(role: MembershipRole): boolean {
  return !isReadOnlyRole(role);
}

/** The role every "add a person" control preselects — the safest one. */
export const DEFAULT_INVITE_ROLE: MembershipRole = "READ_ONLY";

/**
 * Least to most privileged. Explicit (not derived from permission counts,
 * which do not order the specialist roles meaningfully); a test checks every
 * role in the enum appears exactly once, so adding a role forces a decision
 * about where it sits.
 */
export const ROLES_BY_PRIVILEGE: readonly MembershipRole[] = [
  "READ_ONLY",
  "EMPLOYEE",
  "MANAGER",
  "ACCOUNTS_RECEIVABLE",
  "ACCOUNTS_PAYABLE",
  "PAYROLL_MANAGER",
  "BOOKKEEPER",
  "ACCOUNTANT",
  "ADMINISTRATOR",
  "OWNER",
];

export const ROLE_LABELS: Record<MembershipRole, string> = {
  READ_ONLY: "Read only",
  EMPLOYEE: "Employee",
  MANAGER: "Manager",
  ACCOUNTS_RECEIVABLE: "Accounts receivable",
  ACCOUNTS_PAYABLE: "Accounts payable",
  PAYROLL_MANAGER: "Payroll manager",
  BOOKKEEPER: "Bookkeeper",
  ACCOUNTANT: "Accountant",
  ADMINISTRATOR: "Administrator",
  OWNER: "Owner",
};

/**
 * Hand-written one-line description per role. Typed as a full Record, so
 * adding a role to the enum is a compile error here until it is described
 * (and a unit test fails if one is blank).
 */
export const ROLE_DESCRIPTIONS: Record<MembershipRole, string> = {
  READ_ONLY:
    "Can look at everything the books show - invoices, bills, reports, accounts - but cannot change anything. Safe to give to someone who only needs to see.",
  EMPLOYEE: "Can submit their own expense claims and timesheets, and see projects. Cannot see the company's books.",
  MANAGER: "Can see reports and most records, and approve expenses and timesheets and manage projects. Cannot create or post invoices, bills or journals.",
  ACCOUNTS_RECEIVABLE: "Works on sales: creates, posts and voids invoices, quotes and customer payments. Cannot touch purchases, payroll or settings.",
  ACCOUNTS_PAYABLE: "Works on purchases: creates, posts and voids bills, credits and payments, and runs payment runs. Cannot touch sales, payroll or settings.",
  PAYROLL_MANAGER: "Manages employees and pay runs, including sensitive pay details. Cannot touch sales, purchases or settings.",
  BOOKKEEPER: "Day-to-day bookkeeping: invoices, bills, payments, bank reconciliation and journals. Cannot close periods, void invoices or bills, or manage payroll.",
  ACCOUNTANT: "Full accounting access including closing periods and voiding posted documents. Cannot manage people, payroll pay details or organization settings.",
  ADMINISTRATOR: "Everything an Owner can do, including adding and removing people and changing settings.",
  OWNER: "Full control, including adding and removing people and changing settings. There must always be at least one Owner.",
};

/**
 * Permission domain (the part before ":") -> the plain-language area of the
 * product it belongs to. Every domain in PERMISSIONS must appear here (a test
 * enforces it), so a new domain cannot silently go missing from the summary.
 */
export const PERMISSION_AREAS: Record<string, string> = {
  organization: "Organization settings",
  membership: "People and access",
  account: "Chart of accounts",
  fiscal_period: "Accounting periods",
  journal: "Journals",
  contact: "Customers and suppliers",
  tax_code: "Tax codes",
  dimension: "Tracking categories",
  audit: "Audit trail",
  bank_account: "Bank accounts",
  bank_transaction: "Bank transactions",
  bank_rule: "Bank rules",
  customer_invoice: "Sales invoices",
  customer_payment: "Customer payments",
  customer_quote: "Quotes",
  recurring_invoice: "Recurring invoices",
  supplier_bill: "Bills",
  supplier_payment: "Supplier payments",
  onboarding: "Set-up",
  expense_claim: "Expense claims",
  expense_receipt: "Expense receipts",
  purchase_order: "Purchase orders",
  recurring_bill: "Recurring bills",
  supplier_credit: "Supplier credits",
  payment_run: "Payment runs",
  financial_report: "Reports",
  saved_report: "Saved reports",
  project: "Projects",
  timesheet: "Timesheets",
  product: "Products",
  inventory: "Inventory",
  fixed_asset: "Fixed assets",
  employee: "Employees",
  payrun: "Pay runs",
  budget: "Budgets",
  forecast: "Forecasts",
  scenario: "Scenarios",
  period: "Period close and locking",
  close_checklist: "Month-end checklist",
  consolidation: "Consolidation",
  client_request: "Accountant requests",
  api_key: "API access",
  webhook: "Webhooks",
};

function areaOf(permission: Permission): string {
  const domain = permission.split(":")[0]!;
  return PERMISSION_AREAS[domain] ?? domain;
}

/** The areas of the product in which `role` can change data (any write permission), in matrix order. */
export function writableAreas(role: MembershipRole): string[] {
  const areas = new Set<string>();
  for (const permission of PERMISSIONS) {
    if (isWritePermission(permission) && roleHasPermission(role, permission)) areas.add(areaOf(permission));
  }
  return [...areas];
}

/** The areas in which `role` can only look (holds a read permission but no write permission there). */
export function readOnlyAreas(role: MembershipRole): string[] {
  const writable = new Set(writableAreas(role));
  const areas = new Set<string>();
  for (const permission of PERMISSIONS) {
    if (!isWritePermission(permission) && roleHasPermission(role, permission)) {
      const area = areaOf(permission);
      if (!writable.has(area)) areas.add(area);
    }
  }
  return [...areas];
}

export interface RoleOption {
  role: MembershipRole;
  label: string;
  description: string;
  /** Derived from the permission matrix. */
  canChange: string[];
  canOnlyView: string[];
  needsWriteConfirmation: boolean;
}

/** Everything the role picker renders, least privileged first. Plain data, safe to pass to a client component. */
export function roleOptions(): RoleOption[] {
  return ROLES_BY_PRIVILEGE.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
    canChange: role === "OWNER" || role === "ADMINISTRATOR" ? ["Everything"] : writableAreas(role),
    canOnlyView: role === "OWNER" || role === "ADMINISTRATOR" ? [] : readOnlyAreas(role),
    needsWriteConfirmation: roleNeedsWriteConfirmation(role),
  }));
}

export interface DenialDescription {
  /** Plain-language area, e.g. "Sales invoices". */
  area: string;
  /** What was being attempted: looking at it, or changing it. */
  action: "view" | "change";
  roleLabel: string;
}

/**
 * Turns a refused permission (e.g. "customer_invoice:manage") into words a
 * non-accountant can read. Tolerates unknown strings (it is fed from an error
 * digest on the client) by falling back to the raw text.
 */
export function describeDenial(permission: string, role: string): DenialDescription {
  const domain = permission.split(":")[0] ?? permission;
  const area = PERMISSION_AREAS[domain] ?? domain.replace(/_/g, " ");
  const action = permission.endsWith(":read") ? "view" : "change";
  const roleLabel = (ROLE_LABELS as Record<string, string>)[role] ?? role;
  return { area, action, roleLabel };
}
