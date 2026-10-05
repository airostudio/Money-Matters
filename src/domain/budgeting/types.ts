import type { budgetStatusEnum, budgetTypeEnum } from "@/db/schema";

export type BudgetType = (typeof budgetTypeEnum.enumValues)[number];
export type BudgetStatus = (typeof budgetStatusEnum.enumValues)[number];

export interface CreateBudgetInput {
  name: string;
  type?: BudgetType;
  periodStart: Date;
  periodEnd: Date;
  notes?: string;
}

/** One month's budgeted amount for one account (optionally dimension-scoped). */
export interface MonthlyLineInput {
  /** First day of the calendar month (UTC), e.g. `2026-01-01`. */
  month: Date;
  /** Decimal string, normal-balance-signed — see `budgetLines`'s doc comment in src/db/schema.ts. */
  amount: string;
}

/**
 * Bulk-entry input for `BudgetService.setAccountLines`: one account's (and
 * optional dimension value's) whole set of monthly figures across the
 * budget's date range, submitted as one call — the "enter a whole
 * account's year in one form" shape master spec §36's brief asks for,
 * rather than one API call per cell.
 */
export interface SetAccountLinesInput {
  accountId: string;
  dimensionValueId?: string;
  months: MonthlyLineInput[];
}

export interface CreateRollingForecastInput {
  sourceBudgetId: string;
  name: string;
  /** Periods ending on/before this date are copied through unedited (history preserved); periods starting after it are carried forward as a starting point the user then edits. */
  carryForwardAfterDate: Date;
}
