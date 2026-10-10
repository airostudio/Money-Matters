import type { LockLevel } from "@/domain/ledger/period-lock";

/**
 * PASSED          — verified (by the system for AUTOMATIC items; by a named
 *                   human sign-off for MANUAL ones — see `verifiedBy`).
 * ATTENTION       — something to look at; closing needs an explicit
 *                   acknowledgement.
 * BLOCKING        — a ledger-integrity problem; closing is refused.
 * NOT_APPLICABLE  — the check doesn't apply to this organization/period
 *                   (e.g. no fixed assets); excluded from the progress figure.
 * MANUAL          — a human sign-off item the system cannot verify, not yet
 *                   signed off.
 */
export type CheckStatus = "PASSED" | "ATTENTION" | "BLOCKING" | "NOT_APPLICABLE" | "MANUAL";
export type CheckKind = "AUTOMATIC" | "MANUAL";

export type CheckCategory =
  | "BANKING"
  | "SALES"
  | "PURCHASES"
  | "EXPENSES"
  | "PAYROLL"
  | "ASSETS"
  | "INVENTORY"
  | "LEDGER"
  | "ADJUSTMENTS"
  | "TAX"
  | "REVIEW";

export const CATEGORY_LABELS: Record<CheckCategory, string> = {
  BANKING: "Banking",
  SALES: "Sales",
  PURCHASES: "Purchases",
  EXPENSES: "Expenses",
  PAYROLL: "Payroll",
  ASSETS: "Fixed assets",
  INVENTORY: "Inventory",
  LEDGER: "Ledger integrity",
  ADJUSTMENTS: "Adjustments",
  TAX: "Tax",
  REVIEW: "Review",
};

export const CATEGORY_ORDER: CheckCategory[] = [
  "BANKING",
  "SALES",
  "PURCHASES",
  "EXPENSES",
  "PAYROLL",
  "ASSETS",
  "INVENTORY",
  "LEDGER",
  "ADJUSTMENTS",
  "TAX",
  "REVIEW",
];

export interface SignoffInfo {
  signedById: string;
  signedByName: string | null;
  signedAt: string;
  note: string | null;
}

export interface ChecklistItem {
  /** Stable key, e.g. "bank.unreconciled:<bankAccountId>" or "manual.accruals". */
  id: string;
  title: string;
  category: CheckCategory;
  kind: CheckKind;
  status: CheckStatus;
  /** Who vouches for a PASSED item: the system's own live computation, or a named human's sign-off. Null when not PASSED. */
  verifiedBy: "SYSTEM" | "HUMAN" | null;
  /** Plain-language explanation, e.g. "3 bank transactions in Everyday Account are unreconciled." */
  detail: string;
  /** Path (after /{orgSlug}) of the page where it is fixed or reviewed; null when there is none. */
  href: string | null;
  count: number | null;
  /** Base-currency decimal string where an amount is meaningful. */
  amount: string | null;
  /** Present on MANUAL items that have been signed off. */
  signoff: SignoffInfo | null;
}

export interface ChecklistProgress {
  /** PASSED items (system-verified or human-signed-off) among the applicable ones. */
  complete: number;
  /** Visible items that are not NOT_APPLICABLE. */
  applicable: number;
  /** Rounded whole percentage. */
  percent: number;
  /** The formula, stated in words, shown beside the figure. */
  formula: string;
}

export interface ChecklistPeriodInfo {
  /** The workspace key: YYYY-MM for a calendar month, otherwise the fiscal period id. */
  key: string;
  fiscalPeriodId: string | null;
  label: string;
  start: string;
  end: string;
  /** This period's own lock level (OPEN when it exists only implicitly). */
  lockLevel: LockLevel;
}

export interface PeriodChecklist {
  period: ChecklistPeriodInfo;
  items: ChecklistItem[];
  /** Items omitted because the actor's role lacks the permission to see them (e.g. payroll). Not counted in progress. */
  hiddenCount: number;
  progress: ChecklistProgress;
  /** Everything not yet PASSED and not NOT_APPLICABLE, in checklist order. */
  remaining: ChecklistItem[];
  blocking: ChecklistItem[];
  /** ATTENTION items plus unsigned MANUAL items — what a closer must explicitly acknowledge. */
  outstanding: ChecklistItem[];
  generatedAt: string;
}
