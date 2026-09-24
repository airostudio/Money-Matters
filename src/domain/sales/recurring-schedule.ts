import type { RecurringFrequency } from "./types";

/**
 * Pure, DB-free next-run-date advancement — exercised directly by unit
 * tests. Dates are compared/advanced at UTC midnight (matching how Drizzle's
 * `timestamp(..., { mode: "date" })` round-trips a date-only value), so this
 * never drifts a day depending on the server's local timezone.
 *
 * Monthly/quarterly/annually clamp the day-of-month to the target month's
 * last day when it doesn't have one (e.g. 31 Jan + 1 month -> 28/29 Feb),
 * rather than overflowing into the following month.
 */
export function advanceRecurringDate(date: Date, frequency: RecurringFrequency): Date {
  switch (frequency) {
    case "WEEKLY":
      return addDaysUtc(date, 7);
    case "MONTHLY":
      return addMonthsClampedUtc(date, 1);
    case "QUARTERLY":
      return addMonthsClampedUtc(date, 3);
    case "ANNUALLY":
      return addMonthsClampedUtc(date, 12);
    default: {
      const exhaustive: never = frequency;
      throw new Error(`Unknown recurring frequency: ${String(exhaustive)}`);
    }
  }
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function addMonthsClampedUtc(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const targetMonthIndex = month + months;
  const daysInTargetMonth = new Date(Date.UTC(year, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  return new Date(Date.UTC(year, targetMonthIndex, clampedDay));
}
