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
  { label: "Sales", href: "/sales", icon: LineChart },
  { label: "Purchases", href: "/purchases", icon: ShoppingCart },
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
