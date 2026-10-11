import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";

/**
 * The record types the global search can return (master spec s.56) and, for each, the permissions a role needs for
 * the search to look at it AT ALL. Pure data (no database): it is what decides which branches of the one search
 * statement exist, so a type the role cannot read is never queried, not queried-then-filtered.
 *
 * Each list is the LIST service's own read permission PLUS whatever the page a result links to needs to render
 * (checked against the pages' own services: e.g. an invoice page also loads contacts, accounts and tax codes), so a
 * result a person can see is a result they can open without a refusal. All permissions listed must be held.
 */
export const SEARCH_KINDS = [
  "customer",
  "supplier",
  "invoice",
  "quote",
  "bill",
  "purchase_order",
  "account",
  "payment",
  "supplier_payment",
  "employee",
  "bank_transaction",
  "project",
  "product",
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export interface SearchKindSpec {
  kind: SearchKind;
  /** The group heading in the palette. */
  label: string;
  /** Every one of these must be held. */
  permissions: Permission[];
  /** The page a result opens, relative to the organization (`/${orgSlug}` is prefixed by the caller). */
  href: (row: { id: string; ref: string | null }) => string;
}

export const SEARCH_KIND_SPECS: Record<SearchKind, SearchKindSpec> = {
  customer: {
    kind: "customer",
    label: "Customers",
    permissions: ["contact:read", "customer_invoice:read", "account:read"],
    href: (r) => `/sales/customers/${r.id}`,
  },
  supplier: {
    kind: "supplier",
    label: "Suppliers",
    permissions: ["contact:read", "supplier_bill:read", "account:read"],
    href: (r) => `/purchases/suppliers/${r.id}`,
  },
  invoice: {
    kind: "invoice",
    label: "Invoices",
    permissions: ["customer_invoice:read", "contact:read", "account:read", "journal:read"],
    href: (r) => `/sales/invoices/${r.id}`,
  },
  quote: {
    kind: "quote",
    label: "Quotes",
    permissions: ["customer_quote:read", "contact:read", "account:read", "journal:read"],
    href: (r) => `/sales/quotes/${r.id}`,
  },
  bill: {
    kind: "bill",
    label: "Bills",
    permissions: ["supplier_bill:read", "contact:read", "account:read", "journal:read"],
    href: (r) => `/purchases/bills/${r.id}`,
  },
  purchase_order: {
    kind: "purchase_order",
    label: "Purchase orders",
    permissions: ["purchase_order:read", "contact:read"],
    href: (r) => `/purchases/purchase-orders/${r.id}`,
  },
  account: {
    kind: "account",
    label: "Accounts",
    permissions: ["account:read", "journal:read"],
    href: (r) => `/accounting/accounts/${r.id}/transactions`,
  },
  // There is no payments list page: a payment is opened through the customer / supplier it belongs to (`ref`).
  payment: {
    kind: "payment",
    label: "Customer payments",
    permissions: ["customer_payment:read", "contact:read", "customer_invoice:read", "account:read"],
    href: (r) => `/sales/customers/${r.ref ?? r.id}`,
  },
  supplier_payment: {
    kind: "supplier_payment",
    label: "Supplier payments",
    permissions: ["supplier_payment:read", "contact:read", "supplier_bill:read", "account:read"],
    href: (r) => `/purchases/suppliers/${r.ref ?? r.id}`,
  },
  employee: {
    kind: "employee",
    label: "Employees",
    permissions: ["employee:read"],
    href: (r) => `/payroll/employees/${r.id}`,
  },
  // Bank transactions are only listed (as unreconciled) on the bank account page, which needs both of these.
  bank_transaction: {
    kind: "bank_transaction",
    label: "Bank transactions",
    permissions: ["bank_account:read", "bank_transaction:reconcile", "account:read"],
    href: (r) => `/money/${r.ref ?? r.id}`,
  },
  project: {
    kind: "project",
    label: "Projects",
    // The project page also loads its timesheet entries, the chart of accounts and the tax codes.
    permissions: ["project:read", "timesheet:read", "account:read", "journal:read"],
    href: (r) => `/projects/${r.id}`,
  },
  product: {
    kind: "product",
    label: "Products",
    permissions: ["product:read"],
    href: (r) => `/inventory/${r.id}`,
  },
};

/** The kinds a role may search, in display order. The single place that turns a role into "what may be queried". */
export function searchableKindsFor(
  role: MembershipRole,
  granted?: ReadonlySet<Permission>,
): SearchKind[] {
  return SEARCH_KINDS.filter((kind) =>
    SEARCH_KIND_SPECS[kind].permissions.every(
      (p) => roleHasPermission(role, p) && (!granted || granted.has(p)),
    ),
  );
}
