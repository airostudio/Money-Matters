import type { Permission } from "@/domain/permissions/roles";
import type { LucideIcon } from "lucide-react";
import {
  Banknote,
  Bot,
  Building2,
  Home,
  LineChart,
  Package,
  Scale,
  Settings,
  ShoppingCart,
  Sparkles,
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
  { label: "Operations", href: "/operations", icon: Package },
  {
    label: "Accounting",
    href: "/accounting",
    icon: Scale,
    permission: "account:read",
    children: [
      { label: "Chart of Accounts", href: "/accounting/chart-of-accounts", permission: "account:read" },
      { label: "Journals", href: "/accounting/journals", permission: "journal:read" },
      { label: "Trial Balance", href: "/accounting/trial-balance", permission: "journal:read" },
      { label: "Tax Codes", href: "/accounting/tax-codes", permission: "tax_code:manage" },
    ],
  },
  { label: "Insights", href: "/insights", icon: Sparkles },
  { label: "AI Finance", href: "/ai-finance", icon: Bot },
  { label: "Settings", href: "/settings", icon: Settings },
];

export const BRAND_ICON = Building2;
