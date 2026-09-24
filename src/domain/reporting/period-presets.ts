/**
 * Pure date-range helpers for the financial statement pages' default
 * periods and comparison-period picker. Kept here (not inline in the page
 * components) so the month/year arithmetic — including December → January
 * and leap-year edges — is unit-tested without rendering anything.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

/** The calendar month containing `today`, as UTC-midnight boundaries (inclusive). */
export function currentMonthRange(today: Date = new Date()): DateRange {
  const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { from, to };
}

/** The calendar month immediately before `range`'s month. */
export function previousMonthRange(range: DateRange): DateRange {
  const from = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth() - 1, 1));
  const to = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 0));
  return { from, to };
}

/** The same calendar month one year earlier. */
export function sameMonthLastYearRange(range: DateRange): DateRange {
  const from = new Date(Date.UTC(range.from.getUTCFullYear() - 1, range.from.getUTCMonth(), 1));
  const to = new Date(Date.UTC(range.from.getUTCFullYear() - 1, range.from.getUTCMonth() + 1, 0));
  return { from, to };
}

/** The same number of days immediately before `range.from`, for an arbitrary (non-month) custom range. */
export function precedingRangeOfSameLength(range: DateRange): DateRange {
  const lengthMs = range.to.getTime() - range.from.getTime();
  const to = new Date(range.from.getTime() - 24 * 60 * 60 * 1000);
  const from = new Date(to.getTime() - lengthMs);
  return { from, to };
}

export type ComparisonMode = "previous_period" | "previous_year" | "none";

export function resolveComparisonRange(range: DateRange, mode: ComparisonMode): DateRange | undefined {
  if (mode === "none") return undefined;
  if (mode === "previous_year") return sameMonthLastYearRange(range);
  // "previous_period": use the calendar-month-aware version when `range`
  // looks like a full calendar month, otherwise fall back to "same length,
  // immediately before" for a custom range.
  const isFullCalendarMonth =
    range.from.getUTCDate() === 1 &&
    range.to.getTime() === new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth() + 1, 0)).getTime();
  return isFullCalendarMonth ? previousMonthRange(range) : precedingRangeOfSameLength(range);
}

/** Parses a `YYYY-MM-DD` search-param string into a UTC-midnight Date, or `undefined` if absent/invalid. */
export function parseDateParam(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}
