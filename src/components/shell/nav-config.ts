import type { Permission } from "@/domain/permissions/roles";
import type { LucideIcon } from "lucide-react";
import type { UiMode } from "./ui-mode";
import {
  Banknote,
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
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
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
 * Top-level navigation per master spec §59. Sections not yet built in
 * Phase 1 still appear (so the product's shape is honest about what's
 * coming) but route to a "not built yet" page rather than faking data —
 * see docs/roadmap.md and master spec §81.
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "Home", href: "", icon: Home },
  { label: "Money", href: "/money", icon: Banknote },
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
  { label: "People", href: "/people", icon: Users },
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
    label: "Payroll",
    href: "/payroll",
    icon: Wallet,
    permission: "employee:read",
    children: [
      { label: "Employees", href: "/payroll/employees", permission: "employee:read" },
      { label: "Pay Runs", href: "/payroll/pay-runs", permission: "payrun:read" },
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
    ],
  },
  {
    label: "Client requests",
    href: "/requests",
    icon: Inbox,
    permission: "client_request:read",
  },
  { label: "Insights", href: "/insights", icon: Sparkles },
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
  { label: "Settings", href: "/settings", icon: Settings },
];

export const BRAND_ICON = Building2;
