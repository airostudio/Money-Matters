import type { Permission } from "@/domain/permissions/roles";

/**
 * Palette commands that are not a plain "Go to <menu entry>" or a "New <thing>" (those two kinds are derived from the
 * navigation and the Create menu in src/components/shell/palette-model.ts, so they cannot drift from them).
 *
 * A command only ever NAVIGATES to an existing page; nothing here performs a mutation. `permissions` is every
 * permission the destination page needs to render (all must be held), so a role that cannot use the page never sees
 * the command. Pure data: no database, no services.
 */
export interface StaticCommand {
  id: string;
  label: string;
  /** Extra words the palette matches on, besides the label. */
  keywords: string[];
  /** Organization-relative path, optionally with a query string. */
  href: string;
  permissions: Permission[];
}

export const STATIC_COMMANDS: StaticCommand[] = [
  {
    id: "reconcile-banking",
    label: "Reconcile banking",
    keywords: ["bank", "reconciliation", "match", "transactions", "statement"],
    href: "/money",
    // The bank accounts page lists each account's UNRECONCILED transactions, which needs the reconcile permission too.
    permissions: ["bank_account:read", "bank_transaction:reconcile"],
  },
  {
    id: "find-unpaid-invoices",
    label: "Find unpaid invoices",
    keywords: ["outstanding", "owing", "receivable", "debtors", "who owes"],
    href: "/sales/invoices?filter=unpaid",
    permissions: ["customer_invoice:read"],
  },
  {
    id: "find-overdue-invoices",
    label: "Find overdue invoices",
    keywords: ["late", "past due", "chase", "receivable", "debtors"],
    href: "/sales/invoices?filter=overdue",
    permissions: ["customer_invoice:read"],
  },
];

/**
 * Pages whose menu entry is shown more widely than the page itself can be opened: the entry carries no permission (or
 * a weaker one), but the page loads data behind a stricter check. In the palette ONLY, these destinations are gated by
 * what the page really needs, so "Go to ..." never offers a refusal. The menu itself is left as it is.
 * Keyed by the organization-relative href of the nav entry.
 */
export const PAGE_PERMISSION_OVERRIDES: Record<string, Permission[]> = {
  "/money": ["bank_account:read", "bank_transaction:reconcile"],
  // The Purchases menu entry also shows for roles that only hold expense_claim:read, but the overview page lists bills.
  "/purchases": ["supplier_bill:read"],
};

/** Words people use for pages, matched in addition to the page's own label. Keyed by organization-relative href. */
export const PAGE_ALIASES: Record<string, string[]> = {
  "/accounting/reports/profit-and-loss": ["p&l", "pnl", "income statement", "profit and loss", "profit loss"],
  "/accounting/reports/balance-sheet": ["financial position", "assets liabilities"],
  "/accounting/reports/cash-flow": ["cashflow", "cash flow statement"],
  "/accounting/bas": ["gst", "bas", "tax", "ato", "business activity statement"],
  "/accounting/tax-codes": ["gst", "tax rates"],
  "/accounting/chart-of-accounts": ["coa", "ledger accounts", "accounts list"],
  "/accounting/journals": ["journal entries", "manual entries", "general ledger"],
  "/accounting/trial-balance": ["account balances", "tb"],
  "/accounting/close": ["month end", "period close", "lock"],
  "/sales/aged-receivables": ["debtors", "ar", "aged debtors", "who owes us"],
  "/purchases/aged-payables": ["creditors", "ap", "aged creditors", "what we owe"],
  "/sales/customers": ["clients", "debtors"],
  "/purchases/suppliers": ["vendors", "creditors"],
  "/payroll/employees": ["staff", "people", "team"],
  "/payroll/pay-runs": ["payroll", "wages", "salary"],
  "/ai-finance": ["ai", "controller", "assistant", "ask"],
  "/settings": ["company", "team", "members", "users", "roles"],
};
