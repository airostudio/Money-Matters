import type { projectStatusEnum, timesheetEntryStatusEnum } from "@/db/schema";

export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];
export type TimesheetEntryStatus = (typeof timesheetEntryStatusEnum.enumValues)[number];

export interface CreateProjectInput {
  customerContactId?: string;
  code: string;
  name: string;
  currency: string;
  budgetedRevenue?: string;
  budgetedCost?: string;
  defaultHourlyRate?: string;
  startDate?: Date;
  endDate?: Date;
  memo?: string;
}

export type UpdateProjectInput = CreateProjectInput;

export interface CreateProjectTaskInput {
  name: string;
  budgetedHours?: string;
  billingRate?: string;
}

export type UpdateProjectTaskInput = CreateProjectTaskInput & { isDone?: boolean };

/**
 * Shared by both the start/stop timer and manual entry — the same
 * underlying row either way (master spec §23). Manual entry supplies
 * `hours` directly; the timer path supplies `startedAt`/`endedAt` and lets
 * `TimesheetService` derive `hours` from their difference (see
 * `calculateDurationHours`).
 */
export interface CreateManualTimesheetEntryInput {
  employeeUserId: string;
  projectId: string;
  taskId?: string;
  entryDate: Date;
  hours: string;
  notes?: string;
  billable?: boolean;
}

export type UpdateTimesheetEntryInput = CreateManualTimesheetEntryInput;

export interface CreateInvoiceFromUnbilledTimeInput {
  projectId: string;
  /** Inclusive lower bound on `entryDate`. Omit for "since project inception". */
  from?: Date;
  /** Inclusive upper bound on `entryDate`. Omit for "up to today". */
  to?: Date;
  issueDate: Date;
  dueDate: Date;
  /** The Accounts Receivable control account the generated invoice posts to. */
  arAccountId: string;
  /** The revenue account each generated line credits on posting. */
  revenueAccountId: string;
  taxCodeId?: string;
  /** Group one invoice line per task (the default) instead of one line per timesheet entry. */
  groupByTask?: boolean;
}
