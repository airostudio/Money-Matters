/**
 * Business vs Accountant mode (master spec s.72): ONE engine, ONE product, two PRESENTATIONS.
 * The mode is a per-browser cookie that changes terminology and which entry points the
 * navigation shows — nothing else. It grants no permission, hides no data the person's role
 * could see, and changes no calculation: every route stays reachable by URL in either mode and
 * every service check is unchanged.
 *
 *  BUSINESS    plain-language labels ("Account balances", "Manual entries"); no practice entry points.
 *  ACCOUNTANT  accounting terminology (General Ledger, Journals, Trial Balance) and the Practice
 *              entry points (dashboard, workpapers).
 */
export type UiMode = "BUSINESS" | "ACCOUNTANT";

export const UI_MODE_COOKIE = "mm_ui_mode";
export const DEFAULT_UI_MODE: UiMode = "BUSINESS";

export function parseUiMode(value: string | null | undefined): UiMode {
  return value === "ACCOUNTANT" ? "ACCOUNTANT" : value === "BUSINESS" ? "BUSINESS" : DEFAULT_UI_MODE;
}

/** Navigation labels that differ by mode. Anything not listed keeps its one label in both modes. */
const BUSINESS_LABELS: Record<string, string> = {
  Accounting: "Accounts & reports",
  "Chart of Accounts": "Accounts list",
  Journals: "Manual entries",
  "Trial Balance": "Account balances",
  "Month-End Close": "Month-end checklist",
  "Client requests": "Accountant requests",
};

const ACCOUNTANT_LABELS: Record<string, string> = {
  Accounting: "General Ledger",
};

export function labelForMode(label: string, mode: UiMode): string {
  return (mode === "BUSINESS" ? BUSINESS_LABELS[label] : ACCOUNTANT_LABELS[label]) ?? label;
}
