import Decimal from "decimal.js";

/** Matches `timesheet_entries.hours`'s numeric(19,2) column. */
const HOURS_DECIMAL_PLACES = 2;

export class InvalidTimerRangeError extends Error {
  constructor() {
    super("A timer's stop time must be after its start time.");
    this.name = "InvalidTimerRangeError";
  }
}

/**
 * Derives the `hours` decimal string for a start/stop timer entry — the one
 * calculation that must never use floating point (master spec's
 * money-and-hours-never-float rule applies to hours just as much as
 * dollars: a long-running timer with naive float division for the duration
 * compounds rounding error just as badly as a monetary one would).
 */
export function calculateDurationHours(startedAt: Date, endedAt: Date): string {
  if (endedAt.getTime() <= startedAt.getTime()) throw new InvalidTimerRangeError();
  const milliseconds = new Decimal(endedAt.getTime() - startedAt.getTime());
  return milliseconds.div(3_600_000).toFixed(HOURS_DECIMAL_PLACES, Decimal.ROUND_HALF_EVEN);
}

export interface UnbilledTimeFilterEntry {
  id: string;
  projectId: string;
  status: string;
  billable: boolean;
  invoiceId: string | null;
  entryDate: Date;
}

export interface UnbilledTimeFilterOptions {
  projectId: string;
  from?: Date;
  to?: Date;
}

/**
 * The exact predicate `ProjectTimeBillingService.createInvoiceFromUnbilledTime`
 * selects on — approved, billable, not yet linked to any invoice, for the
 * given project and date range — pulled out as a pure function so it can be
 * unit-tested against a crafted mix of statuses directly, independent of
 * the real SQL `WHERE` clause (`timesheet-service.ts`) that expresses the
 * same rule against the database. If this function's rule and the SQL
 * query's rule ever drift, the integration test (which exercises the real
 * query) is the one that would catch it, not this file.
 */
export function selectUnbilledEntries<T extends UnbilledTimeFilterEntry>(
  entries: T[],
  opts: UnbilledTimeFilterOptions,
): T[] {
  return entries.filter((entry) => {
    if (entry.projectId !== opts.projectId) return false;
    if (entry.status !== "APPROVED") return false;
    if (!entry.billable) return false;
    if (entry.invoiceId !== null) return false;
    if (opts.from && entry.entryDate.getTime() < opts.from.getTime()) return false;
    if (opts.to && entry.entryDate.getTime() > opts.to.getTime()) return false;
    return true;
  });
}
