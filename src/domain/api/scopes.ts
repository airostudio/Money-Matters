import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";

/**
 * API scopes (Phase 10 Slice 1, master spec s.54). A CLOSED, small set: the only way a key gets any power is by
 * listing scopes from this table at creation (an unknown scope is rejected, never stored). Each scope maps to
 * the EXISTING permissions the corresponding domain services already assert for a human - there is no parallel
 * permission system. `*:write` always means "create DRAFT documents / contacts" and never more: posting,
 * approving, voiding, paying and deleting have no scope at all.
 *
 * A key's effective permissions are NEVER stored: on every request they are computed as
 *   scope-mapped permissions  INTERSECT  the creator's CURRENT role permissions  INTERSECT  API_ALLOWED_PERMISSIONS
 * (`effectivePermissions` below), so demoting or removing the creator shrinks or kills every key they made on the
 * very next request.
 */
export const API_SCOPES = [
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
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ScopeInfo {
  scope: ApiScope;
  label: string;
  description: string;
  /** True when the scope lets the integration CREATE something (always a draft / a contact, never a posting). */
  write: boolean;
  permissions: readonly Permission[];
}

export const SCOPE_INFO: Record<ApiScope, ScopeInfo> = {
  "contacts:read": {
    scope: "contacts:read",
    label: "Read customers and suppliers",
    description: "List and fetch customers and suppliers (names, emails, tax numbers, addresses).",
    write: false,
    permissions: ["contact:read"],
  },
  "contacts:write": {
    scope: "contacts:write",
    label: "Create customers and suppliers",
    description: "Create new customers and suppliers. Cannot edit or deactivate existing ones.",
    write: true,
    permissions: ["contact:read", "contact:manage"],
  },
  "accounts:read": {
    scope: "accounts:read",
    label: "Read the chart of accounts",
    description: "List and fetch accounts. Read-only: the API cannot create or change accounts.",
    write: false,
    permissions: ["account:read"],
  },
  "invoices:read": {
    scope: "invoices:read",
    label: "Read sales invoices",
    description: "List and fetch customer invoices with their lines and amounts paid.",
    write: false,
    permissions: ["customer_invoice:read"],
  },
  "invoices:write": {
    scope: "invoices:write",
    label: "Create DRAFT sales invoices",
    description:
      "Create draft invoices. A person must review and post each draft in Money Matters; the API cannot post, approve, void, edit or delete an invoice.",
    write: true,
    permissions: ["customer_invoice:read", "customer_invoice:manage"],
  },
  "bills:read": {
    scope: "bills:read",
    label: "Read supplier bills",
    description: "List and fetch supplier bills with their lines and amounts paid.",
    write: false,
    permissions: ["supplier_bill:read"],
  },
  "bills:write": {
    scope: "bills:write",
    label: "Create DRAFT supplier bills",
    description:
      "Create draft bills. A person must review and post each draft in Money Matters; the API cannot post, approve, void, pay, edit or delete a bill.",
    write: true,
    permissions: ["supplier_bill:read", "supplier_bill:manage"],
  },
  "payments:read": {
    scope: "payments:read",
    label: "Read customer receipts and supplier payments",
    description: "List and fetch payments received and payments made. Read-only: the API can never record or move money.",
    write: false,
    permissions: ["customer_payment:read", "supplier_payment:read"],
  },
  "journals:read": {
    scope: "journals:read",
    label: "Read journal entries",
    description: "List and fetch journal entries with their lines. Read-only.",
    write: false,
    permissions: ["journal:read"],
  },
  "reports:read": {
    scope: "reports:read",
    label: "Read financial reports",
    description:
      "Profit and loss, balance sheet and trial balance. (The trial balance is gated on journal:read in the ledger, so this scope also carries it.)",
    write: false,
    permissions: ["financial_report:read", "journal:read"],
  },
};

/**
 * The only permissions an API key can EVER hold. `effectivePermissions` intersects with this set as defence in
 * depth, and a test asserts both that every scope maps inside it and that nothing human-only or critical is in
 * it. Reading it is the quickest way to see what the API can reach: contacts, accounts, invoices and bills
 * (read + draft create), payments (read), journals and reports (read).
 */
export const API_ALLOWED_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "contact:read",
  "contact:manage",
  "account:read",
  "customer_invoice:read",
  "customer_invoice:manage",
  "supplier_bill:read",
  "supplier_bill:manage",
  "customer_payment:read",
  "supplier_payment:read",
  "journal:read",
  "financial_report:read",
]);

/**
 * Permissions that are human-only, critical, or administrative and so must be UNREACHABLE through any scope:
 * posting / approving / voiding / reversing, period close and locks, membership and role management, the AI
 * autonomy settings (`organization:manage`), payment-run approval, payroll, practice / consolidation, and API-key
 * management itself. Used by tests (and `assertScopeTableSafe`) to prove the scope table cannot reach them. The
 * enforcement is structural, not this list: the scope table is closed, `API_ALLOWED_PERMISSIONS` is a
 * whitelist, and an `API` actor fails every `type === "HUMAN"` check.
 */
export function isForbiddenForApi(permission: Permission): boolean {
  const [resource, action] = permission.split(":") as [string, string];
  if (["post", "void", "approve", "reverse", "reopen", "reopen_hard", "override_soft", "post_advisor_locked", "close", "respond", "ai_suggest", "import", "reconcile"].includes(action)) {
    return true;
  }
  return [
    "organization",
    "membership",
    "period",
    "fiscal_period",
    "close_checklist",
    "payment_run",
    "payrun",
    "employee",
    "consolidation",
    "client_request",
    "api_key",
    "oauth_app",
    "automation",
    "integration",
    "webhook",
    "tax_code",
    "audit",
    "bank_account",
    "bank_rule",
    "onboarding",
  ].includes(resource);
}

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && (API_SCOPES as readonly string[]).includes(value);
}

export class InvalidScopeError extends Error {
  constructor(readonly invalid: string[]) {
    super(`Unknown or unsupported API scope: ${invalid.join(", ")}.`);
    this.name = "InvalidScopeError";
  }
}

/** Validates a requested scope list: non-empty, every entry a known scope, de-duplicated and in canonical order. */
export function normaliseScopes(requested: readonly unknown[]): ApiScope[] {
  const invalid = requested.filter((s) => !isApiScope(s)).map(String);
  if (invalid.length > 0) throw new InvalidScopeError(invalid);
  const set = new Set(requested as ApiScope[]);
  if (set.size === 0) throw new InvalidScopeError(["(none selected)"]);
  return API_SCOPES.filter((s) => set.has(s));
}

/** The permissions the SCOPES alone grant (before intersecting with anyone's role). */
export function scopePermissions(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    if (!isApiScope(scope)) continue; // a stored unknown scope (e.g. one retired later) grants nothing
    for (const permission of SCOPE_INFO[scope].permissions) out.add(permission);
  }
  return out;
}

/**
 * THE rule: scope-mapped permissions, intersected with the creator's CURRENT role's permissions, intersected with
 * the API whitelist. Pure and re-evaluated on every request; nothing here is cached or stored.
 */
export function effectivePermissions(scopes: readonly string[], creatorRole: MembershipRole): Set<Permission> {
  const out = new Set<Permission>();
  for (const permission of scopePermissions(scopes)) {
    if (API_ALLOWED_PERMISSIONS.has(permission) && roleHasPermission(creatorRole, permission)) out.add(permission);
  }
  return out;
}
