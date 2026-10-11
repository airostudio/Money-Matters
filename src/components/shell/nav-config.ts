import { roleHasPermission, type MembershipRole, type Permission } from "@/domain/permissions/roles";
import type { LucideIcon } from "lucide-react";
import type { UiMode } from "./ui-mode";
import {
  Banknote,
  Bell,
  Briefcase,
  Inbox,
  Boxes,
  Bot,
  Building2,
  Home,
  Landmark,
  LineChart,
  Package,
  PiggyBank,
  Scale,
  Settings,
  ShoppingCart,
  TrendingUp,
  Users,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Hidden from the nav entirely if the actor's role lacks this permission. Omit to show to every member. */
  permission?: Permission;
  /** Shown if the actor's role holds ANY of these — used when a section covers more than one permission domain (e.g. Purchases also covers Expenses, which an EMPLOYEE role can reach without `supplier_bill:read`). */
  anyPermission?: Permission[];
  children?: Array<{ label: string; href: string; permission?: Permission }>;
  /** A route OUTSIDE `/{orgSlug}` (the accountant practice section). When set, `href` is ignored. */
  absoluteHref?: string;
  /** Shown only in this presentation mode (see ui-mode.ts). Omit to show in both. */
  onlyInMode?: UiMode;
}

/**
 * Top-level navigation per master spec §59. Every entry points at something that is built; a section that is not
 * built yet is left out rather than shown as a "coming soon" page (see docs/roadmap.md). People and Insights used to
 * be placeholder entries: employees, payroll and leave live under "People & Payroll", and the reports live under
 * Accounting. Their old URLs redirect there.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "", icon: Home },
  {
    label: "Money",
    href: "/money",
    icon: Banknote,
    children: [
      { label: "Bank accounts & reconciliation", href: "/money" },
      { label: "Bank rules", href: "/money/rules", permission: "bank_rule:manage" },
    ],
  },
  {
    label: "Sales",
    href: "/sales",
    icon: LineChart,
    anyPermission: ["customer_invoice:read", "customer_quote:read", "recurring_invoice:read"],
    children: [
      { label: "Quotes", href: "/sales/quotes", permission: "customer_quote:read" },
      { label: "Invoices", href: "/sales/invoices", permission: "customer_invoice:read" },
      { label: "Recurring Invoices", href: "/sales/recurring-invoices", permission: "recurring_invoice:read" },
      { label: "Customers", href: "/sales/customers", permission: "customer_invoice:read" },
      { label: "Aged Receivables", href: "/sales/aged-receivables", permission: "customer_invoice:read" },
    ],
  },
  {
    label: "Purchases",
    href: "/purchases",
    icon: ShoppingCart,
    anyPermission: ["supplier_bill:read", "expense_claim:read"],
    children: [
      { label: "Bills", href: "/purchases/bills", permission: "supplier_bill:read" },
      { label: "Purchase Orders", href: "/purchases/purchase-orders", permission: "purchase_order:read" },
      { label: "Recurring Bills", href: "/purchases/recurring-bills", permission: "recurring_bill:read" },
      { label: "Supplier Credits", href: "/purchases/supplier-credits", permission: "supplier_credit:read" },
      { label: "Payment Runs", href: "/purchases/payment-runs", permission: "payment_run:read" },
      { label: "Suppliers", href: "/purchases/suppliers", permission: "supplier_bill:read" },
      { label: "Aged Payables", href: "/purchases/aged-payables", permission: "supplier_bill:read" },
      { label: "Expenses", href: "/expenses", permission: "expense_claim:read" },
    ],
  },
  {
    label: "Projects",
    href: "/projects",
    icon: Package,
    permission: "project:read",
  },
  {
    label: "Inventory",
    href: "/inventory",
    icon: Boxes,
    permission: "product:read",
    children: [
      { label: "Products", href: "/inventory", permission: "product:read" },
      { label: "Valuation", href: "/inventory/valuation", permission: "inventory:read" },
      { label: "Reorder Alerts", href: "/inventory/reorder", permission: "inventory:read" },
    ],
  },
  {
    label: "Fixed Assets",
    href: "/fixed-assets",
    icon: Landmark,
    permission: "fixed_asset:read",
    children: [
      { label: "Register", href: "/fixed-assets", permission: "fixed_asset:read" },
      { label: "Asset Classes", href: "/fixed-assets/classes", permission: "fixed_asset:read" },
      { label: "Run Depreciation", href: "/fixed-assets/depreciation", permission: "fixed_asset:manage" },
    ],
  },
  {
    label: "Budgets",
    href: "/budgets",
    icon: PiggyBank,
    permission: "budget:read",
  },
  {
    label: "Forecasting",
    href: "/forecasting",
    icon: TrendingUp,
    permission: "forecast:read",
    children: [
      { label: "Cash Forecast", href: "/forecasting/cash-flow", permission: "forecast:read" },
      { label: "Scenarios", href: "/forecasting/scenarios", permission: "scenario:read" },
    ],
  },
  {
    label: "People & Payroll",
    href: "/payroll",
    icon: Users,
    anyPermission: ["employee:read", "payslip:read"],
    children: [
      { label: "My pay and leave", href: "/payroll/my", permission: "payslip:read" },
      { label: "Employees", href: "/payroll/employees", permission: "employee:read" },
      { label: "Pay Runs", href: "/payroll/pay-runs", permission: "payrun:read" },
      { label: "Leave requests", href: "/payroll/leave", permission: "leave:read" },
      { label: "Remittances", href: "/payroll/remittances", permission: "payroll_payment:read" },
      { label: "Payroll reports", href: "/payroll/reports/summary", permission: "payrun:read" },
    ],
  },
  {
    label: "Accounting",
    href: "/accounting",
    icon: Scale,
    permission: "account:read",
    children: [
      { label: "Chart of Accounts", href: "/accounting/chart-of-accounts", permission: "account:read" },
      { label: "Journals", href: "/accounting/journals", permission: "journal:read" },
      { label: "Trial Balance", href: "/accounting/trial-balance", permission: "journal:read" },
      { label: "Month-End Close", href: "/accounting/close", permission: "close_checklist:read" },
      {
        label: "Profit & Loss",
        href: "/accounting/reports/profit-and-loss",
        permission: "financial_report:read",
      },
      { label: "Balance Sheet", href: "/accounting/reports/balance-sheet", permission: "financial_report:read" },
      { label: "Cash Flow Statement", href: "/accounting/reports/cash-flow", permission: "financial_report:read" },
      { label: "Management Pack", href: "/accounting/reports/management-pack", permission: "financial_report:read" },
      { label: "Budget vs. Actual", href: "/accounting/reports/budget-vs-actual", permission: "budget:read" },
      { label: "Report Builder", href: "/accounting/reports/builder", permission: "financial_report:read" },
      { label: "Ask a question", href: "/accounting/reports/ask", permission: "financial_report:read" },
      { label: "Dimensions", href: "/accounting/dimensions", permission: "dimension:read" },
      { label: "Tax Codes", href: "/accounting/tax-codes", permission: "tax_code:manage" },
      { label: "BAS / GST", href: "/accounting/bas", permission: "bas:read" },
    ],
  },
  {
    label: "Client requests",
    href: "/requests",
    icon: Inbox,
    permission: "client_request:read",
  },
  {
    label: "AI Finance",
    href: "/ai-finance",
    icon: Bot,
    permission: "financial_report:read",
    children: [
      { label: "Ask the Controller", href: "/ai-finance", permission: "financial_report:read" },
      { label: "Daily Finance Brief", href: "/ai-finance/brief", permission: "financial_report:read" },
    ],
  },
  { label: "Practice", href: "/practice", absoluteHref: "/practice", icon: Briefcase, onlyInMode: "ACCOUNTANT" },
  // No live unread badge on purpose: the shared shell is the hot path and must not run a query per page view (the count is on the page and the home card).
  { label: "Notifications", href: "/notifications", icon: Bell },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    children: [
      { label: "Company & team", href: "/settings" },
      { label: "Accountant access", href: "/settings/accountant", permission: "organization:manage" },
      { label: "Automation", href: "/settings/automation", permission: "automation:read" },
      { label: "Integrations", href: "/settings/integrations", permission: "integration:manage" },
      { label: "API keys", href: "/settings/api", permission: "api_key:manage" },
      { label: "Webhooks", href: "/settings/webhooks", permission: "webhook:manage" },
      { label: "Connected apps", href: "/settings/oauth-apps", permission: "oauth_app:manage" },
    ],
  },
];

export const BRAND_ICON = Building2;

export type CreateGroup = "Sales" | "Purchases" | "Other";

export interface CreateAction {
  /** The menu label ("Invoice"); the command palette says "New invoice" (`commandLabel`). */
  label: string;
  commandLabel: string;
  href: string;
  group: CreateGroup;
  /**
   * EVERY permission the destination page needs to render, not just the one that gates it: a "New ..." page checks
   * its own write permission and then loads the contacts, accounts, tax codes and products its form offers, each
   * through a service that has its own read permission. The menu offers the action only if the role holds all of
   * them, so it never leads to a refusal. (src/tests/unit/search/create-actions.test.ts reads each page's source and
   * fails if this list drifts from what the page checks and loads.)
   */
  permissions: Permission[];
}

/**
 * The universal "+ Create" menu (master spec s.57) and the palette's "New ..." commands. Presentation only: the
 * domain service still enforces the write permission. Order is display order within each group.
 */
export const CREATE_ACTIONS: CreateAction[] = [
  {
    label: "Invoice",
    commandLabel: "New invoice",
    href: "/sales/invoices/new",
    group: "Sales",
    permissions: ["customer_invoice:manage", "contact:read", "account:read", "journal:read", "product:read"],
  },
  {
    label: "Quote",
    commandLabel: "New quote",
    href: "/sales/quotes/new",
    group: "Sales",
    permissions: ["customer_quote:manage", "contact:read", "account:read", "journal:read"],
  },
  { label: "Customer", commandLabel: "New customer", href: "/sales/customers/new", group: "Sales", permissions: ["contact:manage"] },
  {
    label: "Bill",
    commandLabel: "New bill",
    href: "/purchases/bills/new",
    group: "Purchases",
    permissions: ["supplier_bill:manage", "contact:read", "account:read", "journal:read", "product:read"],
  },
  {
    label: "Expense claim",
    commandLabel: "New expense claim",
    href: "/expenses/new",
    group: "Purchases",
    permissions: ["expense_claim:manage", "account:read", "journal:read"],
  },
  {
    label: "Purchase order",
    commandLabel: "New purchase order",
    href: "/purchases/purchase-orders/new",
    group: "Purchases",
    permissions: ["purchase_order:manage", "contact:read", "account:read", "journal:read"],
  },
  { label: "Supplier", commandLabel: "New supplier", href: "/purchases/suppliers/new", group: "Purchases", permissions: ["contact:manage"] },
  { label: "Project", commandLabel: "New project", href: "/projects/new", group: "Other", permissions: ["project:manage", "contact:read"] },
  {
    label: "Journal entry",
    commandLabel: "New journal entry",
    href: "/accounting/journals/new",
    group: "Other",
    permissions: ["journal:post", "account:read", "dimension:read"],
  },
];

export const CREATE_GROUPS: CreateGroup[] = ["Sales", "Purchases", "Other"];

export function createActionsFor(role: MembershipRole): CreateAction[] {
  return CREATE_ACTIONS.filter((a) => a.permissions.every((p) => roleHasPermission(role, p)));
}

/** The actions grouped for the menu, empty groups dropped. An empty result means the whole menu is hidden. */
export function createGroupsFor(role: MembershipRole): Array<{ group: CreateGroup; actions: CreateAction[] }> {
  const allowed = createActionsFor(role);
  return CREATE_GROUPS.map((group) => ({ group, actions: allowed.filter((a) => a.group === group) })).filter(
    (g) => g.actions.length > 0,
  );
}
