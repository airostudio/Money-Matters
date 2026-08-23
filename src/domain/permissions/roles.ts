import type { membershipRoleEnum } from "@/db/schema";

/** Mirrors the `membership_role` Postgres enum in src/db/schema.ts. */
export type MembershipRole = (typeof membershipRoleEnum.enumValues)[number];

export const PERMISSIONS = [
  "organization:manage",
  "membership:manage",
  "account:read",
  "account:manage",
  "fiscal_period:manage",
  "journal:read",
  "journal:post",
  "journal:reverse",
  "contact:read",
  "contact:manage",
  "tax_code:manage",
  "dimension:manage",
  "audit:read",
  "bank_account:read",
  "bank_account:manage",
  "bank_transaction:import",
  "bank_transaction:reconcile",
  "bank_rule:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL_PERMISSIONS = new Set<Permission>(PERMISSIONS);

/**
 * Static role → permission matrix for Phase 1. Later phases may extend this
 * with per-organization overrides (master spec §46's "attribute-level
 * policy enforcement"); a static matrix is the right amount of complexity
 * while the only permission-checked resources are the ledger, contacts, and
 * membership management.
 */
export const ROLE_PERMISSIONS: Record<MembershipRole, ReadonlySet<Permission>> = {
  OWNER: ALL_PERMISSIONS,
  ADMINISTRATOR: ALL_PERMISSIONS,
  ACCOUNTANT: new Set<Permission>([
    "account:read",
    "account:manage",
    "fiscal_period:manage",
    "journal:read",
    "journal:post",
    "journal:reverse",
    "contact:read",
    "contact:manage",
    "tax_code:manage",
    "dimension:manage",
    "audit:read",
    "bank_account:read",
    "bank_account:manage",
    "bank_transaction:import",
    "bank_transaction:reconcile",
    "bank_rule:manage",
  ]),
  BOOKKEEPER: new Set<Permission>([
    "account:read",
    "journal:read",
    "journal:post",
    "contact:read",
    "contact:manage",
    "dimension:manage",
    "bank_account:read",
    "bank_transaction:import",
    "bank_transaction:reconcile",
    "bank_rule:manage",
  ]),
  ACCOUNTS_RECEIVABLE: new Set<Permission>([
    "account:read",
    "journal:read",
    "contact:read",
    "contact:manage",
    "bank_account:read",
  ]),
  ACCOUNTS_PAYABLE: new Set<Permission>([
    "account:read",
    "journal:read",
    "contact:read",
    "contact:manage",
    "bank_account:read",
  ]),
  PAYROLL_MANAGER: new Set<Permission>(["account:read", "journal:read", "contact:read"]),
  MANAGER: new Set<Permission>([
    "account:read",
    "journal:read",
    "contact:read",
    "audit:read",
    "bank_account:read",
  ]),
  EMPLOYEE: new Set<Permission>([]),
  READ_ONLY: new Set<Permission>([
    "account:read",
    "journal:read",
    "contact:read",
    "audit:read",
    "bank_account:read",
  ]),
};

export function roleHasPermission(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
